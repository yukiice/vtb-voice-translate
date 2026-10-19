/**
 * `src/core/asr/` 的单元测试。
 *
 * 这里刻意用**假 socket** 驱动真实事件序列，而不是连真网络 ——
 * M1 的教训是「协议细节只有真机才能发现」，而真机一轮要花几分钟 + 真钱。
 * 把 socket 抽象成接口后，那些坑（usage 不在 task-finished 上、心跳包
 * sentence_id=0、二进制不能走 JSON、task-failed 的字段位置）都能在毫秒级验证。
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PARAMS,
  buildEndpointUrl,
  buildFinishTask,
  buildRunTask,
  parseServerMessage,
  redactSecrets,
} from '../src/core/asr/protocol';
import { BangleAsrSession } from '../src/core/asr/session';
import type { SocketLike } from '../src/core/asr/types';

/** 记录发送内容、可手动驱动事件的假 socket */
class FakeSocket implements SocketLike {
  sent: (string | ArrayBufferView)[] = [];
  bufferedAmount = 0;
  closeCalls: { code?: number; reason?: string }[] = [];

  #openCb?: () => void;
  #msgCb?: (data: unknown) => void;
  #errCb?: (err: unknown) => void;
  #closeCb?: (info: { code: number; reason: string }) => void;

  send(data: string | ArrayBufferView): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
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

  // ── 测试驱动 ──
  emitOpen(): void {
    this.#openCb?.();
  }
  emitEvent(obj: unknown): void {
    this.#msgCb?.(JSON.stringify(obj));
  }
  emitRaw(raw: unknown): void {
    this.#msgCb?.(raw);
  }
  emitError(err: unknown): void {
    this.#errCb?.(err);
  }
  emitClose(code: number, reason: string): void {
    this.#closeCb?.({ code, reason });
  }
  /** 最后一次发出的文本消息（解析成对象） */
  lastText(): Record<string, unknown> | null {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const item = this.sent[i]!;
      if (typeof item === 'string') return JSON.parse(item) as Record<string, unknown>;
    }
    return null;
  }
  binaryCount(): number {
    return this.sent.filter((s) => typeof s !== 'string').length;
  }
}

const API_KEY = 'sk-test1234567890abcdef';

function taskStarted(id = 'task-1'): unknown {
  return { header: { event: 'task-started', task_id: id }, payload: {} };
}

function sentenceEvent(opts: {
  id: number;
  text?: string;
  end?: boolean;
  heartbeat?: boolean;
  usage?: Record<string, number>;
}): unknown {
  return {
    header: { event: 'result-generated', task_id: 'task-1' },
    payload: {
      output: {
        sentence: {
          sentence_id: opts.id,
          ...(opts.text !== undefined ? { text: opts.text } : {}),
          ...(opts.end !== undefined ? { sentence_end: opts.end } : {}),
          ...(opts.heartbeat ? { heartbeat: true } : {}),
        },
      },
      ...(opts.usage ? { usage: opts.usage } : {}),
    },
  };
}

async function connected(socket = new FakeSocket()): Promise<{ socket: FakeSocket; session: BangleAsrSession }> {
  const session = new BangleAsrSession({
    apiKey: API_KEY,
    socketFactory: () => socket,
    newTaskId: () => 'task-fixed',
  });
  const pending = session.open(1000);
  socket.emitOpen();
  await pending;
  return { socket, session };
}

