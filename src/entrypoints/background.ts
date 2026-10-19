/**
 * Service worker（PLAN §6.2）。
 *
 * 职责边界刻意很窄：**只做 Chrome 生命周期** —— 拉 offscreen、调
 * `tabCapture.getMediaStreamId()`、响应图标点击（toggle）、按 D57 用角标当状态灯。
 * 音频捕获、下混/重采样、稳定化、ASR、翻译全在 offscreen，避免跨上下文高频通信。
 *
 * ⚠️ MV3 的 SW 会被随时回收，所以这里**不放任何需要长期存活的状态**：
 * 「是否在采集」一律问 offscreen（M2-0 spike 踩过 —— 状态放在 SW 里，回收一次就与现实不符）。
 */
import type { CaptureResponse, CaptureStatus, OffscreenRequest } from '@/shared/audio-messages';
import type { SubtitleRelayMessage } from '@/shared/subtitle';
import { loadSettings, type Settings } from '@/storage/settings';

/** offscreen 文档路径（`src/entrypoints/offscreen/index.html` 的构建产物） */
const OFFSCREEN_PATH = 'offscreen.html';

/** 角标文案（D57 / §13.1：角标兼任状态灯） */
const BADGE_STARTING = '⏳';
const BADGE_CAPTURING = '●';
const BADGE_ERROR = '!';
const BADGE_COLOR = '#2563eb';
const BADGE_ERROR_COLOR = '#dc2626';
const BADGE_WARN_COLOR = '#d97706';

/**
 * §13.1 的 8 态 → 角标。
 *
 * 设计约束（D56）：**不弹窗、不遮遑、不打断**。异常时只是符号变一下，
 * 但这一下必须变得有意义 —— 「字幕不动了」和「Key 过期了」是完全不同的处境，
 * 而它们在没有状态灯时长得一模一样。
 */
const BADGE_BY_STATE: Record<string, { text: string; color: string }> = {
  idle: { text: '', color: BADGE_COLOR },
  stopped: { text: '', color: BADGE_COLOR },
  starting: { text: BADGE_STARTING, color: BADGE_COLOR },
  running: { text: BADGE_CAPTURING, color: BADGE_COLOR },
  degraded: { text: '⚠', color: BADGE_WARN_COLOR },
  reconnecting: { text: '↻', color: BADGE_WARN_COLOR },
  auth_failed: { text: '⛔', color: BADGE_ERROR_COLOR },
  gave_up: { text: '✕', color: BADGE_ERROR_COLOR },
};

/** 这些状态下，点击图标应该**重试**而不是停止（§13.1） */
const RETRYABLE_STATES = new Set(['auth_failed', 'gave_up']);

// ── polyfill 类型未覆盖的两个 API（用局部类型描述我们真正用到的部分） ──
// 这样比到处 `as any` 安全：用错参数会在 typecheck 阶段暴露。
type OffscreenApi = {
  createDocument(options: { url: string; reasons: string[]; justification: string }): Promise<void>;
  closeDocument(): Promise<void>;
};
type TabCaptureApi = {
  getMediaStreamId(options: { targetTabId: number }): Promise<string>;
};

function offscreenApi(): OffscreenApi {
  return browser.offscreen as unknown as OffscreenApi;
}
function tabCaptureApi(): TabCaptureApi {
  return browser.tabCapture as unknown as TabCaptureApi;
}

async function setBadge(text: string, error = false): Promise<void> {
  await browser.action.setBadgeText({ text });
  if (text) await browser.action.setBadgeBackgroundColor({ color: error ? BADGE_ERROR_COLOR : BADGE_COLOR });
}

/** 按 8 态刷新角标（§13.1）。成本暂时不挤进角标（符号更辨识），留给成本面板 */
async function setBadgeForState(state: string | undefined): Promise<void> {
  const spec = state ? BADGE_BY_STATE[state] : undefined;
  if (!spec) {
    await setBadge('');
    return;
  }
  await browser.action.setBadgeText({ text: spec.text });
  if (spec.text) await browser.action.setBadgeBackgroundColor({ color: spec.color });
}

/**
 * 给 offscreen 发消息。
 *
 * offscreen 文档不存在时 `sendMessage` 会 reject —— **正好可以当「不存在」的判据**，
 * 不必再去查 `runtime.getContexts()`（那是 Chrome 116+ 才有的 API，还要处理兼容分支）。
 */
async function sendToOffscreen(msg: OffscreenRequest): Promise<CaptureResponse | null> {
  try {
    return (await browser.runtime.sendMessage(msg)) as CaptureResponse;
  } catch {
    return null;
  }
}

/** 读会话状态；返回 null 表示 offscreen 尚未创建 */
async function offscreenStatus(): Promise<CaptureStatus | null> {
  const res = await sendToOffscreen({ target: 'offscreen', type: 'status' });
  return res?.status ?? null;
}

