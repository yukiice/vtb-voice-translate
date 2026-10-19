#!/usr/bin/env node
/**
 * M1 探针 —— 用最小成本验证百炼 ASR 全链路，并回答 PLAN 里几个卡住的未知项。
 *
 *   node probe.mjs ping        鉴权 + 协议（不发音频，成本≈0）
 *   node probe.mjs recognize   日语识别全流程（草稿/定稿/时间戳/usage）
 *   node probe.mjs rate        音频 Token 率与固定开销（PLAN D55，6 倍不确定）
 *   node probe.mjs soak        长连接稳定性（默认 30 分钟实时音频，M1 遗留项）
 *   node probe.mjs soak --silent=zeros  改送静音（保活是否可行 + 静音是否计费）
 *   node probe.mjs soak --silent=mute   完全不送音频（多久会被服务端 idle 断开）
 *   node probe.mjs all         依次跑完（⚠️ 不含 soak —— 它默认就是 30 分钟）
 *
 * 鉴权优先级：--key > 环境变量 DASHSCOPE_API_KEY > ./.env.local
 * 密钥只出现在 URL 里，任何输出都会被 redact。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

import { AsrSession, DEFAULT_ENDPOINT, DEFAULT_MODEL, beijingEndpoint, tokenCost, yuan } from './lib/asr.mjs';
import { rawHandshake, explainHandshake } from './lib/handshake.mjs';
import { synthJapanese, fitToDuration, bytesToSec, secToBytes, silence, wavToPcm } from './lib/audio.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, 'out');

// ─────────────────────────── 参数 ───────────────────────────

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      // 同时支持 `--k=v` 与 `--k v`。
      // 只支持后者时，`--silent=zeros` 会被当成一个名叫 "silent=zeros" 的布尔开关 ——
      // 不报错，但默默不生效（这个坑已在 2026-10-17 实际踩到过）。
      const eq = a.indexOf('=');
      if (eq > 2) {
        o[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      o[k] = v;
    } else o._.push(a);
  }
  return o;
}

/** 极简 .env.local 读取（不引依赖） */
function loadLocalEnv() {
  const p = path.join(HERE, '.env.local');
  if (!fs.existsSync(p)) return {};
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

function resolveKey(args) {
  if (typeof args.key === 'string') return args.key;
  if (process.env.DASHSCOPE_API_KEY) return process.env.DASHSCOPE_API_KEY;
  const env = loadLocalEnv();
  if (env.DASHSCOPE_API_KEY) return env.DASHSCOPE_API_KEY;
  console.error(`
❌ 没找到 API Key。三选一：

   1) 环境变量：   export DASHSCOPE_API_KEY=sk-xxxx
   2) 命令行：     node probe.mjs ping --key sk-xxxx
   3) 本地文件：   echo 'DASHSCOPE_API_KEY=sk-xxxx' > tools/m1-bench/.env.local

   （.env.local 已在 .gitignore 里，不会被提交）
`);
  process.exit(1);
}

// ─────────────────────────── 输出 ───────────────────────────

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  c: (s) => `\x1b[36m${s}\x1b[0m`,
};
const hr = (t) => console.log(`\n${C.b('━'.repeat(72))}\n${C.b(t)}\n${C.b('━'.repeat(72))}`);

function saveOut(name, data) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const f = path.join(OUT_DIR, `${name}.json`);
  fs.writeFileSync(f, JSON.stringify(data, null, 2));
  console.log(C.dim(`\n  结果已存 → ${path.relative(process.cwd(), f)}`));
}

// ─────────────────────────── 测试 1：ping ───────────────────────────

const PREFLIGHT_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/models';

/**
 * HTTPS 鉴权预检。
 *
 * 为什么需要它：WebSocket 握手失败时浏览器只给「error + close 1006」，
 * **拿不到 HTTP 状态码**，所以「Key 无效」与「网络不通」在 WS 上无法区分。
 * 而 `fetch()` 可以带请求头、且能读状态码 → 用它来定性。
 * （这条结论对扩展里 D62 的「测试」按钮同样适用。）
 */
async function preflight(key) {
  const t = Date.now();
  try {
    const r = await fetch(PREFLIGHT_URL, { headers: { Authorization: `Bearer ${key}` } });
    return { status: r.status, ms: Date.now() - t };
  } catch (e) {
    return { status: 0, ms: Date.now() - t, error: e.message };
  }
}

