#!/usr/bin/env node
/**
 * 字幕生成 —— 拿真实 ASR 输出走一遍翻译，产出中日对照。
 *
 *   node subtitle.mjs                          # 用最新一次 recognize 结果
 *   node subtitle.mjs --file out/xxx.json
 *   node subtitle.mjs --engine qwen-flash --glossary "スパチャ=SC,歌枠=歌回"
 *   node subtitle.mjs --draft                  # 额外演示「流式草稿逐帧翻译」
 *
 * 用途：人工审阅译文质量（CER 之外的「读起来对不对」），对照真实人工翻译找问题。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildGlossary, toPromptBlock, STREAM_TERMS } from './glossary.mjs';

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
const mss = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;

const key = (() => {
  if (process.env.DASHSCOPE_API_KEY) return process.env.DASHSCOPE_API_KEY;
  const p = path.join(HERE, '.env.local');
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').match(/=(.*)/)?.[1]?.trim();
  throw new Error('没有 API Key');
})();

// ───────────────────────── 提示词 ─────────────────────────

/**
 * 直播字幕体的系统提示词（v2 —— 针对 2026-10-16 首轮实测暴露的三个问题定向修正）。
 *
 * v1 的问题：
 *   ① 汉字假朋友：`指針` → 「指针」（应为「规范」）—— 最严重，因为读起来毫无破绻
 *   ② 加词：凭空生成「随便怎么拍都行」
 *   ③ 语气方向错：`とんでもない`（褒义惊叹）→ 「离谱」（贬义）
 */
const SUBTITLE_SYSTEM = `你是 VTuber 直播的日语→简体中文同传字幕翻译。

【输出格式】
只输出中文译文。不要解释、不要引号、不要罗马音、不要重复原文。

【最高优先级：汉字假朋友】
日语里大量汉字词与中文**长得一样、意思完全不同**。
遇到这类词，**必须按日语原意译，绝不能按中文读法直译**。
例：「指針」是方针/准则而不是指针，「検討」是讨论而不是检讨，「適当」是随便而不是适当。
下面给了术语表，表里的词必须严格遵守；表外遇到拿不准的汉字词，**宁可意译或加括号注原文，也不要硬直译**。

【不要加词】
不要添加原文没有的词、语气词、修饰语。
不要为了让句子完整而补主语、补谓语、补结论。
原文是半句 / 语病 / 口误，译文就照实保留不完整的语感。
唯一例外：中文语序必须补的助词（如「的」「了」「吗」）可以加。

【语气方向要准确】
分辨说话人的情绪是褒是贬、是惊喜还是吐槽：
· 「とんでもない」在惊喜语境下 = 「太夸张了 / 简直不敢想」，**不是**「离谱」（贬义）
· 「やばい」可能是「太扯了」（贬）也可能是「超帅/超棒」（褒），看上下文
· 吐槽、装傻、撒娇的语气要保留，不要磨平成平淡陈述
用「诶」「欸」「啊」「嘛」自然对应「え」「あ」「なんか」这类口语填充词，但不要滥用。

【其他】
· 专有名词按术语表译；没有的日本人名/作品名，用约定俗成译法或保留原文
· 不要省略原文说了的内容`;

/** 从 --glossary "a=b,c=d" 或内置表构建术语表文本块 */
function glossaryBlock(spec) {
  // 内置：直播固定译法 + 同形异义词（D22 的核心价值）
  const blocks = [toPromptBlock({ falseFriends: true, streamTerms: true })];

  // 用户额外的
  if (spec) {
    const pairs = String(spec)
      .split(',')
      .map((s) => s.split('='))
      .filter((p) => p.length === 2);
    if (pairs.length) {
      blocks.push(`\n\n【用户自定义术语】\n${pairs.map(([j, z]) => `  ${j.trim()} → ${z.trim()}`).join('\n')}`);
    }
  }
  return blocks.join('');
}

/** 构建给 MT 用的 terms 数组（MT 走结构化术语表，不是提示词） */
function mtTerms(spec) {
  const terms = buildGlossary({ falseFriends: true, streamTerms: true });
  if (spec) {
    for (const p of String(spec).split(',')) {
      const [j, z] = p.split('=');
      if (j && z) terms.push({ source: j.trim(), target: z.trim() });
    }
  }
  return terms;
}

// ───────────────────────── 翻译调用 ─────────────────────────