describe('协议层（纯函数）', () => {
  it('buildRunTask 的字段层级与 M1 实测一致', () => {
    const msg = JSON.parse(buildRunTask({ taskId: 't1', model: 'm1', params: {} })) as any;
    expect(msg.header).toEqual({ action: 'run-task', task_id: 't1', streaming: 'duplex' });
    expect(msg.payload.task_group).toBe('audio');
    expect(msg.payload.task).toBe('asr');
    expect(msg.payload.function).toBe('recognition');
    expect(msg.payload.model).toBe('m1');
    expect(msg.payload.input).toEqual({}); // 无上下文时给空对象，不省略
    expect(msg.payload.parameters).toMatchObject(DEFAULT_PARAMS);
  });

  it('buildRunTask 有上下文时塞进 input.context', () => {
    const ctx = [{ role: 'user', type: 'input_text', text: '术语' }];
    const msg = JSON.parse(buildRunTask({ taskId: 't1', model: 'm1', params: {}, context: ctx })) as any;
    expect(msg.payload.input.context).toEqual(ctx);
  });

  it('buildFinishTask 用 finish-task 动作', () => {
    const msg = JSON.parse(buildFinishTask('t1')) as any;
    expect(msg.header.action).toBe('finish-task');
    expect(msg.header.task_id).toBe('t1');
  });

  it('鉴权走 ?api_key= 且做 URL 编码（D43：浏览器 WebSocket 设不了请求头）', () => {
    const url = buildEndpointUrl('wss://example.com/ws', 'sk-a+b/c=');
    expect(url).toBe('wss://example.com/ws?api_key=sk-a%2Bb%2Fc%3D');
  });

  it('默认参数必须开中间结果与心跳（D45）', () => {
    expect(DEFAULT_PARAMS.intermediate_result_enabled).toBe(true);
    expect(DEFAULT_PARAMS.heartbeat).toBe(true);
    expect(DEFAULT_PARAMS.sample_rate).toBe(16000);
    expect(DEFAULT_PARAMS.language_hints).toEqual(['ja']);
  });

  it('心跳包不当作句子（sentence_id=0 + heartbeat=true）', () => {
    const parsed = parseServerMessage(
      JSON.stringify({
        header: { event: 'result-generated' },
        payload: { output: { sentence: { sentence_id: 0, heartbeat: true } } },
      }),
      1,
    );
    expect(parsed?.event).toBe('result-generated');
    expect(parsed?.sentence).toBeUndefined();
  });

  it('result-generated 带出 usage（服务端给的是任务累计值）', () => {
    const parsed = parseServerMessage(
      JSON.stringify({
        header: { event: 'result-generated' },
        payload: { output: { sentence: { sentence_id: 3, text: 'あ' } }, usage: { input_tokens: 100 } },
      }),
      1,
    );
    expect(parsed?.usage).toEqual({ input_tokens: 100 });
    expect(parsed?.sentence?.sentence_id).toBe(3);
  });

  it('task-finished 不带 usage 时不要清空已有值', () => {
    const parsed = parseServerMessage(JSON.stringify({ header: { event: 'task-finished' }, payload: {} }), 1);
    expect(parsed?.usage).toBeUndefined();
  });

  it('task-failed 带出错误码与信息', () => {
    const parsed = parseServerMessage(
      JSON.stringify({ header: { event: 'task-failed', error_code: 'X1', error_message: 'boom' } }),
      1,
    );
    expect(parsed?.failure).toEqual({ code: 'X1', message: 'boom' });
  });

  it('坏数据返回 null 而不是抛异常（一条脏消息不该打断链路）', () => {
    expect(parseServerMessage('not json', 1)).toBeNull();
    expect(parseServerMessage(new ArrayBuffer(4), 1)).toBeNull();
  });

  it('未知事件记为 unknown（协议变更时可排查）', () => {
    const parsed = parseServerMessage(JSON.stringify({ header: { event: 'brand-new' } }), 1);
    expect(parsed?.event).toBe('unknown');
  });

  it('密钥在进日志前被抹掉', () => {
    expect(redactSecrets(`failed sk-abcdefgh12345678 oops`)).not.toContain('sk-abcdefgh12345678');
  });
});

