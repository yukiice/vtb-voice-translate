/**
 * 故障分类（§13.2）的单元测试。
 *
 * 这一层很薄，但**判错的代价很大**：
 *   · 把「Key 无效」判成「网络问题」→ 白白重试 8 次，用户等两分钟才看到错
 *   · 把「断网」判成「Key 无效」→ 网络一恢复也不会重连，用户以为 Key 坏了
 *   · 把「429」当普通抖动 → 0.5s 就撞回去，越撞越限流
 *
 * 所以每条规则都要有独立断言，而且**要有一组「长得像但结论必须不同」的对照**。
 */
import { describe, expect, it } from 'vitest';

import {
  CAPTURE_FAILURE,
  TAB_GONE_FAILURE,
  TRANSLATE_FAILURE,
  classifyFailure,
  needsPreflight,
} from '../src/core/asr/failure';
import type { CloseInfo } from '../src/core/asr/types';

const close = (code: number, reason = '', bySelf = false): CloseInfo => ({
  code,
  reason,
  at: 0,
  bySelf,
});

describe('§13.2 #1 Key 无效', () => {
  it('预检 401 → auth + 终态', () => {
    const f = classifyFailure({ preflightStatus: 401 });
    expect(f.kind).toBe('auth');
    expect(f.terminal).toBe(true);
    expect(f.rule).toBe(1);
  });

  it('预检 403（欠费/禁用）→ auth + 终态', () => {
    const f = classifyFailure({ preflightStatus: 403 });
    expect(f.kind).toBe('auth');
    expect(f.terminal).toBe(true);
  });

  it('task-failed 带 InvalidApiKey → auth，不必等预检', () => {
    const f = classifyFailure({
      failure: { kind: 'task', code: 'InvalidApiKey', message: 'Invalid API-key provided.' },
    });
    expect(f.kind).toBe('auth');
    expect(f.terminal).toBe(true);
  });

  it('task-failed 带 Arrearage（欠费）→ auth', () => {
    const f = classifyFailure({
      failure: { kind: 'task', code: 'Arrearage', message: 'Account in arrears' },
    });
    expect(f.kind).toBe('auth');
  });

  it('detail 里明确写出「重试无效」，避免用户干等', () => {
    const f = classifyFailure({ preflightStatus: 401 });
    expect(f.detail).toContain('重试无效');
  });
});

describe('§13.2 #2 网络问题', () => {
  it('预检 status=0 → network + 可重试', () => {
    const f = classifyFailure({ preflightStatus: 0 });
    expect(f.kind).toBe('network');
    expect(f.terminal).toBe(false);
    expect(f.rule).toBe(2);
  });

  it('close 1006（异常断开）→ network', () => {
    const f = classifyFailure({ close: close(1006) });
    expect(f.kind).toBe('network');
    expect(f.terminal).toBe(false);
  });

  it('close 1011（服务端内部错误）→ network', () => {
    const f = classifyFailure({ close: close(1011) });
    expect(f.kind).toBe('network');
    expect(f.terminal).toBe(false);
  });

  it('⚠️ 什么都没给时兜底为 network，而不是 auth', () => {
    // 宁可多试几次，也不要因为信息缺失误判成终态把用户锁死
    const f = classifyFailure({});
    expect(f.kind).toBe('network');
    expect(f.terminal).toBe(false);
  });
});

describe('§13.2 #3 限流', () => {
  it('预检 429 → rate_limit，且**退避至少 5s**', () => {
    const f = classifyFailure({ preflightStatus: 429 });
    expect(f.kind).toBe('rate_limit');
    expect(f.terminal).toBe(false);
    expect(f.minRetryDelayMs).toBeGreaterThanOrEqual(5000);
  });

  it('task-failed 带 Throttling.RateQuota → rate_limit', () => {
    const f = classifyFailure({
      failure: { kind: 'task', code: 'Throttling.RateQuota', message: 'Requests rate limit exceeded' },
    });
    expect(f.kind).toBe('rate_limit');
    expect(f.minRetryDelayMs).toBeGreaterThanOrEqual(5000);
  });
});

describe('§13.2 #4 任务失败', () => {
  it('普通 task-failed → task（可重试，但连接必须重建）', () => {
    const f = classifyFailure({
      failure: { kind: 'task', code: 'InternalError', message: 'Something broke' },
    });
    expect(f.kind).toBe('task');
    expect(f.terminal).toBe(false);
    expect(f.rule).toBe(4);
    expect(f.detail).toContain('不可复用');
  });
});