async function translate(text, { engine, glossary }) {
  const sys = SUBTITLE_SYSTEM + glossaryBlock(glossary);
  const t = Date.now();

  if (engine.startsWith('qwen-mt')) {
    // MT 走原生端点 + translation_options（D90：不带它会拒绝翻译）
    const terms = mtTerms(glossary);
    const r = await fetch(`${BASE}/api/v1/services/aigc/text-generation/generation`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: engine,
        input: { messages: [{ role: 'user', content: text }] },
        parameters: {
          translation_options: { source_lang: 'Japanese', target_lang: 'Chinese', terms },
        },
      }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
    const out = j.output?.choices?.[0]?.message?.content ?? j.choices?.[0]?.message?.content ?? '';
    return { text: String(out).trim(), ms: Date.now() - t, usage: j.usage };
  }

  const r = await fetch(`${BASE}/compatible-mode/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: engine,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: text },
      ],
      temperature: 0.1,
      enable_thinking: false, // ⚠️ 必需（D87）
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  const out = j.choices?.[0]?.message?.content ?? '';
  return { text: String(out).trim(), ms: Date.now() - t, usage: j.usage };
}

// ───────────────────────── 素材 ─────────────────────────

function newestRecognize() {
  if (!fs.existsSync(OUT_DIR)) return null;
  const ts = (f) => Number((f.match(/(\d{10,})/g) || ['0']).pop());
  const files = fs
    .readdirSync(OUT_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort((a, b) => ts(b) - ts(a));
  for (const f of files) {
    try {
      if (JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), 'utf8')).results?.recognize) return path.join(OUT_DIR, f);
    } catch {}
  }
  return null;
}

function loadSentences(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const r = j.results?.recognize;
  if (!r) throw new Error('这个文件里没有 recognize 结果');
  return (r.sentences || [])
    .sort((a, b) => a.id - b.id)
    .filter((s) => s.final && s.final.trim()) // D92：空定稿必须过滤
    .map((s) => ({ id: s.id, begin: s.beginTime, end: s.endTime, ja: s.final.trim(), drafts: s.drafts || [] }));
}

// ───────────────────────── 主流程 ─────────────────────────

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      o[k] = v;
    } else o._.push(argv[i]);
  }
  return o;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const engine = args.engine || 'qwen-flash';
  const glossary = args.glossary || '';
  let file = args.file;
  if (!file) file = newestRecognize();
  if (!file) {
    console.error(C.r('\n  ❌ 找不到 recognize 结果，先跑一次 probe.mjs recognize --file ...\n'));
    process.exit(1);
  }
  if (!path.isAbsolute(file)) file = path.join(OUT_DIR, path.basename(file));

  const sents = loadSentences(file);
  if (!sents.length) {
    console.error(C.r('\n  ❌ 这个结果里没有非空定稿\n'));
    process.exit(1);
  }

  console.log(`\n${C.b('━'.repeat(78))}`);
  console.log(`  ${C.b('字幕生成')}  ${C.dim(path.basename(file))}`);
  console.log(`  引擎 ${C.c(engine)}   句子 ${sents.length} 条${glossary ? `   术语表 ${C.m(glossary)}` : ''}`);
  console.log(`${C.b('━'.repeat(78))}`);
  console.log(C.dim('\n  逐句翻译中…\n'));

  const out = [];
  let totalMs = 0;
  for (const s of sents) {
    let zh = '';
    let ms = 0;
    let err = null;
    try {
      const r = await translate(s.ja, { engine, glossary });
      zh = r.text;
      ms = r.ms;
      totalMs += ms;
    } catch (e) {
      err = e.message;
    }
    out.push({ ...s, zh, ms, err });

    const tag = err ? C.r('✗') : C.g('✓');
    console.log(`  ${tag} ${C.dim(mss(s.begin).padStart(5))}  ${C.dim(String(ms) + 'ms')}`);
    console.log(`      ${C.dim('日')}  ${s.ja}`);
    console.log(`      ${C.dim('中')}  ${err ? C.r(err) : C.c(zh)}`);
    console.log();
  }

  // 流式草稿演示
  if (args.draft) {
    const target = sents.find((s) => (s.drafts || []).length >= 4) || sents[0];
    const ds = (target.drafts || []).map((d) => d.text).filter((t, i, a) => t && t !== a[i - 1]);
    console.log(`${C.b('━'.repeat(78))}`);
    console.log(`  ${C.b('流式草稿逐帧翻译')}  ${C.dim('（模式 1/2 的观感 —— 看会推翻什么）')}`);
    console.log(`${C.b('━'.repeat(78))}\n`);
    console.log(`  原句 ${C.c(target.ja)}\n`);
    let prev = '';
    for (const d of ds.slice(-8)) {
      try {
        const r = await translate(d, { engine, glossary });
        // 与上一帧的最长公共前缀，看推翻程度
        let lcp = 0;
        while (lcp < prev.length && lcp < r.text.length && prev[lcp] === r.text[lcp]) lcp++;
        const kept = prev ? (lcp / Math.max(1, prev.length)) * 100 : 0;
        const flag = !prev ? C.dim('首帧') : kept >= 70 ? C.g(`保持 ${kept.toFixed(0)}%`) : kept >= 40 ? C.y(`推翻 ${(100 - kept).toFixed(0)}%`) : C.r(`大改 ${(100 - kept).toFixed(0)}%`);
        console.log(`   ${flag.padEnd(20)} ${C.dim(d)}`);
        console.log(`   ${' '.repeat(20)} ${C.m(r.text)}`);
        prev = r.text;
      } catch (e) {
        console.log(`   ${C.r('✗')} ${d}  ${C.r(e.message)}`);
      }
    }
    console.log();
  }

  // 存盘
  const outFile = path.join(OUT_DIR, `subtitle-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ engine, glossary, source: path.basename(file), items: out }, null, 2));
  console.log(`${C.b('━'.repeat(78))}`);
  console.log(`  平均延迟 ${C.c((totalMs / Math.max(1, out.length)).toFixed(0) + 'ms')}   结果 → ${C.dim(path.relative(process.cwd(), outFile))}\n`);
}

main().catch((e) => {
  console.error(C.r(`\n  致命错误：${e.stack || e.message}\n`));
  process.exit(1);
});
