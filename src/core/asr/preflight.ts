/**
 * API Key 预检（D72）。
 *
 * 为什么需要它：**WebSocket 握手失败时浏览器拿不到 HTTP 状态码**
 * （实测只给 `close 1006` + 空 reason，`error` 是个空 `TypeError`），
 * 所以光靠 WS 无法区分「Key 无效」和「网络不通」。
 *
 * 解法就是这里：先用一次普通 HTTPS `fetch`（**可以**带 `Authorization` 头、**也能**读状态码）
 * 把原因定性，再去连 WS。这个套路在 M1 已实测过（`probe.mjs` 的 preflight）。
 *
 * 分层约束：`core/` 零 Chrome API。`fetch` / `AbortController` 来自 WebWorker lib，
 * 而且 `fetchImpl` 可注入 —— 测试里不需要真网络。
 */

import type { FetchLike } from '@/core/http';

export const PREFLIGHT_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/models';

export interface PreflightResult {
  /** 能否据此断定「Key 可用」 */
  ok: boolean;
  /** HTTP 状态码；0 表示根本没连上 */
  status: number;
  /** 直接可展示给用户的中文说明 */
  message: string;
}

/**
 * 用一次 HTTPS 请求验证 Key。
 *
 * 状态码的含义（来自 M1 实测）：
 *   - 200            → Key 有效（连模型列表都读得到）
 *   - 401 / 403      → Key 无效、被禁用或欠费 —— **重试没有意义**，属于 §13.2 的第 1 类故障
 *   - 429            → 限流（Key 本身没问题）
 *   - 0              → 网络不通（代理/防火墙），与 Key 无关
 */
export async function checkApiKey(
  apiKey: string,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  timeoutMs = 10000,
): Promise<PreflightResult> {
  const key = apiKey.trim();
  if (!key) return { ok: false, status: 0, message: '请先填入 API Key' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(PREFLIGHT_URL, {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    return { ok: res.status === 200, status: res.status, message: explain(res.status) };
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      message: aborted ? `请求超时（${timeoutMs}ms），检查网络` : '连不上 dashscope.aliyuncs.com（检查代理/防火墙）',
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 状态码 → 用户能照做的中文提示 */
export function explain(status: number): string {
  switch (status) {
    case 200:
      return '✅ Key 有效，连接正常';
    case 401:
    case 403:
      return '⛔ Key 无效、被禁用或欠费 —— 请到百炼控制台确认（重试无效）';
    case 429:
      return '⚠ 触发限流（Key 本身没问题），稍后再试';
    case 0:
      return '连不上服务器';
    default:
      return `⚠ 意外状态 HTTP ${status}`;
  }
}
