/**
 * HTTP 的最小抽象（`core/` 共用）。
 *
 * 为什么单独抽出来：`preflight`（验证 Key）与 `translate`（调翻译）都要发请求、
 * 都要在测试里被替换成假实现。共用一个类型，避免两处各自声明导致调用签名慢慢分叉。
 *
 * 这里**只声明我们真正用到的部分** —— fetch 的完整类型太大，而且 `Response` 的
 * 泛型在 TS 7 里对 `ArrayBufferLike` 很敏感（WS 适配器已经踩过一次）。
 */

export interface HttpResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export interface HttpRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export type FetchLike = (url: string, init?: HttpRequestInit) => Promise<HttpResponseLike>;

/** 一个把 `fetch` 适配成 `FetchLike` 的小工具（真实环境与测试都用得上） */
export function toFetchLike(fetchImpl: unknown): FetchLike {
  return fetchImpl as FetchLike;
}
