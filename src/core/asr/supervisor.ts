/**
 * ASR 督导层（PLAN §13.1 / §13.3 / §13.4）。**纯逻辑，零 Chrome API，时间可注入**。
 *
 * ── 它解决什么问题 ──
 * `BangleAsrSession` 只管**一条**连接：建连、收消息、关闭。它不懂「断了该不该再连」。
 * 而在 α 架构下（纯扩展、无后端）**没有任何人替我们重连** —— 一次网络抖动
 * 就会让字幕**永久停摆**，用户必须手动关掉再点图标。看一场两小时的直播，这是必然事件。
 *
 * 于是把「要不要重连、等多久、什么时候放弃」全部收到这一层：
 *
 *   session（一条连接） → **supervisor（连不上怎么办）** → offscreen（接线） → UI
 *
 * ── 三条硬规则 ──
 *   1. **Key 无效绝不重试**（§13.2 #1）—— 重试 8 次仍然是 401，纯烧时间和配额。
 *   2. **退避不能太懒**（§13.3）—— 用户就坐在屏幕前等，不是后台批处理任务。
 *   3. **放弃要有上限**（§13.3）—— 累计失败 2 分钟就转 `gave_up`，避免无人时无限烧配额。
 *
 * ── 为什么时间要注入 ──
 * 重连策略的核心是「等多久」和「是否超时放弃」。真跑一遍至少 2 分钟，
 * 没法测。注入 `now` / `sleep` 后，整个策略能在 Vitest 里毫秒级跑完。
 */
import { BangleAsrSession, type AsrSessionCallbacks, type AsrSessionOptions } from './session';
import {
  classifyFailure,
  needsPreflight,
  type ClassifiedFailure,
  type ClassifyInput,
} from './failure';
import type { AsrUsage, SocketFactory } from './types';

/** §13.1 的 8 态（UI 与角标共用这一套） */
export type SessionUiState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'degraded'
  | 'reconnecting'
  | 'auth_failed'
  | 'gave_up'
  | 'stopped';

/**
 * §13.3 的退避表（ms）。
 *
 * | 第几次 | 间隔 |
 * | 1–3   | 0.5s / 1s / 2s      ← 快速吃下网络抖动 |
 * | 4–8   | 3s / 5s / 8s / 10s / 10s |
 * | 9+    | 每 10s |
 */
export const BACKOFF_MS = [500, 1000, 2000, 3000, 5000, 8000, 10000] as const;

/** §13.3：累计失败持续这么久 → `gave_up` */
export const GIVE_UP_AFTER_MS = 120_000;

/**
 * 一条连接活过这么久，才算「真的好了」，退避计数才归零。
 *
 * ⚠️ 为什么不能「一连上就归零」（真 bug，测试里抓到的）：
 * 如果每条连接都是「连上 300ms 就断」，那么「连上→归零→断→第 1 次→500ms」会无限循环，
 * **退避永远停在 500ms**，每次失败都只等半秒。这正是「无人时无限烧配额」的画面。
 *
 * 用「活过 30s 才算数」就变成：抖动 → 快速重连；持续震荡 → 自动降频。
 */
export const STABLE_AFTER_MS = 30_000;

/** 第 `attempt` 次重连前应等待的时间（`attempt` 从 1 开始） */
export function backoffDelay(attempt: number): number {
  const i = Math.min(Math.max(attempt, 1) - 1, BACKOFF_MS.length - 1);
  return BACKOFF_MS[i] ?? 10000;
}

/** input ¥6/1M tokens，output ¥4.5/1M tokens（M1 实测口径） */
export function costYuan(inputTokens: number, outputTokens: number): number {
  return (inputTokens * 6 + outputTokens * 4.5) / 1e6;
}

export interface SupervisorUsage {
  input_tokens: number;
  output_tokens: number;
}

/** 给 UI / 角标用的快照 */
export interface SupervisorSnapshot {
  state: SessionUiState;
  /** 本轮已尝试的重连次数（成功连上归零） */
  attempts: number;
  /** 断开起始时刻；`null` = 当前没断 */
  disconnectedSince: number | null;
  /** 最近一次故障的短标题（角标悬停用） */
  title?: string;
  /** 详细说明 */
  detail?: string;
  /** 本场累计 usage（**跨任务累加** —— 重连后新任务会从 0 重数） */
  usage: SupervisorUsage;
  /** 本场累计成本（元） */
  costYuan: number;
  /** 本场成功恢复的次数 */
  reconnects: number;
}

