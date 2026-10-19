/**
 * 督导层（§13.1 / §13.3 / §13.4）的单元测试。
 *
 * ── 为什么这些测试必须存在 ──
 * 重连策略的每一条都**没法用真机验证**：
 *   · 「2 分钟放弃」→ 真跑要等两分钟，而且还得真的断网两分钟
 *   · 「Key 无效只试一次」→ 真跑要拿一个废 Key，还得盯着看它有没有偷偷重试
 *   · 「退避 0.5/1/2/3/5/8/10」→ 真跑要等半分钟，而且时序受调度抖动影响
 *
 * 注入 `now` / `sleep` 之后，这些全部变成毫秒级、确定性的断言。
 * 这也正是把督导层放进 `core/`（零 Chrome API）的原因。
 */
import { describe, expect, it } from 'vitest';

import {
  BACKOFF_MS,
  GIVE_UP_AFTER_MS,
  STABLE_AFTER_MS,
  AsrSupervisor,
  backoffDelay,
  costYuan,
  type SupervisorSnapshot,
} from '../src/core/asr/supervisor';
import { BangleAsrSession, type AsrSessionOptions } from '../src/core/asr/session';
import type { SocketLike } from '../src/core/asr/types';

// ─────────────────────────── 测试替身 ───────────────────────────

/** 记录发送、可手动驱动事件的假 socket */
class FakeSocket implements SocketLike {
  sent: (string | ArrayBufferView)[] = [];
  bufferedAmount = 0;

  #openCb?: () => void;
  #msgCb?: (data: unknown) => void;
  #errCb?: (err: unknown) => void;
  #closeCb?: (info: { code: number; reason: string }) => void;

  send(data: string | ArrayBufferView): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.#closeCb?.({ code: code ?? 1000, reason: reason ?? '' });
  }
  onOpen(cb: () => void): void {
    this.#openCb = cb;
  }
  onMessage(cb: (data: unknown) => void): void {
    this.#msgCb = cb;
  }
  onError(cb: (err: unknown) => void): void {
    this.#errCb = cb;
  }
  onClose(cb: (info: { code: number; reason: string }) => void): void {
    this.#closeCb = cb;
  }

  emitOpen(): void {
    this.#openCb?.();
  }
  emitEvent(obj: unknown): void {
    this.#msgCb?.(JSON.stringify(obj));
  }
  emitError(err: unknown): void {
    this.#errCb?.(err);
  }
  emitClose(code: number, reason = ''): void {
    this.#closeCb?.({ code, reason });
  }

  /** 最后一次发出的文本消息 */
  lastText(): Record<string, unknown> | null {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const item = this.sent[i]!;
      if (typeof item === 'string') return JSON.parse(item) as Record<string, unknown>;
    }
    return null;
  }
}

/** 假时钟：`sleep` 直接推进时间，不真的等 */
class FakeClock {
  t = 1_700_000_000_000;
  sleeps: number[] = [];
  now = (): number => this.t;
  sleep = async (ms: number): Promise<void> => {
    this.sleeps.push(ms);
    this.t += ms;
  };
}

/** 每条连接的行为脚本；在 handler 挂好之后（微任务）执行 */
type Behavior = (socket: FakeSocket, index: number) => void;

/**
 * 构造一个「按脚本逐条连接」的 socket 工厂。
 *
 * 行为用 `queueMicrotask` 延后 —— `BangleAsrSession.open()` 是**同步**挂好
 * `onOpen/onMessage/onClose` 的（在 Promise executor 里），所以微任务时回调一定已就位。
 */
function scriptedFactory(behaviors: Behavior[]) {
  const sockets: FakeSocket[] = [];
  const factory = (_url: string): SocketLike => {
    const index = sockets.length;
    const socket = new FakeSocket();
    sockets.push(socket);
    queueMicrotask(() => {
      const behavior = behaviors[index];
      if (behavior) behavior(socket, index);
      // 没有脚本 = 这条连接一直保持（用来测"连上之后不断"）
    });
    return socket;
  };
  return { factory, sockets };
}

