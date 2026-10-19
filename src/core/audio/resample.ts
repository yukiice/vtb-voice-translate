/**
 * 重采样：设备采样率 → ASR 需要的 16kHz。
 *
 * 为什么必需：M2-0 spike 实测 tabCapture 输出 **48kHz**，而 ASR 参数写的是
 * `sample_rate: 16000`（PLAN §6 的「16kHz mono」假设在**音频源**上是错的）。
 *
 * ⚠️ 关键工程点：**不能直接每隔 N 个样点取一个**。
 * 48k→16k 若不做抗混叠低通，8kHz 以上的能量（BGM 镲片、齿音、音效）会
 * **折叠回语音频段**（例如 10kHz 变成 6kHz），直接污染 ASR 输入。
 * 所以先 FIR 低通到目标 Nyquist 以下，再抽取。
 *
 * 分层约束（PLAN §6.1）：`src/core/` 零 Chrome API，纯 Float32Array 运算，
 * 因此可以在 Vitest 里用「正弦波 + 混叠检测」直接验质量。
 */

/** FirDecimator 的构造参数 */
export interface DecimatorOptions {
  /** 输入采样率（Hz），如 AudioContext 的 48000 */
  inputRate: number;
  /** 目标采样率（Hz），ASR 用 16000 */
  outputRate: number;
  /** FIR 抽头数，必须为奇数。默认 63（Hamming 窗，阻带 ≈ -50dB，群延迟 ≈ 0.65ms@48k） */
  taps?: number;
  /** 截止频率 = cutoffRatio × (outputRate/2)。默认 0.9，给过渡带留余量 */
  cutoffRatio?: number;
}

/**
 * 设计一个线性相位低通 FIR（窗函数法：理想 sinc × Hamming 窗）。
 *
 * 归一化到 **DC 增益 = 1**：不归一化的话下采样会改变响度，
 * 而 VAD 门控（M5 的降本关键）是按 dBFS 阈值判的 —— 阈值会全部失准。
 */
export function designLowpass(cutoffHz: number, sampleRate: number, taps = 63): Float32Array {
  if (taps % 2 === 0) throw new Error('taps 必须为奇数：线性相位需要对称中心');
  if (!(cutoffHz > 0) || cutoffHz >= sampleRate / 2) {
    throw new Error(`截止频率必须落在 (0, ${sampleRate / 2}) 内，收到 ${cutoffHz}`);
  }

  const h = new Float32Array(taps);
  const center = (taps - 1) / 2;
  const fc = cutoffHz / sampleRate; // 归一化频率（周期/样点）

  let sum = 0;
  for (let n = 0; n < taps; n++) {
    const x = n - center;
    // 理想低通冲击响应 2fc·sinc(2fc·x)，x=0 处取极限 2fc
    const sinc = x === 0 ? 1 : Math.sin(2 * Math.PI * fc * x) / (2 * Math.PI * fc * x);
    const hamming = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (taps - 1));
    const v = 2 * fc * sinc * hamming;
    h[n] = v;
    sum += v;
  }
  for (let n = 0; n < taps; n++) h[n] = h[n]! / sum;
  return h;
}

/**
 * 整数倍抽取器（48k→16k 是 factor=3，最常见的路径）。
 *
 * 流式、零分配：`processInto()` 复用调用方的输出缓冲，可以直接在
 * AudioWorklet 的 `process()` 里逐块调用 —— 每块 128 帧，跨块保持 FIR 历史。
 *
 * 计算量：每输出 1 个样点 ≈ taps 次乘加 → 16k × 63 ≈ 1.0M MAC/s。
 * 相对 1 秒音频的处理预算是九牛一毛，所以这里用可读的写法，不做手写展开。
 *
 * ⚠️ 只支持整数倍（inputRate/outputRate 为整数）。非整数比（如 44100→16000）
 * 请用 {@link resampleLinear}：它先抗混叠再线性插值，对 ASR 精度足够。
 */
export class FirDecimator {
  readonly factor: number;
  readonly taps: number;
  readonly cutoffHz: number;
  readonly #h: Float32Array;
  readonly #hist: Float32Array;
  #histPos = 0;
  #sinceOut = 0;

