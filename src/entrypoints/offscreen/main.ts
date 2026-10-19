/**
 * offscreen document —— 音频捕获与管线（PLAN §6.2）。
 *
 * ⚠️ **这里是会话状态的唯一权威**。SW 会被 MV3 随时回收，所以「是否在采集」这类判断
 * 一律问 offscreen（M2-0 spike 踩过：状态放在 SW 里，回收一次就与现实不符）。
 *
 * M2 阶段的职责：拿到 tabCapture 流 → 建 48kHz AudioContext → 挂 worklet（下混+重采样到 16kHz）
 * → **直通回 destination**（否则原标签页静音）→ 把 16kHz PCM 攒块收下来。
 * ASR / 翻译编排是 M3/M4，会挂到同一处（`onAudioBlock` 就是未来的接入点）。
 */
import {
  CAPTURE_PROCESSOR,
  TARGET_CONTEXT_RATE,
  type CaptureResponse,
  type CaptureStatus,
  type OffscreenLogMessage,
  type OffscreenRequest,
  type StartCaptureRequest,
  type WorkletMessage,
} from '@/shared/audio-messages';
import type { SubtitleMessage, SubtitleRelayMessage } from '@/shared/subtitle';
import { AsrSupervisor, type SupervisorSnapshot } from '@/core/asr/supervisor';
import { TRANSLATE_FAILURE } from '@/core/asr/failure';
import { checkApiKey } from '@/core/asr/preflight';
import { toFilteredPromptBlock } from '@/core/glossary';
import { translate } from '@/core/translate/client';
import { buildTranslateMessages, type PastPair } from '@/core/translate/prompt';

import { createWebSocketFactory } from './ws-socket';

/** worklet 的构建产物路径（`unlisted-script` 入口，见 src/entrypoints/audio-worklet.ts） */
const WORKLET_URL = 'audio-worklet.js';

/**
 * 扩展内资源的绝对 URL。
 *
 * WXT 把 `runtime.getURL` 的类型限定到它已知的产出路径上，而 `audio-worklet.js`
 * 是 `unlisted-script` 入口的构建产物，所以这里用局部签名描述真实语义。
 */
function assetUrl(path: string): string {
  return (browser.runtime.getURL as (p: string) => string)(path);
}

/** 日志节流：每 ~2 秒一行，肉眼就能看出「有没有声音」 */
const LOG_INTERVAL_MS = 2000;

// ── 会话状态 ──
let ctx: AudioContext | null = null;
let stream: MediaStream | null = null;
let source: MediaStreamAudioSourceNode | null = null;
let node: AudioWorkletNode | null = null;

let tabId: number | null = null;
let startedAt: number | null = null;
let samples16k = 0;
let blocks = 0;
let lastDb = Number.NEGATIVE_INFINITY;
let loudestDb = Number.NEGATIVE_INFINITY;
let contextRate: number | null = null;
let lastLogAt = 0;
/** ASR 督导（§13.1/§13.3：重连、退避、放弃全部在它手里）；未配置 Key / 启动失败时为 null */
let supervisor: AsrSupervisor | null = null;
/** 最近一次 usage 的累计 input token（M4 的成本面板要用，§5.14） */
let lastUsageInput = 0;
/** 本轮生效的 Key（翻译也要用）；随 start-capture 指令带下来 */
let sessionApiKey: string | null = null;
/** 本轮使用的模型（重连时要带上，否则新任务会退到默认值） */
let sessionModel: string | undefined;

/**
 * 前几段的「原文→译文」对，作为翻译上下文（D37）。
 *
 * 只留 2 对：再多容易把话题带偏（实测风险），而收益趋零。
 * 翻译是**串行**的（见 `queueTranslate`），所以这里的顺序天然与说话顺序一致。
 */
const recentPairs: PastPair[] = [];
const MAX_CONTEXT_PAIRS = 2;

/** 翻译串行链：既保证上下文顺序，也天然限流 */
let translateChain: Promise<void> = Promise.resolve();

