# M2-0 · tabCapture 链路验证

> **这是整个 α 架构最后一个没有验证过的假设。**
> 它决定 D11（纯扩展、无本地后端）能不能成立。如果不通，架构要重来。
> 所以这一版**刻意不引入 WXT / TypeScript / 构建步骤** —— 变量隔离干净，
> 失败时能确定是 Chrome API 的问题，而不是构建配置的问题。

---

## 要验证什么

PLAN §8.8 记的那条：

```
❌ chrome.tabCapture.capture()   ← 不能在 offscreen 里调用
✅ SW:      chrome.tabCapture.getMediaStreamId({ targetTabId })
   offscreen: getUserMedia({ audio: { mandatory: {
                 chromeMediaSource: 'tab',
                 chromeMediaSourceId: streamId } } })
```

文档说这样可以，但**没人实际跑过**。这个 spike 就是跑一遍。

---

## 怎么装

1. Chrome 打开 `chrome://extensions`
2. 右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」
4. 选这个目录：`tools/m2-spike/`

## 怎么跑

1. **先让 B 站直播真的在出声** —— 打开 `live.bilibili.com` 任意直播间，确认能听到声音
2. 点工具栏上的扩展图标 → 角标变成 `…` → `REC`
3. **再点一次同一个图标 = 停止**（并释放该标签页的捕获）。这一步不是可选项：
   一个标签页**同时只能有一条** tabCapture 流，不停就再点，只会拿到
   `Cannot capture a tab with an active stream.`
4. 看结果，三个地方都能看：

| 看哪 | 怎么开 |
|---|---|
| **offscreen 控制台**（最详细） | `chrome://extensions` → 找到本扩展 → 点「检查视图 **offscreen.html**」 |
| SW 控制台 | 同一页点「service worker」 |
| **角标** | `▮▮▮` 大声 / `▮▮` 中等 / `▮` 小声 / `·` 静音 → 最后 `✓` 或 `✕` |

---

## 预期结果

10 秒后 offscreen 控制台会打结论：

```
──────── 10 秒结论 ────────
链路完全打通 ✅  峰值 -18.3 dBFS，共 40 次上报
  ↳ getMediaStreamId → offscreen getUserMedia → AudioWorklet 全部成立

━━━ 还差最后一项：人工确认 B 站声音是否正常 ━━━
  现在去听直播间 —— 如果还能正常听到主播声音 → spike 完全通过
  如果变哑了 → 直通断了（worklet 的 output 没写回去）
```

### 📊 实测结果（2026-10-17，首次真跑）

```
──────── 10 秒结论 ────────
链路完全打通 ✅  峰值 -24.0 dBFS
```

- 音量分布：日常 **-32 ~ -46 dBFS**，瞬时峰值 **-18.5 dBFS**
- 👂 **用户确认原标签页声音正常** → 直通成立（`connect(destination)` + worklet 手动写 output，**两件都要**）
- ⚠️ 那次日志里的「共 973 次上报」**不能当基准**：offscreen 被复用，旧 `AudioContext` 没关、计数器跳会话累计
  （10 秒应约 40 次；音量行间隔也是 ~500ms 而非预期的 ~1000ms）。已修，**干净基准待重跑**
- ⚠️ 这次是「刷新标签页清掉残留流」才跑通的；同一标签页要重复采集，**必须先 toggle 停止**，否则必报 `active stream`
- 📌 这条对 M5 有用：非零样点占比**全程 ≈99%**（底噪也算非零）→ **VAD 门控要用 dBFS 阈值，不能用「非零样点占比」**

### 👂 有一项脚本测不了，必须你用耳朵确认

**采集开始后，B 站直播间还有声音吗？**

`tabCapture` 会静音原标签页，所以必须把音频接回 `audioContext.destination`。
但**接了不等于通了** —— AudioWorklet **不会自动直通**，必须手动把 input 拷到 output。

我第一版就踩了这个坑：只算音量、从不写 output → spike 「全部通过」，但用户的 B 站已经哑了。

**所以：听到声音 = 完全通过；变哑了 = 直通断了。**

### 顺带要记录的真实参数

跑的时候留意这两行，它们是 PLAN 里**假设错了**的地方：

```
· 轨道参数：label="..." 
·   sampleRate=48000  channels=2        ← PLAN §6 假设的是 16000 mono
· AudioContext 实际采样率：48000 Hz
```

**tabCapture 给的是 48kHz 立体声，不是 16kHz 单声道。** 所以 `src/core/audio/` 里的
重采样不是「可选优化」而是**必需环节** —— 这一步在 spike 里被省略了（只算音量）。

---

## 失败时怎么读

脚本会把失败原因原样打出来，并且给出可能的原因：

| 错误 | 含义 |
|---|---|
| `NotAllowedError` | 没拿到 activeTab 授权，或用户拒绝了 |
| `NotFoundError` | streamId 无效 / 已过期（**它是一次性的**） |
| `NotSupportedError` | manifest 缺 `tabCapture` 权限 |
| `AbortError` | 目标标签页被关了或跳转了 |
| `Cannot capture a tab with an active stream.` | **不是链路问题**：该标签页已有一条活跃的 tabCapture 流（多半是上一次点击没停止）。点一次图标即切换成“停止”；若强制清理后仍报此错，残留流在浏览器侧，只能**刷新该标签页**再试 |
| 收到了流但 `-∞ dBFS` | **链路是通的，但没声音** —— B 站标签页没在播 / 被静音了 |
| 完全没有上报 | AudioWorklet 没跑起来 |

**「收到了流但全程静音」和「根本没收到流」是两个完全不同的结论**，别混。
前者说明链路成立，后者说明链路断了 —— 脚本里用「非零样点占比」把这两者区分开。

---

## 这个 spike 不做的事

- ❌ 不重采样到 16kHz（只算音量，不喂 ASR）
- ❌ 不连 WebSocket
- ❌ 不渲染字幕 UI
- ❌ 不处理全屏切换、PiP（PLAN §8 的陷阱 3/5）
- ❌ 不做 `?api_key=` 降级预案

**只回答一个问题：音频拿得到吗？**

---

## 已知必须处理的陷阱（这里已处理）

| 陷阱 | 处理位置 |
|---|---|
| tabCapture 会**静音原标签页** | `offscreen.js` 接到 `destination` + `worklet.js` 手动直通（**两个都要**）|
| MV3 SW 会休眠 | 采集跑在 offscreen，不在 SW |
| 重复创建 offscreen 会抛错 | `background.js` 的 `ensureOffscreen()` 做了竞态兜底 |
| **一个标签页同时只能有一条 tabCapture 流**（不停止就再取 → `Cannot capture a tab with an active stream.`） | `background.js` 点击 = toggle（`handleClick`），撞上该错时销毁 offscreen 强制清流并重试一次（`acquireStreamId`）；`offscreen.js` 的 `stopCapture()` **同步**停轨道并回传释放结果 |
| SW 会被回收 → 会话状态不能存 SW 内存 | 状态由 offscreen 持有，SW 用 `status` 消息查询（`offscreenStatus()`）；轨道 `onended` 回报，角标不会停在假的 `REC` |
| **offscreen 被复用 → 旧 AudioContext / 统计值 / conclude 定时器残留** | `offscreen.js` 新采集前先 `stopCapture()`；`reportCount`、`loudestDb` 每轮重置；`concludeTimer` 句柄化，在 start / stop 时清理 |
