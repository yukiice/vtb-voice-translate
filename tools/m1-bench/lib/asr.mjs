/**
 * 百炼 Qwen-Audio-ASR WebSocket 客户端（M1 探针用）。
 *
 * 协议依据官方文档（2026-10 抓取）：
 *   - 接入指南      /zh/model-studio/qwen-asr-message-websocket-api
 *   - 客户端事件    /zh/model-studio/qwen-asr-message-client-events
 *   - 服务端事件    /zh/model-studio/qwen-asr-message-server-events
 *
 * ⚠️ 这里刻意只用 `?api_key=` 查询参数鉴权，不用 Authorization 头 ——
 * 因为要验证的正是「浏览器 WebSocket 无法设请求头」这个前提下的可行路径（PLAN §5.10 / D43）。
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

export const DEFAULT_ENDPOINT = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';
/**
 * ⚠️ 实测结论（D76）：不要用 `qwen-audio-3.1-asr-flash-message`。
 * 它的草稿路径把日语当中文识别（假名占比 0%，输出「就→哟→今天」这种），
 * 因为 `language_hints` 只对 sentence_end=true 生效 → 模式 1/2/3 全废。
 * `-streaming` 变体同代但草稿是正确日语且单调递增。
 */
export const DEFAULT_MODEL = 'qwen-audio-3.1-asr-flash-streaming';

/** 业务空间专属域名（官方推荐，需 WorkspaceId） */
export const beijingEndpoint = (workspaceId) =>
  `wss://${workspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference`;

/** 文档默认值，仅列出我们关心的 */
export const DEFAULT_PARAMS = {
  format: 'pcm',
  sample_rate: 16000,
  intermediate_result_enabled: true, // 默认 false，必须显式开
  heartbeat: true,                   // 默认 false，必须显式开
  language_hints: ['ja'],            // ⚠️ 仅对最终结果生效
  max_sentence_silence: 800,
};

/** 把密钥从任何字符串里抹掉，避免误打进日志 */
const redact = (s) => String(s).replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***REDACTED***');

export class AsrSession {
  /** @type {WebSocket} */
  #ws;
  #apiKey;
  #endpoint;
  #model;
  #params;
  #taskId;
  #verbose;
  #openResolve = null;
  #openReject = null;
  #waiters = new Map(); // event名 -> resolver 数组

  /** 收到的全部服务端事件，按时间排序 */
  events = [];
  /** 句子表：sentence_id -> {drafts:[], final:null, t0, tFinal} */
  sentences = new Map();
  /** 建连/音频/事件的绝对时间戳，用于算延迟 */
  marks = {};
  /** task-finished / task-failed 的最终 usage */
  finalUsage = null;
  failure = null;
  /** 连接关闭的 code/reason —— soak 测稳定性时需要区分「服务端断开」与「自己关的」 */
  closeInfo = null;

  constructor({ apiKey, model = DEFAULT_MODEL, endpoint = DEFAULT_ENDPOINT, params = {}, verbose = false }) {
    if (!apiKey) throw new Error('缺少 API Key');
    this.#apiKey = apiKey;
    this.#model = model;
    this.#endpoint = endpoint;
    this.#params = { ...DEFAULT_PARAMS, ...params };
    this.#verbose = verbose;
  }

  get taskId() {
    return this.#taskId;
  }