function snapshot(): CaptureStatus {
  const snap = supervisor?.snapshot;
  return {
    capturing: stream !== null,
    tabId,
    startedAt,
    samples16k,
    blocks,
    lastDb,
    loudestDb,
    sampleRate: contextRate,
    sessionState: snap?.state ?? (stream !== null ? 'starting' : 'idle'),
    costYuan: snap?.costYuan ?? 0,
  };
}

/**
 * 打日志到**自己的 console**，同时回流给 SW。
 *
 * 回流的原因是可验证性：用户点开 SW 检查器就能看到采集状态，
 * 不必再去 chrome://extensions 的「检查视图」里找 offscreen 文档。
 */
function sendLog(level: 'info' | 'warn' | 'error', text: string): void {
  if (level === 'error') console.error(`[vtb/offscreen] ${text}`);
  else if (level === 'warn') console.warn(`[vtb/offscreen] ${text}`);
  else console.log(`[vtb/offscreen] ${text}`);
  const msg: OffscreenLogMessage = { type: 'capture-log', level, text };
  void Promise.resolve(browser.runtime.sendMessage(msg)).catch(() => undefined);
}

/**
 * 把字幕推给标签页里的浮层。
 *
 * ⚠️ **offscreen 不能直接用 `chrome.tabs`**（实测：`browser.tabs` 在里面是 `undefined`，
 * 直接调会抛 `Cannot read properties of undefined (reading 'sendMessage')`）——
 * 这是 Chrome 对 offscreen 文档的 API 限制。所以只能请 SW 代发（它长期驻留、有 tabs 权限）。
 *
 * 另一个考虑：content script 可能还没注入（页面在扩展启用前就打开了），
 * 那时 SW 的转发会失败 —— 这属于**正常情况**（提醒用户刷新页面即可），SW 侧静默处理。
 */
function sendToTab(msg: SubtitleMessage): void {
  if (tabId == null) return;
  const relay: SubtitleRelayMessage = { type: 'subtitle-relay', tabId, payload: msg };
  void Promise.resolve(browser.runtime.sendMessage(relay)).catch(() => undefined);
}

/**
 * 启动 ASR 督导（含自动重连）。
 *
 * ── 为什么不能只「连一次」 ──
 * 看一场两小时的直播，网络抖动是必然事件。M5 之前的实现里，一次 `close` 就是**永久停摆**：
 * 字幕不再出现，用户必须手动关掉再点图标 —— 而且他并不知道该这么做。
 *
 * 现在把「断了怎么办」交给了 `AsrSupervisor`：退避重连（0.5s 起步）、
 * Key 无效不重试、累计失败 2 分钟就放弃（§13.1/§13.2/§13.3）。
 *
 * ── 为什么**不**在启动时先预检 ──
 * 第一版加了「先 HTTPS 验 Key 再连 WS」，后来去掉了：
 *   · Key 正常时（绝大多数情况）这只是在第一次出字幕前白加一个往返；
 *   · Key 有问题时，督导层会在**握手失败的那一刻**自己跑预检（`#classify` 里），
 *     同样只多一个往返，就能把「Key 无效」和「断网」分开（§13.2 #1 vs #2）。
 * 所以把它做成「只在失败后诊断」：快路径零成本，慢路径一样准确。
 */
