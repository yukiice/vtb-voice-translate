/**
 * 日语→中文「同形异义词」表（false friends）。
 *
 * 为什么需要它：日语汉字和中文汉字大量同形，但**词义常常不同**。
 * LLM 和 MT 都会不自觉地按中文读法去理解，产生「看起来毫无破绽、实际意思完全错」的译文。
 * 实测案例：`ビリビリの指針` → 「B站的**指针**」（正确应为「B站的**规范/准则**」）。
 *
 * 这类错误比语法错误危险得多 —— 读者察觉不到，因为它读起来非常通顺。
 *
 * 用法：
 *   import { FALSE_FRIENDS, STREAM_TERMS, buildGlossary } from './glossary.mjs';
 *
 * 注意：本表**只收「容易译错」的**，不追求完整。宁可少而准，不要多而杂。
 * 每条都标注了实际含义，避免维护时误改。
 */

/** ⚠️ 同形异义词：日语含义 ≠ 中文表面含义 */
export const FALSE_FRIENDS = {
  // ── 最容易踩、且和直播内容高度相关 ──
  指針: '方针、准则（❌ 不是"指针"）',
  検討: '讨论、研究、评估（❌ 不是"检讨/自我批评"）',
  迷惑: '麻烦、骚扰、困扰（❌ 不是"迷惑/困惑"）',
  適当: '随便、敷衍、差不多就行（❌ 不是"适当/妥当"）',
  深刻: '严重、严峻（❌ 不是"深刻"）',
  真面目: '认真、正经（❌ 不是"真面目"）',
  我慢: '忍耐、忍住',
  勝手: '自作主张、擅自、随便',
  邪魔: '打扰、碍事、妨碍',
  遠慮: '客气、顾虑、回避',
  無理: '勉强、不可能、办不到',
  面倒: '麻烦、费事（面倒くさい＝好麻烦）',
  大丈夫: '没关系、没问题、不要紧',
  結構: '相当、挺；或"不用了"（视语境）',
  微妙: '说不清、不好说、有点悬',
  工夫: '巧思、想办法、下功夫（❌ 不是"工夫/时间"）',
  得意: '擅长、拿手（❌ 不是"得意/骄傲"）',
  苦手: '不擅长、怕、应付不来',
  是非: '务必、一定要',
  全然: '完全（不）…（现代日语多接否定）',
  用意: '准备',
  都合: '方便、情况、时间安排',
  気の毒: '可怜、同情',
  世話: '照顾、照料、帮忙',
  承知: '知道、明白、同意',
  恐縮: '惶恐、不好意思、过意不去',
  早速: '立刻、马上',
  大変: '非常；或"辛苦、不得了"（❌ 不是"大变"）',
  一緒: '一起、一同',
  心配: '担心、操心',
  案外: '出乎意料、意外地',
  一応: '姑且、大致、暂且',
  大切: '重要、珍贵',
  大事: '重要、要紧',
  確か: '大概、应该；或"确实"',
  多分: '大概、多半',
  上達: '进步、提高（技能）',
  出前: '外卖',
  残業: '加班',
  給料: '工资、薪水',
  検索: '搜索、检索',
  情報: '信息、消息',
  空気: '气氛、空气',
  世間: '社会、世人',
  常識: '常识（这个词中日一致，保留作对照）',

  // ── 中文读法会误解的实体词 ──
  娘: '女儿（❌ 不是"娘/母亲"）',
  老婆: '老太婆（❌ 不是"老婆/妻子"）',
  愛人: '情人、婚外恋对象（❌ 不是"爱人/配偶"）',
  手紙: '信、信件（❌ 不是"手纸/卫生纸"）',
  汽車: '火车（❌ 不是"汽车"）',
  丈夫: '结实、耐用、健壮（❌ 不是"丈夫"）',
  大家: '房东（❌ 不是"大家/所有人"）',
  心中: '殉情（❌ 不是"心中/心里"）',
  放心: '发呆、出神（❌ 不是"放心/安心"）',
  得体: '得体、像样（中日大体一致）',
  経理: '会计、财务',
  経営: '经营',
  経済: '经济',
  新聞: '报纸（❌ 不是"新闻"）',
  通知: '通知（一致）',
  名字: '姓氏（❌ 不是"名字/姓名"）',
  取引: '交易、买卖',
  相場: '行情、市价',
  人気: '人气、受欢迎（❌ 不是"人气/生气的样子"）',
  無料: '免费',
  有料: '收费',
  携帯: '手机（❌ 不是"携带"）',
  家内: '内人、我妻子',
  主人: '丈夫；或"主人/老板"（视语境）',

  // ── 网络 / 直播黑话（日语特有的用法，直译必错）──
  草: '笑死、哈哈哈（日式网络用语，源自 www＝笑う；❌ 不是"草"）',
  ワロタ: '笑死、哈哈哈',
  乙: '辛苦了（お疲れ様的网络简写）',
  厨: '中二病、脑残粉、ky 的人',
  荒らし: '捣乱的人、恶意刷屏者',
  自演: '自导自演、自吹自擂',
  パクリ: '抄袭、山寨',
  ガチ: '认真、真心、动真格',
  ネタ: '梗、段子、素材',
  ネタバレ: '剧透',
  マジ: '真的、认真',
  ウケる: '好笑、笑死',
  沼: '深坑、入迷（沼にハマる＝沉迷其中）',
  推し: '本命、推的（偶像/角色）',
  神: '神级、超棒（神回＝神回/超精彩的一集）',
  切り抜き: '切片、剪辑片段',
  初見: '第一次来（直播间）',
  常連: '老观众、常客',
  凸: '连线、突袭（凸待ち＝等待观众连线）',
  枠: '场次、时段（歌枠＝歌回）',
  生放送: '直播',
  収録: '录制、录像',
};

