/**
 * 百炼 ASR 的类型与抽象（PLAN §6.3 的 `core/asr/`）。
 *
 * 分层约束（§6.1）：core 零 Chrome API、零 DOM。所以这里**不直接用全局 `WebSocket`**，
 * 而是依赖下面的 `SocketLike` 接口 —— 真实适配器由 `entrypoints/` 提供，测试里给十几行假实现。
 *
 * 为什么要这么绕：M1 的教训是**协议细节最容易错，却只能靠真机才能发现**
 * （例如 usage 不在 `task-finished` 上、心跳包有 `sentence_id=0`、二进制不能走 JSON）。
 * 抽象出 socket 后，这些都能在 Vitest 里用假事件流覆盖。
 */

/** 服务端事件名（只列我们用到的；未知事件不丢弃，记为 `unknown` 以便排查协议变更） */
export type AsrEventName = 'task-started' | 'result-generated' | 'task-finished' | 'task-failed' | 'unknown';

export interface AsrUsage {
  duration?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

/** 一个句子的累积记录 */
export interface AsrSentence {
  id: number;
  /** 草稿轨迹（中间结果），按时间追加 */
  drafts: { at: number; text: string }[];
  /** 定稿文本（`sentence_end=true` 后写入）；`null` = 仍在草稿阶段 */
  final: string | null;
  /** 首次出现时刻 */
  t0: number;
  /** 定稿时刻 */
  tFinal: number | null;
  beginTime?: number;
  endTime?: number;
}

/** 关闭信息：用于区分「服务端断开」与「自己关的」（D102/D103 的判活依据） */
export interface CloseInfo {
  code: number;
  reason: string;
  at: number;
  bySelf: boolean;
}

export interface AsrFailure {
  kind: 'handshake' | 'task' | 'protocol';
  code?: string;
  message: string;
}
export interface AsrEvent {
  at: number;
  event: AsrEventName;
  raw: ServerMessage;
}

/** 服务端消息（只声明我们读取的字段；其余原样保留在 `raw` 里便于排查） */
export interface ServerMessage {
  header?: { event?: string; error_code?: string; error_message?: string; task_id?: string };
  payload?: {
    output?: { sentence?: ServerSentence };
    usage?: AsrUsage;
  };
}

export interface ServerSentence {
  sentence_id?: number;
  sentence_end?: boolean;
  /** 心跳包置 true 且 `sentence_id=0` —— **必须跳过**，它不是句子 */
  heartbeat?: boolean;
  text?: string;
  begin_time?: number;
  end_time?: number;
  words?: unknown[];
}

/**
 * WebSocket 的最小抽象。
 *
 * 只暴露会话真正需要的部分，所以测试用十几行假实现就能替代。
 *
 * ⚠️ `bufferedAmount` 是**实时场景的关键**：网络变慢时若不看它，音频会越积越多，
 * 字幕延迟无限增长（积压的音频还会被服务端按时间轴处理，等于「越听越慢」）。
 * 直播工具的正确取舍是**宁可丢帧，也不要延迟累积**。
 */
export interface SocketLike {
  send(data: string | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  onOpen(cb: () => void): void;
  onMessage(cb: (data: unknown) => void): void;
  onError(cb: (err: unknown) => void): void;
  onClose(cb: (info: { code: number; reason: string }) => void): void;
  /** 尚未发出的字节数；缺失时按 0 处理 */
  readonly bufferedAmount?: number;
}

export type SocketFactory = (url: string) => SocketLike;

/**
 * 会话对外可见的传输层状态。
 *
 * 与 PLAN §13.1 的 8 态 UI 状态机**不是一回事**：这里是「这条连接现在处于什么阶段」，
 * 上层再把它（结合重连计数、错误类型）映射成 `idle / degraded / reconnecting / …`。
 */
export type AsrState = 'idle' | 'connecting' | 'connected' | 'starting' | 'running' | 'finishing' | 'closed' | 'failed';
