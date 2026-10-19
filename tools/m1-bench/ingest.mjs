#!/usr/bin/env node
/**
 * M1 素材摄取 —— 把 B 站视频/录播的音频抓成本地 16kHz 单声道 PCM。
 *
 *   node ingest.mjs <b站链接> [--name 歌回A] [--start 30] [--dur 120]
 *   node ingest.mjs --list         列出已抓取的素材
 *
 * 走 B 站官方 JSON API，**不走网页**（网页会返回 HTTP 412 反爬）。
 * 零外部依赖：Node 内置 fetch + macOS 自带 afconvert。
 *
 * ⚠️ 产物一律落在 audio/ 下，该目录已 gitignore。
 *    抓来的音频**仅用于本地基准测试，永不提交**（版权）。
 *    这不是产品功能 —— PLAN D17 明确不做录播/投稿视频支持，此脚本只服务于 M1 评测。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { wavToPcm, secToBytes, bytesToSec, RATE } from './lib/audio.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = path.join(HERE, 'audio');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com';
/** 少数需要登录的内容才用得上；默认不带 */
const COOKIE = process.env.BILI_COOKIE || '';

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  c: (s) => `\x1b[36m${s}\x1b[0m`,
};
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const H = (t) => ({ 'User-Agent': UA, Referer: REFERER, ...(COOKIE ? { Cookie: COOKIE } : {}) });

/** 从各种 B 站 URL 形态里抠出 BV 号 */
export function parseBvid(url) {
  const m = String(url).match(/(BV[0-9A-Za-z]{10})/);
  if (m) return m[1];
  const av = String(url).match(/\/av(\d+)/i);
  if (av) return `av${av[1]}`;
  return null;
}

async function api(pathname) {
  const r = await fetch(`https://api.bilibili.com${pathname}`, { headers: H() });
  if (!r.ok) throw new Error(`API HTTP ${r.status}`);
  const j = await r.json();
  if (j.code !== 0) throw new Error(`API code=${j.code} ${j.message || ''}`);
  return j.data;
}

// ───────────────────────── 主流程 ─────────────────────────

async function grab(url, { name, start = 0, dur = 180 } = {}) {
  const bvid = parseBvid(url);
  if (!bvid) {
    console.error(C.r(`  ❌ 从链接里找不到 BV 号：${url}`));
    process.exit(1);
  }

  // ① 元信息
  console.log(C.b('\n  ① 读取视频信息'));
  let info;
  try {
    info = await api(`/x/web-interface/view?bvid=${bvid}`);
  } catch (e) {
    console.error(C.r(`  ❌ ${e.message}`));
    process.exit(1);
  }
  console.log(`  标题  ${C.c(info.title)}`);
  console.log(`  UP    ${info.owner.name}`);
  console.log(`  时长  ${mmss(info.duration)} ${C.dim(`(${info.duration}s)`)}`);
  console.log(`  分区  ${C.dim(info.tname || '—')}`);
  console.log(`  发布  ${C.dim(new Date(info.pubdate * 1000).toISOString().slice(0, 10))}`);

  // ② 音频流
  console.log(C.b('\n  ② 取 DASH 音频流'));
  let streams;
  try {
    const d = await api(`/x/player/playurl?bvid=${bvid}&cid=${info.cid}&fnval=16&fourk=1`);
    streams = d.dash?.audio || [];
  } catch (e) {
    console.error(C.r(`  ❌ ${e.message}`));
    process.exit(1);
  }
  if (!streams.length) {
    console.error(C.r('  ❌ 没拿到音频流（可能需要登录 cookie，见 --help）'));
    process.exit(1);
  }
  streams.sort((a, b) => b.bandwidth - a.bandwidth);
  const best = streams[0];
  console.log(`  可选  ${streams.length} 条，码率 ${streams.map((s) => Math.round(s.bandwidth / 1000) + 'k').join(' / ')}`);
  console.log(`  选用  ${C.c(Math.round(best.bandwidth / 1000) + ' kbps')} ${C.dim(best.codecs || '')}`);

  // ③ 下载
  console.log(C.b('\n  ③ 下载音频'));
  const tmpDir = fs.mkdtempSync('/tmp/m1-ingest-');
  const rawPath = path.join(tmpDir, 'raw.m4s');
  const t0 = Date.now();
  const resp = await fetch(best.baseUrl, { headers: { 'User-Agent': UA, Referer: REFERER } });
  if (!resp.ok) {
    console.error(C.r(`  ❌ 下载失败 HTTP ${resp.status}`));
    process.exit(1);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(rawPath, buf);
  console.log(`  ${C.g('✅')} ${(buf.length / 1024 / 1024).toFixed(1)} MB  ${C.dim(((Date.now() - t0) / 1000).toFixed(1) + 's')}`);

  // ④ 转码
  console.log(C.b('\n  ④ 转码 → 16kHz 单声道 16bit'));
  const fullWav = path.join(tmpDir, 'full.wav');
  try {
    execFileSync('afconvert', ['-f', 'WAVE', '-d', `LEI16@${RATE}`, '-c', '1', rawPath, fullWav], { stdio: 'pipe' });
  } catch (e) {
    console.error(C.r(`  ❌ afconvert 失败：${e.stderr?.toString().slice(0, 200) || e.message}`));
    process.exit(1);
  }
  const pcm = wavToPcm(fs.readFileSync(fullWav));
  console.log(`  全片  ${bytesToSec(pcm.length).toFixed(1)}s`);

  // ⑤ 截取
  const total = bytesToSec(pcm.length);
  const realStart = Math.max(0, Math.min(start, total - 1));
  const realDur = Math.max(1, Math.min(dur, total - realStart));
  if (start + dur > total) {
    console.log(C.y(`  ⚠ 请求区间 ${mmss(start)}–${mmss(start + dur)} 超出时长，收窄为 ${mmss(realStart)}–${mmss(realStart + realDur)}`));
  }
  const from = Math.round(realStart * RATE) * 2;
  const slice = pcm.subarray(from, from + secToBytes(realDur));
  console.log(C.b('\n  ⑤ 截取片段'));
  console.log(`  区间  ${mmss(realStart)} → ${mmss(realStart + bytesToSec(slice.length))}   ${C.c(bytesToSec(slice.length).toFixed(2) + 's')}`);

  // ⑥ 落盘
  const safe = String(name || info.title).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 48);
  const outWav = path.join(AUDIO_DIR, `${safe}.wav`);
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  fs.writeFileSync(outWav, Buffer.concat([wavHeader(slice.length), slice]));

  // 顺带存一份元信息，方便后续对照
  fs.writeFileSync(
    outWav.replace(/\.wav$/, '.meta.json'),
    JSON.stringify(
      { bvid, title: info.title, uploader: info.owner.name, vDuration: info.duration, segStart: realStart, segDur: bytesToSec(slice.length), bitrate: best.bandwidth, grabbedAt: new Date().toISOString() },
      null,
      2,
    ),
  );

  console.log(C.b('\n  ⑥ 完成'));
  console.log(`  ${C.g('✅')} ${path.relative(process.cwd(), outWav)}  ${C.dim((fs.statSync(outWav).size / 1024).toFixed(0) + ' KB')}`);
  console.log(C.dim('     audio/ 已 gitignore，不会被提交'));

  fs.rmSync(tmpDir, { recursive: true, force: true });
  return outWav;
}