/** 一条「正常建立并跑起来」的连接 */
const goLive: Behavior = (s) => {
  s.emitOpen();
  s.emitEvent({ header: { event: 'task-started' } });
};

/** 一条「连上就断」的连接 */
const dieOnClose =
  (code = 1006): Behavior =>
  (s) => {
    s.emitOpen();
    s.emitEvent({ header: { event: 'task-started' } });
    queueMicrotask(() => s.emitClose(code, ''));
  };

/** 一条「握手就失败」的连接（模拟 Key 无效 / 断网） */
const failHandshake: Behavior = (s) => {
  queueMicrotask(() => {
    s.emitError(new Error('WebSocket 连接错误（readyState=3）'));
    s.emitClose(1006, '');
  });
};

function makeSupervisor(
  behaviors: Behavior[],
  opts: Partial<ConstructorParameters<typeof AsrSupervisor>[0]> = {},
  onState?: (s: SupervisorSnapshot) => void,
) {
  const clock = new FakeClock();
  const { factory, sockets } = scriptedFactory(behaviors);
  const gaps: number[] = [];
  const states: string[] = [];

  const sup = new AsrSupervisor(
    {
      apiKey: 'sk-test',
      socketFactory: factory,
      now: clock.now,
      sleep: clock.sleep,
      ...opts,
    },
    {
      onState: (s) => {
        states.push(s.state);
        onState?.(s);
      },
      onGap: (sec) => gaps.push(sec),
    },
  );

  return { sup, clock, sockets, gaps, states };
}

/** 让微任务队列跑干净（脚本里的行为链是微任务串起来的） */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

// ─────────────────────────── 退避表 ───────────────────────────

describe('§13.3 退避表', () => {
  it('前三档是 0.5 / 1 / 2 秒（快速吃下网络抖动）', () => {
    expect(backoffDelay(1)).toBe(500);
    expect(backoffDelay(2)).toBe(1000);
    expect(backoffDelay(3)).toBe(2000);
  });

  it('第 4–8 档是 3 / 5 / 8 / 10 / 10 秒', () => {
    expect([4, 5, 6, 7, 8].map(backoffDelay)).toEqual([3000, 5000, 8000, 10000, 10000]);
  });

  it('第 9 次及以后稳定在 10 秒，不再增长', () => {
    expect(backoffDelay(9)).toBe(10000);
    expect(backoffDelay(50)).toBe(10000);
    expect(backoffDelay(1000)).toBe(10000);
  });

  it('表格只有 7 档，但语义上覆盖到无限次', () => {
    expect(BACKOFF_MS.length).toBe(7);
  });
});

describe('成本换算', () => {
  it('input ¥6/1M + output ¥4.5/1M', () => {
    expect(costYuan(1_000_000, 0)).toBeCloseTo(6);
    expect(costYuan(0, 1_000_000)).toBeCloseTo(4.5);
    // M1 实测：一小时真实内容的量级 ≈ ¥0.22–0.25
    expect(costYuan(37_000, 500)).toBeCloseTo(0.224, 2);
  });
});

// ─────────────────────────── 正常路径 ───────────────────────────

describe('正常连接', () => {
  it('start() 后进入 running，且不回退到别的状态', async () => {
    const { sup, states } = makeSupervisor([goLive]);
    void sup.start();
    await flush();

    expect(sup.state).toBe('running');
    expect(states[0]).toBe('starting');
    expect(states).toContain('running');
  });

  it('连上后不再触发 onGap（首次连接不算「中断」）', async () => {
    const { sup, gaps } = makeSupervisor([goLive]);
    void sup.start();
    await flush();
    expect(gaps).toEqual([]);
  });

  it('重复 start() 不会建出第二条连接', async () => {
    const { sup, sockets } = makeSupervisor([goLive]);
    void sup.start();
    await flush();
    void sup.start();
    await flush();
    expect(sockets.length).toBe(1);
  });

  it('isLive 反映真实连接状态', async () => {
    const { sup } = makeSupervisor([goLive]);
    expect(sup.isLive).toBe(false);
    void sup.start();
    await flush();
    expect(sup.isLive).toBe(true);
  });
});

