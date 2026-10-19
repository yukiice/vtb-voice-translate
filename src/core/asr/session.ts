/**
 * 百炼 ASR 会话（`core/asr/` 的状态层）。
 *
 * 从 `tools/m1-bench/lib/asr.mjs` 移植，但把两件事换掉了：
 *   1. **WebSocket 改为注入**（`SocketLike`）→ 协议与状态机可在 Vitest 里跑，不碰真网络；
 *   2. **`sendPcm` 的节流循环去掉** → 产品里音频是 worklet 按 64ms 块推过来的（本身就是实时速率），
 *      不需要再模拟节奏；取而代之的是**背压处理**（见 `sendAudio`）。
 *
 * 状态权威在 offscreen（§6.2）：本对象就活在那个上下文里。
 */
import {
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
  buildEndpointUrl,
  buildFinishTask,
  buildRunTask,
  parseServerMessage,
  redactSecrets,
  type AsrParameters,
} from './protocol';
import type {
  AsrEvent,
  AsrEventName,
  AsrFailure,
  AsrSentence,
  AsrState,
  AsrUsage,
  CloseInfo,
  ServerMessage,
  ServerSentence,
  SocketFactory,
  SocketLike,
} from './types';

/**
 * 积压阈值：约 2 秒音频（16000 样点 × 2 字节 × 2）。
 *
 * 超过就**丢帧**而不是继续排队 —— 直播字幕的取舍很明确：
 * 积压的音频会让字幕越听越滞后（而且服务端仍按时间轴计费），
 * 宁可丢一小段，也不要让延迟无限增长。
 */
const DEFAULT_MAX_BUFFERED_BYTES = 16000 * 2 * 2;

/** 一个挂起的「等事件」条目：三条结算路径（事件到达 / 超时 / 连接关闭）共用 */
interface Waiter {
  resolve: (msg: ServerMessage) => void;
  reject: (err: Error) => void;
}

export interface AsrSessionOptions {
  apiKey: string;
  socketFactory: SocketFactory;
  model?: string;
  endpoint?: string;
  params?: Partial<AsrParameters>;
  maxBufferedBytes?: number;
  /** 注入任务 ID 生成器（测试可固定它） */
  newTaskId?: () => string;
}

export interface AsrSessionCallbacks {
  /** 每次草稿推进 / 定稿时回调 —— 字幕层的数据源 */
  onSentence?: (sentence: AsrSentence, kind: 'draft' | 'final') => void;
  /** 服务端返回的 usage 是**任务累计值**（D79：所以成本面板不需要自己累加） */
  onUsage?: (usage: AsrUsage) => void;
  onClose?: (info: CloseInfo) => void;
  onFailure?: (failure: AsrFailure) => void;
}

