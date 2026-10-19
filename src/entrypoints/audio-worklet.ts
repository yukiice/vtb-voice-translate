/**
 * AudioWorklet 处理器 —— 音频管线的**第一段**，跑在音频线程。
 *
 * 职责（只有三件）：
 *   1. **直通**：`input → output` 原样拷回。**这步不可省** —— tabCapture 会让原标签页静音，
 *      不接回 destination 用户就听不到直播了（M2-0 spike 踩过：只算音量不写 output，
 *      结果「全部通过」但用户耳朵里已经哑了）。
 *   2. **下混 + 重采样**：48kHz stereo → **16kHz mono**（ASR 输入要求）。复用 `src/core/audio/`，
 *      不在这里重写一遍算法 —— 这是 PLAN §6.1 分层的实际收益。
 *   3. **攒块上报**：攒到 64ms 再 `postMessage` 给 offscreen。
 *
 * 为什么在音频线程就做完下混+重采样：跨界开销直接由数据量和消息频率决定。
 * 原样转发 48kHz stereo Float32 是 ~375 次/秒 / 384KB；降到 16kHz mono Int16 并攒 64ms 后
 * 是 ~15.6 次/秒 / 32KB —— 差一个数量级。
 *
 * ⚠️ 它被 `audioWorklet.addModule()` 当脚本加载，跑在 AudioWorkletGlobalScope 里
 * （没有 window/document/DOM 事件循环，只有 `process()` 回调）。
 * 打包成 IIFE 后导入的 core 模块会被内联，所以最终是自包含的。
 */
import { downmixInto } from '@/core/audio/downmix';
import { floatToInt16, peakToDb, rmsToDb } from '@/core/audio/pcm';
import { FirDecimator } from '@/core/audio/resample';
import { ASR_SAMPLE_RATE, CAPTURE_PROCESSOR, type WorkletMessage } from '@/shared/audio-messages';

// ── AudioWorkletGlobalScope 的最小声明 ──
// TS 的 lib.dom 只覆盖 Window 侧（`AudioWorkletNode`/`AudioWorklet`），
// **不含** worklet 全局（`AudioWorkletProcessor`/`registerProcessor`/`sampleRate`）。
// 声明写在模块作用域内，因此不会污染主线程代码的全局类型。
declare const sampleRate: number;
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}
declare function registerProcessor(
  name: string,
  processorCtor: new () => AudioWorkletProcessor,
): void;

/** 攒块长度：1024 样点 @16kHz = 64ms。够长则消息便宜，够短则字幕不被它拖慢。 */
const FLUSH_SAMPLES = 1024;

/**
 * 用**工厂函数**返回处理器类，而不是在模块顶层直接 `class ... extends AudioWorkletProcessor`。
 *
 * 原因（实测踩到）：WXT/Vite 在构建期会 `import()` 入口模块以读取导出，
 * 而那时是 **Node 环境** —— 顶层求值 `AudioWorkletProcessor` 会当场
 * `ReferenceError: AudioWorkletProcessor is not defined`，build 直接失败。
 * 包进函数后，真正的求值只发生在 `addModule()` 的 worklet 全局里，那时它才存在。
 */
