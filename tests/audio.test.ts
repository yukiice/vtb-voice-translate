/**
 * `src/core/audio/` 的单元测试（PLAN §6.1：core 层零 Chrome API，可脱离浏览器单测）。
 *
 * 这里验的不是「函数能跑」，而是三件会真正翻车的事：
 *  1. **抗混叠**：48k→16k 不做低通会把 >8kHz 能量折叠进语音频段（用「裸抽取」做对照）；
 *  2. **流式一致性**：实时路径是每 128 帧喂一次，分块结果必须与整块完全一致；
 *  3. **直流/通带增益**：响度若被改变，M5 的 VAD 门控阈值会整体失准。
 */
import { describe, expect, it } from 'vitest';

import { downmixInto, downmixToMono } from '../src/core/audio/downmix';
import { FirDecimator, designLowpass, resample, resampleLinear } from '../src/core/audio/resample';

function sine(freq: number, sampleRate: number, length: number, amp = 1): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return out;
}

function rms(x: Float32Array, from = 0, to = x.length): number {
  let sum = 0;
  let n = 0;
  for (let i = from; i < to; i++) {
    sum += x[i]! * x[i]!;
    n++;
  }
  return n === 0 ? 0 : Math.sqrt(sum / n);
}

function maxAbs(x: Float32Array, from = 0): number {
  let m = 0;
  for (let i = from; i < x.length; i++) m = Math.max(m, Math.abs(x[i]!));
  return m;
}

/** 用上升过零点估算频率（无需 FFT，够判断通带频率是否被搬移） */
function estimateFreq(x: Float32Array, sampleRate: number, from = 0): number {
  let crossings = 0;
  let first = -1;
  let last = -1;
  for (let i = from + 1; i < x.length; i++) {
    if (x[i - 1]! <= 0 && x[i]! > 0) {
      if (first < 0) first = i;
      last = i;
      crossings++;
    }
  }
  if (crossings < 2) return 0;
  return ((crossings - 1) * sampleRate) / (last - first);
}

describe('downmix', () => {
  it('单声道直接透传，不做缩放', () => {
    const mono = Float32Array.from([0.5, -0.25, 1, 0]);
    expect(Array.from(downmixToMono([mono]))).toEqual([0.5, -0.25, 1, 0]);
  });

  it('立体声等权平均', () => {
    const l = Float32Array.from([1, 0.5, -1]);
    const r = Float32Array.from([0, -0.5, -1]);
    expect(Array.from(downmixToMono([l, r]))).toEqual([0.5, 0, -1]);
  });

  it('左右反相（相位相反）时抵消为 0', () => {
    const l = sine(440, 48000, 1000);
    const r = Float32Array.from(sine(440, 48000, 1000), (v) => -v);
    expect(maxAbs(downmixToMono([l, r]))).toBeLessThan(1e-7);
  });

  it('4 声道按 1/4 平均（不只是前两路）', () => {
    const ch = Array.from({ length: 4 }, () => Float32Array.from([1, 0, -1, 0.5]));
    expect(Array.from(downmixToMono(ch))).toEqual([1, 0, -1, 0.5]);
  });

  it('空声道列表返回空数组，不抛异常', () => {
    expect(downmixToMono([]).length).toBe(0);
  });

  it('downmixInto 复用缓冲：尾部补 0，且不改动 out 之外的数据', () => {
    const out = new Float32Array(6).fill(9);
    downmixInto(out, [Float32Array.from([1, 1]), Float32Array.from([1, 1])]);
    expect(Array.from(out)).toEqual([1, 1, 0, 0, 0, 0]);
  });

  it('声道长度不一致时按最短声道截断，其余补 0（不延展成半幅样点）', () => {
    // 不延展的原因：只有一路有声时延展会得到 1/ch 的半幅样点，
    // 在实时流里表现为响度突然减半 —— VAD 的门控判断会被这种假突变带偏。
    const out = new Float32Array(4);
    downmixInto(out, [Float32Array.from([1, 1]), Float32Array.from([1])]);
    expect(Array.from(out)).toEqual([1, 0, 0, 0]);
  });

  it('越界与空声道都不产生 NaN（NaN 会污染整块缓冲并打断音频输出）', () => {
    const out = new Float32Array(4);
    downmixInto(out, [new Float32Array(0), new Float32Array(2).fill(1)]);
    for (const v of out) expect(Number.isFinite(v)).toBe(true);
    downmixInto(out, [Float32Array.from([1, 1]), new Float32Array(0)]);
    for (const v of out) expect(Number.isFinite(v)).toBe(true);
    downmixInto(out, []);
    expect(Array.from(out)).toEqual([0, 0, 0, 0]);
  });
});

describe('designLowpass', () => {
  it('DC 增益归一化为 1（否则会改变响度、VAD 阈值整体失准）', () => {
    const h = designLowpass(7200, 48000, 63);
    let sum = 0;
    for (const v of h) sum += v;
    expect(sum).toBeCloseTo(1, 6);
  });

  it('线性相位：系数左右对称', () => {
    const h = designLowpass(7200, 48000, 63);
    for (let i = 0; i < h.length; i++) {
      expect(h[i]!).toBeCloseTo(h[h.length - 1 - i]!, 6);
    }
  });

  it('偶数抽头与非法的截止频率会立即报错（避免悄悄退化成劣质滤波）', () => {
    expect(() => designLowpass(7200, 48000, 64)).toThrow(/奇数/);
    expect(() => designLowpass(24000, 48000, 63)).toThrow(/截止频率/);
    expect(() => designLowpass(0, 48000, 63)).toThrow(/截止频率/);
  });
});

