#!/usr/bin/env node
/**
 * M1 · P5 翻译引擎基准
 *
 * 要回答的问题（PLAN §5.5）：
 *   日语是 SOV，谓语在**句尾**。ASR 是流式的，会先给出「昨日はちょっと寝不足でして、今日は」
 *   这种**没有谓语**的半句。此时：
 *     · 专用 MT  → 会**硬编一个谓语**把中文补成完整句，等真谓语来了再整句推翻
 *     · 小 LLM   → 能留半句不撒谎（"昨天有点没睡够，今天…"）
 *   §5.5 的结论是：**MT 那种「流畅的错误」比 LLM 的「明显未完成」更危险**。
 *
 * 本脚本用逐字前缀模拟流式 ASR，逐级翻译，量化「推翻率」与「同传体」表现。
 *
 *   node translate.mjs            对比默认引擎组
 *   node translate.mjs --engines qwen-mt-flash,qwen-flash
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, 'out');
const BASE = 'https://dashscope.aliyuncs.com';

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  c: (s) => `\x1b[36m${s}\x1b[0m`,
  m: (s) => `\x1b[35m${s}\x1b[0m`,
};
const hr = (t) => console.log(`\n${C.b('━'.repeat(78))}\n${C.b(t)}\n${C.b('━'.repeat(78))}`);

const key = (() => {
  if (process.env.DASHSCOPE_API_KEY) return process.env.DASHSCOPE_API_KEY;
  const p = path.join(HERE, '.env.local');
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').match(/=(.*)/)?.[1]?.trim();
  throw new Error('没有 API Key');
})();

// ───────────────────────── 引擎定义 ─────────────────────────

/**
 * 同传体系统提示词。
 * 关键约束：「谓语还没出现时，不要编一个出来」—— 这正是 §5.5 里 LLM 相对 MT 的优势所在。
 */
const SIMUL_SYSTEM = `你是日语→简体中文的实时同声传译引擎，输入是语音识别到一半的**不完整**日语句子。

规则：
1. 只输出中文译文，不要解释、不要引号、不要重复原文。
2. 输入不完整时，**只翻译已确定的部分，绝不补全或猜测未说出的内容**。
3. 如果句子还没有谓语，就输出一个悬空的半句（例如「昨天有点没睡够，今天……」），这是正确行为。
4. 不要为了读起来通顺而添加原文没有的词。`;

const ENGINES = {
  'qwen-mt-flash': {
    kind: 'MT',
    call: (text) =>
      post(`${BASE}/api/v1/services/aigc/text-generation/generation`, {
        model: 'qwen-mt-flash',
        input: { messages: [{ role: 'user', content: text }] },
        parameters: { translation_options: { source_lang: 'Japanese', target_lang: 'Chinese' } },
      }),
  },
  'qwen-mt-lite': {
    kind: 'MT',
    call: (text) =>
      post(`${BASE}/api/v1/services/aigc/text-generation/generation`, {
        model: 'qwen-mt-lite',
        input: { messages: [{ role: 'user', content: text }] },
        parameters: { translation_options: { source_lang: 'Japanese', target_lang: 'Chinese' } },
      }),
  },
  'qwen-flash': {
    kind: 'LLM',
    call: (text) =>
      post(`${BASE}/compatible-mode/v1/chat/completions`, {
        model: 'qwen-flash',
        messages: [
          { role: 'system', content: SIMUL_SYSTEM },
          { role: 'user', content: text },
        ],
        temperature: 0.1,
      }),
  },
  'qwen3.5-flash': llm('qwen3.5-flash'),
  'qwen3.6-flash': llm('qwen3.6-flash'),
  'qwen3.7-flash': llm('qwen3.7-flash'),
  'qwen3.8-flash': llm('qwen3.8-flash'),
};

/**
 * LLM 引擎工厂。
 * ⚠️ `enable_thinking: false` 是**必须的** —— 实测默认开启思考会导致 8–30 秒延迟，
 * 实时字幕场合完全不可用（qwen3.5-flash: 30025ms → 560ms，差 54 倍）。
 */
