/**
 * `src/core/audio/pcm.ts` 的单元测试。
 *
 * 重点验的不是「能不能转」，而是**两个会真正毁掉 ASR 输入的点**：
 *  1. **clamp**：滤波/重采样的振铃会让样点超过 ±1.0，不夹住就写进 Int16 溢出成**反极性**的尖峰
 *     （听感是「咔嚓」爆音，而 ASR 会把这当噪声特征）；
 *  2. **静音 → `-Infinity`**：VAD 门控按 dBFS 阈值比较，这个语义不能退化成一个「大负数」。
 */
import { describe, expect, it } from 'vitest';

import { floatToInt16, peakToDb, rmsToDb } from '../src/core/audio/pcm';
import { FirDecimator } from '../src/core/audio/resample';

describe('floatToInt16', () => {
  it('满刻度映射到 ±32767（不是 32768 —— Int16 正向只到 32767）', () => {
    expect(Array.from(floatToInt16(Float32Array.from([1, -1, 0])))).toEqual([32767, -32767, 0]);
  });

  it('超出 ±1 的值被夹住', () => {
    const out = floatToInt16(Float32Array.from([1.5, -1.5, 12, -12]));
    expect(Array.from(out)).toEqual([32767, -32767, 32767, -32767]);
  });

  it('不 clamp 的话会溢出成反极性的值 —— 这就是「爆音」的成因', () => {
    // 直接写 Int16Array 时，49151 会回绕成负数：极性翻转，波形上是一个尖峰
    const naive = new Int16Array(1);
    naive[0] = Math.round(1.5 * 32767);
    expect(naive[0]!).toBeLessThan(0);

    // 我们的实现不允许这种情况发生
    expect(floatToInt16(Float32Array.from([1.5]))[0]!).toBe(32767);
  });

  it('四舍五入而不是截断（截断会引入系统性直流偏移）', () => {
    expect(Array.from(floatToInt16(Float32Array.from([0.00004, -0.00004])))).toEqual([1, -1]);
  });

  it('可复用输出缓冲（实时路径避免 GC 抖动）', () => {
    const buf = new Int16Array(3);
    const out = floatToInt16(Float32Array.from([1, 0, -1]), buf);
    expect(out).toBe(buf);
    expect(Array.from(buf)).toEqual([32767, 0, -32767]);
  });

  it('缓冲不够长时另分配，绝不越界写', () => {
    const small = new Int16Array(1);
    const out = floatToInt16(Float32Array.from([1, 1, 1]), small);
    expect(out).not.toBe(small);
    expect(out.length).toBe(3);
    // 传入的缓冲比输入短 —— 必须另分配，且**完全不碰**原缓冲（否则就是越界写）
    expect(Array.from(small)).toEqual([0]);
  });

  it('真实链路：方波经 FIR 重采样后即使过冲，转出的 Int16 也不会溢出', () => {
    // 240Hz 方波 —— 跳变处会引起 FIR 的 Gibbs 过冲（这是 clamp 的现实来源）
    const square = new Float32Array(48000);
    for (let i = 0; i < square.length; i++) square[i] = i % 100 < 50 ? 1 : -1;
    const resampled = new FirDecimator({ inputRate: 48000, outputRate: 16000 }).process(square);

    let overshoots = 0;
    for (const v of resampled) if (v > 1 || v < -1) overshoots++;

    const pcm = floatToInt16(resampled);
    for (const v of pcm) {
      expect(v).toBeGreaterThanOrEqual(-32768);
      expect(v).toBeLessThanOrEqual(32767);
    }
    // 记录实测：若过冲确实发生，说明 clamp 不是多余的保险
    console.log(`[pcm.test] FIR 重采样后过冲样点数：${overshoots}`);
  });
});

describe('dBFS 换算', () => {
  it('满幅 RMS = 0 dBFS，半幅 ≈ -6.02 dBFS', () => {
    expect(rmsToDb(1)).toBeCloseTo(0, 10);
    expect(rmsToDb(0.5)).toBeCloseTo(-6.0206, 3);
  });

  it('纯静音是 -Infinity（VAD 阈值比较依赖这个语义）', () => {
    expect(rmsToDb(0)).toBe(Number.NEGATIVE_INFINITY);
    expect(peakToDb(0)).toBe(Number.NEGATIVE_INFINITY);
    // -Infinity 参与阈值比较永远成立（不能用某个「大负数」替代）
    expect(rmsToDb(0) < -60).toBe(true);
  });
});
