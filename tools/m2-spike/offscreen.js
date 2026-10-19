/**
 * Offscreen document —— 音频采集核心（M2-0 spike）。
 *
 * 验证目标（PLAN §8.8 那条「未验证」的链路）：
 *
 *   service worker                          offscreen document
 *   ─────────────────────────────────────   ────────────────────────────────────
 *   chrome.tabCapture.getMediaStreamId()  →  streamId
 *                                           getUserMedia({ chromeMediaSource:'tab',
 *                                                          chromeMediaSourceId })
 *
 * ⚠️ 关键背景：`chrome.tabCapture.capture()` **不能在 offscreen 里调**（它要求调用方是
 *    标签页或 SW）。所以正确姿势只有上面这条 —— SW 拿 id，offscreen 拿流。
 *
 * 本脚本会顺带量几个真实参数（采样率、声道数、是否真有声音），
 * 因为 PLAN §6 假设「16kHz mono」，而 tabCapture 实际给的多半是 48kHz stereo。
 */

// ───────────────────────── 日志 ─────────────────────────

const $log = document.getElementById('log');
const $state = document.getElementById('state');
const t0 = Date.now();

function log(msg, level = 'info') {
  const ms = String(Date.now() - t0).padStart(6);
  const mark = { info: '·', ok: '✅', warn: '⚠️ ', fail: '❌' }[level] || '·';
  const line = `[${ms}ms] ${mark} ${msg}`;
  $log.textContent += line + '\n';
  $log.scrollTop = $log.scrollHeight;
  console.log(line);
  // 同时回传 SW，方便从 SW 控制台看
  chrome.runtime.sendMessage({ target: 'sw', type: 'log', text: line, level }).catch(() => {});
}

function setState(s) {
  $state.textContent = s;
}

// ───────────────────────── 状态 ─────────────────────────

let audioContext = null;
let stream = null;
let workletNode = null;
let sourceNode = null;
let reportCount = 0;
let loudestDb = -Infinity;

// 会话状态：SW 会休眠，所以「是否正在采集」这件事必须以这里为准（SW 会来查）
let capturing = false;
let currentTabId = null;
let startedAt = 0;
let concludeTimer = null;

// ───────────────────────── 核心：采集 ─────────────────────────