async function ensureOffscreen(): Promise<void> {
  if (await offscreenStatus()) return;
  try {
    await offscreenApi().createDocument({
      url: OFFSCREEN_PATH,
      // USER_MEDIA：需要长期持有 getUserMedia 流（并同时跑 WebAudio + 未来的 WebSocket）
      reasons: ['USER_MEDIA'],
      justification: '捕获直播标签页音频并保持长连接以生成实时字幕；offscreen 是 MV3 中唯一能长期运行 WebAudio/WebSocket 的上下文',
    });
  } catch (e) {
    // 并发或竞态下重复创建会报 "Only a single offscreen document may be created" —— 可忽略
    const text = e instanceof Error ? e.message : String(e);
    if (!/single offscreen/i.test(text)) throw e;
  }
}

async function closeOffscreen(reason: string): Promise<void> {
  try {
    await offscreenApi().closeDocument();
    console.log(`[vtb] offscreen 已关闭（${reason}）`);
  } catch {
    // 本来就没有文档 —— 正常情况（例如启动前就在清理）
  }
}

/**
 * 取 streamId。
 *
 * ⚠️ 撞上「active stream」时**先销毁 offscreen 强制清流再重试一次**：
 * 一个标签页同时只能有一条 tabCapture 流，而残留流往往挂在上一轮的 offscreen 上
 * （M2-0 spike 的坑 8）。重试一次就能自愈，比直接报错让用户去刷新标签页好得多。
 */
async function acquireStreamId(tabId: number): Promise<string> {
  try {
    return await tabCaptureApi().getMediaStreamId({ targetTabId: tabId });
  } catch (e) {
    if (!isActiveStreamError(e)) throw e;
    console.warn('[vtb] 撞上 active stream，销毁 offscreen 清流后重试一次');
    await closeOffscreen('stale-stream');
    return await tabCaptureApi().getMediaStreamId({ targetTabId: tabId });
  }
}

/**
 * ⚠️ tabCapture 抛的是**普通 `Error`**，`e.name` 恒为 `'Error'`（不是 DOMException），
 * 所以判断只能看 message（M2-0 spike 实测；按 `e.name` 查表的老写法永远打不出提示）。
 */
function isActiveStreamError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /active stream/i.test(msg);
}

/** 把底层异常翻译成用户能照做的提示，而不是把 Chrome 的英文原文丢出去 */
function explainError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/active stream/i.test(msg)) return '该标签页仍有残留的捕获流，请刷新该标签页后重试';
  if (/permission|not allowed|NotAllowed/i.test(msg)) return '缺少权限或非用户手势触发：请直接点击扩展图标';
  if (/No tab with id|Cannot access|chrome:\/\//i.test(msg)) return '该页面不支持捕获（内部页面/商店页面等），请切到直播标签页';
  if (/no audio track/i.test(msg)) return '标签页里没有音频轨道 —— 确认直播正在播放';
  return msg;
}

async function startCapture(tabId: number, settings: Settings): Promise<void> {
  await setBadge(BADGE_STARTING);
  try {
    await ensureOffscreen();
    const streamId = await acquireStreamId(tabId);
    const res = await sendToOffscreen({
      target: 'offscreen',
      type: 'start-capture',
      streamId,
      tabId,
      // 把配置带下去（见 StartCaptureRequest.settings 的注释：offscreen 刚创建时读不到 storage）
      settings: { apiKey: settings.apiKey, ...(settings.model ? { model: settings.model } : {}) },
    });
    if (!res?.ok) throw new Error(res?.error ?? 'offscreen 未返回结果');

    await setBadge(BADGE_CAPTURING);
    console.log(`[vtb] 开始采集 tab=${tabId}（再点一次图标即停止）`);
  } catch (e) {
    await setBadge(BADGE_ERROR, true);
    console.error(`[vtb] 启动失败：${explainError(e)}`);
    // 别留一个空转的 offscreen
    await closeOffscreen('start-failed');
  }
}

async function stopCapture(reason: string): Promise<void> {
  const res = await sendToOffscreen({ target: 'offscreen', type: 'stop-capture' });
  await closeOffscreen(reason);
  await setBadge('');
  console.log(`[vtb] 已停止（${reason}，释放 ${res?.releasedTracks ?? 0} 条轨道）`);
}