describe('FirDecimator（48kHz → 16kHz，factor=3）', () => {
  const IN = 48000;
  const OUT = 16000;

  it('输出长度 = 输入长度 / 3', () => {
    const d = new FirDecimator({ inputRate: IN, outputRate: OUT });
    expect(d.factor).toBe(3);
    expect(d.process(new Float32Array(30000)).length).toBe(10000);
    expect(d.groupDelaySamples).toBe(31);
  });

  it('非整数倍比率拒绝构造，并提示走 resampleLinear', () => {
    expect(() => new FirDecimator({ inputRate: 44100, outputRate: 16000 })).toThrow(/整数倍/);
  });

  it('直流输入增益为 1（稳定段，偏差 < 0.1%）', () => {
    const input = new Float32Array(48000).fill(0.5);
    const out = new FirDecimator({ inputRate: IN, outputRate: OUT }).process(input);
    const steady = out.subarray(100);
    expect(steady.length).toBeGreaterThan(1000);
    expect(maxAbs(Float32Array.from(steady, (v) => v - 0.5))).toBeLessThan(5e-4);
  });

  it('抗混叠：10kHz（> 输出 Nyquist 8kHz）被压到 -40dB 以下', () => {
    const input = sine(10000, IN, IN); // 1 秒
    const out = new FirDecimator({ inputRate: IN, outputRate: OUT }).process(input);

    // 对照组：裸抽取（每 3 个取 1，无低通）——10kHz 会折叠成 6kHz，能量几乎不衰减
    const naive = new Float32Array(OUT);
    for (let i = 0; i < naive.length; i++) naive[i] = input[i * 3]!;

    const naiveRms = rms(naive);
    const filteredRms = rms(out, 1000, out.length - 1000);
    const attenuationDb = 20 * Math.log10(filteredRms / naiveRms);

    expect(naiveRms).toBeGreaterThan(0.5); // 混叠能量确实很大（≈0.707）
    expect(attenuationDb).toBeLessThan(-40); // 我们的低通把它按下去
  });

  it('通带保持：1kHz 正弦频率不变、幅度衰减 < 5%', () => {
    const input = sine(1000, IN, IN);
    const out = new FirDecimator({ inputRate: IN, outputRate: OUT }).process(input);
    const steady = out.subarray(200, out.length - 200);

    expect(estimateFreq(out, OUT, 200)).toBeGreaterThan(950);
    expect(estimateFreq(out, OUT, 200)).toBeLessThan(1050);
    expect(rms(steady)).toBeGreaterThan(0.707 * 0.95);
    expect(rms(steady)).toBeLessThan(0.707 * 1.05);
  });

  it('流式一致性：按 128 帧分块喂入的结果与整块完全一致（实时路径的正确性依据）', () => {
    const input = sine(440, IN, IN);
    const whole = new FirDecimator({ inputRate: IN, outputRate: OUT }).process(input);

    const streaming = new FirDecimator({ inputRate: IN, outputRate: OUT });
    const CHUNK = 128; // AudioWorklet 的固定帧数
    const buf = new Float32Array(CHUNK / 3 + 2);
    const collected: number[] = [];
    for (let off = 0; off < input.length; off += CHUNK) {
      const written = streaming.processInto(input.subarray(off, off + CHUNK), buf);
      for (let i = 0; i < written; i++) collected.push(buf[i]!);
    }

    expect(collected.length).toBe(whole.length);
    for (let i = 0; i < whole.length; i++) expect(collected[i]!).toBeCloseTo(whole[i]!, 6);
  });

  it('reset() 后状态清空，不会把上一段音频渗进新会话', () => {
    const d = new FirDecimator({ inputRate: IN, outputRate: OUT });
    const loud = new Float32Array(3000).fill(1);
    d.process(loud);
    d.reset();
    const fresh = new FirDecimator({ inputRate: IN, outputRate: OUT }).process(loud);
    const afterReset = d.process(loud);
    for (let i = 0; i < fresh.length; i++) expect(afterReset[i]!).toBeCloseTo(fresh[i]!, 6);
  });
});

describe('resample（统一入口）', () => {
  it('整数倍走 FIR：48k→16k', () => {
    const out = resample(sine(440, 48000, 48000), 48000, 16000);
    expect(out.length).toBe(16000);
    expect(estimateFreq(out, 16000, 200)).toBeGreaterThan(430);
    expect(estimateFreq(out, 16000, 200)).toBeLessThan(450);
  });

  it('非整数倍走线性插值兜底：44100→16000 长度正确且直流增益 ≈1', () => {
    const input = new Float32Array(44100).fill(0.5);
    const out = resampleLinear(input, 44100, 16000);
    expect(out.length).toBe(Math.round((44100 * 16000) / 44100));
    const steady = out.subarray(200, out.length - 200);
    expect(maxAbs(Float32Array.from(steady, (v) => v - 0.5))).toBeLessThan(5e-3);
  });

  it('同采样率返回副本（不是同一个引用，避免下游就地把上游改掉）', () => {
    const input = sine(440, 16000, 100);
    const out = resampleLinear(input, 16000, 16000);
    expect(out).not.toBe(input);
    expect(Array.from(out)).toEqual(Array.from(input));
  });

  it('非法采样率报错', () => {
    expect(() => resampleLinear(new Float32Array(10), 0, 16000)).toThrow(/采样率/);
  });
});