async function startCapture(streamId, tabId = null) {
  log(`收到 streamId (${String(streamId).slice(0, 12)}…)  tabId=${tabId ?? '(未提供)'}`, 'ok');

  // 🔴 同一个标签页只允许有一条 tabCapture 流。若上一轮会话还活着又走进来，
  //    绝不能让两个 AudioContext / 两条流叠加 —— 先清理干净再开始。
  if (capturing) {
    log('检测到上一次会话仍持有流，先停止再开始（防叠加）', 'warn');
    stopCapture('开始新采集前清理旧会话');
  }

  // 🔴 每轮会话的统计必须是**本轮**的：offscreen 会被复用，
  //    旧版不重置 reportCount / loudestDb → 结论行的数字跨会话累计（实测出现过"共 973 次上报"，
  //    而 10 秒最多约 40 次）。数字错了，结论就不可信。
  reportCount = 0;
  loudestDb = -Infinity;
  currentTabId = tabId;
  startedAt = Date.now();
  setState('正在 getUserMedia…');

  // ── 步骤 1：拿流 ──
  // 注意：这是 spike 里最可能失败的一步，出错信息要原样打出来。
  let tStep = Date.now();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });
    capturing = true;
    log(`getUserMedia 成功（${Date.now() - tStep}ms）—— 本标签页从此持有活跃流`, 'ok');
    log('  ↳ 此时若再让 SW 调一次 getMediaStreamId，Chrome 会直接拒绝（active stream）', 'warn');
  } catch (e) {
    log(`getUserMedia 失败：${e.name} — ${e.message}`, 'fail');
    setState('❌ getUserMedia 失败');
    // 常见原因提示
    const hints = {
      NotAllowedError: '多半是没拿到 activeTab 授权，或用户在弹窗里拒绝了',
      NotFoundError: 'chromeMediaSourceId 无效 / 已过期（streamId 是一次性的）',
      NotSupportedError: 'manifest 里缺 tabCapture 权限',
      AbortError: '目标标签页被关闭或跳转了',
    };
    if (hints[e.name]) log(`   ↳ 可能原因：${hints[e.name]}`, 'warn');
    return;
  }

  // ── 步骤 2：看真实参数（PLAN 假设 16kHz mono，实际多半不是）──
  const track = stream.getAudioTracks()[0];

  // 标签页被刷新/关闭、或流被系统收回时，Chrome 会结束这条轨道。
  // 必须把这个事实回报 SW，否则角标会一直停在 REC（假状态）。
  track.onended = () => {
    log('音频轨道 ended —— 标签页多半被刷新/关闭，或捕获被系统收回', 'warn');
    capturing = false;
    currentTabId = null;
    setState('已结束（标签页刷新/关闭？）');
    chrome.runtime.sendMessage({ target: 'sw', type: 'ended', reason: 'track ended' }).catch(() => {});
  };

  const settings = track.getSettings();
  log(`轨道参数：label="${track.label}"`, 'info');
  log(
    `  sampleRate=${settings.sampleRate ?? '未报告'}  channels=${settings.channelCount ?? '未报告'}  ` +
      `deviceId=${settings.deviceId ? '有' : '无'}`,
    'info',
  );

  // ── 步骤 3：建 AudioContext + Worklet ──
  tStep = Date.now();
  try {
    audioContext = new AudioContext();
    await audioContext.audioWorklet.addModule(chrome.runtime.getURL('worklet.js'));
    log(`AudioWorklet 加载成功（${Date.now() - tStep}ms）`, 'ok');
  } catch (e) {
    log(`AudioWorklet 加载失败：${e.name} — ${e.message}`, 'fail');
    setState('❌ AudioWorklet 失败');
    return;
  }

  log(`AudioContext 实际采样率：${audioContext.sampleRate} Hz`, 'info');

  // ── 步骤 4：接线 ──
  sourceNode = audioContext.createMediaStreamSource(stream);
  workletNode = new AudioWorkletNode(audioContext, 'level-meter');
  workletNode.port.onmessage = onLevel;

  sourceNode.connect(workletNode);

  // 🔴 陷阱 1（PLAN §8.1）：tabCapture 会**静音原标签页**。
  // 必须把音频同时接到 destination，否则用户就听不到直播了 —— 这是产品级 bug。
  workletNode.connect(audioContext.destination);
  log('已连到 audioContext.destination（直通）', 'ok');
  log('  ↳ 这步不可省：tabCapture 会静音原标签页，不接回去用户就听不到声音了', 'warn');
  log('  ↳ ⚠️ 而且 worklet 必须**真的把音频写进 output**，不会自动直通', 'warn');
  log('  👂 人工确认项：现在 B 站还听得到声音吗？ 如果变哑了说明直通断了', 'warn');

  setState(`✅ 采集中 · ${audioContext.sampleRate}Hz · 正在测音量…`);
  log('开始接收音频，等待音量上报…', 'ok');

  // 10 秒后做一次结论判定。
  // ⚠️ 必须存句柄并先清旧的：offscreen 被复用时，旧版会把上一轮的定时器留在队列里，
  //    结果新会话中途冒出一条（数字还是累计的）旧结论行。
  if (concludeTimer) clearTimeout(concludeTimer);
  concludeTimer = setTimeout(conclude, 10_000);
}

// ───────────────────────── 音量上报 ─────────────────────────

function onLevel(ev) {
  const d = ev.data;
  if (d.type !== 'level') return;
  reportCount++;
  if (d.db > loudestDb) loudestDb = d.db;

  // 每 4 次（≈1s）打一行，避免刷屏
  if (reportCount % 4 === 0) {
    const bar = d.db === -Infinity ? '（静音）' : '█'.repeat(Math.max(0, Math.min(40, Math.round((d.db + 60) / 1.5))));
    log(
      `${d.seconds.toFixed(1)}s  ${d.db === -Infinity ? '-∞' : d.db.toFixed(1)} dBFS  ` +
        `峰值 ${d.peakDb === -Infinity ? '-∞' : d.peakDb.toFixed(1)}  ` +
        `非零 ${d.nonZeroPct.toFixed(1)}%  ${bar}`,
    );
  }
  setState(
    `✅ 采集中 · ${d.sampleRate}Hz ${d.channels}ch · ` +
      `当前 ${d.db === -Infinity ? '-∞' : d.db.toFixed(1)} dBFS · ${d.seconds.toFixed(0)}s`,
  );

  // 回报 SW 更新角标（D57：角标兼任状态灯）
  chrome.runtime.sendMessage({
    target: 'sw',
    type: 'level',
    db: d.db,
    seconds: d.seconds,
  }).catch(() => {});
}