describe('§13.2 #5 假死 / 服务端超时', () => {
  it('close 1007 → stalled（不是"协议写错了"，是长时间没音频被踢）', () => {
    const f = classifyFailure({ close: close(1007) });
    expect(f.kind).toBe('stalled');
    expect(f.terminal).toBe(false);
    expect(f.rule).toBe(5);
  });

  it('1007 的说明要能解释"为什么会这样"', () => {
    const f = classifyFailure({ close: close(1007) });
    expect(f.detail).toMatch(/无有效音频|心跳/);
  });
});

describe('§13.2 #6 翻译失败', () => {
  it('是降级而不是断线：不涉及重连', () => {
    expect(TRANSLATE_FAILURE.kind).toBe('translate');
    expect(TRANSLATE_FAILURE.terminal).toBe(false);
    expect(TRANSLATE_FAILURE.rule).toBe(6);
  });
});

describe('§13.2 #7 / #8 捕获层', () => {
  it('拿不到流 → 终态（重试无意义，需要用户手势）', () => {
    expect(CAPTURE_FAILURE.kind).toBe('capture');
    expect(CAPTURE_FAILURE.terminal).toBe(true);
    expect(CAPTURE_FAILURE.detail).toContain('点击扩展图标');
  });

  it('标签页关闭 → 终态，但属于正常结束而不是错误', () => {
    expect(TAB_GONE_FAILURE.kind).toBe('tab_gone');
    expect(TAB_GONE_FAILURE.terminal).toBe(true);
    expect(TAB_GONE_FAILURE.title).not.toMatch(/错误|失败/);
  });
});

describe('判定优先级', () => {
  it('服务端给了 error_code 就不用看预检（证据更硬）', () => {
    const f = classifyFailure({
      failure: { kind: 'task', code: 'InvalidApiKey', message: '' },
      // 矛盾输入：预检说网络断了
      preflightStatus: 0,
    });
    expect(f.kind).toBe('auth');
  });

  it('预检状态码比 close 码更能定性', () => {
    const f = classifyFailure({ close: close(1006), preflightStatus: 401 });
    expect(f.kind).toBe('auth');
  });
});

describe('needsPreflight：只在原因不明时才多花一次 HTTPS', () => {
  it('close 1006 值得问（可能是断网，也可能是 Key 坏了）', () => {
    expect(needsPreflight({ close: close(1006) })).toBe(true);
  });

  it('握手失败值得问', () => {
    expect(needsPreflight({ failure: { kind: 'handshake', message: 'boom' } })).toBe(true);
  });

  it('task-failed 带 error_code 不用问（服务端已经说了）', () => {
    expect(needsPreflight({ failure: { kind: 'task', code: 'X', message: '' } })).toBe(false);
  });

  it('1007 / 1011 这类明确的服务端断开不用问', () => {
    expect(needsPreflight({ close: close(1007) })).toBe(false);
    expect(needsPreflight({ close: close(1011) })).toBe(false);
  });

  it('自己主动关的不用问', () => {
    expect(needsPreflight({ close: close(1000, 'client-stop', true) })).toBe(false);
  });

  it('协议脏数据不用问', () => {
    expect(needsPreflight({ failure: { kind: 'protocol', message: '' } })).toBe(false);
  });
});

describe('分类结果的完整性（UI 依赖这些字段）', () => {
  const samples = [
    classifyFailure({ preflightStatus: 401 }),
    classifyFailure({ preflightStatus: 429 }),
    classifyFailure({ close: close(1006) }),
    classifyFailure({ close: close(1007) }),
    classifyFailure({ failure: { kind: 'task', code: 'X', message: '' } }),
    classifyFailure({}),
    TRANSLATE_FAILURE,
    CAPTURE_FAILURE,
    TAB_GONE_FAILURE,
  ];

  it('每个结果都有 rule / title / detail / minRetryDelayMs', () => {
    for (const f of samples) {
      expect(f.rule).toBeGreaterThanOrEqual(1);
      expect(f.rule).toBeLessThanOrEqual(10);
      expect(f.title.length).toBeGreaterThan(0);
      expect(f.detail.length).toBeGreaterThan(0);
      expect(typeof f.minRetryDelayMs).toBe('number');
      expect(f.minRetryDelayMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('终态的规则只有 1 / 7 / 8（Key 无效、拿不到流、标签页关闭）', () => {
    const terminalRules = samples.filter((f) => f.terminal).map((f) => f.rule);
    for (const r of terminalRules) expect([1, 7, 8]).toContain(r);
  });

  it('title 里不含密钥（防止误把 Key 写进角标悬停）', () => {
    for (const f of samples) {
      expect(f.title).not.toMatch(/sk-/);
      expect(f.detail).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
    }
  });
});
