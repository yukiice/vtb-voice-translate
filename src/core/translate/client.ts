/**
 * 翻译客户端（百炼 compatible-mode / OpenAI 兼容接口）。
 *
 * 配置与 M1 探针实测一致（D86）：
 *   - 模型 `qwen-flash`：候选里**最快**的 LLM（实测 361ms），推翻率 12.5%，硬编谓语 0/13
 *   - `temperature: 0.1`：字幕要稳定，不要创作
 *   - `enable_thinking: false`：思考模式会显著增加首字延迟，字幕场景不可接受
 *
 * 分层：`FetchLike` 注入，所以整个请求/解析路径都能用假 fetch 单测，不碰真网络。
 */
import type { FetchLike } from '@/core/http';
import type { ChatMessage } from './prompt';

export const DEFAULT_TRANSLATE_ENDPOINT = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
export const DEFAULT_TRANSLATE_MODEL = 'qwen-flash';

/**
 * 超时 5s。
 *
 * 这是一个**产品取舍**：直播字幕宁可显示日文原文，也不要让一行中文晚到十几秒——
 * 那行译文到达时，观众早就看过上下文了（§13.2 故障 6：翻译失败 → 显示日文原文，转 degraded）。
 * qwen-flash 实测 361ms，5s 已是 10 倍余量。
 */
const DEFAULT_TIMEOUT_MS = 5000;

export interface TranslateUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

export interface TranslateResult {
  text: string;
  /** 端到端耗时（ms）—— 用于延迟预算与后续调优参照 */
  ms: number;
  usage?: TranslateUsage;
}

export interface TranslateClientOptions {
  apiKey: string;
  model?: string;
  endpoint?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export interface ParsedCompletion {
  text: string;
  usage?: TranslateUsage;
}

/**
 * 解析 OpenAI 兼容响应（同时容忍百炼原生形状 `output.choices`）。
 *
 * 纯函数，便于单测各种畸形响应 —— 解析失败要让调用方看得见，
 * 不能返回空字符串当"翻译成功"。
 */
export function parseCompletion(body: string): ParsedCompletion {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(`翻译响应不是 JSON：${body.slice(0, 120)}`);
  }

  const root = json as {
    choices?: { message?: { content?: unknown } }[];
    output?: { choices?: { message?: { content?: unknown } }[] };
    usage?: TranslateUsage;
  };

  const content = root.choices?.[0]?.message?.content ?? root.output?.choices?.[0]?.message?.content;
  const text = typeof content === 'string' ? content.trim() : '';
  return { text, ...(root.usage ? { usage: root.usage } : {}) };
}

export async function translate(
  messages: readonly ChatMessage[],
  options: TranslateClientOptions,
): Promise<TranslateResult> {
  const {
    apiKey,
    model = DEFAULT_TRANSLATE_MODEL,
    endpoint = DEFAULT_TRANSLATE_ENDPOINT,
    fetchImpl = globalThis.fetch as unknown as FetchLike,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  if (!apiKey.trim()) throw new Error('缺少 API Key');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, temperature: 0.1, enable_thinking: false }),
      signal: controller.signal,
    });

    const body = await res.text();
    const ms = Date.now() - startedAt;

    if (!res.ok) throw new Error(`翻译请求失败 HTTP ${res.status}：${body.slice(0, 200)}`);

    const parsed = parseCompletion(body);
    if (!parsed.text) throw new Error('翻译返回了空文本');

    return { text: parsed.text, ms, ...(parsed.usage ? { usage: parsed.usage } : {}) };
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw new Error(`翻译超时（${timeoutMs}ms）`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
