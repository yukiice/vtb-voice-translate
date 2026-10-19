/**
 * 百炼 ASR 的协议层：**全部是纯函数**，不持有状态、不碰网络。
 *
 * 这样最容易被测到 —— 协议字段拼错是 M1 阶段最容易踩的坑，
 * 而它的代价很隐蔽（服务端只回一句含糊的错误，或者干脆不回）。
 * 从 `tools/m1-bench/lib/asr.mjs` 移植，保留已实测过的确切字段。
 */
import type { AsrEventName, AsrUsage, ServerMessage, ServerSentence } from './types';

/**
 * ⚠️ **D76 的结论：不要用 `qwen-audio-3.1-asr-flash-message`**。
 * 它的草稿路径把日语当中文识别（假名占比 0%，输出「就→哟→今天」这种），
 * 因为 `language_hints` 只对 `sentence_end=true` 生效 → 模式 1/2/3 全废。
 * `-streaming` 变体同代，但草稿是正确日语且单调递增。
 */
export const DEFAULT_MODEL = 'qwen-audio-3.1-asr-flash-streaming';

export const DEFAULT_ENDPOINT = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';

export interface AsrParameters {
  /** ASR 只吃 16kHz mono 16bit PCM（我们的管线正好产出这个） */
  format: string;
  sample_rate: number;
  /** 默认 false，**必须显式开**，否则拿不到草稿（D45） */
  intermediate_result_enabled: boolean;
  /** 默认 false，**必须显式开**（D45 / D102：静默时靠它保活） */
  heartbeat: boolean;
  /** ⚠️ 仅对最终结果生效，中间结果的语种由模型自己判（§5.11 的关键限制） */
  language_hints: string[];
  /** VAD 断句静音阈值 ms，范围 [200, 6000]；调小可让字幕更快定型，但会切碎长句 */
  max_sentence_silence: number;
  [key: string]: unknown;
}

/** 与 M1 探针实测一致的一组参数（D45） */
export const DEFAULT_PARAMS: AsrParameters = {
  format: 'pcm',
  sample_rate: 16000,
  intermediate_result_enabled: true,
  heartbeat: true,
  language_hints: ['ja'],
  max_sentence_silence: 800,
};

/** 把密钥从任何要进日志的字符串里抹掉 */
export function redactSecrets(input: string): string {
  return input.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***REDACTED***');
}

/**
 * 拼接入地址。
 *
 * ⚠️ 用 `?api_key=` 查询参数而不是 `Authorization` 头：浏览器 `WebSocket`
 * **无法设置请求头**（D43 / §5.10），这条路径是 α 架构（纯扩展、无后端）的生死线，已实测通过。
 */
export function buildEndpointUrl(endpoint: string, apiKey: string): string {
  return `${endpoint}?api_key=${encodeURIComponent(apiKey)}`;
}

export interface RunTaskOptions {
  taskId: string;
  model: string;
  params: Partial<AsrParameters>;
  /** `input.context`：术语表 / 前文（D22 / D37）。两类各最多 5 条、合计 ≤400 字符 */
  context?: unknown;
}

/**
 * 构造 `run-task`（返回 JSON 字符串，直接 send）。
 *
 * 字段名与层级**一个都不能猜** —— 这是 M1 实测过的形状。
 */
export function buildRunTask({ taskId, model, params, context }: RunTaskOptions): string {
  return JSON.stringify({
    header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
    payload: {
      task_group: 'audio',
      task: 'asr',
      function: 'recognition',
      model,
      // 没有上下文时给空对象，不要省略 input 字段
      input: context ? { context } : {},
      parameters: { ...DEFAULT_PARAMS, ...params },
    },
  });
}

export function buildFinishTask(taskId: string): string {
  return JSON.stringify({
    header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
    payload: { input: {} },
  });
}

export interface ParsedServerMessage {
  event: AsrEventName;
  raw: ServerMessage;
  /** 仅 `result-generated` 且**非心跳**时有值 */
  sentence?: ServerSentence;
  /** 服务端返回的是**任务累计值**，不是增量（D79：因此不存在隐藏累积） */
  usage?: AsrUsage;
  failure?: { code?: string; message: string };
}

const KNOWN_EVENTS: readonly string[] = ['task-started', 'result-generated', 'task-finished', 'task-failed'];

/**
 * 解析一条服务端消息。
 *
 * 返回 `null` 表示**这条数据不可用**（非文本 / 非 JSON）—— 刻意不抛异常：
 * 一条脏消息不该打断整条实时链路，但也不能静默吞掉（调用方应计数并在日志里体现）。
 */
export function parseServerMessage(data: unknown, at: number): ParsedServerMessage | null {
  if (typeof data !== 'string') return null;

  let raw: ServerMessage;
  try {
    raw = JSON.parse(data) as ServerMessage;
  } catch {
    return null;
  }

  const name = raw.header?.event ?? 'unknown';
  const event: AsrEventName = KNOWN_EVENTS.includes(name) ? (name as AsrEventName) : 'unknown';

  const parsed: ParsedServerMessage = { event, raw };

  if (event === 'result-generated') {
    const usage = raw.payload?.usage;
    if (usage) parsed.usage = usage;

    const s = raw.payload?.output?.sentence;
    // ⚠️ 心跳包有 sentence 字段但 sentence_id=0 且 heartbeat=true —— 不是句子，必须排除。
    //    实测：30 分钟实时语音里一条心跳都没有；纯静音时约每 56 秒一条（D102）。
    if (s && !s.heartbeat) parsed.sentence = s;
  } else if (event === 'task-finished') {
    // ⚠️ 实测：task-finished **通常不带 usage**，usage 只出现在 sentence_end 那条
    //    result-generated 上（与官方示例不符）。所以这里只在真的有值时取，别覆盖成 null。
    const usage = raw.payload?.usage;
    if (usage) parsed.usage = usage;
  } else if (event === 'task-failed') {
    parsed.failure = {
      code: raw.header?.error_code,
      message: redactSecrets(raw.header?.error_message ?? '任务失败'),
    };
  }

  return parsed;
}
