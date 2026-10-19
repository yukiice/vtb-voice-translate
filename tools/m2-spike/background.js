/**
 * Service worker —— M2-0 spike。
 *
 * 职责边界（与 PLAN §6.1 的分工一致）：
 *   · SW：生命周期、创建 offscreen、拿 streamId、角标状态灯
 *   · offscreen：真正的采集与音频处理
 *
 * 为什么要绕这一圈：`chrome.tabCapture.getMediaStreamId()` **必须**在 SW/扩展页里调，
 * 而音频处理必须在 offscreen 里跑（SW 会休眠）。所以只能这样接力。
 *
 * 触发方式（D61）：点击扩展图标。点击本身即构成 user gesture，满足 tabCapture 的要求。
 *
 * 🔴 首次实跑踩到的坑（v2 修复）—— 一个标签页**同时只能有一条** tabCapture 流。
 *    只要上一条流还活着，再点一次图标就会拿到：
 *        Error: Cannot capture a tab with an active stream.
 *    这不是链路坏了，而是「重复取流」（PLAN §8.8）。本版补三件事：
 *      ① 会话状态由 offscreen 持有 —— SW 随时可能被回收，内存变量不可信；
 *      ② 点击图标 = **toggle**：同一标签页再点 → 停止；换标签页 → 先停旧再起新；
 *      ③ 撞上 active stream 时，先销毁 offscreen 强制释放再重试一次；
 *         仍失败 = 残留流不在扩展侧，只能刷新标签页（见 acquireStreamId 的提示）。
 *    另注：tabCapture 的失败是**普通 Error**（`e.name` 恒为 `'Error'`），不是 DOMException，
 *    所以判定只能靠 message 正则，不能沿用 `e.name` 查表 —— v1 的提示映射就因此永远打不出来。
 */

const OFFSCREEN_PATH = 'offscreen.html';

// ───────────────────────── 小工具 ─────────────────────────

const log = (...a) => console.log('[SW]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function badge(text, color = '#2563eb') {
  await chrome.action.setBadgeText({ text: text ?? '' });
  if (text) await chrome.action.setBadgeBackgroundColor({ color });
}

/** offscreen document 是否已存在 */
async function hasOffscreen() {
  // Chrome 116+ 支持 getContexts；更早的版本没有，退回 try/catch
  if (chrome.runtime.getContexts) {
    const ctxs = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
    });
    return ctxs.length > 0;
  }
  // 老办法：clients.matchAll
  const clients = await self.clients.matchAll();
  return clients.some((c) => c.url === chrome.runtime.getURL(OFFSCREEN_PATH));
}

/**
 * 向 offscreen 询问当前会话状态。
 * 这是**唯一可信的状态源**：offscreen 在捕获期间一直活着（PLAN §8.2），
 * 而 SW 被回收后内存变量会清零 —— 拿 SW 的变量做 toggle 判定必然错。
 */
async function offscreenStatus() {
  if (!(await hasOffscreen())) return { alive: false, capturing: false, tabId: null, seconds: 0 };
  try {
    const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'status' });
    return {
      alive: true,
      capturing: !!res?.capturing,
      tabId: res?.tabId ?? null,
      seconds: res?.seconds ?? 0,
    };
  } catch (e) {
    log('查询 offscreen 状态失败：', e.message);
    return { alive: true, capturing: false, tabId: null, seconds: 0 };
  }
}

/**
 * 确保 offscreen document 存在。
 * ⚠️ 竞态：重复调用 createDocument 会抛 "Only a single offscreen document may be created"。
 *    这里用「先查后建 + 建失败再查一次」兜住。
 */
async function ensureOffscreen() {
  if (await hasOffscreen()) {
    log('offscreen 已存在');
    return;
  }
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['USER_MEDIA'],
      justification: '采集 B 站直播标签页音频用于实时字幕（不录制、不落盘）',
    });
    log('offscreen 已创建');
  } catch (e) {
    // 多半是竞态：别人刚建好了
    if (String(e.message).includes('single offscreen')) {
      log('offscreen 已由并发调用创建');
      return;
    }
    throw e;
  }
}

/** 销毁 offscreen —— 连带回收 AudioContext / 音频设备，也是清残留流的手段 */
async function closeOffscreen(reason) {
  if (!(await hasOffscreen())) return;
  try {
    await chrome.offscreen.closeDocument();
    log(`offscreen 已销毁（${reason}）`);
  } catch (e) {
    log(`销毁 offscreen 失败：${e.message}`);
  }
}

// ───────────────────────── 主流程 ─────────────────────────

chrome.action.onClicked.addListener((tab) => {
  handleClick(tab).catch((e) => log('未捕获异常：', e.stack || e.message));
});

/**
 * 点击图标 = 唯一入口（D61），语义是 toggle：
 *   正在采集的就是这个标签页 → 停止
 *   正在采集的是别的标签页   → 先停旧的，再起新的（同一枚图标，不加 UI）
 *   没在采集                 → 开始
 */
async function handleClick(tab) {
  log(`被点击：tabId=${tab.id}  url=${tab.url ?? '(无权限读)'}`);

  const st = await offscreenStatus();
  if (st.capturing && st.tabId === tab.id) {
    await stopCapture(`再次点击图标（已采集约 ${Math.round(st.seconds)}s）`);
    return;
  }
  if (st.capturing) {
    log(`当前正在采集 tabId=${st.tabId}，先停止旧会话再切到 tabId=${tab.id}`);
    await stopCapture('切换标签页');
  }
  await startCapture(tab);
}

