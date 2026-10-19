#!/usr/bin/env node
/**
 * 提示词版本三方对比 —— 同一组句子，v1 / v2 / v3 各译一遍，并排看。
 *
 *   node compare.mjs                    # 用内置探针句 + 真实 ASR 句
 *   node compare.mjs --probe-only       # 只跑探针句（快，专打已知问题）
 *   node compare.mjs --real 6           # 只跑真实句里的前 6 条
 *   node compare.mjs --nofilter         # 关闭术语表过滤（对比 D98 的收益）
 *
 * 评判维度：
 *   · 假朋友 —— 专有探针句直接测（指針/検討/適当/迷惑/草/娘…）
 *   · 语气方向 —— とんでもない / やばい
 *   · 口语感 —— 用真实对话句看译文像不像中文
 *   · 延迟 / 术语命中率
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FALSE_FRIENDS, buildGlossary, filterGlossary, toFilteredPromptBlock } from './glossary.mjs';
import { PROMPTS, VERSIONS } from './prompts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, 'out');
const BASE = 'https://dashscope.aliyuncs.com';
const MODEL = 'qwen-flash';

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  c: (s) => `\x1b[36m${s}\x1b[0m`,
  m: (s) => `\x1b[35m${s}\x1b[0m`,
};

const key = (() => {
  if (process.env.DASHSCOPE_API_KEY) return process.env.DASHSCOPE_API_KEY;
  const p = path.join(HERE, '.env.local');
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').match(/=(.*)/)?.[1]?.trim();
  throw new Error('没有 API Key');
})();

// ─────────────────── 探针句：每条专打一个已知问题 ───────────────────
//
// ⚠️ 第一版探针失败了 —— 我给的都是**带上下文**的完整句（`指針に従って`），
// 结果三个版本全对。但真实失败的是 **裸片段**（`ビリビリの指針の話`）。
// 所以每条假朋友都配「易」（有上下文）/「难」（裸片段）两个版本。
// 重点看「难」那组 —— 那才是直播字幕的真实形态。
const PROBES = [
  // ── 易：有动词/语境消歧 ──
  { tag: '易 指針（に従って）', ja: 'ビリビリの指針に従って配信しますね。', want: '方针', bad: '指针' },
  { tag: '易 検討（してみます）', ja: 'ちょっと検討してみますね。', want: '讨论/研究', bad: '检讨' },
  { tag: '易 適当（にやっちゃった）', ja: 'もう適当にやっちゃいました。', want: '随便/敷衍', bad: '适当' },
  { tag: '易 迷惑（をおかけして）', ja: 'ご迷惑をおかけしてすみません。', want: '麻烦/困扰', bad: '迷惑' },

  // ── 难：裸片段，无消歧线索（直播字幕的真实形态）──
  { tag: '难 指針（の話）', ja: 'ビリビリの指針の話はさっきも言ったけど。', want: '方针/准则/规范', bad: '指针' },
  { tag: '难 検討（中です）', ja: '今検討中です。', want: '讨论/研究/评估', bad: '检讨' },
  { tag: '难 適当（なこと言わないで）', ja: '適当なこと言わないでよ。', want: '随便/瞎说/不负责任', bad: '适当' },
  { tag: '难 迷惑（な話）', ja: 'それは迷惑な話だよね。', want: '麻烦/困扰/过分', bad: '迷惑' },
  { tag: '难 我慢（できない）', ja: 'もう我慢できない。', want: '忍/撑', bad: '我慢' },
  { tag: '难 勝手（にしないで）', ja: '勝手にしないでよ。', want: '自作主张/擅自', bad: '胜手' },
  { tag: '难 遠慮（しないで）', ja: '遠慮しないでね。', want: '客气/拘谨', bad: '远虑' },
  { tag: '难 無理（しないで）', ja: '無理しないでね。', want: '勉强/硬撑', bad: '无理' },
  { tag: '难 面倒（くさい）', ja: 'あー、面倒くさい。', want: '麻烦/烦', bad: '面倒' },
  { tag: '难 大変（な一日）', ja: '大変な一日だったよ。', want: '辛苦/不容易/糟糕', bad: '大变' },
  { tag: '难 草（単独）', ja: 'そのコメント草。', want: '笑死/哈哈哈', bad: '草' },
  { tag: '难 娘（の話）', ja: 'うちの娘の話なんだけど。', want: '女儿', bad: '娘' },
  { tag: '难 愛人（がいる）', ja: '愛人がいるって噂。', want: '情人/小三', bad: '爱人' },

  // ── 语气 / 语义 ──
  { tag: '语气 とんでもない', ja: 'え、6000人来てくれたの？とんでもないよ。', want: '惊叹/褒义', bad: '离谱' },
  { tag: '语气 やばい', ja: 'この曲やばくない？めっちゃ好き。', want: '褒义', bad: '' },
  { tag: '动词语义 乗る', ja: 'エヴァの初号機に乗ってみたいな。', want: '驾驶/坐', bad: '骑' },
  { tag: '半句 不许补完', ja: '昨日はちょっと寝不足でして、今日はのんびり', want: '悬空', bad: '' },
  { tag: '填充词', ja: 'なんか、あの、今日はなんかすごいことになってるんですけど。', want: '轻带/省略', bad: '' },
  { tag: '口语感', ja: 'ええ、でも、ありがとう、本当に。', want: '自然口语', bad: '' },
];

// ─────────────────── 翻译调用 ───────────────────

let GLOSSARY_ALL = null;
let STATS = { hit: 0, total: 0, sendLen: 0 };

async function translate(ja, version, useFilter = true) {
  const sysParts = [PROMPTS[version]];
  if (useFilter) {
    const { block, hit, total } = toFilteredPromptBlock(ja, { falseFriends: true, streamTerms: true });
    STATS.hit += hit;
    STATS.total += total;
    sysParts.push(block);
  } else {
    GLOSSARY_ALL ||= buildGlossary({ falseFriends: true, streamTerms: true });
    const lines = GLOSSARY_ALL.map((t) => `  ${t.source} → ${t.target}`);
    sysParts.push(`\n\n【术语表 · 必须严格遵守】\n${lines.join('\n')}`);
  }
  const sys = sysParts.join('');
  STATS.sendLen += sys.length;

  const t = Date.now();
  const r = await fetch(`${BASE}/compatible-mode/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: ja },
      ],
      temperature: 0.1,
      enable_thinking: false, // ⚠️ 必需（D87）
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`HTTP ${r.status} ${JSON.stringify(j).slice(0, 150)}`);
  return { text: String(j.choices?.[0]?.message?.content ?? '').trim(), ms: Date.now() - t };
}

// ─────────────────── 真实句子 ───────────────────

function newestRecognize() {
  if (!fs.existsSync(OUT_DIR)) return null;
  const ts = (f) => Number((f.match(/(\d{10,})/g) || ['0']).pop());
  const files = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.json')).sort((a, b) => ts(b) - ts(a));
  for (const f of files) {
    try {
      if (JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), 'utf8')).results?.recognize) return path.join(OUT_DIR, f);
    } catch {}
  }
  return null;
}

function realSentences(limit) {
  const f = newestRecognize();
  if (!f) return [];
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  return (j.results.recognize.sentences || [])
    .filter((s) => s.final && s.final.trim())
    .sort((a, b) => a.id - b.id)
    .slice(0, limit)
    .map((s) => ({ tag: '真实', ja: s.final.trim() }));
}

// ─────────────────── 主流程 ───────────────────

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
  const useFilter = !args.nofilter;
  const onlyProbe = !!args['probe-only'];
  const realLimit = args.real ? Number(args.real) : onlyProbe ? 0 : 4;

  const cases = onlyProbe ? PROBES : [...PROBES, ...realSentences(realLimit)];

  console.log(`\n${'━'.repeat(96)}`);
  console.log(`  ${C.b('提示词三方对比')}  模型 ${C.c(MODEL)}   版本 ${VERSIONS.map((v) => C.m(v)).join(' / ')}`);
  console.log(`  术语表 ${useFilter ? C.g('按输入过滤（D98）') : C.y('全量注入')}   用例 ${cases.length} 条`);
  console.log(`${'━'.repeat(96)}`);

  const rows = [];
  for (const c of cases) {
    const out = {};
    for (const v of VERSIONS) {
      try {
        out[v] = await translate(c.ja, v, useFilter);
      } catch (e) {
        out[v] = { text: 'ERR: ' + e.message, ms: 0 };
      }
    }
    rows.push({ ...c, out });

    // 打印
    console.log(`\n${C.b('▍' + c.tag)}`);
    console.log(`  ${C.dim('日')} ${c.ja}`);
    for (const v of VERSIONS) {
      const { text, ms } = out[v];
      let mark = ' ';
      if (c.bad) {
        // 命中"反面模式"就报警
        if (text.includes(c.bad)) mark = C.r('✗');
        else if (c.want && c.want.split('/').some((w) => text.includes(w))) mark = C.g('✓');
        else mark = C.y('?');
      }
      console.log(`  ${mark} ${C.m(v)} ${C.dim(String(ms).padStart(4) + 'ms')}  ${text}`);
    }
  }

  // 汇总
  console.log(`\n${'━'.repeat(96)}`);
  console.log(`  ${C.b('延迟')}`);
  for (const v of VERSIONS) {
    const ms = rows.map((r) => r.out[v].ms).filter(Boolean);
    const avg = ms.reduce((a, b) => a + b, 0) / Math.max(1, ms.length);
    console.log(`    ${C.m(v)}  ${C.c(avg.toFixed(0) + 'ms')}  (最快 ${Math.min(...ms)} / 最慢 ${Math.max(...ms)})`);
  }

  console.log(`\n  ${C.b('术语表')}  命中 ${C.g(STATS.hit)} / ${STATS.total} 条次  ` +
    `平均每次发送 ${C.c(Math.round(STATS.sendLen / (rows.length * VERSIONS.length)))} 字符`);

  console.log(`\n  ${C.b('假朋友探针得分')} ${C.dim('（只看带 ✓ 判定的行）')}`);
  for (const v of VERSIONS) {
    const judged = rows.filter((r) => r.bad);
    let pass = 0;
    for (const r of judged) {
      const t = r.out[v].text;
      if (!t.includes(r.bad) && r.want.split('/').some((w) => t.includes(w))) pass++;
    }
    const bar = '█'.repeat(pass) + '░'.repeat(judged.length - pass);
    console.log(`    ${C.m(v)}  ${C.c(pass + '/' + judged.length)}  ${bar}`);
  }

  // 分「易 / 难」两组单独统计 —— 这是本轮实验的核心
  const easy = rows.filter((r) => r.tag.startsWith('易 ') && r.bad);
  const hard = rows.filter((r) => r.tag.startsWith('难 ') && r.bad);
  const score = (group, v) =>
    group.filter((r) => {
      const t = r.out[v].text;
      return !t.includes(r.bad) && r.want.split('/').some((w) => t.includes(w));
    }).length;
  if (easy.length && hard.length) {
    console.log(`\n  ${C.b('易 / 难 分开算')} ${C.dim('（难 = 裸片段，直播字幕的真实形态）')}`);
    for (const v of VERSIONS) {
      const e = score(easy, v);
      const h = score(hard, v);
      console.log(
        `    ${C.m(v)}  易 ${C.c(e + '/' + easy.length)}  ` +
          `难 ${h === hard.length ? C.g(h + '/' + hard.length) : C.y(h + '/' + hard.length)}  ` +
          `${'█'.repeat(h)}${'░'.repeat(hard.length - h)}`,
      );
    }
  }
  console.log();

  const outFile = path.join(OUT_DIR, `compare-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ model: MODEL, filter: useFilter, rows }, null, 2));
  console.log(`  结果 → ${C.dim(path.relative(process.cwd(), outFile))}\n`);
}

main().catch((e) => {
  console.error(C.r(`\n  致命错误：${e.stack || e.message}\n`));
  process.exit(1);
});