// ─────────────────────────── 重连 ───────────────────────────

describe('§13.2 #2 网络抖动 → 退避重连', () => {
  it('断线后自动重连，并回到 running', async () => {
    const { sup, sockets, states } = makeSupervisor([goLive, goLive]);
    void sup.start();
    await flush();
    expect(sup.state).toBe('running');

    // 服务端断开
    sockets[0]!.emitClose(1006, '');
    await flush();

    expect(sup.state).toBe('running');
    expect(sockets.length).toBe(2);
    expect(states).toContain('reconnecting');
  });

  it('连续震荡时退避逐级增长（避免每 500ms 猛撞一次）', async () => {
    const { sup, sockets, clock } = makeSupervisor([goLive, dieOnClose(), dieOnClose(), dieOnClose()]);
    void sup.start();
    await flush();

    sockets[0]!.emitClose(1006, '');
    await flush();
    sockets[1]!.emitClose(1006, '');
    await flush();
    sockets[2]!.emitClose(1006, '');
    await flush();

    // 依次应为 500 / 1000 / 2000（每条连接都只活了几微秒，不算稳定）
    expect(clock.sleeps.slice(0, 3)).toEqual([500, 1000, 2000]);
  });

  it('★ 连上就断 ≠ 恢复：退避不能归零', async () => {
    // 这条测试守的是一个真实 bug：早先的实现在 `#onLive()` 里就把 attempts 清零，
    // 于是「连上 0.3s 又断」会永远停在 500ms 退避 —— 无人时能烧掉大量配额。
    const { sup, sockets, clock } = makeSupervisor([
      goLive,
      dieOnClose(),
      dieOnClose(),
      dieOnClose(),
      dieOnClose(),
    ]);
    void sup.start();
    await flush();

    for (let i = 0; i < 4; i++) {
      sockets[i]!.emitClose(1006, '');
      await flush();
    }

    // 如果归零就会全是 500；正确行为是逐级上涨
    expect(clock.sleeps.slice(0, 4)).toEqual([500, 1000, 2000, 3000]);
  });

  it('活过 STABLE_AFTER_MS 的连接断开后，退避确实归零', async () => {
    const { sup, sockets, clock } = makeSupervisor([goLive, goLive, goLive]);
    void sup.start();
    await flush();

    // 第一次失败 → 退避 500
    sockets[0]!.emitClose(1006, '');
    await flush();
    expect(clock.sleeps).toEqual([500]);
    expect(sup.state).toBe('running');

    // 第二条连接已经跑起来了；现在把时钟推过稳定性阈值，**再**断开
    clock.t += STABLE_AFTER_MS + 10_000;
    sockets[1]!.emitClose(1006, '');
    await flush();

    // 因为上一条连接稳定过，退避计数归零 → 下一次又是 500
    expect(clock.sleeps).toEqual([500, 500]);
  });

  it('§13.4 恢复后上报本次中断了多久', async () => {
    // 第二条连接**不自动连上**（空脚本），这样我们可以自己控制恢复时刻，
    // 否则 `flush()` 里就已经连上了，再推时钟已经晚了。
    const { sup, sockets, gaps, clock } = makeSupervisor([goLive, () => {}]);
    void sup.start();
    await flush();

    sockets[0]!.emitClose(1006, '');
    await flush(); // 这里会推进 500ms（退避）并开始第二条连接（但没 open）

    clock.t += 11_500; // 再耗掉 11.5s，凑成约 12s 的中断

    // 现在才让第二条连接跑起来
    sockets[1]!.emitOpen();
    sockets[1]!.emitEvent({ header: { event: 'task-started' } });
    await flush();

    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toBeGreaterThanOrEqual(11);
    expect(gaps[0]).toBeLessThanOrEqual(13);
  });
});

