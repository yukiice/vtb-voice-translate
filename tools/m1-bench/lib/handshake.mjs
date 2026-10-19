/**
 * 裸 TLS 的 WebSocket 握手探测器。
 *
 * 为什么需要它：浏览器和 Node 的 `WebSocket` 在握手失败时都只给
 * 「error（无信息）+ close 1006（空 reason）」，**拿不到 HTTP 状态码**。
 * 于是「Key 无效」和「网络不通」在应用层无法区分 —— 这对 D62 的
 * 「测试」按钮是个真问题（见 PLAN §13.1 的 auth_failed vs 网络错误）。
 *
 * 探针里用裸 TLS 直接发握手请求，就能读到服务端真实的响应状态行，
 * 从而把两类失败彻底分开。真实扩展里没有这个能力，需要另想办法。
 */
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';

/**
 * @param {{url:string, apiKey?:string, origin?:string, extraHeaders?:Record<string,string>, timeoutMs?:number}} o
 * @returns {Promise<{status:number, statusText:string, headers:Record<string,string>, raw:string, ms:number}>}
 */
export function rawHandshake({ url, apiKey, origin, extraHeaders = {}, timeoutMs = 15000 }) {
  const u = new URL(url);
  if (apiKey) u.searchParams.set('api_key', apiKey);

  const wsKey = randomBytes(16).toString('base64');
  const headers = {
    Host: u.host,
    Upgrade: 'websocket',
    Connection: 'Upgrade',
    'Sec-WebSocket-Key': wsKey,
    'Sec-WebSocket-Version': '13',
    'User-Agent': 'vtb-voice-translate/m1-probe',
    ...(origin ? { Origin: origin } : {}),
    ...extraHeaders,
  };

  const req = [`GET ${u.pathname}${u.search} HTTP/1.1`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), '', ''].join('\r\n');
  const started = Date.now();

  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: u.hostname, port: u.port ? Number(u.port) : 443, servername: u.hostname }, () => {
      sock.write(req);
    });
    let buf = '';
    const done = (fn) => {
      clearTimeout(timer);
      sock.destroy();
      fn();
    };
    const timer = setTimeout(() => done(() => reject(new Error(`握手超时 ${timeoutMs}ms`))), timeoutMs);

    sock.on('data', (d) => {
      buf += d.toString('latin1');
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = buf.slice(0, end);
      const lines = head.split('\r\n');
      const m = lines[0].match(/^HTTP\/1\.[01] (\d{3})\s*(.*)$/);
      const hs = {};
      for (const line of lines.slice(1)) {
        const i = line.indexOf(':');
        if (i > 0) hs[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      done(() =>
        resolve({
          status: m ? Number(m[1]) : 0,
          statusText: m ? m[2] : lines[0],
          headers: hs,
          raw: m ? '' : head.slice(0, 400),
          ms: Date.now() - started,
        }),
      );
    });

    sock.on('error', (e) => done(() => reject(new Error(`TLS/网络错误: ${e.message}`))));
    sock.on('close', () => done(() => reject(new Error('连接在收到响应前关闭'))));
  });
}

/** 把一次探测结果翻译成人话 */
export function explainHandshake(r) {
  if (r.status === 101) return { level: 'ok', text: '鉴权通过，可升级为 WebSocket' };
  if (r.status === 401) return { level: 'auth', text: 'API Key 无效或已失效' };
  if (r.status === 403) return { level: 'auth', text: 'API Key 被拒绝（无权访问该模型/业务空间）' };
  if (r.status === 404) return { level: 'bad', text: '路径或模型不存在 / 业务空间 ID 不对' };
  if (r.status === 429) return { level: 'limit', text: '触发限流（RPM 超限）' };
  if (r.status >= 500) return { level: 'server', text: '服务端错误' };
  return { level: 'bad', text: r.statusText || `未知状态 ${r.status}` };
}