/**
 * 只建连 + run-task + finish-task，不发任何音频。
 * 用途：验证 `?api_key=` 鉴权与协议信封是否正确（对应 D62 的「测试」按钮）。
 */
async function ping({ key, model, endpoint, verbose, preflight: pf }) {
  hr(`测试 1 · 鉴权与协议 ${C.dim('(不发音频，成本≈0)')}`);
  console.log(`  端点  ${endpoint}`);
  console.log(`  模型  ${model}`);

  // 1a) HTTPS 预检结论（已在 main 里跑过）
  if (pf.status === 200) console.log(C.g(`  ✅ HTTPS 预检：Key 有效  ${C.dim(`HTTP 200 · ${pf.ms}ms`)}`));
  else if (pf.status === 401 || pf.status === 403) console.log(C.r(`  ⛔ HTTPS 预检：Key 无效  ${C.dim(`HTTP ${pf.status} · ${pf.ms}ms`)}`));
  else console.log(C.y(`  ⚠ HTTPS 预检：意外状态  ${C.dim(`HTTP ${pf.status} · ${pf.ms}ms`)}`));

  // 1b) 裸 TLS 握手 —— 能读到真实状态行（浏览器没有这个能力，仅探针用）
  const hs = await rawHandshake({ url: endpoint, apiKey: key, origin: 'chrome-extension://m1probem1probem1probem1probe' })
    .then((r) => ({ ...r, ...explainHandshake(r) }))
    .catch((e) => ({ level: 'net', text: e.message }));
  const hsIcon = { ok: '✅', auth: '⛔', net: '⚠', limit: '⚠', server: '⚠', bad: '⚠' }[hs.level] || '⚠';
  console.log(
    `${hsIcon} 裸握手（带 chrome-extension Origin）：${hs.status ? `HTTP ${hs.status} · ` : ''}${hs.text}` +
      C.dim(`  ${hs.ms}ms ${hs.status === 101 ? '(Origin 被接受)' : '(Origin 未被拒，只卡在 Key)'}`),
  );

  // 1c) 真正的 WebSocket 建连 + 协议往返
  const s = new AsrSession({ apiKey: key, model, endpoint, verbose });
  const t0 = Date.now();
  try {
    const openMs = await s.open();
    console.log(C.g(`  ✅ WebSocket 建连成功  ${openMs}ms`));

    const st = await s.start();
    console.log(C.g(`  ✅ task-started  ${st}ms`));

    const usage = await s.finish(20000, { keepOpen: true });
    console.log(C.g(`  ✅ task-finished  全程 ${Date.now() - t0}ms`));
    console.log(
      `  usage  ${C.dim('duration=' + (usage?.duration ?? '?'))}  input=${usage?.input_tokens ?? '?'}  output=${usage?.output_tokens ?? '?'}`,
    );
    console.log(`  ${C.y('预计费用')}  ${yuan(tokenCost(usage))}`);
    return { ok: true, preflight: pf, tls: { status: hs.status, level: hs.level }, handshakeMs: openMs, startMs: st, usage };
  } catch (e) {
    console.log(C.r(`  ❌ ${e.message}`));
    // WS 失败但 HTTPS 预检是 401 → 定性为 Key 问题，而不是网络问题
    if (pf.status === 401 || pf.status === 403) {
      console.log(C.dim('     注：HTTPS 预检已返回 401 —— WebSocket 握手失败属同一原因（Key 无效）'));
    }
    if (s.failure) console.log(C.dim(`     failure=${JSON.stringify(s.failure)}`));
    return { ok: false, error: e.message, failure: s.failure, preflight: pf };
  } finally {
    s.close();
  }
}

// ─────────────────────────── 测试 2：recognize ───────────────────────────

const SAMPLE_TEXT = 'こんにちは、今日も配信を見に来てくれてありがとうございます。';

/**
 * 日语识别全流程。打印草稿序列（看抖动）、定稿文本、字级时间戳、usage。
 */