export type PreflightFn = (apiKey: string) => Promise<{ ok: boolean; status: number; message: string }>;

export interface AsrSupervisorOptions {
  apiKey: string;
  socketFactory: SocketFactory;
  model?: string;
  endpoint?: string;
  params?: AsrSessionOptions['params'];
  /**
   * 每次（重）连后注入的 `run-task` 上下文（D22 术语表 + D37 前文）。
   *
   * ⚠️ 必须是**函数**而不是值：`input.context` 不会跨任务保留（§13.3），
   * 而重连时我们想注入的是**此刻最新的**前文，不是建连那一刻的。
   */
  context?: () => unknown;
  /** 不传则不做预检（测试里常用） */
  preflight?: PreflightFn;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 注入会话工厂（测试里用假 session） */
  makeSession?: (options: AsrSessionOptions, callbacks: AsrSessionCallbacks) => BangleAsrSession;
  /** 预检超时（诊断用途，别拖慢重连） */
  preflightTimeoutMs?: number;
}

export interface AsrSupervisorCallbacks {
  onSentence?: AsrSessionCallbacks['onSentence'];
  /** 状态或用量变化 */
  onState?: (snapshot: SupervisorSnapshot) => void;
  /** 断连恢复后报告**这次中断了多久**（§13.4 分隔线用） */
  onGap?: (seconds: number) => void;
  onLog?: (level: 'info' | 'warn' | 'error', text: string) => void;
}

type Outcome = { kind: 'ended'; failure: ClassifiedFailure } | { kind: 'cancelled' };

