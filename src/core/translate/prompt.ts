/**
 * 翻译提示词与消息组装（**纯函数**）。
 *
 * 提示词用 M1 定稿的 **v4（加词白名单制）**（D99）。演进过程很值得留着看 ——
 * 它是这个产品最核心的一处「产品判断」，而不是随手写的 prompt：
 *
 *   v1  基线：暴露三类问题 —— ① 汉字假朋友（`指針`→"指针"）② 加词 ③ 语气方向错（`とんでもない`→"离谱"）
 *   v2  加假朋友规则 + 严格「不要加词」：修掉了 ①②③，但**矫枉过正** ——
 *       口语感掉档，「ええ、でも、ありがとう、本当に」被译成「嗯，不过，谢谢，真的。」太僵
 *   v3  放宽为「不要加**信息**，但可以加**语气**」：口语感回来了，
 *       但出现新问题 —— `ありがとう` 被加了「感动」（那是**实词**，改了信息量）
 *   v4  **白名单制**：明确列举允许添加的**语法成分**（语气词/助词/连接词），其余一律禁止。
 *       自检句：「译文里出现原文没有的实词就是错」
 *
 * ⚠️ D100 记录了更重要的一件事：**不要在这个层面继续小样本调优** ——
 * 22 条探针上 v2/v3/v4 的差异小于轮次间方差（`temperature: 0.1` 仍非确定），
 * 继续调就是过拟合。真正的调优要用几百句真实直播样本。
 */

/** 日语是 SOV —— 谓语常出现在句末，所以「半句」是常态而非异常 */
const FORMAT = `【输出格式】
只输出中文译文。不要解释、不要引号、不要罗马音、不要重复原文。`;

/** 假朋友规则：v2 起引入，v3/v4 保留 */
const FALSE_FRIEND_RULE = `【最高优先级：汉字假朋友】
日语里大量汉字词与中文**长得一样、意思完全不同**。
遇到这类词，**必须按日语原意译，绝不能按中文读法直译**。
例：「指針」是方针/准则而不是指针，「検討」是讨论而不是检讨，「適当」是随便而不是适当。
下面给了术语表，表里的词必须严格遵守；表外遇到拿不准的汉字词，**宁可意译或加括号注原文，也不要硬直译**。`;

/** 语气方向：v2 起引入，v3/v4 保留 */
const TONE_RULE = `【语气方向要准确】
分辨说话人的情绪是褒是贬、是惊喜还是吐槽：
· 「とんでもない」在惊喜语境下 = 「太夸张了 / 简直不敢想」，**不是**「离谱」（贬义）
· 「やばい」可能是「太扯了」（贬）也可能是「超帅/超棒」（褒），看上下文
· 吐槽、装傻、撒娇的语气要保留，不要磨平成平淡陈述`;

/** v4 的 system 提示词（D99 定稿）。术语块会追加在末尾。 */
export const TRANSLATE_SYSTEM_PROMPT = `你是 VTuber 直播的日语→简体中文同传字幕翻译。
你的译文会被当作**实时字幕**看，首先要**准**，其次要**像中文**。

${FORMAT}

${FALSE_FRIEND_RULE}

【加词白名单 —— 只允许加这些】
可以添加的（**仅限语法性成分**）：
  ✅ 语气词：嘛、啦、啊、诶、欸、吧、呢、哦、呀
  ✅ 结构助词：的、了、吗、着、过
  ✅ 语序必需的连接词：就、才、还、也、都

绝对禁止添加的（**实词**）：
  ❌ 动词、名词、形容词、副词
  ❌ 原文没有的情绪词（例：原文只说「ありがとう」，就**不能**译成「感动」）
  ❌ 原文没有的事实、结论、主语、谓语

自检：如果你的译文里出现了一个**原文没有的实词**，就是错。

${TONE_RULE}

【填充词处理】
「なんか」「あの」「ええと」多数是**填充词**，没有实义。
不要把它们译成「随便」「那个」之类的实词 —— 直接省略，或用轻语气词带过。

【不要替她补完】
原文是半句 / 语病 / 口误，译文就照实保留不完整的语感。

【其他】
· 专有名词按术语表译；没有的日本人名/作品名，用约定俗成译法或保留原文
· 不要省略原文说了的内容`;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 前文的一对「原文→译文」，用于给翻译提供上下文（D37） */
export interface PastPair {
  source: string;
  target: string;
}

export interface BuildMessagesOptions {
  /** 本句日语原文 */
  text: string;
  /** `toFilteredPromptBlock()` 产出的术语块（可空） */
  glossaryBlock?: string;
  /** 前文对，最新的在最后 */
  previous?: readonly PastPair[];
  /** 最多带几对前文。D37 定为 2 —— 再多容易把话题带偏（实测风险），收益也趋零 */
  maxPreviousPairs?: number;
}

/**
 * 组装 OpenAI 兼容的 messages。
 *
 * 前文用**真实的对话历史**注入（`user: 原文` / `assistant: 译文`），
 * 而不是塞进 system —— 后者会让模型把它当成"示例"而非"刚才说过的话"，
 * 在语境延续（代词指代、话题连贯）上效果差一截。
 */
export function buildTranslateMessages({
  text,
  glossaryBlock = '',
  previous = [],
  maxPreviousPairs = 2,
}: BuildMessagesOptions): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: TRANSLATE_SYSTEM_PROMPT + glossaryBlock }];

  const pairs = previous.slice(-maxPreviousPairs);
  for (const pair of pairs) {
    // 跳过残缺对：只有一边有内容时，注入反而会误导
    if (!pair.source.trim() || !pair.target.trim()) continue;
    messages.push({ role: 'user', content: pair.source });
    messages.push({ role: 'assistant', content: pair.target });
  }

  messages.push({ role: 'user', content: text });
  return messages;
}