// ─────────────────────────── Key 无效：绝不重试 ───────────────────────────

describe('§13.2 #1 Key 无效 → 不重试', () => {
  it('预检 401 → 直接 auth_failed，只试一次', async () => {
    const { sup, sockets } = makeSupervisor([failHandshake], {
      preflight: async () => ({ ok: false, status: 401, message: '⛔ Key 无效' }),
    });

    void sup.start();
    await flush();

    expect(sup.state).toBe('auth_failed');
    // ★ 核心断言：**绝不能**有第二次连接
    expect(sockets.length).toBe(1);
  });

  it('预检 403（欠费/禁用）同样不重试', async () => {
    const { sup, sockets } = makeSupervisor([failHandshake], {
      preflight: async () => ({ ok: false, status: 403, message: '⛔ 被禁用' }),
    });
    void sup.start();
    await flush();

    expect(sup.state).toBe('auth_failed');
    expect(sockets.length).toBe(1);
  });

  it('服务端 task-failed 带 InvalidApiKey → 也不重试（不必等预检）', async () => {
    const { sup, sockets } = makeSupervisor([
      (s) => {
        s.emitOpen();
        s.emitEvent({
          header: { event: 'task-failed', error_code: 'InvalidApiKey', error_message: 'Invalid API-key provided.' },
        });
      },
    ]);

    void sup.start();
    await flush();

    expect(sup.state).toBe('auth_failed');
    expect(sockets.length).toBe(1);
  });

  it('auth_failed 的 detail 明确写着「重试无效」', async () => {
    const { sup } = makeSupervisor([failHandshake], {
      preflight: async () => ({ ok: false, status: 401, message: '' }),
    });
    void sup.start();
    await flush();
    expect(sup.snapshot.detail).toContain('重试无效');
  });

  it('retryNow() 能从 auth_failed 重新拉起（用户换了 Key）', async () => {
    const { sup, sockets } = makeSupervisor([failHandshake, goLive], {
      preflight: async () => ({ ok: false, status: 401, message: '' }),
    });
    void sup.start();
    await flush();
    expect(sup.state).toBe('auth_failed');

    sup.retryNow();
    await flush();

    expect(sup.state).toBe('running');
    expect(sockets.length).toBe(2);
  });
});

// ─────────────────────────── 断网（预检也得说清楚） ───────────────────────────

describe('§13.2 #2 断网 → 预检定性后继续重试', () => {
  it('预检 status=0（连不上）→ 判为网络问题，继续重连而不是锁死', async () => {
    const { sup, sockets } = makeSupervisor([failHandshake, goLive], {
      preflight: async () => ({ ok: false, status: 0, message: '连不上' }),
    });

    void sup.start();
    await flush(); // 第一次失败 + 预检 → 转入重连
    await flush(); // 第二次连接成功

    expect(sup.state).toBe('running');
    expect(sockets.length).toBe(2);
  });

  it('⚠️ 断网和 Key 无效在 WS 层面长得一样，必须靠预检区分', async () => {
    // 同一个 failHandshake 行为，只改预检结果 → 结局必须不同
    const auth = makeSupervisor([failHandshake], {
      preflight: async () => ({ ok: false, status: 401, message: '' }),
    });
    void auth.sup.start();
    await flush();

    const net = makeSupervisor([failHandshake], {
      preflight: async () => ({ ok: false, status: 0, message: '' }),
    });
    void net.sup.start();
    await flush();

    expect(auth.sup.state).toBe('auth_failed'); // 不重试
    expect(net.sup.state).toBe('reconnecting'); // 继续重试
  });
});

// ─────────────────────────── 429 限流 ───────────────────────────

