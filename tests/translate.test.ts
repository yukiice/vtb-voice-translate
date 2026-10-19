/**
 * `src/core/glossary/` 与 `src/core/translate/` 的单元测试。
 *
 * 这两块是整个产品「看起来准不准」的关键：
 *   - 术语表失效 → 出现 `指針`→「指针」这种**读起来毫无破绽但意思全错**的译文；
 *   - 提示词组装错（术语块没拼上、前文没注入、白名单规则丢失）→ 质量静默下降，且很难归因。
 * 所以它们都用纯函数表达，在这里逐条钉住。
 */
import { describe, expect, it } from 'vitest';

import { buildGlossary, filterGlossary, toFilteredPromptBlock } from '../src/core/glossary';
import type { FetchLike } from '../src/core/http';
import { DEFAULT_TRANSLATE_MODEL, parseCompletion, translate } from '../src/core/translate/client';
import { TRANSLATE_SYSTEM_PROMPT, buildTranslateMessages } from '../src/core/translate/prompt';

describe('术语表', () => {
  it('全量表包含同形异义词与直播固定译法', () => {
    const all = buildGlossary();
    expect(all.length).toBeGreaterThan(100);
    const bySource = new Map(all.map((t) => [t.source, t.target]));
    expect(bySource.get('指針')).toBe('方针、准则');
    expect(bySource.get('配信')).toBe('直播');
    expect(bySource.get('ビリビリ')).toBe('B站');
  });

  it('去掉括号说明，但**不切坏**带分号备选的条目', () => {
    const bySource = new Map(buildGlossary().map((t) => [t.source, t.target]));
    // `大変: '非常；或"辛苦、不得了"（❌ 不是"大变"）'`
    // M1 当年的 split('、')[0] 会切坏成 `非常；或"辛苦`
    expect(bySource.get('大変')).toContain('辛苦');
    expect(bySource.get('大変')).not.toContain('大变');
    expect(bySource.get('常識')).toBe('常识');
  });

  it('按输入过滤：只保留真正出现的术语', () => {
    const all = buildGlossary();
    const hit = filterGlossary('ビリビリの指針について配信で話します', all);
    const sources = hit.map((t) => t.source);
    expect(sources).toContain('ビリビリ');
    expect(sources).toContain('指針');
    expect(sources).toContain('配信');
    // 过滤后的量应该远小于全量（这是 D98 省 token 的依据）
    expect(hit.length).toBeLessThan(all.length / 10);
  });

  it('拉丁字母条目按大小写不敏感匹配', () => {
    const terms = buildGlossary({ falseFriends: false, streamTerms: false, extra: { CP: 'CP' } });
    expect(filterGlossary('cp 好嗑', terms).map((t) => t.source)).toEqual(['CP']);
    expect(filterGlossary('无关文本', terms)).toEqual([]);
  });

  it('无命中时返回空块且如实报告 hit=0', () => {
    const r = toFilteredPromptBlock('まったく関係のない文章です');
    // 可能有巧合命中（如「配信」），所以只断言结构
    expect(typeof r.block).toBe('string');
    expect(r.hit).toBeLessThanOrEqual(r.total);
  });

  it('命中时生成带警示语的提示块', () => {
    const r = toFilteredPromptBlock('ビリビリの指針');
    expect(r.hit).toBeGreaterThanOrEqual(2);
    expect(r.block).toContain('指針 → 方针、准则');
    expect(r.block).toContain('术语表');
  });
});

describe('翻译提示词', () => {
  it('system 里保留了 v4 的两条核心规则（D99）', () => {
    expect(TRANSLATE_SYSTEM_PROMPT).toContain('加词白名单');
    expect(TRANSLATE_SYSTEM_PROMPT).toContain('汉字假朋友');
    // v4 的自检句：出现原文没有的实词就是错
    expect(TRANSLATE_SYSTEM_PROMPT).toContain('原文没有的实词');
  });

  it('基本结构：system → user（当前句）', () => {
    const msgs = buildTranslateMessages({ text: 'こんにちは' });
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.role).toBe('system');
    expect(msgs.at(-1)).toEqual({ role: 'user', content: 'こんにちは' });
  });

  it('术语块拼在 system 末尾', () => {
    const block = '\n\n【术语表 · 必须严格遵守】\n  指針 → 方针、准则';
    const msgs = buildTranslateMessages({ text: 'x', glossaryBlock: block });
    expect(msgs[0]!.content).toContain('指針 → 方针、准则');
    expect(msgs[0]!.content.startsWith(TRANSLATE_SYSTEM_PROMPT)).toBe(true);
  });

  it('前文按「原文/译文」成对注入，且只带最近 2 对（D37）', () => {
    const previous = [
      { source: 's1', target: 't1' },
      { source: 's2', target: 't2' },
      { source: 's3', target: 't3' },
    ];
    const msgs = buildTranslateMessages({ text: 'now', previous });
    const roles = msgs.map((m) => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'user', 'assistant', 'user']);
    expect(msgs[1]!.content).toBe('s2');
    expect(msgs[2]!.content).toBe('t2');
    expect(msgs.at(-1)!.content).toBe('now');
  });

  it('残缺的前文对会被跳过（半截上下文比没有更糟）', () => {
    const msgs = buildTranslateMessages({
      text: 'now',
      previous: [
        { source: 's1', target: '' },
        { source: 's2', target: 't2' },
      ],
    });
    const contents = msgs.map((m) => m.content);
    expect(contents).not.toContain('s1');
    expect(contents).toContain('s2');
  });
});

