/**
 * 字幕消息协议（offscreen → content script）。
 *
 * M3 只承载**日文原文**；中文译文是 M4 的事 —— 所以这里刻意把 `text` 定义成
 * 「这一行要显示什么」，而不是「ASR 结果」或「翻译结果」。
 * 等 M4 加译文时，再加一个字段即可，content script 的渲染逻辑不用重写。
 */

/** 一条字幕更新 */
export interface SubtitleUpdateMessage {
  type: 'subtitle';
  /** `draft` = 还在修正中；`final` = 已经定型（D10 的两级显示） */
  kind: 'draft' | 'final';
  /** 服务端的 `sentence_id`，用来分辨「同一句的推进」和「新的一句」 */
  sentenceId: number;
  /** 日语原文 */
  source: string;
  /**
   * 中文译文；`null` = 还没翻译出来。
   *
   * 刻意允许 null，而不是等译文好了再一次性发：ASR 一定型就**先把日文显示出来**，
   * 译文晚约 400ms 到达再补上 —— 观众不必为等译文多等那 400ms，
   * 而且翻译失败时本来就只有日文可显（§13.2 故障 6）。
   */
  target: string | null;
  /** 事件产生时刻（`Date.now()`） */
  at: number;
}

/**
 * §13.1 的 8 态。
 *
 * 与 `core/asr/types.ts` 的 `AsrState` **不是一回事**：那个描述「一条连接处于什么阶段」，
 * 这个描述「用户现在处于什么处境」—— 包含了重连计数、终止原因等上层信息。
 */
export type SessionState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'degraded'
  | 'reconnecting'
  | 'auth_failed'
  | 'gave_up'
  | 'stopped';

/** 会话状态变化，让浮层/角标能提示当下的处理情况 */
export interface SubtitleStatusMessage {
  type: 'subtitle-status';
  state: SessionState;
  /** 短标题（如「Key 无效或欠费」） */
  title?: string;
  /** 详细说明 / 错误原因 */
  detail?: string;
  /** `reconnecting` 时：本轮第几次重连 */
  attempt?: number;
  /** `reconnecting` 时：从什么时候开始断的（`Date.now()`） */
  since?: number;
}

/**
 * 断连分隔线（§13.4）。
 *
 * 直播场景（D17）**不回溯、不补内容** —— 断连期间说的话就是丢了。
 * 但**不能假装没发生过**：已渲染的历史行保留（它们确实发生过），
 * 在断口处插一条灰色小字 `—— 中断 12 秒 ——`。
 *
 * 刻意分成独立消息而不是附在 `subtitle` 上：分隔线**不是一句话**，
 * 它不参与「上一句/当前句」的推进，渲染位置也不同。
 */
export interface SubtitleGapMessage {
  type: 'subtitle-gap';
  /** 这次中断了多久（秒） */
  seconds: number;
  at: number;
}

export type SubtitleMessage = SubtitleUpdateMessage | SubtitleStatusMessage | SubtitleGapMessage;

/** 收到消息的一侧用来过滤的判定 */
export function isSubtitleMessage(msg: unknown): msg is SubtitleMessage {
  const t = (msg as { type?: string } | null)?.type;
  return t === 'subtitle' || t === 'subtitle-status' || t === 'subtitle-gap';
}

/**
 * offscreen → SW 的**转发信封**。
 *
 * ⚠️ 为什么需要绕这一道：**offscreen 文档不能访问 `chrome.tabs`**
 * （实测：里面 `browser.tabs` 是 `undefined`，直接调 `tabs.sendMessage` 会抛
 * `Cannot read properties of undefined`）。而往 content script 发消息只能走 `tabs.sendMessage`
 * → 所以只能请 SW 代发。
 *
 * 信封类型名与内层不同（`subtitle-relay` vs `subtitle`），是为了让 content script
 * 即使直接收到广播也能忽略它 —— 避免同一个消息被渲染两次。
 */
export interface SubtitleRelayMessage {
  type: 'subtitle-relay';
  tabId: number;
  payload: SubtitleMessage;
}