describe('§13.2 #3 限流 429', () => {
  it('退避至少 5 秒起（不像普通抖动那样 0.5s 就冲）', async () => {
    const { sup, sockets, clock } = makeSupervisor([failHandshake, goLive], {
      preflight: async () => ({ ok: false, status: 429, message: '限流' }),
    });

    void sup.start();
    await flush();

    // 第一次重连的等待时间必须 ≥ 5000
    const firstWait = clock.sleeps[0];
    expect(firstWait).toBeGreaterThanOrEqual(5000);
    expect(sockets.length).toBe(2);
  });
});

// ─────────────────────────── 2 分钟放弃 ───────────────────────────

describe('§13.3 累计失败 2 分钟 → gave_up', () => {
  it('持续失败会在 2 分钟后停止重试', async () => {
    // 给足 30 条「连上就断」的脚本，远超 2 分钟内能跑的次数
    const behaviors: Behavior[] = Array.from({ length: 40 }, () => failHandshake);
    const { sup, sockets, clock } = makeSupervisor(behaviors, {
      preflight: async () => ({ ok: false, status: 0, message: '断网' }),
    });

    void sup.start();
    for (let i = 0; i < 80; i++) await flush();

    expect(sup.state).toBe('gave_up');
    // 累计推进的时间必须跨过 2 分钟门槛
    expect(clock.t - 1_700_000_000_000).toBeGreaterThanOrEqual(GIVE_UP_AFTER_MS);
    // 不该无限试下去
    expect(sockets.length).toBeLessThan(40);
  });

  it('放弃时**不会**再多等一轮退避（省掉无意义等待）', async () => {
    const behaviors: Behavior[] = Array.from({ length: 40 }, () => failHandshake);
    const { sup, clock } = makeSupervisor(behaviors, {
      preflight: async () => ({ ok: false, status: 0, message: '' }),
    });
    void sup.start();
    for (let i = 0; i < 80; i++) await flush();

    const totalSlept = clock.sleeps.reduce((a, b) => a + b, 0);
    // 最后一次等待不该把它推过 2 分钟太久（容忍一档 10s）
    expect(totalSlept).toBeLessThan(GIVE_UP_AFTER_MS + 10_000);
  });

  it('中途连上过一次 → 计时归零，不会因为历史失败而被放弃', async () => {
    // 前 3 次失败，第 4 次成功，之后再失败 2 次：因为成功过，streak 被重置
    const behaviors: Behavior[] = [failHandshake, failHandshake, failHandshake, goLive, dieOnClose(), goLive];
    const { sup } = makeSupervisor(behaviors, {
      preflight: async () => ({ ok: false, status: 0, message: '' }),
    });

    void sup.start();
    for (let i = 0; i < 40; i++) await flush();

    expect(sup.state).toBe('running');
    expect(sup.snapshot.reconnects).toBeGreaterThanOrEqual(1);
  });
});

// ─────────────────────────── 预检的取舍 ───────────────────────────

describe('预检只在「原因不明」时跑', () => {
  it('已经正常跑过一段时间再断 → 跳过预检（Key 显然是好的，别多花一次往返）', async () => {
    let preflightCalls = 0;
    const { sup, sockets } = makeSupervisor([goLive, goLive], {
      preflight: async () => {
        preflightCalls++;
        return { ok: false, status: 0, message: '' };
      },
    });

    void sup.start();
    await flush();
    sockets[0]!.emitClose(1006, '');
    await flush();

    expect(preflightCalls).toBe(0);
    expect(sup.state).toBe('running');
  });

  it('冷启动握手失败 → 会跑一次预检', async () => {
    let preflightCalls = 0;
    const { sup } = makeSupervisor([failHandshake, goLive], {
      preflight: async () => {
        preflightCalls++;
        return { ok: false, status: 0, message: '' };
      },
    });
    void sup.start();
    await flush();
    expect(preflightCalls).toBe(1);
  });

  it('没注入 preflight 时也能跑（不会崩）', async () => {
    const { sup } = makeSupervisor([failHandshake, goLive]);
    void sup.start();
    await flush();
    expect(sup.state).toBe('running');
  });
});