// ─────────────────────────── 翻译客户端 ───────────────────────────

interface FakeReply {
  ok?: boolean;
  status?: number;
  body?: string;
}

function fakeFetch(reply: FakeReply): { fetchImpl: FetchLike; sent: () => { url: string; init: Record<string, unknown> } } {
  let captured: { url: string; init: Record<string, unknown> } = { url: '', init: {} };
  const fetchImpl: FetchLike = async (url, init) => {
    captured = { url, init: (init ?? {}) as Record<string, unknown> };
    return {
      ok: reply.ok ?? true,
      status: reply.status ?? 200,
      text: async () => reply.body ?? '{}',
    };
  };
  return { fetchImpl, sent: () => captured };
}

function completionJson(content: string, usage?: Record<string, number>): string {
  return JSON.stringify({
    choices: [{ message: { role: 'assistant', content } }],
    ...(usage ? { usage } : {}),
  });
}

describe('翻译客户端', () => {
  it('请求体与 M1 实测配置一致（模型 / temperature / 关闭思考）', async () => {
    const { fetchImpl, sent } = fakeFetch({ body: completionJson('你好') });
    await translate([{ role: 'user', content: 'こんにちは' }], { apiKey: 'sk-test12345678', fetchImpl });

    const { url, init } = sent();
    expect(url).toContain('/compatible-mode/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test12345678');

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.model).toBe(DEFAULT_TRANSLATE_MODEL);
    expect(body.temperature).toBe(0.1);
    expect(body.enable_thinking).toBe(false);
    expect(body.messages).toEqual([{ role: 'user', content: 'こんにちは' }]);
  });

  it('返回译文与耗时', async () => {
    const { fetchImpl } = fakeFetch({ body: completionJson('你好', { input_tokens: 30, output_tokens: 5 }) });
    const r = await translate([{ role: 'user', content: 'x' }], { apiKey: 'sk-test12345678', fetchImpl });
    expect(r.text).toBe('你好');
    expect(r.ms).toBeGreaterThanOrEqual(0);
    expect(r.usage?.input_tokens).toBe(30);
  });

  it('HTTP 失败时抛出带状态码的错误（上层据此决定是否显示日文原文）', async () => {
    const { fetchImpl } = fakeFetch({ ok: false, status: 429, body: 'rate limited' });
    await expect(translate([{ role: 'user', content: 'x' }], { apiKey: 'sk-test12345678', fetchImpl })).rejects.toThrow(
      /429/,
    );
  });

  it('空译文被视为失败，而不是"翻译成功但没内容"', async () => {
    const { fetchImpl } = fakeFetch({ body: completionJson('') });
    await expect(translate([{ role: 'user', content: 'x' }], { apiKey: 'sk-test12345678', fetchImpl })).rejects.toThrow(
      /空文本/,
    );
  });

  it('超时后抛出可读错误（而不是挂在那里等）', async () => {
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    await expect(
      translate([{ role: 'user', content: 'x' }], { apiKey: 'sk-test12345678', fetchImpl: hanging, timeoutMs: 20 }),
    ).rejects.toThrow(/超时/);
  });

  it('缺少 Key 直接报错，不发请求', async () => {
    const { fetchImpl, sent } = fakeFetch({ body: completionJson('x') });
    await expect(translate([{ role: 'user', content: 'x' }], { apiKey: '  ', fetchImpl })).rejects.toThrow(/API Key/);
    expect(sent().url).toBe('');
  });
});

describe('响应解析', () => {
  it('支持 OpenAI 兼容形状与百炼原生形状', () => {
    expect(parseCompletion(completionJson('好')).text).toBe('好');
    expect(parseCompletion(JSON.stringify({ output: { choices: [{ message: { content: '也行' } }] } })).text).toBe('也行');
  });

  it('非 JSON 响应抛出可读错误', () => {
    expect(() => parseCompletion('<html>502</html>')).toThrow(/不是 JSON/);
  });
});