function llm(model) {
  return {
    kind: 'LLM',
    call: (text) =>
      post(`${BASE}/compatible-mode/v1/chat/completions`, {
        model,
        messages: [
          { role: 'system', content: SIMUL_SYSTEM },
          { role: 'user', content: text },
        ],
        temperature: 0.1,
        enable_thinking: false,
      }),
  };
}

async function post(url, body) {
  const t = Date.now();
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const ms = Date.now() - t;
  const txt = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} ${txt.slice(0, 200)}`);
  const j = JSON.parse(txt);
  const out = j.choices?.[0]?.message?.content ?? j.output?.choices?.[0]?.message?.content ?? '';
  const usage = j.usage ?? (j.usage ? null : null);
  return { text: String(out).trim(), ms, usage };
}

// ───────────────────────── 测试素材 ─────────────────────────

/**
 * 精心构造：谓语在最后，前面全是状语从句。
 * 前缀越短，越考验「会不会硬编一个谓语」。
 */
const CASE = {
  ja: '昨日はちょっと寝不足でして、今日はのんびりやっていこうかなと思っています。',
  /** 完整参考译文（人写） */
  ref: '昨天有点没睡够，今天打算轻松一点播。',
};

/** 生成逐字前缀序列（模拟 ASR 的 progressive 输出） */
function prefixes(ja) {
  const chars = [...ja];
  const out = [];
  // 从第 3 个字开始，每 3 个字推进一次（避免调用次数爆炸）
  for (let n = 3; n <= chars.length; n += 3) out.push(chars.slice(0, n).join(''));
  if (out[out.length - 1] !== ja) out.push(ja);
  return out;
}

// ───────────────────────── 指标 ─────────────────────────

/** 最长公共前缀长度 */
function lcp(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * 中文「真的说完了」的标记。
 * ⚠️ 刻意**不包含 `…`** —— 「今天……」是**诚实的悬空**，正是我们想要的同传体，
 * 不能和「今天就悠闲地过吧。」这种**硬编出来的完整句**混为一谈。
 */
const SENT_CLOSED = /[。！？]$/;
/** 悬空标记：省略号，或干脆没有任何句末标点 */
const SENT_DANGLING = /[….．·]?$/;

/**
 * 日语「谓语已出现」的粗略判据。
 * 半句（没谓语）时若中文输出了句号结尾 → 说明模型**编了一个谓语**。
 */
function jaLooksComplete(ja) {
  return /(です|ます|でした|ました|ている|ています|と思う|と思っています|かな|だ|た|る|い|ね|よ)[。、！？]?$/.test(ja);
}

/**
 * 推翻率：上一条译文有多少被这一条**丢弃**。
 * 用最长公共前缀算，1 - lcp(prev,curr)/len(prev)。
 * 0 = 完全保留，1 = 整个推翻。
 */
function overturn(prev, curr) {
  if (!prev) return 0;
  const common = lcp(prev, curr);
  // 丢弃的部分 = 上一条译文中，不在公共前缀里的字数
  return (prev.length - common) / prev.length;
}

// ───────────────────────── 跑一个引擎 ─────────────────────────

async function bench(name, spec, prefs) {
  console.log(`\n  ${C.b(name)}  ${C.dim(`[${spec.kind}]`)}`);

  const rows = [];
  let prev = '';
  for (const p of prefs) {
    let r;
    try {
      r = await spec.call(p);
    } catch (e) {
      console.log(`    ${C.r('❌ ' + e.message)}`);
      return null;
    }
    const ot = overturn(prev, r.text);
    const closed = SENT_CLOSED.test(r.text);
    const jaComplete = jaLooksComplete(p);
    // 「硬编」= 日语谓语还没出现，中文却已经写成完整句（以。！？结尾）
    // 「悬空」= 日语未完成，中文也是开放结尾（…… 或无标点）—— 这是**正确**行为
    const fabricated = !jaComplete && closed;
    const dangling = !jaComplete && !closed;

    rows.push({ ja: p, zh: r.text, ms: r.ms, overturn: ot, closed, jaComplete, fabricated, dangling, usage: r.usage });
    prev = r.text;

    const flag = fabricated ? C.r(' ⚠硬编谓语') : dangling ? C.g(' ◦悬空(诚实)') : '';
    console.log(
      `    ${String(r.ms).padStart(4)}ms  推翻${C.m((ot * 100).toFixed(0).padStart(3) + '%')}  ${C.dim(p.slice(-14).padEnd(15))} → ${r.text}${flag}`,
    );
    await sleep(120);
  }

  // 汇总
  const withPrev = rows.slice(1);
  const avgMs = rows.reduce((a, r) => a + r.ms, 0) / rows.length;
  const avgOt = withPrev.length ? withPrev.reduce((a, r) => a + r.overturn, 0) / withPrev.length : 0;
  const fabricated = rows.filter((r) => r.fabricated).length;
  const dangling = rows.filter((r) => r.dangling).length;
  const maxOt = Math.max(...withPrev.map((r) => r.overturn), 0);

  console.log(
    `    ${C.dim('──')} 平均延迟 ${C.c(avgMs.toFixed(0) + 'ms')}  平均推翻率 ${C.m((avgOt * 100).toFixed(1) + '%')}  最大推翻 ${(maxOt * 100).toFixed(0)}%  硬编谓语 ${C.r(`${fabricated}/${rows.length}`)}  诚实悬空 ${C.g(`${dangling}`)}`,
  );

  return { name, kind: spec.kind, rows, avgMs, avgOt, maxOt, fabricated, dangling };
}

function total(s) {
  return s && s.length;
}

// ───────────────────────── main ─────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const getArg = (k) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const names = (getArg('--engines') || Object.keys(ENGINES).join(',')).split(',').map((s) => s.trim());

  console.log(C.b('\n  M1 · P5 翻译引擎基准 —— 推翻率与同传体'));
  console.log(C.dim(`  日语原文  ${CASE.ja}`));
  console.log(C.dim(`  参考译文  ${CASE.ref}`));

  const prefs = prefixes(CASE.ja);
  console.log(C.dim(`  前缀序列  ${prefs.length} 级（模拟流式 ASR 的 progressive 输出）`));

  const results = [];
  for (const n of names) {
    if (!ENGINES[n]) {
      console.log(C.y(`\n  跳过未知引擎 ${n}`));
      continue;
    }
    const r = await bench(n, ENGINES[n], prefs);
    if (r) results.push(r);
  }

  // 对比
  hr('对比结论');
  console.log(
    `  ${'引擎'.padEnd(18)}${'类型'.padEnd(6)}${'平均延迟'.padEnd(10)}${'平均推翻率'.padEnd(12)}${'最大推翻'.padEnd(10)}硬编谓语`.padEnd(20),
  );
  console.log(`  ${'─'.repeat(72)}`);
  for (const r of results.sort((a, b) => a.avgOt - b.avgOt)) {
    console.log(
      `  ${r.name.padEnd(18)}${r.kind.padEnd(6)}${(r.avgMs.toFixed(0) + 'ms').padEnd(10)}${((r.avgOt * 100).toFixed(1) + '%').padEnd(12)}${((r.maxOt * 100).toFixed(0) + '%').padEnd(10)}${r.fabricated}/${r.rows.length}`,
    );
  }

  console.log(
    C.dim(`
  读法：
    · 「推翻率」= 上一条译文被本条丢弃的比例。越低越好 —— 高推翻意味着观众看到的字会被抹掉重写。
    · 「硬编谓语」= 日语谓语还没出现，中文却写成完整句（。！？结尾）。**这是 §5.5 最担心的失败模式**：
      流畅的错误比明显的未完成更危险，因为观众会先信了再被推翻。
    · MT 预期：延迟低、推翻率高、硬编谓语多。LLM 预期：延迟略高、推翻率低、不硬编。`),
  );

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const f = path.join(OUT_DIR, `translate-${Date.now()}.json`);
  fs.writeFileSync(f, JSON.stringify({ case: CASE, results }, null, 2));
  console.log(C.dim(`\n  结果已存 → ${path.relative(process.cwd(), f)}`));
}

main().catch((e) => {
  console.error(C.r(`\n致命错误：${e.stack || e.message}`));
  process.exit(1);
});
