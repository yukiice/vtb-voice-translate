/**
 * AudioWorklet 处理器 —— M2-0 spike。
 *
 * 职责：把标签页音频降成单声道 16kHz PCM，并周期性回报音量。
 * 这是在 offscreen document 里跑的，不是页面上下文。
 *
 * ⚠️ 与 PLAN §6.1 的关系：真实产品里这里会做「下混 + 重采样 + 打 VAD 标记」，
 *    本 spike 只验证**能否拿到音频**，所以只算 RMS 上报，不做重采样。
 */

const REPORT_INTERVAL_MS = 250;

class LevelMeter extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frames = 0;
    this.sumSq = 0;
    this.peak = 0;
    this.sinceReport = 0;
    this.chunks = 0;
    this.totalFrames = 0;
    // 检测样点是否全是 0 —— 这是"连上了但没声音"和"真拿到音频"的关键区分
    this.nonZeroFrames = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true; // 输入还没接上，继续等

    // 多声道 → 单声道（下混）
    const nCh = input.length;
    const n = input[0].length;

    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let c = 0; c < nCh; c++) s += input[c][i];
      s /= nCh;

      this.sumSq += s * s;
      if (Math.abs(s) > this.peak) this.peak = Math.abs(s);
      if (s !== 0) this.nonZeroFrames++;
      this.frames++;
      this.totalFrames++;
    }

    // 🔴 关键：直通（passthrough）。
    // tabCapture 会**静音原标签页**，所以必须把音频原样送回 destination，
    // 否则用户就听不到直播了 —— 这是产品级 bug，不是可选优化。
    //
    // ⚠️ 踩过的坑：第一版只算音量、从不写 output，结果 connect(destination)
    //    送出去的是静音 —— spike 会「全部通过」但用户耳朵里 B 站已经哑了。
    //    AudioWorklet 不会自动直通，必须手动拷。
    if (output && output.length) {
      for (let c = 0; c < output.length; c++) {
        const src = input[Math.min(c, nCh - 1)]; // 单声道输入时各输出声道都用同一源
        output[c].set(src);
      }
    }

    this.chunks++;
    this.sinceReport += n;
    if (this.sinceReport / sampleRate * 1000 >= REPORT_INTERVAL_MS) {
      const rms = Math.sqrt(this.sumSq / Math.max(1, this.frames));
      this.port.postMessage({
        type: 'level',
        // dBFS：-Infinity 表示纯静音
        db: rms > 0 ? 20 * Math.log10(rms) : -Infinity,
        peakDb: this.peak > 0 ? 20 * Math.log10(this.peak) : -Infinity,
        rms,
        sampleRate,
        channels: nCh,
        chunks: this.chunks,
        seconds: this.totalFrames / sampleRate,
        // 关键指标：非零样点占比。0% = 拿到流但没声音（多半是 tab 被静音或没在播放）
        nonZeroPct: (this.nonZeroFrames / Math.max(1, this.totalFrames)) * 100,
      });
      this.frames = 0;
      this.sumSq = 0;
      this.peak = 0;
      this.sinceReport = 0;
    }
    return true;
  }
}

registerProcessor('level-meter', LevelMeter);