async function recognize({ key, model, endpoint, verbose, text = SAMPLE_TEXT, voice = 'Kyoko', speed = 1, file }) {
  hr(`测试 2 · 日语识别全流程 ${file ? C.dim('(真实音频)') : ''}`);

  let pcm;
  if (file) {
    // 从 wav 读真音频（ingest.mjs 的产物）
    const p = path.isAbsolute(file) ? file : path.join(HERE, file);
    if (!fs.existsSync(p)) {
      console.log(C.r(`  ❌ 找不到文件 ${p}`));
      return { ok: false, error: 'file not found' };
    }
    pcm = wavToPcm(fs.readFileSync(p));
    console.log(`  文件      ${path.relative(process.cwd(), p)}`);
  } else {
    console.log(`  合成日语  ${C.dim('say -v ' + voice)}`);
    pcm = synthJapanese(text, voice);
    console.log(`  文本      ${text}`);
  }
  console.log(`  音频      ${bytesToSec(pcm.length).toFixed(2)}s @16kHz mono  ${C.dim(`(发送速率 ${speed}x)`)}`);

  const s = new AsrSession({ apiKey: key, model, endpoint, verbose });
  const wall = Date.now();
  try {
    await s.open();
    await s.start();

    const t0 = Date.now();
    const { sentMs } = await s.sendPcm(pcm, { speed: Number(speed) });
    await s.finish(30000, { keepOpen: true });

    const usage = s.finalUsage;
    const sorted = [...s.sentences.values()].sort((a, b) => a.id - b.id);
    const finals = sorted.filter((x) => x.final != null);
    const recognized = finals.map((x) => x.final).join('');

    console.log(`\n  ${C.b('识别结果')}`);
    if (!file) console.log(`    原文   ${text}`);
    console.log(`    识别   ${C.c(recognized || '(空)')}`);

    // 草稿 → 看抖动（对应 §5.5 / 模式 1 抖动频率）—— 文件模式下只打前 6 句，避免刷屏
    console.log(`\n  ${C.b('草稿序列')} ${C.dim('（同一句被重写的次数 = 抖动）')}`);
    const show = file ? sorted.slice(0, 6) : sorted;
    for (const sen of show) {
      if (!sen.drafts.length && sen.final == null) continue;
      const uniq = [];
      for (const d of sen.drafts) {
        if (uniq[uniq.length - 1] !== d.text) uniq.push(d.text);
      }
      console.log(`    句${sen.id}  草稿 ${C.y(String(uniq.length))} 次  ${C.dim('|')}  ${uniq.slice(-4).join(' ⟶ ')}`);
      console.log(`          定稿 ${C.c(sen.final ?? '(无)')}`);
    }

    // 时间戳（稳定化算法的前提）
    const w = finals.flatMap((x) => x.words || []);
    console.log(`\n  ${C.b('时间戳')}`);
    console.log(`    句级   ${finals.length ? C.g('✅') : C.r('❌')}  ${finals.map((x) => `[${x.beginTime}→${x.endTime}ms]`).join(' ')}`);
    console.log(`    字级   ${w.length ? C.g('✅ ' + w.length + ' 个字') : C.r('❌ 无')}`);
    if (w.length) console.log(C.dim(`      ${w.slice(0, 12).map((x) => `${x.text}${x.punctuation || ''}(${x.begin_time})`).join(' ')}`));

    // 首字延迟（音频起 → 第一个非心跳结果）
    const first = s.events.find((e) => e.event === 'result-generated' && !e.raw.payload?.output?.sentence?.heartbeat);
    const firstCharMs = first ? first.t - t0 - sentMs : null;

    console.log(`\n  ${C.b('成本')}`);
    console.log(`    usage     ${JSON.stringify(usage)}`);
    console.log(`    本次费用   ${C.y(yuan(tokenCost(usage)))}`);
    console.log(`    时长       ${bytesToSec(pcm.length).toFixed(2)}s / 计费时长 ${usage?.duration ?? '?'}s`);
    if (firstCharMs != null && firstCharMs > 0) {
      console.log(`    首字延迟   ${firstCharMs}ms ${C.dim('(音频发完→首个结果，含尾部静音等待)')}`);
    }
    console.log(C.dim(`\n  墙钟总耗时 ${Date.now() - wall}ms`));

    return { ok: true, text, recognized, usage, sentences: sorted, audioSec: bytesToSec(pcm.length), events: s.events.map((e) => e.raw) };
  } catch (e) {
    console.log(C.r(`\n  ❌ ${e.message}`));
    return { ok: false, error: e.message, failure: s.failure };
  } finally {
    s.close();
  }
}