describe('会话状态机（FakeSocket 驱动）', () => {
  it('open 触发 onOpen 后进入已连接，start 后进入 running', async () => {
    const { socket, session } = await connected();
    expect(session.state).toBe('connected'); // 已建连、但还没 run-task

    const pending = session.start();
    expect(session.state).toBe('starting');
    expect(socket.lastText()).toMatchObject({ header: { action: 'run-task' } });

    socket.emitEvent(taskStarted());
    await pending;
    expect(session.state).toBe('running');
    expect(session.taskId).toBe('task-fixed');
  });

  it('草稿推进与定稿分别回调，且句子按 sentence_id 归组', async () => {
    const socket = new FakeSocket();
    const seen: string[] = [];
    const session = new BangleAsrSession(
      { apiKey: API_KEY, socketFactory: () => socket, newTaskId: () => 't' },
      { onSentence: (s, kind) => seen.push(`${kind}:${s.id}:${s.final ?? s.drafts.at(-1)?.text}`) },
    );
    const p = session.open(1000);
    socket.emitOpen();
    await p;
    const sp = session.start();
    socket.emitEvent(taskStarted());
    await sp;

    socket.emitEvent(sentenceEvent({ id: 1, text: 'こん' }));
    socket.emitEvent(sentenceEvent({ id: 1, text: 'こんにちは' }));
    socket.emitEvent(sentenceEvent({ id: 1, text: 'こんにちは。', end: true }));

    expect(seen).toEqual(['draft:1:こん', 'draft:1:こんにちは', 'final:1:こんにちは。']);
    const rec = session.sentences.get(1)!;
    expect(rec.final).toBe('こんにちは。');
    expect(rec.drafts).toHaveLength(2);
    expect(rec.tFinal).not.toBeNull();
    session.close();
  });

  it('task-failed 记为 failure 并把状态置为 failed', async () => {
    const { socket, session } = await connected();
    const p = session.start();
    socket.emitEvent(taskStarted());
    await p;

    socket.emitEvent({ header: { event: 'task-failed', error_code: 'E42', error_message: 'bad' } });
    expect(session.failure).toEqual({ kind: 'task', code: 'E42', message: 'bad' });
    expect(session.state).toBe('failed');
  });

  it('未 start 之前 sendAudio 一律丢弃（否则服务端会先收到音频再收到 run-task）', async () => {
    const { socket, session } = await connected();
    expect(session.sendAudio(new Int16Array(1600))).toBe(false);
    expect(socket.binaryCount()).toBe(0);

    const p = session.start();
    socket.emitEvent(taskStarted());
    await p;
    expect(session.sendAudio(new Int16Array(1600))).toBe(true);
    expect(socket.binaryCount()).toBe(1);
  });

  it('背压：积压超过阈值就丢帧并计数（宁可丢帧，不让延迟累积）', async () => {
    const { socket, session } = await connected();
    const p = session.start();
    socket.emitEvent(taskStarted());
    await p;

    socket.bufferedAmount = 0;
    expect(session.sendAudio(new Int16Array(1024))).toBe(true);

    socket.bufferedAmount = 10 * 1024 * 1024; // 远超阈值
    expect(session.sendAudio(new Int16Array(1024))).toBe(false);
    expect(session.sendAudio(new Int16Array(1024))).toBe(false);

    expect(session.dropped.frames).toBe(2);
    expect(session.dropped.bytes).toBe(4096);
    expect(socket.binaryCount()).toBe(1); // 只有第一块真的发出去了
  });

  it('closeInfo 区分「服务端断开」与「自己关的」（D102/D103 的判活依据）', async () => {
    const { socket, session } = await connected();
    let seen: { code: number; bySelf: boolean } | null = null;
    socket.emitClose(1007, 'Invalid payload data');
    seen = session.closeInfo as unknown as { code: number; bySelf: boolean };
    expect(seen.code).toBe(1007);
    expect(seen.bySelf).toBe(false);
    expect(session.closeInfo?.reason).toBe('Invalid payload data');
  });

  it('自己 close 时 bySelf=true，且不抛异常', async () => {
    const { socket, session } = await connected();
    session.close();
    expect(socket.closeCalls).toHaveLength(1);
    expect(session.closeInfo?.bySelf).toBe(true);
  });

  it('坏消息被计数而不是抛异常', async () => {
    const { socket, session } = await connected();
    socket.emitRaw('{ 这不是 json');
    socket.emitRaw(new ArrayBuffer(8));
    expect(session.badMessages).toBe(2);
  });

  it('start 超时的错误信息里带上已收到的事件名（方便定位卡在哪一步）', async () => {
    const { socket, session } = await connected();
    // 收到的是**别**的事件 —— 此时 task-started 不可能命中，start 必然超时
    socket.emitEvent({ header: { event: 'result-generated' } });
    await expect(session.start(undefined, 30)).rejects.toThrow(/result-generated/);
  });

  it('finish 返回最终 usage', async () => {
    const { socket, session } = await connected();
    const p = session.start();
    socket.emitEvent(taskStarted());
    await p;

    socket.emitEvent(sentenceEvent({ id: 1, text: 'x', end: true, usage: { input_tokens: 42, duration: 10 } }));
    const fin = session.finish(500);
    socket.emitEvent({ header: { event: 'task-finished' }, payload: {} });
    const usage = await fin;

    expect(usage).toEqual({ input_tokens: 42, duration: 10 });
    expect(socket.lastText()).toMatchObject({ header: { action: 'finish-task' } });
  });
});
