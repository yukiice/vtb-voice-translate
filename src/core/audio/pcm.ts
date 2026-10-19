/**
 * Float32 → 16-bit PCM（小端）转换。
 *
 * 为什么需要：ASR（百炼 `qwen-audio-3.1-asr-flash-*`）的 `format=pcm, sample_rate=16000`
 * 吃的是 **16bit 整数 PCM**，而 WebAudio 全程用 Float32（[-1, 1]）。
 *
 * ⚠️ **必须 clamp**：Float32 的 `1.0` 乘 32767 得 32767 没问题，但音频链路里
 * 重采样/滤波的振铃（Gibbs）会让样点**超过 1.0**（实测过 1.02 这种值），
 * 不 clamp 就会写进 Int16Array 溢出成 -32768 —— 听感上是「咔嚓」爆音，
 * 而 ASR 会把这种脉冲当成噪声特征。这是 M2 到 M3 之间最容易漏掉的一步。
 *
 * 分层约束（PLAN §6.1）：`src/core/` 零 Chrome API。
 */

/** 16bit 有符号整数的正向满刻度（-32768..32767，正向只到 32767） */
const INT16_MAX = 32767;

/**
 * 就地/异地转换，返回写入的 Int16Array。
 *
 * @param input Float32 样点（超出 [-1,1] 的值会被 clamp）
 * @param out 可选的输出缓冲（实时路径复用它以避免 GC 抖动）；不足部分不写
 */
export function floatToInt16(input: Float32Array, out?: Int16Array): Int16Array {
  const dst = out && out.length >= input.length ? out : new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    let v = input[i]!;
    if (v > 1) v = 1;
    else if (v < -1) v = -1;
    dst[i] = Math.round(v * INT16_MAX);
  }
  return dst;
}

/**
 * 样点 RMS → dBFS。
 *
 * ⚠️ 纯静音返回 `-Infinity` 而不是某个大负数 —— VAD 门控（§5.3 降本）要用它做阈值比较，
 * 而 `-Infinity < 阈值` 恒成立，比「随便取 -100」更不容易误判。
 */
export function rmsToDb(rms: number): number {
  return rms > 0 ? 20 * Math.log10(rms) : Number.NEGATIVE_INFINITY;
}

/** 峰值 → dBFS（同样保留 -Infinity 语义） */
export function peakToDb(peak: number): number {
  return peak > 0 ? 20 * Math.log10(peak) : Number.NEGATIVE_INFINITY;
}