  constructor({ inputRate, outputRate, taps = 63, cutoffRatio = 0.9 }: DecimatorOptions) {
    const ratio = inputRate / outputRate;
    if (!Number.isInteger(ratio)) {
      throw new Error(
        `FirDecimator 只支持整数倍抽取（收到 ${inputRate}→${outputRate}）；非整数比请用 resampleLinear`,
      );
    }
    if (!Number.isInteger(taps) || taps < 3 || taps % 2 === 0) {
      throw new Error(`taps 必须是 ≥3 的奇数，收到 ${taps}`);
    }
    this.factor = ratio;
    this.taps = taps;
    this.cutoffHz = cutoffRatio * (outputRate / 2);
    this.#h = designLowpass(this.cutoffHz, inputRate, taps);
    this.#hist = new Float32Array(taps);
  }

  /** 群延迟（输入侧样点数），用于对齐时间戳/延迟统计 */
  get groupDelaySamples(): number {
    return (this.taps - 1) / 2;
  }

  /** 一次性处理整段（离线/测试用）。返回新数组。 */
  process(input: Float32Array): Float32Array {
    const out = new Float32Array(Math.ceil(input.length / this.factor) + 1);
    const n = this.processInto(input, out);
    return out.slice(0, n);
  }

  /**
   * 流式处理，写入 `out`，返回实际写入的样点数。
   * `out` 需要至少 `ceil(input.length / factor)` 那么长。
   */
  processInto(input: Float32Array, out: Float32Array): number {
    const taps = this.taps;
    const hist = this.#hist;
    const h = this.#h;
    let pos = this.#histPos;
    let sinceOut = this.#sinceOut;
    let written = 0;

    for (let i = 0; i < input.length; i++) {
      hist[pos] = input[i]!;
      pos++;
      if (pos === taps) pos = 0;

      sinceOut++;
      if (sinceOut < this.factor) continue;
      sinceOut = 0;
      if (written >= out.length) break;

      // 卷积：hist 中最近 taps 个样点 × 对称 FIR
      let acc = 0;
      let idx = pos - 1;
      if (idx < 0) idx += taps;
      for (let k = 0; k < taps; k++) {
        acc += h[k]! * hist[idx]!;
        idx--;
        if (idx < 0) idx += taps;
      }
      out[written++] = acc;
    }

    this.#histPos = pos;
    this.#sinceOut = sinceOut;
    return written;
  }

  /** 重置跨块状态（切标签页/重连后调用，避免旧数据渗进新会话） */
  reset(): void {
    this.#hist.fill(0);
    this.#histPos = 0;
    this.#sinceOut = 0;
  }
}

/**
 * 非整数比兜底（例如 AudioContext 是 44100Hz → 16000）。
 *
 * 做法：先 FIR 低通抗混叠，再线性插值。对 ASR 来说精度足够
 * （线性插值的通带高频略有衰减，对 8kHz 以内的语音影响很小）。
 * 若将来实测发现精度不够，升级为多相 sinc（L/M 有理比）即可，接口不变。
 */
export function resampleLinear(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (inRate === outRate) return input.slice();
  if (!(inRate > 0) || !(outRate > 0)) throw new Error('采样率必须为正数');

  const outLen = Math.max(0, Math.round((input.length * outRate) / inRate));
  const out = new Float32Array(outLen);

  let src = input;
  if (outRate < inRate) {
    const h = designLowpass(outRate * 0.45, inRate, 63);
    src = convolveSame(input, h);
  }

  const step = inRate / outRate;
  for (let i = 0; i < outLen; i++) {
    const at = i * step;
    const i0 = Math.floor(at);
    const frac = at - i0;
    const a = src[i0] ?? 0;
    const b = src[i0 + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** 一次性重采样（离线/测试用）。实时路径请用 {@link FirDecimator}（流式、零分配）。 */
export function resample(input: Float32Array, inRate: number, outRate: number): Float32Array {
  const ratio = inRate / outRate;
  if (Number.isInteger(ratio)) {
    return new FirDecimator({ inputRate: inRate, outputRate: outRate }).process(input);
  }
  return resampleLinear(input, inRate, outRate);
}

/** 同长度卷积（中心对齐），用于离线抗混叠 */
function convolveSame(input: Float32Array, h: Float32Array): Float32Array {
  const center = (h.length - 1) / 2;
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) {
    let acc = 0;
    for (let k = 0; k < h.length; k++) {
      const j = i + center - k;
      if (j >= 0 && j < input.length) acc += h[k]! * input[j]!;
    }
    out[i] = acc;
  }
  return out;
}