// ───────────────────────── 结论判定 ─────────────────────────

function conclude() {
  concludeTimer = null;
  log('──────── 10 秒结论 ────────', 'info');
  if (reportCount === 0) {
    log('完全没收到 worklet 上报 → AudioWorklet 没跑起来或输入没接上', 'fail');
    return;
  }
  if (loudestDb === -Infinity) {
    log('收到了音频流，但**全程静音**', 'warn');
    log('  ↳ 流是通的（链路成立），但没声音。检查：B站标签页是否在播放？是否被静音？', 'warn');
    return;
  }
  log(`链路完全打通 ✅  峰值 ${loudestDb.toFixed(1)} dBFS，共 ${reportCount} 次上报`, 'ok');
  log('  ↳ getMediaStreamId → offscreen getUserMedia → AudioWorklet 全部成立', 'ok');
  log('', 'info');
  log('━━━ 还差最后一项：人工确认 B 站声音是否正常 ━━━', 'warn');
  log('  现在去听直播间 —— 如果还能正常听到主播声音 → spike 完全通过', 'warn');
  log('  如果变哑了 → 直通断了（worklet 的 output 没写回去）', 'warn');
  setState(`✅ 验证通过 · 峰值 ${loudestDb.toFixed(1)} dBFS`);
  log('  ↳ 采集仍在继续（直通保持，方便你用耳朵确认 B 站声音）', 'info');
  log('  ↳ 停止方式：再点一次扩展图标 → 立即释放标签页；不停止的话，下次点击会撞上 active stream', 'info');
  chrome.runtime.sendMessage({ target: 'sw', type: 'done', ok: true, peakDb: loudestDb }).catch(() => {});
}

// ───────────────────────── 消息入口 ─────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;

  if (msg.type === 'start-capture') {
    log('收到 start-capture 指令', 'info');
    startCapture(msg.streamId, msg.tabId).catch((e) =>
      log(`未捕获异常：${e.stack || e.message}`, 'fail'),
    );
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'stop-capture') {
    // 必须**同步**停掉轨道后再回响应：SW 收到响应就会销毁 offscreen，
    // 而停轨道才是解除 Chrome 侧 active stream 的关键动作。
    const r = stopCapture('SW 指令');
    sendResponse({ ok: true, ...r });
    return true;
  }

  // SW 侧 toggle 判定用的状态查询（SW 自己可能已被回收，不能信它的内存）
  if (msg.type === 'status') {
    sendResponse({
      ok: true,
      capturing,
      tabId: currentTabId,
      seconds: capturing ? (Date.now() - startedAt) / 1000 : 0,
    });
    return true;
  }

  return true;
});

/**
 * 停止采集并释放该标签页。
 * 返回值回给 SW，用来在日志里确认「到底释放了几条轨道」。
 */
function stopCapture(reason = '未说明') {
  if (!capturing && !stream && !audioContext) {
    log(`没有正在进行的采集（${reason}）`, 'info');
    return { stopped: false, detail: '无活跃会话' };
  }

  log(`正在停止：${reason}`, 'info');
  if (concludeTimer) {
    clearTimeout(concludeTimer);
    concludeTimer = null;
  }
  const tracks = stream?.getTracks() ?? [];
  try {
    workletNode?.disconnect();
    sourceNode?.disconnect();
    for (const t of tracks) {
      t.onended = null; // 主动停止不该报「意外结束」
      t.stop();
    }
    audioContext?.close();
  } catch (e) {
    log(`停止时报错：${e.message}`, 'warn');
  }

  audioContext = stream = workletNode = sourceNode = null;
  capturing = false;
  currentTabId = null;
  startedAt = 0;
  setState('已停止（标签页捕获已释放）');
  log(`已停止：释放了 ${tracks.length} 条轨道`, 'ok');
  return { stopped: true, detail: `已释放 ${tracks.length} 条轨道` };
}

log('offscreen document 已加载，等待 streamId…');
setState('等待 service worker 派发 streamId…');
