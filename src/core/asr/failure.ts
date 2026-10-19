/**
 * 故障分类（PLAN §13.2）。**纯函数，无状态、无 IO**。
 *
 * ── 为什么需要单独一层 ──
 * 会话层（`session.ts`）只知道「出事了」，而且只知道三种粗粒度：
 * `handshake / task / protocol`。但 §13.2 要求区分 10 类，因为**动作完全不同**：
 *
 *   1. Key 无效  → **绝不能重试**（重试 8 次也还是 401，纯烧时间和配额）
 *   2. 网络抖动  → 快速退避重连
 *   3. 429 限流  → 退避，且**至少 5s 起**（比普通抖动慢，尊重服务端）
 *   4. task-failed → 连接**不可复用**，必须整条新建
 *
 * 把分类抽出来，才能对每种故障单独写测试，而不是「跑真机看看」。
 *
 * ── 为什么分类需要 preflight 状态码 ──
 * ⚠️ 这是 α 架构最坑的一点（M1 实测，见 `ws-socket.ts` 的注释）：
 * **WebSocket 握手失败时，浏览器只给 `close 1006` + 空 reason**，拿不到 HTTP 状态码。
 * 所以「Key 无效」和「断网」在 WS 层面**长得一模一样**。
 *
 * 解法：只有在**失败原因不明**时，才用一次 HTTPS 请求（`preflight.ts`，D72）把原因定性。
 * 不能每次连之前都预检 —— 那会多一次往返，正常观感下不该付这个代价。
 */
import type { AsrFailure, CloseInfo } from './types';

/** §13.2 的 10 类故障（域名与文档编号一一对应） */
export type FailureKind =
  /** #1 Key 无效 / 欠费 → 终态，需人工 */
  | 'auth'
  /** #2 网络抖动 / 断网 → 退避重连 */
  | 'network'
  /** #3 限流 429 → 退避，但起步更慢 */
  | 'rate_limit'
  /** #4 ASR 任务失败 → 连接不可复用，必须新建 */
  | 'task'
  /** #5 假死 / 服务端超时断开（D104：完全停发音频约 24s 会被 1007 踢） */
  | 'stalled'
  /** #6 翻译失败 → 只影响译文，不影响 ASR 连接 */
  | 'translate'
  /** #7 tabCapture 拿不到流 → 终态，需用户手势 */
  | 'capture'
  /** #8 标签页关闭 / 导航 → 正常结束 */
  | 'tab_gone'
  /** #9 全屏切换 */
  | 'fullscreen'
  /** #10 content script 未就绪 */
  | 'inject';

export interface ClassifiedFailure {
  /** §13.2 表格里的行号（1–10），用于日志与文档对齐 */
  rule: number;
  kind: FailureKind;
  /** 终态：**不再自动重试**，必须人工介入或本场结束 */
  terminal: boolean;
  /** 重试前的**最短**等待；真实间隔取 `max(退避表, 这个值)` */
  minRetryDelayMs: number;
  /** 给角标悬停用的短标签 */
  title: string;
  /** 给日志/面板用的详细说明 */
  detail: string;
}

/** 分类的输入：三者都可能缺失，按「信息量从强到弱」依次判断 */
export interface ClassifyInput {
  /** 会话层报的失败 */
  failure?: AsrFailure | null;
  /** 关闭信息（含 `bySelf`，用于排除"自己关的"） */
  close?: CloseInfo | null;
  /** HTTPS 预检拿到的状态码；`null`/`undefined` = 没跑预检 */
  preflightStatus?: number | null;
}

/**
 * `task-failed` 的 `error_code` 可能长这样（DashScope 的命名不太统一）：
 * `InvalidApiKey` / `Arrearage` / `AccessDenied` / `Throttling.RateQuota` / …
 *
 * ⚠️ 只能按**子串**匹配，不能精确等值 —— 服务端会带命名空间前缀
 * （`Throttling.RateQuota`、`InvalidParameter.FileDownloadFailed`）。
 */