/** 手写 44 字节 WAV 头（16kHz / mono / 16bit） */
function wavHeader(dataLen) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataLen, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(dataLen, 40);
  return h;
}

function listAudio() {
  if (!fs.existsSync(AUDIO_DIR)) {
    console.log(C.dim('\n  audio/ 还是空的\n'));
    return;
  }
  const wavs = fs.readdirSync(AUDIO_DIR).filter((f) => f.endsWith('.wav')).sort();
  if (!wavs.length) {
    console.log(C.dim('\n  audio/ 还是空的\n'));
    return;
  }
  console.log(C.b('\n  已抓取的素材\n'));
  for (const f of wavs) {
    const p = path.join(AUDIO_DIR, f);
    const metaP = p.replace(/\.wav$/, '.meta.json');
    const meta = fs.existsSync(metaP) ? JSON.parse(fs.readFileSync(metaP, 'utf8')) : null;
    const secs = bytesToSec(wavToPcm(fs.readFileSync(p)).length);
    console.log(`  ${f.padEnd(46)} ${secs.toFixed(1).padStart(7)}s  ${C.dim(meta?.title || '')}`);
  }
  console.log();
}

// ───────────────────────── CLI ─────────────────────────

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

const args = parseArgs(process.argv.slice(2));
if (args.list) {
  listAudio();
} else if (args.help || !args._[0]) {
  console.log(`
${C.b('M1 素材摄取')} —— 抓 B 站音频成本地 16kHz PCM

  node ingest.mjs <b站链接> [选项]
  node ingest.mjs --list

选项
  --name <名字>   输出文件名（默认用视频标题，会被截断）
  --start <秒>    从第几秒开始截（默认 0）
  --dur <秒>      截多长（默认 180）

说明
  · 走官方 JSON API，不走网页（网页返回 HTTP 412 反爬）
  · 零依赖：Node 内置 fetch + macOS 自带 afconvert
  · 产物落在 audio/，已 gitignore，仅本地测试用，永不提交
  · 需要登录的内容可用环境变量带 cookie：
      BILI_COOKIE='SESSDATA=...; bili_jct=...' node ingest.mjs <链接>
`);
} else {
  grab(args._[0], { name: args.name, start: Number(args.start || 0), dur: Number(args.dur || 180) }).catch((e) => {
    console.error(C.r(`\n  致命错误：${e.stack || e.message}\n`));
    process.exit(1);
  });
}