// ─────────────────────────── stop ───────────────────────────

describe('主动停止', () => {
  it('stop() 后进入 stopped，且**不触发重连**', async () => {
    const { sup, sockets } = makeSupervisor([goLive, goLive]);
    void sup.start();
    await flush();

    sup.stop();
    await flush();

    expect(sup.state).toBe('stopped');
    expect(sockets.length).toBe(1); // 没有第二条
  });

  it('stop() 发生在 open() 进行中时不会悬空（#loop 能退出来）', async () => {
    // 第二条连接永远不 open（空脚本）→ 卡在 await session.open() 里
    const { sup, sockets } = makeSupervisor([goLive, () => {}]);

    let startResolved = false;
    const starting = sup.start().then(() => {
      startResolved = true;
    });
    await flush();
    expect(sup.state).toBe('running');

    // 断线 → 进入重连 → 第二条连接挂在 open() 上
    sockets[0]!.emitClose(1006, '');
    await flush();
    expect(sockets.length).toBe(2);

    sup.stop();
    await flush();
    await starting;

    expect(sup.state).toBe('stopped');
    // `start()` 必须真的 resolve —— 否则会留一个永不结束的 promise
    expect(startResolved).toBe(true);
  });

  it('stop() 后 state 直接为 stopped，不会被迟到的 onClose 翻回 reconnecting', async () => {
    const { sup, sockets } = makeSupervisor([goLive, () => {}]);
    void sup.start();
    await flush();

    sockets[0]!.emitClose(1006, '');
    await flush();
    sup.stop();
    // 即使随后还有一条迟到的 close 事件，也不能把它拉回重连
    sockets[1]!.emitClose(1006, '');
    await flush();

    expect(sup.state).toBe('stopped');
  });

  it('stop() 后 isLive 为 false（不再有连接可用）', async () => {
    const { sup } = makeSupervisor([goLive]);
    void sup.start();
    await flush();
    expect(sup.isLive).toBe(true);

    sup.stop();
    await flush();
    expect(sup.isLive).toBe(false);
  });

  it('stop() 能打断正在进行的退避等待（永不 resolve 的 sleep 也不会把它卡住）', async () => {
    const clock = new FakeClock();
    let releaseSleep: (() => void) | null = null;
    const { factory } = scriptedFactory([failHandshake, goLive]);
    const sup = new AsrSupervisor(
      {
        apiKey: 'sk-test',
        socketFactory: factory,
        now: clock.now,
        sleep: () =>
          new Promise<void>((resolve) => {
            releaseSleep = resolve;
          }),
        preflight: async () => ({ ok: false, status: 0, message: '' }),
      },
      {},
    );

    void sup.start();
    await flush();
    await flush();
    // 此刻卡在退避 sleep 里
    expect(releaseSleep).not.toBeNull();

    sup.stop();
    await flush();

    expect(sup.state).toBe('stopped');
  });
});

// ─────────────────────────── 用量跨任务累加 ───────────────────────────