const AUTH_CODE_HINTS = ['invalidapikey', 'invalid_api_key', 'arrearage', 'accessdenied', 'unauthorized', 'forbidden'];
const RATE_LIMIT_CODE_HINTS = ['throttling', 'ratelimit', 'rate_limit', 'quota', 'toomanyrequests'];

function hit(haystack: string, needles: readonly string[]): boolean {
  const s = haystack.toLowerCase();
  return needles.some((n) => s.includes(n));
}

function detailOf(x: { message?: string; reason?: string; code?: string | number }): string {
  const parts = [x.message, x.reason].filter((s): s is string => Boolean(s && s.trim()));
  if (parts.length) return parts.join(' / ');
  return x.code != null && x.code !== '' ? `code=${String(x.code)}` : '未知原因';
}

/**
 * 把一次失败归类。
 *
 * **判定顺序很重要**：先看证据最硬的（服务端给的 error_code、预检状态码），
 * 最后才落到「默认当网络问题」—— 因为网络问题是最常见的，而且重试是安全的兜底。
 */
export function classifyFailure(input: ClassifyInput): ClassifiedFailure {
  const { failure, close, preflightStatus } = input;

  // ── 1. 服务端明确说了原因（task-failed 的 error_code）—— 证据最硬 ──
  if (failure?.kind === 'task') {
    const codeText = `${failure.code ?? ''} ${failure.message}`;
    if (hit(codeText, AUTH_CODE_HINTS)) {
      return {
        rule: 1,
        kind: 'auth',
        terminal: true,
        minRetryDelayMs: 0,
        title: 'Key 无效或欠费',
        detail: `服务端判定鉴权失败（${detailOf(failure)}）—— 重试无效，请到百炼控制台确认`,
      };
    }
    if (hit(codeText, RATE_LIMIT_CODE_HINTS)) {
      return {
        rule: 3,
        kind: 'rate_limit',
        terminal: false,
        minRetryDelayMs: 5000,
        title: '被限流',
        detail: `服务端限流（${detailOf(failure)}）—— 退避后自动重试`,
      };
    }
    return {
      rule: 4,
      kind: 'task',
      terminal: false,
      minRetryDelayMs: 0,
      title: '识别任务失败',
      detail: `ASR 任务被服务端终止（${detailOf(failure)}）—— 连接不可复用，将整条重建`,
    };
  }

  // ── 2. 预检状态码：这是唯一能区分「Key 无效」与「断网」的证据（WS 拿不到） ──
  if (preflightStatus != null) {
    if (preflightStatus === 401 || preflightStatus === 403) {
      return {
        rule: 1,
        kind: 'auth',
        terminal: true,
        minRetryDelayMs: 0,
        title: 'Key 无效或欠费',
        detail: `预检返回 HTTP ${preflightStatus}：Key 无效、被禁用或欠费 —— 重试无效`,
      };
    }
    if (preflightStatus === 429) {
      return {
        rule: 3,
        kind: 'rate_limit',
        terminal: false,
        minRetryDelayMs: 5000,
        title: '被限流',
        detail: '预检返回 HTTP 429：触发限流（Key 本身没问题），退避后重试',
      };
    }
    if (preflightStatus === 0) {
      return {
        rule: 2,
        kind: 'network',
        terminal: false,
        minRetryDelayMs: 0,
        title: '网络不通',
        detail: '连不上 dashscope.aliyuncs.com —— 检查代理/防火墙，将自动重试',
      };
    }
  }

  // ── 3. 关闭码 ──
  if (close && !close.bySelf) {
    // 1007 = 收到的数据格式非法。实测：**完全停发音频约 24s 会被 1007 断开**（D104），
    // 所以它其实更接近「假死」而不是「协议写错了」。
    if (close.code === 1007) {
      return {
        rule: 5,
        kind: 'stalled',
        terminal: false,
        minRetryDelayMs: 0,
        title: '连接已超时断开',
        detail: `服务端以 1007 断开（长时间无有效音频/心跳）—— 将自动重连`,
      };
    }
    if (close.code === 1000) {
      // 1000 但 bySelf=false：服务端主动正常关闭（例如任务被结束）
      return {
        rule: 2,
        kind: 'network',
        terminal: false,
        minRetryDelayMs: 0,
        title: '服务端关闭了连接',
        detail: '服务端以 1000 正常关闭连接 —— 将自动重连',
      };
    }
    return {
      rule: 2,
      kind: 'network',
      terminal: false,
      minRetryDelayMs: 0,
      title: '连接中断',
      detail: `WebSocket 断开（code=${close.code}${close.reason ? `, ${close.reason}` : ''}）—— 将自动重连`,
    };
  }

  // ── 4. 协议层脏数据：不致命，但值得记一笔 ──
  if (failure?.kind === 'protocol') {
    return {
      rule: 2,
      kind: 'network',
      terminal: false,
      minRetryDelayMs: 0,
      title: '收到异常数据',
      detail: `${detailOf(failure)} —— 按网络问题处理，自动重连`,
    };
  }

  // ── 5. 兜底：握手失败且没跑预检 ──
  // ⚠️ 这里**不能**直接判成 auth —— 断网也是这个形状。宁可多试几次也不要误锁。
  return {
    rule: 2,
    kind: 'network',
    terminal: false,
    minRetryDelayMs: 0,
    title: '连接失败',
    detail: `${detailOf(failure ?? close ?? {})} —— 将自动重连`,
  };
}