async function startCapture(tab) {
  await badge('…');

  // ① 拿 streamId（必须在 SW 里调）
  const streamId = await acquireStreamId(tab);
  if (!streamId) return;

  // ② 确保 offscreen 存在
  try {
    await ensureOffscreen();
  } catch (e) {
    log('❌ 创建 offscreen 失败：', e.message);
    await badge('✕', '#dc2626');
    return;
  }

  // ③ 把 streamId 派发过去
  try {
    await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'start-capture',
      streamId,
      tabId: tab.id,
    });
    log('streamId 已派发给 offscreen');
    await badge('REC', '#16a34a');
  } catch (e) {
    log('❌ 派发失败：', e.message);
    await badge('✕', '#dc2626');
  }
}

/**
 * 取 streamId，并专门处理「同一标签页已有活跃流」这一实测坑。
 *
 * ⚠️ 注意错误形态：tabCapture 抛的是**普通 Error**（`e.name === 'Error'`），
 *    message 才是有效信息 —— 所以这里按 message 判定，不复用 DOMException 名字表。
 */
async function acquireStreamId(tab) {
  const t0 = Date.now();
  try {
    const id = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    log(`getMediaStreamId 成功（${Date.now() - t0}ms）：${String(id).slice(0, 12)}…`);
    return id;
  } catch (e) {
    const msg = String(e.message ?? '');

    // ── 坑：重复取流（PLAN §8.8）──
    if (/active stream/i.test(msg)) {
      log('⚠️ 该标签页已有活跃的 tabCapture 流 —— 这是「重复取流」，不是链路坏了');
      log('   ↳ 先销毁 offscreen（扩展侧唯一能主动释放流的地方），再重试一次…');
      await closeOffscreen('强制清理残留捕获流');
      await sleep(400);
      try {
        const id = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
        log(`清理后重试成功（${Date.now() - t0}ms）：${String(id).slice(0, 12)}…`);
        return id;
      } catch (e2) {
        log('❌ 清理后仍然失败：', String(e2.message));
        log('   ↳ 残留流不在扩展侧：浏览器认为该标签页仍被捕获，扩展无法自行解除。');
        log('   ↳ 解法：刷新该标签页（Cmd/Ctrl+R）或关掉重开，然后再点图标。');
        await badge('⟳', '#dc2626');
        return null;
      }
    }

    log('❌ getMediaStreamId 失败：', e.name, msg);
    await badge('✕', '#dc2626');
    log('   ↳ 可能原因：', classifyError(e, tab));
    console.log('[SW] 完整错误：', e);
    return null;
  }
}

/** 把 tabCapture 的报错翻成人话（按 message，不按 e.name —— 见文件头注） */
function classifyError(e, tab) {
  const msg = String(e.message ?? '');
  if (/has not been invoked/i.test(msg) || e.name === 'NotAllowedError')
    return '没拿到 activeTab 授权 —— 必须点击图标时正处在该标签页上（点击本身即授权）';
  if (/active stream/i.test(msg)) return '该标签页已有活跃捕获流（见上方处理）';
  if (/Cannot capture|not capturable|is not capturable/i.test(msg))
    return `目标不可捕获：${tab.url ?? ''} —— chrome:// 页、扩展页，或已被别的进程/扩展占用`;
  if (e.name === 'NotFoundError') return '标签页不存在或已关闭';
  if (e.name === 'NotSupportedError') return 'manifest 缺 tabCapture 权限';
  return `未分类（name=${e.name}）`;
}

/**
 * 停止采集并释放标签页。
 * 顺序重要：先让 offscreen 停轨道（**这才是解除 Chrome 侧 active stream 的关键**），
 * 再销毁 offscreen 把 AudioContext / 音频设备一并回收。
 */
async function stopCapture(reason) {
  log(`停止采集：${reason}`);
  try {
    const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop-capture' });
    log(`offscreen 已停止（${res?.detail ?? 'ok'}）`);
  } catch (e) {
    log(`停止指令未送达（${e.message}）—— 直接销毁 offscreen`);
  }
  await closeOffscreen('停止采集后释放资源');
  await badge('');
  log('已停止，该标签页的捕获已释放（可以重新点图标再采）');
}

// ───────────────────────── 来自 offscreen 的消息 ─────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'sw') return;

  if (msg.type === 'log') {
    log(msg.text);
  } else if (msg.type === 'level') {
    // 用角标显示实时音量档位（D57：角标兼任状态灯）
    const db = msg.db;
    if (db > -45) void badge('▮▮▮', '#16a34a');
    else if (db > -60) void badge('▮▮', '#65a30d');
    else if (db > -Infinity) void badge('▮', '#ca8a04');
    else void badge('·', '#9ca3af');
  } else if (msg.type === 'done') {
    void badge(msg.ok ? '✓' : '✕', msg.ok ? '#16a34a' : '#dc2626');
    log(msg.ok ? `✅ 验证通过，峰值 ${msg.peakDb.toFixed(1)} dBFS` : '❌ 验证未通过');
    if (msg.ok) log('   ↳ 采集仍在继续；再点一次图标即可停止并释放标签页');
  } else if (msg.type === 'ended') {
    // 轨道被浏览器结束（标签页刷新/关闭、系统收回），角标必须跟着复位，否则是假状态
    log(`⚠️ 音频轨道已结束（${msg.reason ?? '未知原因'}）—— 捕获已释放`);
    void badge('');
  }
  sendResponse({ ok: true });
  return true;
});

// 目标标签页被关掉时主动收尾，别让 offscreen 攥着一条永远不会再出声的流
chrome.tabs.onRemoved.addListener((tabId) => {
  (async () => {
    const st = await offscreenStatus();
    if (st.capturing && st.tabId === tabId) await stopCapture('目标标签页已关闭');
  })().catch((e) => log('onRemoved 清理异常：', e.message));
});

log('service worker 已启动，等待点击扩展图标（再次点击 = 停止）');