/** 对文件模式做专项统计：句数、总字数、抖动、成本外推 */
function fileStats(r, audioSec) {
  if (!r.ok) return;
  const batch = r.sentences || [];
  const finals = batch.filter((x) => x.final != null);
  const drafts = batch.reduce((a, x) => a + x.drafts.length, 0);
  const chars = finals.reduce((a, x) => a + (x.final || '').length, 0);
  console.log(`\n  ${C.b('整段统计')}`);
  console.log(`    句子数     ${finals.length}`);
  console.log(`    识别字数   ${chars}  ${C.dim('（日文字符）')}`);
  console.log(`    草稿事件   ${drafts}  → 抖动 ${C.c((drafts / Math.max(1, audioSec)).toFixed(2))} 次/秒`);
  console.log(`    有定稿句占比 ${((finals.length / Math.max(1, batch.length)) * 100).toFixed(0)}%`);

  // 成本外推到小时
  if (r.usage) {
    const u = r.usage;
    const rate = audioSec > 0 ? u.input_tokens / audioSec : 0;
    const perHourInput = (rate * 3600 * 6) / 1e6;
    const perHourOutput = (u.output_tokens / Math.max(1, audioSec)) * 3600 * 4.5e-6;
    console.log(`    真实 Token  ${C.dim(JSON.stringify(u))}`);
    console.log(`    成本外推    ${C.y('¥' + (perHourInput + perHourOutput).toFixed(3) + '/h')}  ${C.dim(`(本段 ${audioSec.toFixed(1)}s 花费 ¥${(((u.input_tokens * 6 + u.output_tokens * 4.5) / 1e6)).toFixed(5)})`)}`);
  }
}

// ─────────────────────────── 测试 3：rate ───────────────────────────

/** 最小二乘拟合 y = slope*x + intercept */
function linfit(pts) {
  const n = pts.length;
  const sx = pts.reduce((a, [x]) => a + x, 0);
  const sy = pts.reduce((a, [, y]) => a + y, 0);
  const sxy = pts.reduce((a, [x, y]) => a + x * y, 0);
  const sxx = pts.reduce((a, [x]) => a + x * x, 0);
  const den = n * sxx - sx * sx;
  const slope = den === 0 ? Number.NaN : (n * sxy - sx * sy) / den;
  return { slope, intercept: (sy - slope * sx) / n };
}

/**
 * 音频 Token 率测量（PLAN D55）。
 *
 * 官方文档只给了「输入每秒音频消耗 7 Token」，但示例 usage 又可解释为 42/s。
 * 做法：同一段日语补静音到不同长度，各跑一次，用 input_tokens 对音频秒数做线性拟合：
 *     input_tokens = F + r × duration
 *   r = 每秒音频的 Token 数（解开 6 倍不确定）
 *   F = 固定 prompt 开销（每次都白付的那部分）
 *
 * ⚠️ 每个长度都用「全新连接 + 全新任务」，排除任务内上下文累积的干扰。
 */
