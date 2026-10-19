/**
 * 下混：任意声道数 → 单声道。
 *
 * 为什么需要：M2-0 spike 实测 tabCapture 给的是 **48kHz 立体声**
 * （`sampleRate=48000 channels=2`），而 ASR 只吃单声道 PCM。
 * PLAN §6 把「下混 + 重采样」定为**必需环节**，不是可选优化
 * （D15 已把降噪交给 ASR 自带能力，所以前端音频管线就这两步）。
 *
 * 分层约束（PLAN §6.1）：本文件属于 `src/core/`，**不得出现任何 Chrome API**，
 * 只处理 `Float32Array` —— 这样能用 Vitest 直接跑，不需要浏览器。
 */

/**
 * 多声道 → 单声道（等权平均）。
 *
 * 为什么是等权平均而不是只取左声道：直播里人声与 BGM 常是立体声分布，
 * 只取一路会丢掉部分能量，也会让 VAD 的响度判断偏离真实输入。
 *
 * @returns 新的 Float32Array（长度 = 最短声道长度）
 */
export function downmixToMono(channels: readonly Float32Array[]): Float32Array {
  const first = channels[0];
  if (!first) return new Float32Array(0);
  const out = new Float32Array(first.length);
  downmixInto(out, channels);
  return out;
}

/**
 * 就地版：把下混结果写进调用方给的缓冲。
 *
 * 实时路径（AudioWorklet 的 `process()`）每 128 帧就要跑一次，
 * 不能每块都 `new Float32Array` —— GC 抖动在音频线程里会变成爆音。
 *
 * 长度不一致时按**最短**声道处理，多出来的部分补 0（而不是读越界）。
 */
export function downmixInto(out: Float32Array, channels: readonly Float32Array[]): void {
  const ch = channels.length;
  if (ch === 0) {
    out.fill(0);
    return;
  }

  const only = channels[0]!;
  if (ch === 1) {
    const n = Math.min(out.length, only.length);
    out.set(only.subarray(0, n));
    if (n < out.length) out.fill(0, n);
    return;
  }

  let frames = out.length;
  for (let c = 0; c < ch; c++) {
    const len = channels[c]!.length;
    if (len < frames) frames = len;
  }

  const scale = 1 / ch;
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < ch; c++) sum += channels[c]![i]!;
    out[i] = sum * scale;
  }
  if (frames < out.length) out.fill(0, frames);
}
