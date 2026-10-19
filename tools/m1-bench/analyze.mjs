#!/usr/bin/env node
/**
 * 分析一次 recognize 的结果 JSON —— 真实素材跑完后的复盘工具。
 *
 *   node analyze.mjs               # 分析 out/ 里最新一次
 *   node analyze.mjs <文件>
 *   node analyze.mjs --all         # 列出全部并逐个摘要
 *
 * 关注的四件事（都是真实素材才暴露得出来的）：
 *   ① 草稿语言漂移 —— 草稿里 0 假名 + >0 汉字 = 蹦中文（模式 1/2/3 的致命伤）
 *   ② 空定稿       —— VAD 切出来的非语音段
 *   ③ 抖动频率     —— 模式 1 的闪烁频率（PLAN 门槛 ≤2 次/秒）
 *   ④ 成本外推     —— 真实内容的 ¥/小时
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  c: (s) => `\x1b[36m${s}\x1b[0m`,
};
const kana = (t) => ((t || '').match(/[\u3040-\u30ff]/g) || []).length;
const han = (t) => ((t || '').match(/[\u4e00-\u9fff]/g) || []).length;
const mss = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;

function analyze(file, { quiet = false } = {}) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const r = j.results?.recognize;
  if (!r) {
    console.log(C.y(`  ${path.basename(file)}: 没有 recognize 结果`));
    return null;
  }
  const sents = (r.sentences || []).sort((a, b) => a.id - b.id);
  const withFinal = sents.filter((s) => s.final != null);
  const empty = withFinal.filter((s) => !s.final.trim());
  const drafts = sents.flatMap((s) => s.drafts.map((d) => ({ id: s.id, final: s.final, ...d })));
  // 漂移 = 草稿里 0 假名 + 有汉字，且**不是定稿的前缀**。
  // 后者很重要：日语里有「私」「誰」「雑談」这种纯汉字词，它们合法，不是漂移。
  const drift = drafts.filter((d) => {
    if (!d.text || kana(d.text) > 0 || han(d.text) === 0) return false;
    if (d.final && d.final.trim().startsWith(d.text)) return false;
    return true;
  });
  const usage = r.usage || {};
  const audioSec = r.audioSec || (usage.duration ?? 0);

  const out = {
    file: path.basename(file),
    audioSec,
    sentences: withFinal.length,
    emptyFinals: empty.length,
    drafts: drafts.length,
    drift: drift.length,
    jitterPerSec: audioSec ? drafts.length / audioSec : 0,
    chars: withFinal.reduce((a, s) => a + s.final.length, 0),
    usage,
    costYuan: (usage.input_tokens * 6 + usage.output_tokens * 4.5) / 1e6,
    perHour: audioSec ? ((usage.input_tokens * 6 + usage.output_tokens * 4.5) / 1e6) * (3600 / audioSec) : 0,
  };

  if (quiet) {
    const flag = out.drift > 0 ? C.y('⚠') : C.g('✓');
    console.log(
      `  ${flag} ${out.file.padEnd(28)} ${out.audioSec.toFixed(0).padStart(4)}s  ` +
        `句${String(out.sentences).padStart(3)}  空${String(out.emptyFinals).padStart(2)}  ` +
        `漂移 ${String(out.drift).padStart(3)}/${String(out.drafts).padStart(3)}  ` +
        `抖动 ${out.jitterPerSec.toFixed(2)}/s  ${C.y('¥' + out.perHour.toFixed(3) + '/h')}`,
    );
    return out;
  }

  console.log(`\n${C.b('━'.repeat(70))}`);
  console.log(`${C.b('  复盘')}  ${path.relative(process.cwd(), file)}`);
  console.log(`${C.b('━'.repeat(70))}\n`);

  console.log(`  音频        ${audioSec.toFixed(1)}s`);
  console.log(`  定稿句数    ${withFinal.length}  ${C.dim(`（其中空句 ${empty.length}）`)}`);
  console.log(`  识别字数    ${out.chars}`);
  console.log(`  草稿事件    ${drafts.length}  →  ${C.c(out.jitterPerSec.toFixed(2))} 次/秒  ${out.jitterPerSec <= 2 ? C.g('✅ ≤2 通过') : C.r('❌ 超门槛')}`);

  // ① 语言漂移
  console.log(`\n  ${C.b('① 草稿语言漂移')}  ${C.dim('（草稿里 0 假名 + 有汉字 = 蹦中文）')}`);
  if (!drift.length) {
    console.log(`     ${C.g('✅ 无漂移')}`);
  } else {
    console.log(`     ${C.y(`⚠ ${drift.length}/${drafts.length} = ${((drift.length / drafts.length) * 100).toFixed(1)}%`)} 的草稿蹦中文 ${C.dim('（已排除纯汉字日语词）')}`);
    for (const d of drift.slice(0, 10)) console.log(`       句${String(d.id).padStart(3)}  ${C.y(JSON.stringify(d.text))}`);
    if (drift.length > 10) console.log(C.dim(`       … 还有 ${drift.length - 10} 条`));
  }

  // ② 空定稿
  console.log(`\n  ${C.b('② 空定稿')}  ${C.dim('（VAD 切出来的非语音段，需前端过滤）')}`);
  if (!empty.length) console.log(`     ${C.g('✅ 无')}`);
  else {
    console.log(`     ${C.y(`${empty.length} 句`)}：${empty.map((s) => mss(s.beginTime)).join('  ')}`);
  }

  // ③ 完整转写
  console.log(`\n  ${C.b('③ 完整转写')}\n`);
  let n = 0;
  for (const s of withFinal) {
    if (!s.final.trim()) {
      console.log(C.dim(`     ${mss(s.beginTime).padStart(6)}  ·（空）`));
      continue;
    }
    n++;
    console.log(`     ${C.dim(mss(s.beginTime).padStart(6))}  ${s.final}`);
  }

  // ④ 成本
  console.log(`\n  ${C.b('④ 成本')}`);
  console.log(`     Token     ${C.dim(JSON.stringify(usage))}`);
  if (audioSec) {
    console.log(`     本段       ${C.y('¥' + out.costYuan.toFixed(5))}`);
    console.log(`     外推       ${C.y('¥' + out.perHour.toFixed(3) + '/h')}  ${out.perHour <= 1.5 ? C.g('✅ ≤¥1.5/h 通过') : C.r('❌ 超门槛')}`);
    console.log(`     Token 率   ${(usage.input_tokens / audioSec).toFixed(2)} input/s  ${C.dim('（纯语音时测的是 12.52/s，低于它说明中间有停顿没计费）')}`);
  }
  console.log();
  return out;
}

/** 挑出真正含 recognize 结果的最新文件（按文件名里的时间戳数值排，不按字母序） */
function newestRecognize() {
  if (!fs.existsSync(OUT)) return null;
  const ts = (f) => Number((f.match(/(\d{10,})/g) || ['0']).pop());
  const files = fs
    .readdirSync(OUT)
    .filter((f) => f.endsWith('.json'))
    .sort((a, b) => ts(b) - ts(a));
  for (const f of files) {
    try {
      if (JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8')).results?.recognize) return path.join(OUT, f);
    } catch {}
  }
  return null;
}

// ── CLI ──
function cli() {
  const args = process.argv.slice(2);
  if (args[0] === '--all') {
    if (!fs.existsSync(OUT)) return console.log(C.dim('\n  out/ 还是空的\n'));
    const files = fs.readdirSync(OUT).filter((f) => f.endsWith('.json')).map((f) => path.join(OUT, f)).sort();
    console.log(`\n${C.b('  全部记录')}  ${C.dim('（' + files.length + ' 次）')}\n`);
    for (const f of files) {
      try {
        analyze(f, { quiet: true });
      } catch (e) {
        console.log(C.r(`  ${path.basename(f)}  解析失败: ${e.message}`));
      }
    }
    console.log();
    return;
  }

  let file = args[0];
  if (!file) {
    file = newestRecognize();
    if (!file) return console.log(C.dim('\n  out/ 里没有 recognize 结果，先跑一次\n'));
  } else if (!path.isAbsolute(file)) {
    file = fs.existsSync(file) ? file : path.join(OUT, file);
  }
  analyze(file);
}

cli();