async function startAsr(settings: StartCaptureRequest['settings']): Promise<void> {
  if (!settings.apiKey.trim()) {
    throw new Error('未配置百炼 API Key：请到扩展的「选项」页填入后重试');
  }

  sendToTab({ type: 'subtitle-status', state: 'starting' });

  sessionApiKey = settings.apiKey;
  sessionModel = settings.model;

  const sup = new AsrSupervisor(
    {
      apiKey: settings.apiKey,
      socketFactory: createWebSocketFactory(),
      ...(settings.model ? { model: settings.model } : {}),
      // §13.3：重连后**必须重新注入上下文** —— `input.context` 不会跨任务保留。
      // 用函数而不是值：重连时想注入的是「此刻最新」的前文，不是首次建连那一刻的。
      context: () => buildRunContext(),
      // 督导层在「原因不明」时用它把 Key 无效与断网分开（§13.2 #1 vs #2）。
      // ⚠️ 超时压到 4s：`checkApiKey` 默认 10s，但这里是在**重连的冷却期**里跑的，
      //    它只是诊断，不该拖慢恢复。网络真断了的话预检本身也会 4s 就放弃，
      //    结果是 status=0 → 归为网络问题 → 继续重连，不会误判。
      preflight: (key) => checkApiKey(key, undefined, 4000),
    },
    {
      onSentence: (sentence, kind) => {
        // 语言闸门 / 空定稿过滤在 M5 后续项里补；这里先保证不推空串（D92）
        const text = kind === 'final' ? (sentence.final ?? '') : (sentence.drafts.at(-1)?.text ?? '');
        if (!text) return;

        sendToTab({ type: 'subtitle', kind, sentenceId: sentence.id, source: text, target: null, at: Date.now() });
        if (kind === 'final') queueTranslate(sentence.id, text);
      },
      onState: (snap) => onSupervisorState(snap),
      // §13.4：断连恢复后插一条灰色分隔线，不回溯、但也不假装没发生
      onGap: (seconds) => {
        sendLog('warn', `采集中断 ${seconds}s，已恢复`);
        sendToTab({ type: 'subtitle-gap', seconds, at: Date.now() });
      },
      onLog: (level, text) => sendLog(level, text),
    },
  );

  supervisor = sup;
  await sup.start();

  sendLog('info', `ASR 督导已启动（模型 ${settings.model || '默认'}）`);
}

/** 构造 `run-task` 的 `input.context`（D22 术语表 + D37 前文） */
function buildRunContext(): unknown {
  // 术语表按「最近几句」过滤（D98）；重连时用当前上下文，而不是首连的快照
  const recentText = recentPairs.map((p) => p.source).join('\n');
  const glossary = toFilteredPromptBlock(recentText);
  if (!glossary.block) return undefined;
  return { glossary: glossary.block };
}

/**
 * 督导层状态变化 → 浮层 + 日志。
 *
 * 这里**不做任何打断**（D56）：不弹窗、不遮遢。状态只在浮层底部一行小字与角标上体现。
 */
function onSupervisorState(snap: SupervisorSnapshot): void {
  lastUsageInput = snap.usage.input_tokens;

  if (snap.state === 'running') {
    sendToTab({ type: 'subtitle-status', state: 'running' });
    return;
  }
  if (snap.state === 'degraded') {
    sendToTab({ type: 'subtitle-status', state: 'degraded', detail: snap.detail ?? '部分功能降级' });
    return;
  }
  if (snap.state === 'reconnecting') {
    sendToTab({
      type: 'subtitle-status',
      state: 'reconnecting',
      ...(snap.title ? { title: snap.title } : {}),
      attempt: snap.attempts,
      ...(snap.disconnectedSince != null ? { since: snap.disconnectedSince } : {}),
    });
    return;
  }
  if (snap.state === 'starting') {
    sendToTab({ type: 'subtitle-status', state: 'starting' });
    return;
  }
  if (snap.state === 'auth_failed' || snap.state === 'gave_up') {
    sendToTab({
      type: 'subtitle-status',
      state: snap.state,
      ...(snap.title ? { title: snap.title } : {}),
      ...(snap.detail ? { detail: snap.detail } : {}),
    });
  }
}

/**
 * 翻译定稿句，并把译文补推到浮层。
 *
 * **串行**（不用并发）有三个理由：
 *   1. `recentPairs` 是上下文，顺序错了等于给模型错误的前文；
 *   2. 并发会把 RPM/TPM 打满 —— 直播里句子密度不低；
 *   3. 串行天然限流。
 * qwen-flash 实测 361ms，而句子间隔通常 >1s，所以串行不会积压。
 */
function queueTranslate(sentenceId: number, source: string): void {
  translateChain = translateChain.then(() => translateAndPush(sentenceId, source)).catch(() => undefined);
}