/** 默认 sleep */
const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export class AsrSupervisor {
  readonly #opts: Required<Pick<AsrSupervisorOptions, 'apiKey' | 'socketFactory' | 'now' | 'sleep'>> &
    Omit<AsrSupervisorOptions, 'apiKey' | 'socketFactory' | 'now' | 'sleep'>;
  readonly #cb: AsrSupervisorCallbacks;

  #state: SessionUiState = 'idle';
  /** 与 `#state` 正交：连接正常但某个能力降级（例如翻译挂了） */
  #degraded: ClassifiedFailure | null = null;

  #session: BangleAsrSession | null = null;
  #stopped = false;
  /** 每次尝试递增；用来让旧尝试的回调失效（否则旧连接关闭会把新连接干掉） */
  #token = 0;

  #attempts = 0;
  #reconnects = 0;
  #disconnectedSince: number | null = null;
  /** 当前这条连接连上的时刻；用来判定「是否算稳定」（见 STABLE_AFTER_MS） */
  #liveSince: number | null = null;
  /** 本轮故障streak 的起点；成功连上并稳定后清空 */
  #streakStartedAt: number | null = null;
  /**
   * 本轮 streak 里有没有**成功跑起来过**。
   *
   * 这是「要不要跑预检」的判据：如果几秒前还好好的，Key 显然是有效的，
   * 那这次断开必然是网络问题 —— 不必多花一次 HTTPS 往返去问。
   */
  #ranInStreak = false;

  #lastFailure: ClassifiedFailure | null = null;

  /** 已完成任务的 usage 累计（新任务会从 0 重数，所以必须自己跨任务累加） */
  #baseUsage: SupervisorUsage = { input_tokens: 0, output_tokens: 0 };
  /** 当前任务的 usage（服务端给的是任务累计值，D79） */
  #currentUsage: SupervisorUsage = { input_tokens: 0, output_tokens: 0 };

  /** 用来让 `stop()` 能打断正在等待的退避 */
  #wakeSleep: (() => void) | null = null;

  constructor(options: AsrSupervisorOptions, callbacks: AsrSupervisorCallbacks = {}) {
    this.#opts = {
      ...options,
      now: options.now ?? (() => Date.now()),
      sleep: options.sleep ?? realSleep,
    };
    this.#cb = callbacks;
  }

  get snapshot(): SupervisorSnapshot {
    const usage = this.usage;
    return {
      // `degraded` 是叠加态：只有连接本身正常时才有意义
      state: this.#state === 'running' && this.#degraded ? 'degraded' : this.#state,
      attempts: this.#attempts,
      disconnectedSince: this.#disconnectedSince,
      ...(this.#lastFailure ? { title: this.#lastFailure.title, detail: this.#lastFailure.detail } : {}),
      usage,
      costYuan: costYuan(usage.input_tokens, usage.output_tokens),
      reconnects: this.#reconnects,
    };
  }

  get usage(): SupervisorUsage {
    return {
      input_tokens: this.#baseUsage.input_tokens + this.#currentUsage.input_tokens,
      output_tokens: this.#baseUsage.output_tokens + this.#currentUsage.output_tokens,
    };
  }

  get state(): SessionUiState {
    return this.snapshot.state;
  }

  /** 当前连接是否可用于送音频 */
  get isLive(): boolean {
    return this.#state === 'running' && this.#session?.state === 'running';
  }

  /** 送一块 16kHz mono PCM。未连上时返回 `false`（调用方**照旧继续送**，见 D104） */
  sendAudio(pcm: Int16Array): boolean {
    return this.#session?.sendAudio(pcm) ?? false;
  }

  /**
   * 开始（或重新开始）督导循环。
   *
   * 幂等：已经在跑时重复调用不会建出第二条连接。
   */
  async start(): Promise<void> {
    if (!this.#stopped && this.#state !== 'idle' && this.#state !== 'stopped') return;
    this.#stopped = false;
    this.#attempts = 0;
    this.#reconnects = 0;
    this.#disconnectedSince = null;
    this.#streakStartedAt = null;
    this.#ranInStreak = false;
    this.#degraded = null;
    this.#lastFailure = null;
    this.#baseUsage = { input_tokens: 0, output_tokens: 0 };
    this.#currentUsage = { input_tokens: 0, output_tokens: 0 };

    this.#setState('starting');
    await this.#loop();
  }

  /**
   * 停止。
   *
   * 顺序要求：先置 `#stopped` 再关 session —— 否则 `onClose` 会把它当成
   * 「服务端断开」，触发一次多余的重连。
   */
  stop(): void {
    this.#stopped = true;
    this.#token++; // 让所有在飞的回调失效
    this.#wakeSleep?.();
    this.#wakeSleep = null;

    const s = this.#session;
    this.#session = null;
    if (s) {
      try {
        s.close(1000, 'client-stop');
      } catch {
        /* 连接已不可用，忽略 */
      }
    }
    this.#disconnectedSince = null;
    this.#liveSince = null;
    this.#degraded = null;
    this.#setState('stopped');
  }

  /** 手动重试（点 `⛔` / `✕` 角标时）—— 从终态重新拉起 */
  retryNow(): void {
    if (this.#state !== 'auth_failed' && this.#state !== 'gave_up') return;
    this.#log('info', '用户手动重试');
    this.#stopped = false;
    this.#attempts = 0;
    this.#streakStartedAt = null;
    this.#ranInStreak = false;
    this.#lastFailure = null;
    this.#setState('starting');
    void this.#loop();
  }

  /** 标记降级（例如翻译失败）—— 不改变连接，只改变 UI 状态 */
  degrade(failure: ClassifiedFailure): void {
    this.#degraded = failure;
    this.#lastFailure = failure;
    this.#emitState();
  }

  /** 清除降级（下一句翻译成功后调用） */
  recover(): void {
    if (!this.#degraded) return;
    this.#degraded = null;
    this.#emitState();
  }

  // ─────────────────────────── 督导循环 ───────────────────────────

  async #loop(): Promise<void> {
    while (!this.#stopped) {
      // ── 退避（第一次尝试不退避） ──
      if (this.#attempts > 0) {
        // 放弃判定放在**退避之前**：省掉最后一次无意义的等待
        if (this.#streakStartedAt != null && this.#opts.now() - this.#streakStartedAt >= GIVE_UP_AFTER_MS) {
          this.#log('error', `累计失败已超过 ${GIVE_UP_AFTER_MS / 1000}s，停止重试`);
          this.#leavingReconnect();
          this.#setState('gave_up');
          return;
        }

        const delay = Math.max(backoffDelay(this.#attempts), this.#lastFailure?.minRetryDelayMs ?? 0);
        this.#log('warn', `${delay}ms 后第 ${this.#attempts} 次重连（${this.#lastFailure?.title ?? '未知'}）`);
        this.#setState('reconnecting');
        const stopped = await this.#sleepUnlessStopped(delay);
        if (stopped) return;
      }

      const outcome = await this.#runAttempt();
      if (outcome.kind === 'cancelled' || this.#stopped) return;

      // ── 连接结束：记账并决定下一步 ──
      const failure = outcome.failure;
      this.#lastFailure = failure;
      this.#accumulateUsage();

      // 这条连接如果活过 STABLE_AFTER_MS，说明它是**真的连上过**而不是刚连就断：
      // 退避计数与放弃计时都归零，不把历史失败算到这一轮头上。
      const liveSince = this.#liveSince;
      this.#liveSince = null;
      if (liveSince != null && this.#opts.now() - liveSince >= STABLE_AFTER_MS) {
        this.#attempts = 0;
        this.#streakStartedAt = null;
      }

      this.#attempts++;
      if (this.#streakStartedAt == null) this.#streakStartedAt = this.#opts.now();
      if (this.#disconnectedSince == null) this.#disconnectedSince = this.#opts.now();

      this.#log(failure.terminal ? 'error' : 'warn', `${failure.title}：${failure.detail}`);

      if (failure.terminal) {
        this.#leavingReconnect();
        this.#setState(failure.kind === 'auth' ? 'auth_failed' : 'gave_up');
        return;
      }
    }
  }

  /**
   * 跑一次连接尝试。
   *
   * 返回时**连接已经结束**（无论是失败、还是连上之后又断了）——
   * 所以这个 Promise 可能长时间挂起，这是刻意的：它代表「这一条连接的生命周期」。
   */
  async #runAttempt(): Promise<Outcome> {
    const token = ++this.#token;
    const mine = (): boolean => token === this.#token && !this.#stopped;

    let finish: ((o: Outcome) => void) | null = null;
    const ended = new Promise<Outcome>((resolve) => {
      finish = resolve;
    });
    let settled = false;
    /**
     * 是否已经开始结算。
     *
     * ⚠️ 仅靠 `settled` 不够：`#classify` 是 **async**（可能要 await 预检），
     * 从「开始分类」到「分类完成」之间，`settled` 仍是 false。
     * 而一次握手失败会**同时**走两条路：`onError → open() reject`（进 catch）和 `onClose`，
     * 两条路都看到 `settled === false` → 预检被白白跑两遍（多一次 HTTPS 往返）。
     * 所以需要这个**同步**置位的闸门。
     */
    let ending = false;
    const settle = (o: Outcome): void => {
      if (settled) return;
      settled = true;
      finish?.(o);
    };

    /** 会话层报上来的失败（还没分类）；`open()/start()` 的 catch 会用到 */
    let rawFailure: ClassifyInput = {};
    /** 是否已经连上并跑起来过 */
    let wentLive = false;

    /** 开始结算一条连接（幂等）—— 两条失败路径共用 */
    const beginEnd = (input: ClassifyInput): void => {
      if (settled || ending) return;
      ending = true;
      // 连接已经没了，降级态失去意义（不能让「翻译失败」盖住「断线」）
      this.#degraded = null;
      void this.#classify(input, wentLive).then((failure) => {
        if (!mine()) return;
        settle({ kind: 'ended', failure });
      });
    };

    const session = this.#makeSession({
      onSentence: (sentence, kind) => {
        if (!mine()) return;
        this.#cb.onSentence?.(sentence, kind);
      },
      onUsage: (usage) => {
        if (!mine()) return;
        this.#absorbUsage(usage);
      },
      onFailure: (failure) => {
        if (!mine()) return;
        rawFailure = { failure };
        this.#log('warn', `ASR ${failure.kind} 失败：${failure.message}`);
        // 注意：这里**不 settle** —— 让 open()/start() 的 catch 统一处理，
        // 避免同一次失败被结算两次。
      },
      onClose: (info) => {
        if (!mine()) return;
        if (info.bySelf) {
          // 我们主动关的（stop 或上一轮清理）：不是故障
          settle({ kind: 'cancelled' });
          return;
        }
        beginEnd({ ...rawFailure, close: info });
      },
    });

    this.#session = session;
    this.#currentUsage = { input_tokens: 0, output_tokens: 0 };

    try {
      await session.open();
      if (!mine()) {
        session.close(1000, 'superseded');
        return { kind: 'cancelled' };
      }
      await session.start(this.#opts.context?.());
      if (!mine()) {
        session.close(1000, 'superseded');
        return { kind: 'cancelled' };
      }
    } catch (e) {
      // ⚠️ 这里必须返回 'cancelled' 而不是 `ended`：`stop()` 也会让 `open()` reject
      //    （它会走 `#handleClose` → reject），此时若返回永不 resolve 的 `ended`，
      //    `#loop` 就永远卡在这一行。功能上看不出来（offscreen 随后就被销毁），
      //    但它会把“已经结束的会话”伪装成“在飞”。
      if (!mine()) return { kind: 'cancelled' };
      const message = e instanceof Error ? e.message : String(e);
      beginEnd(rawFailure.failure ? rawFailure : { failure: { kind: 'handshake', message } });
      return ended;
    }

    // ★ 连上了
    wentLive = true;
    this.#ranInStreak = true;
    this.#onLive();
    return ended;
  }

  /** 连上之后：报 gap、切 running */
  #onLive(): void {
    const now = this.#opts.now();

    // §13.4：恢复后告诉上层「刚才断了多久」，让浮层插入分隔线
    if (this.#disconnectedSince != null) {
      const seconds = Math.max(1, Math.round((now - this.#disconnectedSince) / 1000));
      this.#log('info', `连接已恢复，本次中断 ${seconds}s`);
      this.#cb.onGap?.(seconds);
      this.#reconnects++;
    }

    this.#disconnectedSince = null;
    this.#liveSince = now;
    this.#degraded = null;
    this.#lastFailure = null;
    // ⚠️ 这里**故意不重置 `#attempts` / `#streakStartedAt`**：
    //    「连上了」不等于「好了」。刚连上就断的震荡场景必须在退避里降频，
    //    归零由 `#loop` 在连接结束时按 STABLE_AFTER_MS 判定。
    this.#setState('running');
  }

  /** 离开重连态前清掉断连标记（转终态时不该还显示「已中断 N 秒」） */
  #leavingReconnect(): void {
    this.#disconnectedSince = null;
    this.#streakStartedAt = null;
    this.#liveSince = null;
  }

  // ─────────────────────────── 故障分类（含预检） ───────────────────────────

  /**
   * 分类一次失败，必要时先跑预检把原因定性。
   *
   * `wentLive` = 这次断开之前是否已经正常跑过。
   * 如果跑过，Key 显然是有效的 → **跳过预检**，直接按网络问题快速重连。
   */
  async #classify(input: ClassifyInput, wentLive: boolean): Promise<ClassifiedFailure> {
    let preflightStatus: number | null = null;

    const worthProbing = !wentLive && !this.#ranInStreak && needsPreflight(input) && this.#opts.preflight;
    if (worthProbing && this.#opts.preflight) {
      this.#log('info', '失败原因不明，跑一次 HTTPS 预检定性（Key 无效 vs 网络不通）');
      try {
        const res = await this.#opts.preflight(this.#opts.apiKey);
        preflightStatus = res.status;
        this.#log('info', `预检结果：${res.message}`);
      } catch {
        // 预检自己挂了：不能据此判定任何事，按网络问题兜底
        preflightStatus = 0;
      }
    }

    return classifyFailure({ ...input, preflightStatus });
  }

  // ─────────────────────────── 小工具 ───────────────────────────

  #absorbUsage(usage: AsrUsage): void {
    this.#currentUsage = {
      input_tokens: usage.input_tokens ?? this.#currentUsage.input_tokens,
      output_tokens: usage.output_tokens ?? this.#currentUsage.output_tokens,
    };
    this.#emitState();
  }

  /** 把当前任务的 usage 结转到累计里（一条连接结束时调用一次） */
  #accumulateUsage(): void {
    this.#baseUsage = {
      input_tokens: this.#baseUsage.input_tokens + this.#currentUsage.input_tokens,
      output_tokens: this.#baseUsage.output_tokens + this.#currentUsage.output_tokens,
    };
    this.#currentUsage = { input_tokens: 0, output_tokens: 0 };
  }

  /** 可被 `stop()` 打断的 sleep */
  async #sleepUnlessStopped(ms: number): Promise<boolean> {
    if (this.#stopped) return true;
    let wake: (() => void) | null = null;
    const woken = new Promise<void>((resolve) => {
      wake = resolve;
    });
    this.#wakeSleep = () => {
      wake?.();
      wake = null;
    };
    await Promise.race([this.#opts.sleep(ms), woken]);
    this.#wakeSleep = null;
    return this.#stopped;
  }

  #makeSession(cb: AsrSessionCallbacks): BangleAsrSession {
    const options: AsrSessionOptions = {
      apiKey: this.#opts.apiKey,
      socketFactory: this.#opts.socketFactory,
      ...(this.#opts.model ? { model: this.#opts.model } : {}),
      ...(this.#opts.endpoint ? { endpoint: this.#opts.endpoint } : {}),
      ...(this.#opts.params ? { params: this.#opts.params } : {}),
    };
    return this.#opts.makeSession ? this.#opts.makeSession(options, cb) : new BangleAsrSession(options, cb);
  }

  #setState(state: SessionUiState): void {
    this.#state = state;
    this.#emitState();
  }

  #emitState(): void {
    this.#cb.onState?.(this.snapshot);
  }

  #log(level: 'info' | 'warn' | 'error', text: string): void {
    this.#cb.onLog?.(level, text);
  }
}