/**
 * 是否值得为这次失败跑一次 HTTPS 预检。
 *
 * 只在**原因不明**时跑：已经能认定的（task 带 error_code、429、明确的 close 码之外的握手失败）
 * 就别多花那一次往返。特别是 Key 无效的场景 —— 跑一次预检就能避免 8 次无意义重连。
 */
export function needsPreflight(input: ClassifyInput): boolean {
  const { failure, close } = input;
  // 自己主动关的（stop / 上一轮清理）：不是故障，没什么可定性的
  if (close?.bySelf) return false;
  // 已经知道原因了
  if (failure?.kind === 'task') return false;
  if (close && close.code !== 1006) return false; // 1006 才是"原因不明"的那个
  if (failure?.kind === 'protocol') return false;
  // 握手失败 / 1006 断连：可能是 Key，也可能是网络 → 值得问一次
  return true;
}

// ───────────────────────── 非 ASR 侧的故障（§13.2 的 #6–#10） ─────────────────────────

/** #6 翻译失败：**不影响 ASR 连接**，只是这一句没有译文 */
export const TRANSLATE_FAILURE: ClassifiedFailure = {
  rule: 6,
  kind: 'translate',
  terminal: false,
  minRetryDelayMs: 0,
  title: '翻译失败',
  detail: '译文获取失败，该句显示日文原文；下一句会自动恢复',
};

/** #7 tabCapture 拿不到流：**自动重试无意义**，必须用户手势 */
export const CAPTURE_FAILURE: ClassifiedFailure = {
  rule: 7,
  kind: 'capture',
  terminal: true,
  minRetryDelayMs: 0,
  title: '无法捕获标签页音频',
  detail: 'tabCapture 需要用户手势触发 —— 请直接点击扩展图标重试',
};

/** #8 标签页关闭/导航：**正常结束**，不是错误 */
export const TAB_GONE_FAILURE: ClassifiedFailure = {
  rule: 8,
  kind: 'tab_gone',
  terminal: true,
  minRetryDelayMs: 0,
  title: '直播已结束',
  detail: '标签页已关闭或跳转，本场采集结束',
};

/** #10 字幕层注入失败 */
export const INJECT_FAILURE: ClassifiedFailure = {
  rule: 10,
  kind: 'inject',
  terminal: false,
  minRetryDelayMs: 0,
  title: '字幕层未就绪',
  detail: '页面上还没有字幕浮层 —— 刷新直播页即可恢复',
};