function defaultTaskId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `t-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

export class BangleAsrSession {
  readonly #apiKey: string;
  readonly #model: string;
  readonly #endpoint: string;
  readonly #params: Partial<AsrParameters>;
  readonly #socketFactory: SocketFactory;
  readonly #newTaskId: () => string;
  readonly #maxBufferedBytes: number;
  readonly #cb: AsrSessionCallbacks;

  #socket: SocketLike | null = null;
  #taskId: string | null = null;
  #state: AsrState = 'idle';
  #failure: AsrFailure | null = null;
  #closeInfo: CloseInfo | null = null;
  #usage: AsrUsage | null = null;
  #opened = false;
  #selfClosing = false;
  #droppedFrames = 0;
  #droppedBytes = 0;
  #badMessages = 0;

  readonly #events: AsrEvent[] = [];
  readonly #sentences = new Map<number, AsrSentence>();
  /**
   * 正在等待的事件。
   *
   * ⚠️ 必须同时存 `reject`：`task-failed` / 连接关闭时若只等 `task-started`，
   * `#waitFor` 会**空转满超时**（默认 15s）才返回。在没有重连的时候这只是慢；
   * 加上重连之后就是致命的 —— 每次失败都要白等 15 秒才去重试。
   */
  readonly #waiters = new Map<AsrEventName, Waiter[]>();
  /** 关闭/失败时用来打断所有挂起等待的原因；置位后新建的等待一律立即拒绝 */
  #abortReason: string | null = null;

  constructor(options: AsrSessionOptions, callbacks: AsrSessionCallbacks = {}) {
    if (!options.apiKey) throw new Error('缺少 API Key');
    this.#apiKey = options.apiKey;
    this.#model = options.model ?? DEFAULT_MODEL;
    this.#endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.#params = options.params ?? {};
    this.#socketFactory = options.socketFactory;
    this.#newTaskId = options.newTaskId ?? defaultTaskId;
    this.#maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    this.#cb = callbacks;
  }

  get state(): AsrState {
    return this.#state;
  }
  get taskId(): string | null {
    return this.#taskId;
  }
  get usage(): AsrUsage | null {
    return this.#usage;
  }
  get closeInfo(): CloseInfo | null {
    return this.#closeInfo;
  }
  get failure(): AsrFailure | null {
    return this.#failure;
  }
  get sentences(): ReadonlyMap<number, AsrSentence> {
    return this.#sentences;
  }
  get events(): readonly AsrEvent[] {
    return this.#events;
  }
  /** 因背压丢弃的音频量 —— 它应当出现在状态里，而不是悄悄发生 */
  get dropped(): { frames: number; bytes: number } {
    return { frames: this.#droppedFrames, bytes: this.#droppedBytes };
  }
  get badMessages(): number {
    return this.#badMessages;
  }

  /** 建连。返回握手耗时（ms）。失败时区分「握手被拒」与「超时」。 */
  async open(timeoutMs = 20000): Promise<number> {
    this.#state = 'connecting';
    const url = buildEndpointUrl(this.#endpoint, this.#apiKey);
    const startedAt = Date.now();

    const socket = this.#socketFactory(url);
    this.#socket = socket;

    return new Promise<number>((resolve, reject) => {
      let settled = false;
      const settleOnce = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        fn();
      };
      const timer = setTimeout(() => {
        settleOnce(() => {
          this.#setFailure({ kind: 'handshake', message: `握手超时 ${timeoutMs}ms` });
          reject(new Error(`握手超时 ${timeoutMs}ms`));
        });
      }, timeoutMs);

      socket.onOpen(() => {
        settleOnce(() => {
          this.#opened = true;
          // 「已建连、但还没 run-task」是一个独立状态：它决定 sendAudio 能不能发
          this.#state = 'connected';
          resolve(Date.now() - startedAt);
        });
      });

      socket.onError((err) => {
        const message = redactSecrets(err instanceof Error ? err.message : String(err));
        settleOnce(() => {
          this.#setFailure({ kind: 'handshake', message });
          reject(new Error(`握手失败: ${message}`));
        });
      });

      // ⚠️ onmessage 要在 open 之前就挂上：task-started 可能在 resolve 之前就到
      socket.onMessage((data) => this.#onMessage(data));

      socket.onClose((info) => {
        this.#handleClose(info);
        settleOnce(() => reject(new Error(`连接被关闭 code=${info.code} ${redactSecrets(info.reason)}`)));
      });
    });
  }

  /** 发 `run-task` 并等待 `task-started`。返回往返耗时（ms）。 */
  async start(context?: unknown, timeoutMs = 15000): Promise<number> {
    if (!this.#socket || !this.#opened) throw new Error('尚未建连，不能 start');

    this.#taskId = this.#newTaskId();
    this.#state = 'starting';
    const startedAt = Date.now();
    this.#sendText(buildRunTask({ taskId: this.#taskId, model: this.#model, params: this.#params, context }));
    await this.#waitFor('task-started', timeoutMs);
    // ⚠️ 如果 `task-started` 在 `start()` 被调用之前就到了（`#waitFor` 直接命中事件缓存），
    //    `#onMessage` 已经把状态推到了 `running`，而上面那句 `#state = 'starting'` 又把它盖回去了，
    //    之后不会再有消息把它改回来 —— 结果是 `sendAudio` 永远返回 `false`，
    //    音频一块都发不出去，而日志上看着「已连接」。
    //    真机上这条路径会在「重连后服务端回包极快」时命中，所以必须补这一句。
    if (this.#state === 'starting') this.#state = 'running';
    return Date.now() - startedAt;
  }

  /**
   * 送一块 16kHz mono 16bit PCM。
   *
   * 返回 `false` 表示**这块被丢弃**（未建连 / 未 start / 背压超限）。
   * 调用方应当把 `dropped` 反映到状态上，不要静默。
   */
  sendAudio(pcm: Int16Array): boolean {
    const socket = this.#socket;
    if (!socket || this.#state !== 'running') return false;

    if ((socket.bufferedAmount ?? 0) > this.#maxBufferedBytes) {
      this.#droppedFrames++;
      this.#droppedBytes += pcm.byteLength;
      return false;
    }

    socket.send(pcm);
    return true;
  }

  /** 发 `finish-task`，等服务端收尾，返回最终 usage。 */
  async finish(timeoutMs = 30000): Promise<AsrUsage | null> {
    if (!this.#socket || !this.#taskId) return null;
    this.#state = 'finishing';
    this.#sendText(buildFinishTask(this.#taskId));
    await this.#raceFor(['task-finished', 'task-failed'], timeoutMs);
    return this.#usage;
  }

  /** 自己主动关闭。关闭后 `closeInfo.bySelf === true`，用于与「服务端断开」区分。 */
  close(code = 1000, reason = 'client-close'): void {
    this.#selfClosing = true;
    const socket = this.#socket;
    this.#socket = null;
    try {
      socket?.close(code, reason);
    } catch {
      /* 关闭失败无所谓：连接已经不可用 */
    }
  }

  // ── 内部 ──

  #sendText(payload: string): void {
    this.#socket?.send(payload);
  }

  #onMessage(data: unknown): void {
    const at = Date.now();
    const parsed = parseServerMessage(data, at);

    if (!parsed) {
      // 不抛异常（一条脏消息不该打断实时链路），但必须计数并让上层知道
      this.#badMessages++;
      this.#cb.onFailure?.({ kind: 'protocol', message: '收到无法解析的服务端消息' });
      return;
    }

    this.#events.push({ at, event: parsed.event, raw: parsed.raw });

    if (parsed.usage) {
      this.#usage = parsed.usage;
      this.#cb.onUsage?.(parsed.usage);
    }
    if (parsed.event === 'task-started') this.#state = 'running';
    if (parsed.failure) {
      this.#setFailure({ kind: 'task', code: parsed.failure.code, message: parsed.failure.message });
    }
    if (parsed.sentence) this.#absorbSentence(parsed.sentence, at);

    this.#emit(parsed.event, parsed.raw);
  }

  #absorbSentence(s: ServerSentence, at: number): void {
    const id = s.sentence_id ?? 0;
    let rec = this.#sentences.get(id);
    if (!rec) {
      rec = { id, drafts: [], final: null, t0: at, tFinal: null };
      this.#sentences.set(id, rec);
    }
    if (s.begin_time != null) rec.beginTime = s.begin_time;

    if (s.sentence_end) {
      rec.final = s.text ?? '';
      rec.tFinal = at;
      if (s.end_time != null) rec.endTime = s.end_time;
      this.#cb.onSentence?.(rec, 'final');
      return;
    }

    if (s.text) {
      rec.drafts.push({ at, text: s.text });
      this.#cb.onSentence?.(rec, 'draft');
    }
  }

  #handleClose(info: { code: number; reason: string }): void {
    const closeInfo: CloseInfo = {
      code: info.code,
      reason: redactSecrets(info.reason),
      at: Date.now(),
      bySelf: this.#selfClosing,
    };
    this.#closeInfo = closeInfo;
    if (this.#state !== 'failed') this.#state = 'closed';
    // 先叫醒挂起的等待者，再回调上层 —— 否则上层会先收到 onClose、开始重连，
    // 而这边的 start() 还在慢慢等它那个 15s 的超时。
    this.#abortWaiters(
      `连接已关闭 code=${closeInfo.code}${closeInfo.bySelf ? '（主动）' : ''} ${closeInfo.reason}`,
    );
    this.#cb.onClose?.(closeInfo);
  }

  #setFailure(failure: AsrFailure): void {
    this.#failure = failure;
    this.#state = 'failed';
    // 同样先打断等待：task-failed 之后连接就不可复用了，没必要等 task-started 超时
    this.#abortWaiters(`${failure.kind} 失败：${failure.message}`);
    this.#cb.onFailure?.(failure);
  }

  /** 唤醒并拒绝所有挂起的等待者 */
  #abortWaiters(reason: string): void {
    // ⚠️ 必须先置 `#abortReason` **再**判断有没有等待者。
    //    早先的写法是「没有等待者就 return」，于是当 `task-failed` / 连接关闭
    //    **早于** `start()` 到达时（重连后服务端回包很快就会这样），标志位永远不会被置位，
    //    随后 `start()` 的 `#waitFor('task-started')` 会白等满 15 秒。
    this.#abortReason = reason;
    if (this.#waiters.size === 0) return;
    const lists = [...this.#waiters.values()];
    this.#waiters.clear();
    for (const list of lists) {
      for (const w of list) w.reject(new Error(reason));
    }
  }

  #emit(name: AsrEventName, msg: ServerMessage): void {
    const list = this.#waiters.get(name);
    if (!list?.length) return;
    this.#waiters.delete(name);
    for (const w of list) w.resolve(msg);
  }

  #eventSummary(): string {
    const names = [...new Set(this.#events.map((e) => e.event))];
    return names.length ? names.join(', ') : '(无)';
  }

  #waitFor(name: AsrEventName, timeoutMs: number): Promise<ServerMessage> {
    const hit = this.#events.find((e) => e.event === name);
    if (hit) return Promise.resolve(hit.raw);
    if (this.#abortReason) return Promise.reject(new Error(this.#abortReason));
    return this.#register([name], timeoutMs);
  }

  #raceFor(names: readonly AsrEventName[], timeoutMs: number): Promise<ServerMessage> {
    for (const name of names) {
      const hit = this.#events.find((e) => e.event === name);
      if (hit) return Promise.resolve(hit.raw);
    }
    if (this.#abortReason) return Promise.reject(new Error(this.#abortReason));
    return this.#register(names, timeoutMs);
  }

  /**
   * 注册一组「等其中任意一个事件」的等待者。
   *
   * 统一成一处让三个结束路径（事件到达 / 超时 / 连接关闭）都走同一个 `settle`，
   * 保证：定时器清掉、`#waiters` 里的条目摘掉、 Promise 只结算一次。
   */
  #register(names: readonly AsrEventName[], timeoutMs: number): Promise<ServerMessage> {
    return new Promise<ServerMessage>((resolve, reject) => {
      const entries: { name: AsrEventName; waiter: Waiter }[] = [];
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = (): void => {
        for (const { name, waiter } of entries) {
          const list = this.#waiters.get(name);
          if (!list) continue;
          const i = list.indexOf(waiter);
          if (i >= 0) list.splice(i, 1);
          if (list.length === 0) this.#waiters.delete(name);
        }
      };

      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        cleanup();
        fn();
      };

      timer = setTimeout(() => {
        settle(() =>
          reject(new Error(`等 ${names.join('|')} 超时 ${timeoutMs}ms；已收到事件: ${this.#eventSummary()}`)),
        );
      }, timeoutMs);

      for (const name of names) {
        const waiter: Waiter = {
          resolve: (msg) => settle(() => resolve(msg)),
          reject: (err) => settle(() => reject(err)),
        };
        entries.push({ name, waiter });
        const list = this.#waiters.get(name) ?? [];
        list.push(waiter);
        this.#waiters.set(name, list);
      }
    });
  }
}