async function translateAndPush(sentenceId: number, source: string): Promise<void> {
  const apiKey = sessionApiKey;
  if (!apiKey) return;

  const startedAt = Date.now();
  try {
    // 术语表按输入过滤后注入（D98）—— 一句话通常只命中 3~4 条，全量发每句都白付 700+ tokens
    const glossary = toFilteredPromptBlock(source);
    const messages = buildTranslateMessages({
      text: source,
      glossaryBlock: glossary.block,
      previous: recentPairs,
    });

    const result = await translate(messages, { apiKey });

    recentPairs.push({ source, target: result.text });
    if (recentPairs.length > MAX_CONTEXT_PAIRS) recentPairs.shift();

    sendToTab({ type: 'subtitle', kind: 'final', sentenceId, source, target: result.text, at: Date.now() });
    // 翻译恢复正常 → 清掉降级态（§13.2 #6：下一句自动恢复）
    supervisor?.recover();
    sendLog(
      'info',
      `译文 ${Date.now() - startedAt}ms${glossary.hit ? ` · 术语 ${glossary.hit}/${glossary.total}` : ''} · ${result.text}`,
    );
  } catch (e) {
    // §13.2 故障 6：翻译失败时**保留已显示的日文原文**，下一句自然恢复。
    // 这是「故障降级」而不是「成本降级」—— 只影响译文，绝不影响采集与 ASR（§13.5）。
    supervisor?.degrade(TRANSLATE_FAILURE);
    sendLog('warn', `翻译失败，已保留日文原文：${e instanceof Error ? e.message : String(e)}`);
  }
}

function onAudioBlock(msg: Extract<WorkletMessage, { type: 'audio' }>): void {
  blocks++;
  samples16k = msg.totalSamples;
  lastDb = msg.db;
  if (msg.db > loudestDb) loudestDb = msg.db;

  // ★ M3 的接线点：这块 16kHz mono PCM 直接进 ASR。
  //   静默时**继续送**（不丢），因为送静音成本实测为 ¥0 且能保活（D104）。
  //   ⚠️ 断线期间也照旧送（督导层会返回 false）—— 这样重连成功后能**立即**从当前时刻接上，
  //   不需要等下一块音频；代价只是几块被丢弃的 PCM。
  supervisor?.sendAudio(msg.pcm);

  const now = Date.now();
  if (now - lastLogAt >= LOG_INTERVAL_MS) {
    lastLogAt = now;
    const secs = (samples16k / 16000).toFixed(1);
    const db = Number.isFinite(msg.db) ? `${msg.db.toFixed(1)} dBFS` : '静音（-inf）';
    sendLog('info', `已采 ${secs}s · 当前 ${db} · 峰值 ${loudestDb.toFixed(1)} dBFS`);
  }
}

function handleWorkletMessage(msg: WorkletMessage): void {
  if (msg.type === 'error') {
    sendLog('error', `worklet 报错：${msg.message}`);
    return;
  }
  onAudioBlock(msg);
}

/**
 * 开始采集。
 *
 * ⚠️ 第一件事是 `stopCapture()`：offscreen 会被复用，旧 `AudioContext` / 旧 worklet 不清理，
 * 就会出现「旧会话继续上报 + 统计跳会话累计」的假结果（M2-0 spike 的坑 9）。
 */
