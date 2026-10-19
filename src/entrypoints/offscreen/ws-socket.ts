/**
 * 真实 `WebSocket` 的适配器 —— 把浏览器 WebSocket 包成 `core/asr` 要求的 `SocketLike`。
 *
 * 这是「Chrome API / 浏览器全局」与「纯逻辑 core」之间的那一层贴纸：
 * core 只认识接口，所以它的协议解析与状态机能用假 socket 单测；
 * 而真机上的连接细节（binaryType、事件对象形状）全部收在这一个文件里。
 */
import type { SocketFactory, SocketLike } from '@/core/asr/types';

/**
 * ⚠️ 关于错误：WebSocket 握手失败时（401/403/网络不通），浏览器**只**给出
 * 一个空的 `error` 事件 + `close 1006`，**拿不到 HTTP 状态码**（M1 实测）。
 * 所以别指望在这里分辨原因 —— 那是 `core/asr/preflight.ts` 的活儿（D72）：
 * 先用一次 HTTPS 请求把原因定性，再来连 WS。
 */
class BrowserWebSocket implements SocketLike {
  readonly #ws: WebSocket;

  constructor(url: string) {
    this.#ws = new WebSocket(url);
    // 服务端只发文本；设成 arraybuffer 是为了让意外收到的二进制保持原样（便于排查）
    this.#ws.binaryType = 'arraybuffer';
  }

  get bufferedAmount(): number {
    return this.#ws.bufferedAmount;
  }

  send(data: string | ArrayBufferView): void {
    if (typeof data === 'string') {
      this.#ws.send(data);
      return;
    }
    // 音频帧走二进制。⚠️ 绝不能 JSON 化 —— M1 踩过：会被当成
    // `{"0":0,"1":0,...}` 这样的文本发出去，服务端报 `Missing required parameter 'header'`。
    //
    // 这里显式构造 Uint8Array 视图而不是直接传 Int16Array：`WebSocket.send` 的参数类型是
    // `BufferSource`，它要求底层是 `ArrayBuffer`，而视图的 `buffer` 静态类型是 `ArrayBufferLike`
    // （含 SharedArrayBuffer）。构造视图是零拷贝的，只是把类型收窄。
    const view = new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
    this.#ws.send(view);
  }

  close(code?: number, reason?: string): void {
    try {
      // 1000 = normal closure；readyState 已是 CLOSING/CLOSED 时再调会抛，故包起来
      this.#ws.close(code ?? 1000, reason);
    } catch {
      /* 已经关了，忽略 */
    }
  }

  onOpen(cb: () => void): void {
    this.#ws.onopen = () => cb();
  }

  onMessage(cb: (data: unknown) => void): void {
    this.#ws.onmessage = (ev: MessageEvent) => cb(ev.data);
  }

  onError(cb: (err: unknown) => void): void {
    this.#ws.onerror = () => {
      // 事件对象没有有用信息（实测：空的 TypeError），给出能读的替代信息
      cb(new Error(`WebSocket 连接错误（readyState=${this.#ws.readyState}）`));
    };
  }

  onClose(cb: (info: { code: number; reason: string }) => void): void {
    this.#ws.onclose = (ev: CloseEvent) => cb({ code: ev.code, reason: ev.reason ?? '' });
  }
}

export function createWebSocketFactory(): SocketFactory {
  return (url: string): SocketLike => new BrowserWebSocket(url);
}