function createCaptureProcessor(): new () => AudioWorkletProcessor {
  class CaptureProcessor extends AudioWorkletProcessor {
    #decimator: FirDecimator | null = null;
    /** 下混缓冲（每块 128 帧，复用避免音频线程 GC 抖动） */
    #mono = new Float32Array(0);
    /** 重采样输出缓冲 */
    #resampled = new Float32Array(0);
    /** Int16 转换缓冲 */
    #i16 = new Int16Array(0);
    /** 攒块缓冲（满即发） */
    #acc = new Int16Array(FLUSH_SAMPLES);
    #accLen = 0;
    // 本轮统计（flush 时随块一起带走并归零）
    #sumSq = 0;
    #frames = 0;
    #peak = 0;
    #totalSamples = 0;
    #dead = false;

    constructor() {
      super();
      const ratio = sampleRate / ASR_SAMPLE_RATE;
      if (Number.isInteger(ratio)) {
        this.#decimator = new FirDecimator({ inputRate: sampleRate, outputRate: ASR_SAMPLE_RATE });
      } else {
        // 只接受整数倍抽取（48k→16k = factor 3）。
        // 非整数倍（如 44100）会让线性插值兜底进 ASR 输入 —— 与其静默降质，不如**明确失败**：
        // offscreen 侧会强制 `new AudioContext({ sampleRate: 48000 })`，所以正常不该走到这。
        this.#dead = true;
        this.#post({
          type: 'error',
          message: `AudioContext 采样率 ${sampleRate}Hz 不是 16000 的整数倍，无法用 FIR 抽取（应强制 48000）`,
        });
      }
    }

    override process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
      const input = inputs[0];
      const output = outputs[0];
      if (!input?.length) return true; // 输入尚未接上，保持存活等待

      const nCh = input.length;
      const frames = input[0]!.length;

      // 1) 直通（见文件头：这是「用户还能听见直播」的唯一保障）
      if (output?.length) {
        for (let c = 0; c < output.length; c++) {
          output[c]!.set(input[Math.min(c, nCh - 1)]!);
        }
      }
      if (this.#dead) return true;

      // 2) 下混 → 单声道
      if (this.#mono.length !== frames) this.#mono = new Float32Array(frames);
      downmixInto(this.#mono, input);

      // 统计也顺手在这里做：VAD 门控（§5.3）用的 dBFS 就是这个值
      for (let i = 0; i < frames; i++) {
        const s = this.#mono[i]!;
        this.#sumSq += s * s;
        const a = s < 0 ? -s : s;
        if (a > this.#peak) this.#peak = a;
      }
      this.#frames += frames;

      // 3) 重采样（含抗混叠 FIR）
      const dec = this.#decimator!;
      const maxOut = Math.ceil(frames / dec.factor) + 1;
      if (this.#resampled.length < maxOut) this.#resampled = new Float32Array(maxOut);
      const written = dec.processInto(this.#mono, this.#resampled);
      if (written === 0) return true;

      if (this.#i16.length < written) this.#i16 = new Int16Array(maxOut);
      floatToInt16(this.#resampled.subarray(0, written), this.#i16);

      // 4) 攒块
      let off = 0;
      while (off < written) {
        const take = Math.min(FLUSH_SAMPLES - this.#accLen, written - off);
        this.#acc.set(this.#i16.subarray(off, off + take), this.#accLen);
        this.#accLen += take;
        off += take;
        if (this.#accLen === FLUSH_SAMPLES) this.#flush();
      }

      return true; // 永远存活：停止由 offscreen 侧 disconnect 控制
    }

    #flush(): void {
      const db = rmsToDb(Math.sqrt(this.#sumSq / Math.max(1, this.#frames)));
      const peakDb = peakToDb(this.#peak);
      this.#totalSamples += this.#accLen;

      // ⚠️ `buffer` 会被 transfer 走（零拷贝），所以之后必须重新分配 #acc，
      //    否则下一块会写进已失效的缓冲。
      const pcm = this.#acc;
      this.#post({ type: 'audio', pcm, samples: this.#accLen, db, peakDb, totalSamples: this.#totalSamples }, [
        pcm.buffer,
      ]);

      this.#acc = new Int16Array(FLUSH_SAMPLES);
      this.#accLen = 0;
      this.#sumSq = 0;
      this.#frames = 0;
      this.#peak = 0;
    }

    #post(msg: WorkletMessage, transfer: Transferable[] = []): void {
      this.port.postMessage(msg, transfer);
    }
  }

  return CaptureProcessor;
}

export default defineUnlistedScript(() => {
  registerProcessor(CAPTURE_PROCESSOR, createCaptureProcessor());
});
