/**
 * 跨上下文消息协议（PLAN §6.3 的 `src/shared/`）。
 *
 * 三条通道，各自的方向与频率差别很大，所以**分开定义**：
 *   1. SW → offscreen：低频（只在点击图标时）
 *   2. worklet → offscreen：音频块，~15 次/秒（攒到 64ms 才发一次）
 *   3. offscreen → content：字幕事件，M3 起才用；按 §6.2 要求走 **Port 长连接**
 *
 * 这里只放**类型**，运行时零成本（`import type` 即可）。
 */

/** 会话状态：唯一权威在 offscreen（PLAN §6.2；SW 会被回收，不能存会话状态） */
export interface CaptureStatus {
  capturing: boolean;
  tabId: number | null;
  /** 建流时刻（`Date.now()`），未采集为 null */
  startedAt: number | null;
  /** 已产出的 16kHz mono 样点总数 —— 用它换算「已采秒数」，比墙钟更可信 */
  samples16k: number;
  /** 收到的音频块数 */
  blocks: number;
  /** 最近一块的 dBFS（VAD 门控的初级信号，M5 用） */
  lastDb: number;
  /** 本轮最响的 dBFS */
  loudestDb: number;
  /** AudioContext 实际采样率（实测 48000；若 ≠48000 说明重采样走的是非整数倍兜底） */
  sampleRate: number | null;
  /**
   * ASR 会话的 8 态（§13.1）。
   *
   * SW 需要它来区分「点击图标该做什么」：
   *   · 采集在跑且一切正常 → 点击 = 停止
   *   · 采集在跑但 ASR 已放弃（`auth_failed` / `gave_up`）→ 点击 = **重试**
   *     （§13.1：点 ⛔ / ✕ 角标 = 手动重试）。
   *     这时如果按「一律 toggle」处理，用户点了反而把采集停了，完全反直觉。
   */
  sessionState: string;
  /** 本场累计成本（元）—— 角标显示用（§13.1 的 `¥0.03`） */
  costYuan: number;
}

// ─────────────────────────── SW ↔ offscreen ───────────────────────────

export interface StartCaptureRequest {
  target: 'offscreen';
  type: 'start-capture';
  streamId: string;
  tabId: number;
  /**
   * 配置**由 SW 随指令带下来**，而不是让 offscreen 自己去读 storage。
   *
   * 为什么（真机实测踩到）：offscreen 文档刚被 `createDocument` 拉起时，
   * 立刻 `storage.local.get` **读不到内容** —— 而 [loadSettings] 里那个静默 catch
   * 把它变成了「未配置 API Key」，于是现象成了「明明配了 Key 却说没配」。
   * SW 是长期存在的，它读一定成功；把值带下来就绕开了这个初始化时序。
   */
  settings: { apiKey: string; model?: string };
}

export interface StopCaptureRequest {
  target: 'offscreen';
  type: 'stop-capture';
}

export interface StatusRequest {
  target: 'offscreen';
  type: 'status';
}

/** 手动重试（点 ⛔ / ✕ 角标时，§13.1） */
export interface RetryRequest {
  target: 'offscreen';
  type: 'retry';
}

export type OffscreenRequest = StartCaptureRequest | StopCaptureRequest | StatusRequest | RetryRequest;

export interface CaptureResponse {
  ok: boolean;
  error?: string;
  status?: CaptureStatus;
  /** stop 成功时回传释放的轨道数，便于确认真的停了（M2-0 spike 的教训） */
  releasedTracks?: number;
}

// ─────────────────────────── worklet → offscreen ───────────────────────────

/**
 * 一个音频块：已下混 + 重采样到 **16kHz mono**，并转成 Int16 PCM。
 *
 * 为什么在 worklet 里就做完这些：跨界（worklet → 主线程）的数据量与消息频率直接决定开销。
 * 若把 48kHz stereo Float32 原样转发，是每秒 375 次消息 / 384KB；
 * 在这里降到 16kHz mono Int16 后攒 64ms 发一次，变成 ~15.6 次/秒 / 32KB —— 差一个数量级。
 */
export interface AudioBlockMessage {
  type: 'audio';
  /** 16kHz mono、16bit 小端；`buffer` 会被 transfer 掉，接收方拿到的是所有权 */
  pcm: Int16Array;
  /** 该块样点数（= pcm.length） */
  samples: number;
  /** 该块 dBFS（-Infinity = 静音） */
  db: number;
  /** 该块峰值 dBFS */
  peakDb: number;
  /** 累计已产出样点（用于算「已采秒数」） */
  totalSamples: number;
}

/** worklet 初始化失败等致命情况：上报而不是静默（否则表现为「连上了但永远没字幕」） */
export interface AudioErrorMessage {
  type: 'error';
  message: string;
}

export type WorkletMessage = AudioBlockMessage | AudioErrorMessage;

/** `registerProcessor` 的注册名，worklet 与 offscreen 两侧必须一致 */
export const CAPTURE_PROCESSOR = 'capture';
/** offscreen 强制 AudioContext 的采样率：保证 48000→16000 是整数倍（factor=3） */
export const TARGET_CONTEXT_RATE = 48000;

/** ASR 要求的输入采样率 */
export const ASR_SAMPLE_RATE = 16000;

// ─────────────────────────── offscreen → SW（仅关键事件 + 低频心跳） ───────────────────────────

/**
 * offscreen 想让用户看到的一行日志。
 *
 * 为什么不「offscreen 自己 `console.log` 就够了」：offscreen 是**独立文档**，它的 console
 * 必须到 chrome://extensions 的「检查视图」里单独打开；而 SW 的检查器是用户最容易点开的那个。
 * 把关键事件与每 2 秒一条的采集心跳回流给 SW，就能「一个 console 看全」。
 *
 * ⚠️ 仍保持低频（PLAN §6.2：避免跨上下文高频通信）：音频数据本身**不**走这条路，
 * 日志每 2 秒最多一行。
 */
export interface OffscreenLogMessage {
  type: 'capture-log';
  level: 'info' | 'warn' | 'error';
  text: string;
}