async function rate({ key, model, endpoint, verbose, durations = '5,10,20,40', speed = 8 }) {
  hr('测试 3 · 音频 Token 率 + 固定开销');
  console.log(`  ${C.dim('官方称 7 Token/秒音频；示例 usage 又像 42/秒 —— 这里用线性拟合判定')}`);
  console.log(`  长度序列  ${durations}s   ${C.dim(`(发送加速 ${speed}x)`)}`);

  const list = String(durations).split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
  const base = synthJapanese('こんにちは、今日もいい天気ですね。', 'Kyoko');
  const baseSec = bytesToSec(base.length);
  console.log(`  基准语音  ${baseSec.toFixed(2)}s ${C.dim('(不足的长度用静音补齐)')}\n`);

  const rows = [];
  for (const d of list) {
    const { pcm, truncated } = fitToDuration(base, d);
    const s = new AsrSession({ apiKey: key, model, endpoint, verbose });
    try {
      await s.open();
      await s.start();
      await s.sendPcm(pcm, { speed: Number(speed) });
      const usage = await s.finish(30000, { keepOpen: true });
      const row = {
        requestedSec: d,
        billedSec: usage?.duration ?? null,
        input: usage?.input_tokens ?? null,
        output: usage?.output_tokens ?? null,
        cost: tokenCost(usage),
        truncated,
        measuredSec: Number(bytesToSec(pcm.length).toFixed(2)),
      };
      rows.push(row);
      console.log(
        `  ${String(d).padStart(3)}s  →  input=${C.y(String(row.input).padStart(5))}  output=${String(row.output).padStart(4)}` +
          `  billed=${String(row.billedSec).padStart(3)}s  ${yuan(row.cost)}${truncated ? C.r('  ⚠语音被截断') : ''}`,
      );
    } catch (e) {
      console.log(`  ${String(d).padStart(3)}s  →  ${C.r('❌ ' + e.message)}`);
    } finally {
      s.close();
    }
    await sleep(300); // 别贴着 RPM 上限打
  }

  // 拟合（用服务端回传的 billedSec，更贴近计费口径）
  const pts = rows.filter((r) => r.input != null && r.billedSec).map((r) => [r.billedSec, r.input]);
  let verdict = '样本不足，无法判定';
  let fit = null;
  if (pts.length >= 2) {
    fit = linfit(pts);
    const { slope, intercept } = fit;
    const candidates = [
      { name: '7 Token/秒（官方文档说法）', v: 7 },
      { name: '42 Token/秒（示例 usage 的另一种解读）', v: 42 },
    ];
    const best = candidates.reduce((a, b) => (Math.abs(b.v - slope) < Math.abs(a.v - slope) ? b : a));
    verdict = `实测 ${slope.toFixed(2)} Token/秒 → 最接近「${best.name}」，偏差 ${Math.abs(slope - best.v).toFixed(2)}`;
    console.log(`\n  ${C.b('拟合结果')}   input_tokens = ${intercept.toFixed(1)} + ${slope.toFixed(3)} × 音频秒数`);
    console.log(`    ${C.dim('每秒音频 Token')}  ${C.c(slope.toFixed(3))}`);
    console.log(`    ${C.dim('固定 prompt 开销')} ${C.c(intercept.toFixed(1))} Token ${C.dim('(每次任务白付一次)')}`);
    console.log(`\n  ${C.b('判定')}  ${C.g(verdict)}`);

    // 换算成每小时成本
    const perHourIn = slope * 3600;
    console.log(`\n  ${C.b('外推到 1 小时')}  ${C.dim('(纯 ASR 输入侧)')}`);
    console.log(`    输入 Token/h   ${Math.round(perHourIn).toLocaleString()}`);
    console.log(`    费用/h         ${C.y(yuan((perHourIn * 6) / 1e6))}  ${C.dim('+ 输出侧，另计')}`);
    if (perHourIn * 6 / 1e6 > 1.5) {
      console.log(`    ${C.r('⚠ 已超过 PLAN 的 ¥1.5/h 门槛 —— 需考虑 VAD 门控或换 paraformer-realtime-v2')}`);
    } else {
      console.log(`    ${C.g('✅ 在 PLAN 的 ¥1.5/h 门槛内')}`);
    }
  }

  return { ok: rows.length > 0, rows, fit, verdict };
}

// ─────────────────────────── 测试 4：soak ───────────────────────────

/**
 * 长连接稳定性 —— PLAN §11 的 P1 遗留项之一。
 *
 * 在一条 WebSocket 上以**实时速率**连续送音频 N 分钟（默认 30），每 60 秒打一行状态。
 * 回答三个问题：
 *   ① 服务端会在某个时长上限主动断开吗？（记 close code / reason / 断开时刻）
 *   ② heartbeat 与 result-generated 是否稳定持续，还是随时间衰减？
 *   ③ usage 是否随音频时长线性增长？（斜率漂移 = 有隐藏的累积计费）
 *
 * ⚠️ 刻意**不自动重连** —— 要看的就是「会不会断」。重连退避（D58）属于 M2 的产品逻辑。
 * 成本：按 D94（¥0.22–0.25/h）估 30 分钟约 ¥0.12；最坏按 42 token/s 计约 ¥0.4。
 *
 * `--silent` 补的是「长时间无人声」这个未覆盖场景（D103 遗留）：
 *   - `zeros`：**送静音保活** —— 「静音保活」可行吗？静音到底计不计费（D78 在长连接里是否成立）？
 *   - `mute`：**完全不送** —— 服务端多久才会因 idle 主动断开？（决定 §3 静默断流的安全边界）
 * 两种都几乎不计费（D78：静音不算钱；mute 连音频都没有），适合长时间跑。
 */