  /** 建立连接。返回握手耗时（ms）。 */
  async open(timeoutMs = 20000) {
    const url = `${this.#endpoint}?api_key=${encodeURIComponent(this.#apiKey)}`;
    this.marks.connectStart = Date.now();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`握手超时 ${timeoutMs}ms`)), timeoutMs);
      let ws;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        clearTimeout(timer);
        return reject(new Error(`WebSocket 构造失败: ${redact(e.message)}`));
      }
      ws.binaryType = 'arraybuffer';
      this.#ws = ws;

      ws.onopen = () => {
        clearTimeout(timer);
        this.marks.connected = Date.now();
        resolve(this.marks.connected - this.marks.connectStart);
      };
      ws.onerror = (e) => {
        const msg = redact(e?.message || e?.error?.message || '连接错误');
        // 握手失败时（401/403）这里会先于 onclose 触发
        clearTimeout(timer);
        this.failure = { kind: 'handshake', message: msg };
        reject(new Error(`握手失败: ${msg}`));
      };
      ws.onclose = (e) => {
        clearTimeout(timer);
        this.marks.closed = Date.now();
        this.closeInfo = { code: e.code, reason: redact(e.reason || ''), at: this.marks.closed };
        this.#emit('__closed', { code: e.code, reason: redact(e.reason || '') });
        if (!this.marks.connected) reject(new Error(`连接被关闭 code=${e.code} ${redact(e.reason || '')}`));
      };
      ws.onmessage = (e) => this.#onMessage(e.data);
    });
  }

  /** 发送 run-task 并等待 task-started */
  async start(timeoutMs = 15000) {
    this.#taskId = randomUUID();
    const msg = {
      header: { action: 'run-task', task_id: this.#taskId, streaming: 'duplex' },
      payload: {
        task_group: 'audio',
        task: 'asr',
        function: 'recognition',
        model: this.#model,
        input: this.#context ? { context: this.#context } : {},
        parameters: this.#params,
      },
    };
    this.marks.runTaskSent = Date.now();
    this.#send(msg);
    await this.#waitFor('task-started', timeoutMs);
    return this.marks.taskStarted - this.marks.runTaskSent;
  }

  #context = null;
  /** 注入上下文（术语表 / 前文），必须在 start() 之前调用 */
  setContext(context) {
    this.#context = context;
    return this;
  }

  /**
   * 分块发送音频。
   * @param {Buffer} pcm 裸 PCM
   * @param {{chunkMs?:number, speed?:number}} [opts] speed=1 为实时；>1 加速（省等待时间）
   * @returns {Promise<{firstResultAt:number|null, sentMs:number}>}
   */
  async sendPcm(pcm, { chunkMs = 100, speed = 1 } = {}) {
    const chunkBytes = Math.max(2, Math.round((chunkMs / 1000) * 16000) * 2);
    const gapMs = speed > 0 ? chunkMs / speed : 0;
    this.marks.audioStart = Date.now();
    const t0 = this.marks.audioStart;
    const firstResultBefore = this.events.length;

    for (let off = 0; off < pcm.length; off += chunkBytes) {
      const chunk = pcm.subarray(off, Math.min(off + chunkBytes, pcm.length));
      // Buffer 的 subarray 可能带 offset，转成独立 Uint8Array 再发
      this.#sendBinary(new Uint8Array(chunk));
      if (gapMs > 0) await sleep(gapMs);
    }
    this.marks.audioSent = Date.now();

    let firstResultAt = null;
    if (this.events.length > firstResultBefore) firstResultAt = this.events[firstResultBefore].t;
    return { firstResultAt, sentMs: this.marks.audioSent - t0 };
  }

  /** 发送 finish-task 并等待 task-finished（或 task-failed） */
  async finish(timeoutMs = 30000, { keepOpen = false } = {}) {
    this.marks.finishSent = Date.now();
    this.#send({
      header: { action: 'finish-task', task_id: this.#taskId, streaming: 'duplex' },
      payload: { input: {} },
    });
    const ev = await this.#raceFor(['task-finished', 'task-failed'], timeoutMs);
    if (ev.header?.event === 'task-failed') {
      this.failure = {
        kind: 'task',
        code: ev.header.error_code,
        message: redact(ev.header.error_message),
      };
      if (!keepOpen) this.close();
      throw new Error(`任务失败 [${ev.header.error_code}] ${redact(ev.header.error_message)}`);
    }
    this.finalUsage = ev.payload?.usage ?? this.finalUsage;
    return this.finalUsage;
  }

  /** 取最后一次看到的 usage（不论来自哪个事件） */
  get usage() {
    return this.finalUsage;
  }

  close() {
    try {
      if (this.#ws && this.#ws.readyState <= 1) this.#ws.close();
    } catch {
      /* 忽略 */
    }
  }

  // ── 内部 ──

  #send(obj) {
    const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
    if (this.#verbose) console.error('  →', redact(text).slice(0, 300));
    this.#ws.send(text);
  }

  /**
   * 发二进制音频帧。
   * ⚠️ 必须与 #send 分开 —— 早期版本把 Uint8Array 也走了 JSON.stringify，
   * 结果音频被当成 "{"0":0,"1":0,...}" 这种文本发出去，服务端报
   * `Missing required parameter 'header'`。二进制就是二进制，不能过 JSON。
   */
  #sendBinary(u8) {
    if (this.#verbose) console.error(`  → [binary] ${u8.byteLength} bytes`);
    this.#ws.send(u8);
  }

  #onMessage(data) {
    const t = Date.now();
    if (typeof data !== 'string') {
      // 服务端只发文本事件，收到二进制说明协议有变
      if (this.#verbose) console.error('  ← [binary]', data.byteLength, 'bytes');
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      if (this.#verbose) console.error('  ← [非JSON]', redact(data).slice(0, 200));
      return;
    }
    const name = msg.header?.event || 'unknown';
    if (this.#verbose) console.error('  ←', name, redact(data).slice(0, 300));

    const rec = { t, event: name, raw: msg };
    this.events.push(rec);

    if (name === 'task-started') this.marks.taskStarted = t;
    if (name === 'result-generated') this.#absorbSentence(msg, t);
    if (name === 'task-finished') {
      // ⚠️ 实测：qwen-audio-3.1-asr-flash-message 的 task-finished **不带 usage**，
      // usage 只出现在 sentence_end=true 那条 result-generated 上（与文档示例不符）。
      // 所以这里只在真的带了 usage 时才覆盖，否则会把已收到的累计值洗成 null。
      const u = msg.payload?.usage;
      if (u) this.finalUsage = u;
      this.marks.taskFinished = t;
    }
    if (name === 'task-failed') {
      this.failure = {
        kind: 'task',
        code: msg.header?.error_code,
        message: redact(msg.header?.error_message),
      };
    }

    this.#emit(name, msg);
  }

  #absorbSentence(msg, t) {
    const s = msg.payload?.output?.sentence;
    const usage = msg.payload?.usage;
    if (usage) this.finalUsage = usage; // 每次事件都是任务累计值
    if (!s || s.heartbeat) return;      // 心跳包 sentence_id=0，跳过

    const id = s.sentence_id;
    if (!this.sentences.has(id)) {
      this.sentences.set(id, { id, drafts: [], final: null, t0: t, tFinal: null, words: [] });
    }
    const rec = this.sentences.get(id);
    if (s.sentence_end) {
      rec.final = s.text;
      rec.words = s.words || [];
      rec.tFinal = t;
      rec.endTime = s.end_time;
      rec.beginTime = s.begin_time;
    } else {
      if (s.text) rec.drafts.push({ t, text: s.text });
      if (s.begin_time != null) rec.beginTime = s.begin_time;
    }
  }

  #emit(name, payload) {
    const arr = this.#waiters.get(name);
    if (arr?.length) {
      this.#waiters.delete(name);
      for (const r of arr) r(payload);
    }
  }

  #waitFor(name, timeoutMs) {
    const hit = this.events.find((e) => e.event === name);
    if (hit) return Promise.resolve(hit.raw);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const seen = [...new Set(this.events.map((e) => e.event))].join(', ') || '(无)';
        reject(new Error(`等 ${name} 超时 ${timeoutMs}ms；已收到事件: ${seen}`));
      }, timeoutMs);
      const wrap = (p) => {
        clearTimeout(timer);
        resolve(p);
      };
      if (!this.#waiters.has(name)) this.#waiters.set(name, []);
      this.#waiters.get(name).push(wrap);
    });
  }

  #raceFor(names, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const seen = [...new Set(this.events.map((e) => e.event))].join(', ') || '(无)';
        reject(new Error(`等 ${names.join('|')} 超时 ${timeoutMs}ms；已收到事件: ${seen}`));
      }, timeoutMs);
      for (const n of names) {
        const hit = this.events.find((e) => e.event === n);
        if (hit) {
          clearTimeout(timer);
          return resolve(hit.raw);
        }
        if (!this.#waiters.has(n)) this.#waiters.set(n, []);
        this.#waiters.get(n).push((p) => {
          clearTimeout(timer);
          resolve(p);
        });
      }
    });
  }
}

/** Token → 人民币（元）。北京地域价格：输入 ¥6/M，输出 ¥4.5/M */
export const tokenCost = (usage) => {
  if (!usage) return 0;
  return ((usage.input_tokens || 0) * 6 + (usage.output_tokens || 0) * 4.5) / 1e6;
};

/** 元 → 分，便于展示 */
export const yuan = (v) => `¥${v.toFixed(4)}`;
