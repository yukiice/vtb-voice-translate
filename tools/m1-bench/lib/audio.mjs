/**
 * M1 音频工具 —— 用 macOS 内置的 say + afconvert 合成日语测试音频。
 * 零外部依赖（不需要 ffmpeg / sox / pip）。
 *
 * 约定：所有音频都是 16kHz · 单声道 · 16bit 小端 PCM，
 * 与 qwen-audio-3.1-asr-flash-message 的 `format=pcm, sample_rate=16000` 一致。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const RATE = 16000;
export const BYTES_PER_SAMPLE = 2;

/** 秒 → PCM 字节数 */
export const secToBytes = (s) => Math.round(s * RATE) * BYTES_PER_SAMPLE;
/** PCM 字节数 → 秒 */
export const bytesToSec = (b) => b / BYTES_PER_SAMPLE / RATE;

/**
 * 合成日语语音（macOS say，默认 Kyoko 音色）。
 * @param {string} text 日语文本
 * @param {string} [voice] ja_JP 音色
 * @returns {Buffer} 裸 PCM（无 WAV 头）
 */
export function synthJapanese(text, voice = 'Kyoko') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-'));
  try {
    const aiff = path.join(tmp, 'a.aiff');
    const wav = path.join(tmp, 'a.wav');
    execFileSync('say', ['-v', voice, '-o', aiff, text], { stdio: 'pipe' });
    execFileSync(
      'afconvert',
      ['-f', 'WAVE', '-d', `LEI16@${RATE}`, '-c', '1', aiff, wav],
      { stdio: 'pipe' },
    );
    return wavToPcm(fs.readFileSync(wav));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * 剥掉 WAV 头，返回裸 PCM。按 chunk 遍历，不假设 44 字节固定头。
 * @param {Buffer} buf
 * @returns {Buffer}
 */
export function wavToPcm(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('不是 WAV 文件');
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') return buf.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2); // chunk 按偶数字节对齐
  }
  throw new Error('WAV 里找不到 data chunk');
}

/**
 * 把 PCM 补齐/截断到精确时长（补的部分是纯静音）。
 * 用于 Token 率测量 —— 必须知道确切音频秒数，才能做线性拟合。
 * @param {Buffer} pcm
 * @param {number} seconds 目标秒数
 * @returns {{pcm: Buffer, truncated: boolean}}
 */
export function fitToDuration(pcm, seconds) {
  const want = secToBytes(seconds);
  if (pcm.length === want) return { pcm, truncated: false };
  if (pcm.length > want) return { pcm: pcm.subarray(0, want), truncated: true };
  const out = Buffer.alloc(want); // Buffer.alloc 默认全 0 = 静音
  pcm.copy(out);
  return { pcm: out, truncated: false };
}

/** 生成纯静音 PCM（用于心跳测试） */
export const silence = (seconds) => Buffer.alloc(secToBytes(seconds));