/** 📺 直播场景固定译法（不是"异义"，而是"统一译法"，保证字幕一致性） */
export const STREAM_TERMS = {
  配信: '直播',
  雑談: '杂谈',
  歌枠: '歌回',
  雑談枠: '杂谈回',
  スパチャ: 'SC',
  スーパーチャット: 'SC',
  メンバー: '会员',
  メン限: '会员限定',
  リスナー: '观众',
  コメント: '弹幕',
  弾幕: '弹幕',
  ビリビリ: 'B站',
  スパチャ読み: '读 SC',
  挨拶: '打招呼',
  凸待ち: '连线回',
  同時接続: '同接',
  切り抜き: '切片',
  歌ってみた: '翻唱',
  配信者: '主播',
  視聴者: '观众',
  登録者: '订阅者',
  高評価: '点赞',
  低評価: '点踩',
  チャンネル: '频道',
  ボイス: '语音包',
  グッズ: '周边',
  告知: '通知',
  企画: '企划',
};

/**
 * 构建给翻译用的术语表。
 * @param {object} opts
 * @param {boolean} opts.falseFriends 是否带上同形异义词（默认 true —— 这是 D22 的核心价值）
 * @param {boolean} opts.streamTerms  是否带上直播固定译法（默认 true）
 * @param {object}  opts.extra        用户自定义（优先级最高）
 * @returns {{source:string,target:string}[]}
 */
export function buildGlossary({ falseFriends = true, streamTerms = true, extra = {} } = {}) {
  const out = [];
  const push = (k, v) => {
    // 从注释里剥离说明，只取真正的译词（第一个「、」或「（」之前）
    const clean = String(v).split(/[（(]/)[0].split('、')[0].trim();
    out.push({ source: k, target: clean });
  };
  if (streamTerms) for (const [k, v] of Object.entries(STREAM_TERMS)) push(k, v);
  if (falseFriends) for (const [k, v] of Object.entries(FALSE_FRIENDS)) push(k, v);
  for (const [k, v] of Object.entries(extra)) out.push({ source: k, target: String(v) });
  return out;
}

/** 转成 `a=b,c=d` 的 CLI 形式 */
export function toCliSpec(opts) {
  return buildGlossary(opts)
    .map((t) => `${t.source}=${t.target}`)
    .join(',');
}

/** 转成给 LLM 提示词的文本块 */
export function toPromptBlock(opts) {
  const terms = buildGlossary(opts);
  if (!terms.length) return '';
  const lines = terms.map((t) => `  ${t.source} → ${t.target}`);
  return `\n\n【术语表 · 必须严格遵守】\n${lines.join('\n')}\n\n⚠️ 上表是**同形异义词**（日语汉字与中文汉字长得一样但意思不同），遇到这些词必须按上表译，不要按中文读法直译。`;
}

/**
 * 🎯 只保留**输入文本里真正出现**的术语（D98）。
 *
 * 为什么需要：119 条全发 ≈ 1348 字符 ≈ 700+ tokens，**每句话都付一遍**。
 * 但实测一句话里真正命中的往往只有三四个（`ビリビリ` `指針` `配信`）。
 * 过滤后既省 token 又省延迟，且输入越短效果越明显。
 *
 * 匹配策略：子串匹配。日文术语不含汉字时（如 `スパチャ` `なんか`）用直接包含判断；
 * 汉字术语同理 —— 因为假朋友的定义就是「汉字长得一样」。
 *
 * @param {string} text 待翻译的日语原文
 * @param {{source:string,target:string}[]} terms 全量术语表
 * @returns {{source:string,target:string}[]} 命中的子集
 */
export function filterGlossary(text, terms) {
  if (!text) return [];
  const seen = new Set();
  const out = [];
  for (const t of terms) {
    const src = t.source;
    if (!src || seen.has(src)) continue;
    // 汉字/假名直接子串匹配；纯拉丁字母（如 CP、SC）按大小写不敏感匹配
    const hit = /^[A-Za-z0-9_]+$/.test(src)
      ? new RegExp(src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(text)
      : text.includes(src);
    if (hit) {
      seen.add(src);
      out.push(t);
    }
  }
  return out;
}

/**
 * 过滤版提示词块。同样一段话，只需带命中的那几条术语。
 * @returns {{block:string, hit:number, total:number}} 统计信息便于观察命中率
 */
export function toFilteredPromptBlock(text, opts) {
  const all = buildGlossary(opts);
  const hit = filterGlossary(text, all);
  if (!hit.length) return { block: '', hit: 0, total: all.length };
  const lines = hit.map((t) => `  ${t.source} → ${t.target}`);
  return {
    block: `\n\n【术语表 · 必须严格遵守】\n${lines.join('\n')}\n\n⚠️ 上表是**同形异义词**（日语汉字与中文汉字长得一样但意思不同），遇到这些词必须按上表译，不要按中文读法直译。`,
    hit: hit.length,
    total: all.length,
  };
}

export default { FALSE_FRIENDS, STREAM_TERMS, buildGlossary, toCliSpec, toPromptBlock, filterGlossary, toFilteredPromptBlock };