/** 点击图标 = toggle（D61：不做 popup）。判断依据是 offscreen 的真实状态，不是本地变量。 */
async function handleClick(tab: { id?: number }): Promise<void> {
  const tabId = tab.id;
  if (tabId == null) return;

  const status = await offscreenStatus();
  if (status?.capturing) {
    // ⚠️ 采集还在跑，但 ASR 已经进了终态（Key 无效 / 重试用尽）：
    //    此时点击应该**重试**，而不是把采集停掉。
    //    这是「角标就是按钮」的设计（§13.1）：用户看到 ⛔ 就会去点它。
    if (RETRYABLE_STATES.has(status.sessionState)) {
      console.log(`[vtb] 手动重试（原状态 ${status.sessionState}）`);
      await sendToOffscreen({ target: 'offscreen', type: 'retry' });
      await setBadgeForState('starting');
      return;
    }
    await stopCapture('user-stop');
    return;
  }

  // 没配 Key 就**别白跑一趟**（否则会先建流再失败，用户还得自己去翻设置页入口）。
  // 也顺带把「你点击的是哪个扩展副本」打在日志里 —— 加载多份副本时，
  // 它们各有各的 storage，Key 很容易存在另一个副本里。
  let settings: Settings;
  try {
    settings = await loadSettings();
  } catch (e) {
    // ⚠️ 「读取失败」与「没配置」是两回事，必须分开报 —— 否则会把排查引到错方向
    // （真机上就吃过这个亏：offscreen 读 storage 失败，却报「未配置 API Key」）。
    await setBadge(BADGE_ERROR, true);
    console.error(`[vtb] 读取设置失败（storage 不可用？）：${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  if (!settings.apiKey.trim()) {
    await setBadge(BADGE_ERROR, true);
    console.warn(
      `[vtb] 未配置 API Key —— 已为你打开设置页（本扩展 ID ${browser.runtime.id}；请确认与设置页底部显示的 ID 一致）`,
    );
    await browser.runtime.openOptionsPage();
    return;
  }

  await startCapture(tabId, settings);
}

export default defineBackground(() => {
  // 冷启动先打一行带 [VTB] 前缀的日志，并**直接在日志里告诉用户怎么区分两个扩展**。
  // 这是纯可验证性考虑：两个扩展的 Service Worker 检查器长得一模一样，
  // 而旧 spike 扩展的启动文案与本扩展高度相似（都叫「已启动，等待点击扩展图标」），
  // 极容易「点着新扩展、看着旧扩展的 console」。
  console.log(
    `%c[VTB]%c VTB Voice Translate 已就绪（扩展 ID %c${browser.runtime.id}%c）。前缀 %c[VTB]%c / %c[vtb/offscreen]%c = 本扩展；%c[SW]%c = 旧的 M2-0 spike 扩展`,
    'color:#2563eb;font-weight:bold',
    '',
    'color:#7c3aed;font-weight:bold',
    '',
    'color:#2563eb;font-weight:bold',
    '',
    'color:#2563eb;font-weight:bold',
    '',
    'color:#9ca3af',
    '',
  );

  browser.action.onClicked.addListener((tab) => {
    // 顶层 catch：SW 里未捕获的 rejection 会被静默丢弃，排查时看不到任何线索
    void handleClick(tab).catch((e) => {
      console.error(`[vtb] 点击处理异常：${e instanceof Error ? e.message : String(e)}`);
    });
  });

  // 标签页关闭 → 优雅拆掉（§13.2 故障 8）
  browser.tabs.onRemoved.addListener((removedTabId) => {
    void (async () => {
      const status = await offscreenStatus();
      if (status?.capturing && status.tabId === removedTabId) {
        await stopCapture('tab-closed');
      }
    })();
  });

  browser.runtime.onMessage.addListener((raw) => {
    const msg = raw as { type?: string; tabId?: number; level?: string; text?: string };

    // offscreen 回流的日志：让用户「一个 console 看全」
    // （offscreen 是独立文档，它自己的 console 要到「检查视图」里单独打开）
    if (msg?.type === 'capture-log') {
      const line = `[vtb/offscreen] ${msg.text ?? ''}`;
      if (msg.level === 'error') console.error(line);
      else if (msg.level === 'warn') console.warn(line);
      else console.log(line);
      return undefined;
    }

    // 字幕转发：**offscreen 没有 `chrome.tabs`**（Chrome 的 API 限制），
    // 所以把它交给 SW 代发给 content script。
    if (msg?.type === 'subtitle-relay') {
      const relay = raw as SubtitleRelayMessage;
      // 顺手把状态映射到角标：这一条路径本来就在流量上，不用额外消息（§13.1）
      if (relay.payload?.type === 'subtitle-status') {
        void setBadgeForState(relay.payload.state);
      }
      // content script 可能还没注入（用户没刷新页面）—— 静默忽略，这是正常情况
      void Promise.resolve(browser.tabs.sendMessage(relay.tabId, relay.payload)).catch(() => undefined);
      return undefined;
    }

    // 来自 offscreen 的通知：轨道 ended（标签页关闭/跳转/流被抢占）
    if (msg?.type === 'capture-ended') {
      void (async () => {
        const status = await offscreenStatus();
        if (status?.capturing) await stopCapture('stream-ended');
        else await setBadge('');
        console.warn(`[vtb] 采集流已结束（tab=${msg.tabId ?? '?'}）—— 标签页关闭/跳转，或流被其它程序抢走`);
      })();
    }
    return undefined; // 不占用响应通道
  });

  // SW 冷启动（可能刚被回收过）：按 offscreen 的真实状态把角标对齐，避免残留错状态
  void (async () => {
    const status = await offscreenStatus();
    await setBadgeForState(status?.capturing ? status.sessionState : undefined);
  })();
});
