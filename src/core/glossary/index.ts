/**
 * 术语表的使用方式：**先按输入过滤，再注入提示词**（D98）。
 *
 * 为什么必须过滤：全量表 120 条 ≈ 1348 字符 ≈ 700+ tokens，而**每句话都要付一遍**。
 * M1 实测：一句话里真正命中的通常只有 3–4 条（`ビリビリ` `指針` `配信`），其余全是陪跑。
 * 过滤后既省 token 又省延迟，输入越短差别越明显。
 */
import { FALSE_FRIENDS, STREAM_TERMS } from './terms';

export interface GlossaryTerm {
  source: string;
  target: string;
}

export interface BuildGlossaryOptions {
  /** 是否带上同形异义词（D22 的核心价值，默认带） */
  falseFriends?: boolean;
  /** 是否带上直播固定译法 */
  streamTerms?: boolean;
  /** 用户自定义（优先级最高，放最后以便覆盖观感） */
  extra?: Record<string, string>;
}

/**
 * 去掉括号里的说明，保留真正要用的译词。
 *
 * ⚠️ 这里**改进了 M1 的做法**：探针当年是 `split(/[（(]/)[0].split('、')[0]`，
 * 会把 `非常；或"辛苦、不得了"（…）` 这种**切坏成 `非常；或"辛苦`**（因为分隔符是「；」不是「、」）。
 * 现在只剥括号，保留分号连接的备选译法。
 */
function cleanTarget(value: string): string {
  return value
    .replace(/（[^）]*）/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildGlossary(options: BuildGlossaryOptions = {}): GlossaryTerm[] {
  const { falseFriends = true, streamTerms = true, extra = {} } = options;
  const out: GlossaryTerm[] = [];
  const push = (source: string, target: string): void => {
    out.push({ source, target: cleanTarget(target) });
  };

  // 顺序：先通用直播译法，再同形异义词（更关键），最后用户自定义
  if (streamTerms) for (const [k, v] of Object.entries(STREAM_TERMS)) push(k, v);
  if (falseFriends) for (const [k, v] of Object.entries(FALSE_FRIENDS)) push(k, v);
  for (const [k, v] of Object.entries(extra)) out.push({ source: k, target: v });

  return out;
}

/**
 * 只保留**文本里真的出现**的术语。
 *
 * 匹配策略：子串包含。汉字术语天然适用 —— 假朋友的定义就是「汉字长得一样」；
 * 纯拉丁字母（SC、CP）按大小写不敏感匹配。
 */
export function filterGlossary(text: string, terms: readonly GlossaryTerm[]): GlossaryTerm[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: GlossaryTerm[] = [];

  for (const term of terms) {
    const source = term.source;
    if (!source || seen.has(source)) continue;
    const hit = /^[A-Za-z0-9_]+$/.test(source)
      ? new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(text)
      : text.includes(source);
    if (hit) {
      seen.add(source);
      out.push(term);
    }
  }

  return out;
}

export interface FilteredGlossaryBlock {
  /** 可直接拼接进 system 提示词的文本块；无命中时为空串 */
  block: string;
  hit: number;
  total: number;
}

/**
 * 生成过滤版提示词块。
 *
 * 返回 `hit`/`total` 是为了可观测性 —— 命中率异常（例如总是 0）说明术语表失效了，
 * 这种事不该只在译文质量下降时才被发现。
 */
export function toFilteredPromptBlock(text: string, options: BuildGlossaryOptions = {}): FilteredGlossaryBlock {
  const all = buildGlossary(options);
  const hit = filterGlossary(text, all);
  if (!hit.length) return { block: '', hit: 0, total: all.length };

  const lines = hit.map((t) => `  ${t.source} → ${t.target}`);
  return {
    block: `\n\n【术语表 · 必须严格遵守】\n${lines.join('\n')}\n\n⚠️ 上表是**同形异义词**（日语汉字与中文汉字长得一样但意思不同），遇到这些词必须按上表译，不要按中文读法直译，也不要用上表译词的同义替换。`,
    hit: hit.length,
    total: all.length,
  };
}

export { FALSE_FRIENDS, STREAM_TERMS };