async function soak({ key, model, endpoint, verbose, minutes = 30, chunkSec = 5, voice = 'Kyoko', silent = null }) {
  const budgetMs = Number(minutes) * 60_000;
  // --silent 单独出现时 parseArgs 会给出 true，这种等同于没给
  const silentMode = typeof silent === 'string' ? silent : null;
  if (silentMode && !['zeros', 'mute'].includes(silentMode)) {
    throw new Error(`--silent 只支持 zeros | mute，收到 "${silentMode}"`);
  }
  const modeLabel = silentMode === 'mute' ? '完全不送音频' : silentMode === 'zeros' ? '只送静音' : '实时音频';
  hr(`测试 4 · 长连接稳定性 ${C.dim(`(${minutes} 分钟${modeLabel})`)}`);
  console.log(`  端点  ${endpoint}`);
  console.log(`  模型  ${model}`);
  if (!silentMode) {
    console.log(
      C.dim(
        `  预估成本 ≈ ¥${((0.25 * Number(minutes)) / 60).toFixed(3)}（按 ¥0.25/h）〜 ¥${(Number(minutes) / 60).toFixed(3)}（最坏 42 token/s）`,
      ),
    );
  } else {
    console.log(C.dim('  预估成本 ≈ ¥0（静音不计费；mute 连音频都不发）'));
  }

  // 三段不同内容轮换，避开「反复发同一段」引入的额外未知
  const texts = [
    'こんにちは、今日も配信を見に来てくれてありがとうございます。',
    'ちょっと待ってね、いまマイクの調子を確認しています。',
    'このゲームは昨日からずっとやっているんだけど、なかなか難しいですね。',
  ];
  // 静音模式不合成语音：省掉 macOS say 依赖，也让「零输入」这件事更彻底
  const chunks = silentMode ? [] : texts.map((t) => synthJapanese(t, voice));
  /** `zeros` 模式要发的内容：全 0 PCM == 静音（16kHz·mono·16bit） */
  const silencePcm = silentMode === 'zeros' ? Buffer.alloc(secToBytes(chunkSec)) : null;
  console.log(
    silentMode === 'mute'
      ? `  素材  ${C.dim('无 —— 完全不发送任何音频帧')}`
      : silentMode === 'zeros'
        ? `  素材  ${C.dim(`全 0 静音 PCM ${chunkSec}s × 循环`)}`
        : `  素材  ${chunks.length} 段合成本语：${chunks.map((c) => bytesToSec(c.length).toFixed(1) + 's').join(' / ')} ${C.dim('(轮换)')}`,
  );

  const s = new AsrSession({ apiKey: key, model, endpoint, verbose });
  const t0 = Date.now();
  const samples = [];
  let audioSecSent = 0;
  let rounds = 0;
  let lastSampleAt = t0;
  let interrupted = null;
  let finishedOk = false;

  const snapshot = () => {
    const hb = s.events.filter((e) => e.raw?.payload?.output?.sentence?.heartbeat).length;
    const finals = [...s.sentences.values()].filter((x) => x.final != null).length;
    const input = s.finalUsage?.input_tokens ?? 0;
    return { hb, finals, events: s.events.length, input, audioSecSent };
  };

  try {
    const openMs = await s.open();
    console.log(C.g(`  ✅ 建连 ${openMs}ms`));
    await s.start();
    console.log(C.g('  ✅ task-started，开始按实时速率送音频\n'));
    console.log(C.dim('   运行   已发音频    事件   心跳  定稿句   累计input   input/s'));

    while (Date.now() - t0 < budgetMs) {
      if (silentMode === 'mute') {
        // 完全不送音频 —— §3「静默 N 秒断流」最激进的一端。
        // 1s 粒度是为了及时捕获服务端的 idle 断开（靠 onclose 设 marks.closed）。
        await sleep(1000);
      } else {
        const pcm = silentMode === 'zeros' ? silencePcm : chunks[rounds % chunks.length];
        // speed=1 实时 —— 这是本测试的关键，绝不能加速
        await s.sendPcm(pcm, { speed: 1 });
        audioSecSent += bytesToSec(pcm.length);
      }
      rounds++;

      if (s.marks.closed) {
        interrupted = { kind: 'closed-at', at: s.marks.closed };
        break;
      }

      if (Date.now() - lastSampleAt >= 60_000) {
        lastSampleAt = Date.now();
        const snap = snapshot();
        const min = (Date.now() - t0) / 60_000;
        samples.push({ min, ...snap });
        console.log(
          `  ${String(Math.round(min)).padStart(4)}min  ${String(Math.round(snap.audioSecSent)).padStart(7)}s  ` +
            `${String(snap.events).padStart(6)}  ${String(snap.hb).padStart(5)}  ${String(snap.finals).padStart(5)}  ` +
            `${String(snap.input).padStart(10)}  ${(snap.input / Math.max(1, snap.audioSecSent)).toFixed(2)}`,
        );
      }
    }
  } catch (e) {
    interrupted = { kind: 'send-error', message: e.message, at: Date.now() };
    console.log(C.r(`\n  ❌ 发送中断：${e.message}`));
  }

  const elapsedMin = (Date.now() - t0) / 60_000;

  // 若连接还活着，正常收尾拿 usage（也会顺带验证长任务能否正常 finish）
  if (!interrupted && !s.marks.closed) {
    try {
      await s.finish(30000, { keepOpen: true });
      finishedOk = true;
      console.log(C.g('\n  ✅ finish-task 正常返回（长连接可正常收尾）'));
    } catch (e) {
      console.log(C.r(`\n  ❌ finish 失败：${e.message}`));
    }
  }
  s.close();

  const snap = snapshot();
  const usage = s.finalUsage;
  const info = s.closeInfo;

  // 线性性：累计 input_tokens 对运行分钟做最小二乘
  let linearity = null;
  if (samples.length >= 2) {
    const fit = linfit(samples.map((x) => [x.min, x.input]));
    const worst = samples.reduce((acc, x) => Math.max(acc, Math.abs(x.input - (fit.intercept + fit.slope * x.min))), 0);
    linearity = { slopePerMin: fit.slope, intercept: fit.intercept, worstDeviation: worst };
  }

  // 「最后一次收到事件距今多久」—— mute 模式下这是区分「只是没事件」和「真断了」的关键辅助
  const lastEv = s.events.length ? s.events[s.events.length - 1].t : null;
  const quietFor = lastEv == null ? null : (Date.now() - lastEv) / 1000;

  hr('SOAK 结论');
  console.log(`  音频模式        ${silentMode ? C.y(modeLabel) : '实时音频'}`);
  console.log(`  运行时长        ${elapsedMin.toFixed(1)} 分钟（目标 ${minutes}）`);
  console.log(`  实发音频        ${audioSecSent.toFixed(1)}s（${rounds} 轮）`);
  console.log(`  最后事件距今    ${quietFor == null ? C.dim('—（全程未收到任何事件）') : quietFor.toFixed(0) + 's'}`);
  console.log(
    `  连接状态        ${
      interrupted
        ? C.r(`❌ 中断 kind=${interrupted.kind}${info ? ` code=${info.code} reason="${info.reason || '空'}"` : ''}`)
        : C.g('✅ 全程未被动断开')
    }`,
  );
  if (info) console.log(`  关闭详情        code=${info.code} reason="${info.reason || '空'}"`);
  console.log(`  收尾            ${finishedOk ? C.g('✅ finish-task 正常') : C.y('未走 finish（连接已断？）')}`);
  console.log(`  事件/心跳/定稿   ${snap.events} / ${snap.hb} / ${snap.finals}`);

  if (usage) {
    const perSec = snap.input / Math.max(1, audioSecSent);
    const perHour =
      (perSec * 3600 * 6) / 1e6 + (usage.output_tokens / Math.max(1, audioSecSent)) * 3600 * 4.5e-6;
    console.log(`  usage           ${JSON.stringify(usage)}`);
    console.log(`  实测 Token/s    ${C.c(perSec.toFixed(2))} ${C.dim('(与 rate 拟合值对照：7 还是 42)')}`);
    console.log(`  费用            ${yuan(tokenCost(usage))} → 外推 ${C.y('¥' + perHour.toFixed(3) + '/h')}`);
    if (perHour > 1.5) console.log(C.r('  ⚠ 已超过 PLAN 的 ¥1.5/h 门槛 —— 需 VAD 门控或换 paraformer-realtime-v2'));
    else console.log(C.g('  ✅ 在 PLAN 的 ¥1.5/h 门槛内'));
  }
  if (linearity) {
    console.log(
      `  计费线性性      ${C.c(linearity.slopePerMin.toFixed(1))} token/分钟，最大偏差 ${linearity.worstDeviation.toFixed(0)} ${C.dim('(偏差大 = 有隐藏累积)')}`,
    );
  } else {
    console.log(C.y('  计费线性性      样本不足（少于 2 分钟，未采到曲线）'));
  }

  // mute 模式下「没走 finish」不构成失败 —— 它的验收点只有「有没有被 idle 断开」
  const ok = silentMode === 'mute' ? !interrupted : !interrupted && finishedOk;
  return { ok, silent: silentMode, minutes: elapsedMin, audioSecSent, rounds, interrupted, closeInfo: info, samples, linearity, usage, events: snap };
}