async function startCapture(
  streamId: string,
  tab: number,
  settings: StartCaptureRequest['settings'],
): Promise<CaptureResponse> {
  try {
    await stopCapture();

    stream = await navigator.mediaDevices.getUserMedia({
      // Chrome 专有的 tabCapture 约束：用 SW 换来的 streamId 直接接上标签页音频
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: false,
    } as unknown as MediaStreamConstraints);

    const track = stream.getAudioTracks()[0];
    if (!track) throw new Error('getUserMedia 成功但流里没有音轨');

    // 标签页关闭/跳转时轨道会 ended —— 通知 SW 做收尾，不要留一个假「采集中」的角标
    track.onended = () => {
      void browser.runtime.sendMessage({ type: 'capture-ended', tabId: tab });
    };

    // 强制 48kHz：让「48k→16k」恒为整数倍（factor=3），走 FIR 抽取。
    // 交给 AudioContext 做输入重采样，比我们自己写非整数比插值更稳。
    ctx = new AudioContext({ sampleRate: TARGET_CONTEXT_RATE });
    contextRate = ctx.sampleRate;

    await ctx.audioWorklet.addModule(assetUrl(WORKLET_URL));

    source = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, CAPTURE_PROCESSOR, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    node.port.onmessage = (ev: MessageEvent<WorkletMessage>) => handleWorkletMessage(ev.data);

    source.connect(node);

    // 🔴 直通：tabCapture 会**静音原标签页**，不接回 destination 用户就听不到直播了。
    //    worklet 侧也真的写回了 output（见 audio-worklet.ts），两步缺一不可。
    node.connect(ctx.destination);

    tabId = tab;
    startedAt = Date.now();
    // ⚠️ 必须把节流基准设成「现在」，不能指望它还是初值 0。
    // `Date.now()` 是绝对值（~1.7e12），`now - 0 >= 2000` 恒成立 →
    // 第一条音频块（≈0.06s）就会抢跑打一行「已采 0.1s」（真机上实测三条会话都命中）。
    lastLogAt = Date.now();

    // 音频链路就绪后再接 ASR：这样「听得见」与「看得见字幕」的因果关系是顺序发生的，
    // 出了问题时也容易判断卡在哪一段。
    await startAsr(settings);

    sendLog('info', `采集已启动 tab=${tab} · AudioContext ${ctx.sampleRate}Hz · 输出 16kHz mono`);

    return { ok: true, status: snapshot() };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await stopCapture();
    sendLog('error', `启动失败：${message}`);
    return { ok: false, error: message };
  }
}

/**
 * 停止采集并释放标签页。
 *
 * 顺序很重要：**先同步停轨道**（`track.stop()`），再关 AudioContext。
 * 只 close 不 stop 会让标签页上残留一条活跃流 —— 下一次 `getMediaStreamId()` 必被
 * 「Cannot capture a tab with an active stream」拒绝（M2-0 spike 的坑 8）。
 */
async function stopCapture(): Promise<CaptureResponse> {
  const releasedTracks = stream?.getTracks().length ?? 0;

  // 先拆 ASR（会发 finish/close，且之后不该再有新音频进来）
  // ⚠️ 必须先 stop 督导层再清音频链路：督导层会把 `#stopped` 置位后才关连接，
  //    否则关闭会被当成「服务端断开」而触发一次多余的重连。
  const closing = supervisor;
  supervisor = null;
  closing?.stop();

  // 清理跨会话状态：上下文对与 Key（否则下一场直播会拿上一场的前文当语境）
  recentPairs.length = 0;
  sessionApiKey = null;
  sessionModel = undefined;

  if (node) {
    node.port.onmessage = null;
    node.disconnect();
    node = null;
  }
  if (source) {
    source.disconnect();
    source = null;
  }
  if (stream) {
    for (const t of stream.getTracks()) t.stop();
    stream = null;
  }
  if (ctx) {
    const closing = ctx;
    ctx = null;
    await closing.close().catch(() => undefined);
  }

  // 按轮重置统计，避免下一轮结果混进上一轮的数字（坑 9）
  tabId = null;
  startedAt = null;
  samples16k = 0;
  blocks = 0;
  lastDb = Number.NEGATIVE_INFINITY;
  loudestDb = Number.NEGATIVE_INFINITY;
  contextRate = null;
  lastLogAt = 0;

  return { ok: true, releasedTracks, status: snapshot() };
}

// ─────────────────────────── 消息入口（SW → 本页） ───────────────────────────

browser.runtime.onMessage.addListener((raw) => {
  const msg = raw as OffscreenRequest;
  // 只接发给 offscreen 的消息；其它（含自己发出去的 capture-ended）忽略
  if (!msg || msg.target !== 'offscreen') return undefined;

  switch (msg.type) {
    case 'start-capture':
      return startCapture(msg.streamId, msg.tabId, msg.settings);
    case 'stop-capture':
      return stopCapture();
    case 'retry':
      // §13.1：点 ⛔ / ✕ 角标 = 手动重试（只重建 ASR，不动采集）
      supervisor?.retryNow();
      return Promise.resolve({ ok: true, status: snapshot() } satisfies CaptureResponse);
    case 'status':
      return Promise.resolve({ ok: true, status: snapshot() } satisfies CaptureResponse);
  }
});