describe('§5.14 成本：usage 必须跨任务累加', () => {
  it('重连后新任务的 usage 从 0 重数，督导层要把它加到账上而不是覆盖', async () => {
    const withUsage =
      (input: number, output: number): Behavior =>
      (s) => {
        s.emitOpen();
        s.emitEvent({ header: { event: 'task-started' } });
        s.emitEvent({
          header: { event: 'result-generated' },
          payload: {
            output: { sentence: { sentence_id: 1, sentence_end: true, text: 'テスト' } },
            usage: { input_tokens: input, output_tokens: output },
          },
        });
      };

    const { sup, sockets } = makeSupervisor([withUsage(1000, 100), withUsage(500, 50)]);
    void sup.start();
    await flush();

    expect(sup.usage.input_tokens).toBe(1000);

    sockets[0]!.emitClose(1006, '');
    await flush();
    // 第二条连接报的是它自己的累计值（500），但总账必须是 1500
    expect(sup.usage.input_tokens).toBe(1500);
    expect(sup.usage.output_tokens).toBe(150);
  });

  it('成本随 usage 实时反映到快照', async () => {
    const { sup } = makeSupervisor([
      (s) => {
        s.emitOpen();
        s.emitEvent({ header: { event: 'task-started' } });
        s.emitEvent({
          header: { event: 'result-generated' },
          payload: {
            output: { sentence: { sentence_id: 1, sentence_end: true, text: 'x' } },
            usage: { input_tokens: 1_000_000, output_tokens: 0 },
          },
        });
      },
    ]);
    void sup.start();
    await flush();
    expect(sup.snapshot.costYuan).toBeCloseTo(6, 5);
  });
});

// ─────────────────────────── 降级叠加态 ───────────────────────────

describe('§13.1 degraded 是叠加态', () => {
  it('连接正常 + 翻译失败 → degraded', async () => {
    const { sup } = makeSupervisor([goLive]);
    void sup.start();
    await flush();

    sup.degrade({
      rule: 6,
      kind: 'translate',
      terminal: false,
      minRetryDelayMs: 0,
      title: '翻译失败',
      detail: '该句显示日文原文',
    });
    expect(sup.state).toBe('degraded');

    sup.recover();
    expect(sup.state).toBe('running');
  });

  it('断线优先级高于降级（不能因为翻译挂了就掩盖断线）', async () => {
    const { sup, sockets } = makeSupervisor([goLive, goLive]);
    void sup.start();
    await flush();

    sup.degrade({
      rule: 6,
      kind: 'translate',
      terminal: false,
      minRetryDelayMs: 0,
      title: '翻译失败',
      detail: '',
    });
    expect(sup.state).toBe('degraded');

    sockets[0]!.emitClose(1006, '');
    // 同步检查：断开后立刻不该再显示 degraded
    await Promise.resolve();
    expect(['reconnecting', 'running']).toContain(sup.state);
  });

  it('连接恢复后 degraded 自动清除（新任务等于新开始）', async () => {
    const { sup, sockets } = makeSupervisor([goLive, goLive]);
    void sup.start();
    await flush();

    sup.degrade({
      rule: 6,
      kind: 'translate',
      terminal: false,
      minRetryDelayMs: 0,
      title: '翻译失败',
      detail: '',
    });
    sockets[0]!.emitClose(1006, '');
    await flush();

    expect(sup.state).toBe('running');
  });
});

// ─────────────────────────── 会话工厂注入 ───────────────────────────

describe('会话可注入（便于替换成假实现）', () => {
  it('makeSession 会被调用，并拿到我们的回调', async () => {
    const seen: AsrSessionOptions[] = [];
    const { sup } = makeSupervisor([goLive], {
      makeSession: (options, callbacks) => {
        seen.push(options);
        // 复用真实实现，但记录一下参数
        return new BangleAsrSession(options, callbacks);
      },
    });

    void sup.start();
    await flush();

    expect(seen).toHaveLength(1);
    expect(seen[0]!.apiKey).toBe('sk-test');
    expect(sup.state).toBe('running');
  });
});

// ─────────────────────────── 送音频 ───────────────────────────

describe('sendAudio 在未连上时安全返回 false', () => {
  it('idle 状态下不抛异常', () => {
    const { sup } = makeSupervisor([goLive]);
    expect(sup.sendAudio(new Int16Array(160))).toBe(false);
  });

  it('连上之后能送（返回 true）', async () => {
    const { sup } = makeSupervisor([goLive]);
    void sup.start();
    await flush();
    expect(sup.sendAudio(new Int16Array(160))).toBe(true);
  });
});