// ─────────────────────────── main ───────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'all';
  const key = resolveKey(args);
  const model = typeof args.model === 'string' ? args.model : DEFAULT_MODEL;
  const endpoint =
    typeof args.workspace === 'string' ? beijingEndpoint(args.workspace) : typeof args.endpoint === 'string' ? args.endpoint : DEFAULT_ENDPOINT;
  const verbose = Boolean(args.verbose);
  const ctx = {
    key,
    model,
    endpoint,
    verbose,
    voice: args.voice,
    text: args.text,
    speed: args.speed,
    durations: args.durations,
    file: args.file,
    minutes: args.minutes,
    chunkSec: args.chunk,
    silent: args.silent,
    preflight: null,
  };

  console.log(C.b('\n  M1 探针 · 百炼 ASR'));
  console.log(C.dim(`  模型 ${model}\n  端点 ${endpoint}\n  时间 ${new Date().toISOString()}`));

  // 统一先做 HTTPS 预检 —— WebSocket 的错误是黑的，先定性再测
  const pf = await preflight(key);
  ctx.preflight = pf;
  if (pf.status === 401 || pf.status === 403) {
    console.log(C.r(`\n  ⛔ API Key 无效（HTTP ${pf.status}）—— 后续测试已跳过`));
    console.log(C.dim('     请到百炼控制台确认 Key，并确保已开通对应模型\n'));
    process.exit(1);
  }
  if (pf.status === 0) {
    console.log(C.y(`\n  ⚠ 网络不通：${pf.error}`));
    console.log(C.dim('     检查代理/防火墙能否访问 dashscope.aliyuncs.com\n'));
    process.exit(1);
  }
  if (pf.status !== 200) console.log(C.y(`\n  ⚠ HTTPS 预检返回意外状态 HTTP ${pf.status}，继续尝试\n`));

  const report = { startedAt: new Date().toISOString(), model, endpoint, results: {} };

  if (cmd === 'ping' || cmd === 'all') report.results.ping = await ping(ctx);
  if (cmd === 'recognize' || cmd === 'all') {
    report.results.recognize = await recognize(ctx);
    if (ctx.file) fileStats(report.results.recognize, report.results.recognize.audioSec || 0);
  }
  if (cmd === 'rate' || cmd === 'all') report.results.rate = await rate(ctx);
  // ⚠️ soak 刻意不进 all：它默认就是 30 分钟，不该被顺带触发
  if (cmd === 'soak') report.results.soak = await soak(ctx);

  if (!['ping', 'recognize', 'rate', 'soak', 'all'].includes(cmd)) {
    console.log(C.r(`\n未知子命令：${cmd}`));
    console.log('可用：ping | recognize | rate | soak | all');
    process.exit(1);
  }

  // 汇总
  hr('汇总');
  const totalCost = Object.values(report.results).reduce((a, r) => a + (r?.usage ? tokenCost(r.usage) : 0), 0);
  for (const [k, v] of Object.entries(report.results)) {
    console.log(`  ${k.padEnd(12)} ${v?.ok ? C.g('✅ 通过') : C.r('❌ 失败')}${v?.error ? C.dim('  ' + v.error) : ''}`);
  }
  console.log(`\n  本次总花费  ${C.y(yuan(totalCost))}`);
  console.log(C.dim('  ⚠ 本地估算 ≠ 控制台扣费；免费额度不计入'));

  report.finishedAt = new Date().toISOString();
  report.totalCostYuan = totalCost;
  saveOut(`${cmd}-${Date.now()}`, report);
}

main().catch((e) => {
  console.error(C.r(`\n致命错误：${e.stack || e.message}`));
  process.exit(1);
});
