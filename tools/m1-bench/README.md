# M1 探针 —— 百炼 ASR 最小验证工具

用来在写产品代码之前，用**真实 API** 回答 PLAN.md 里几个卡住的未知项。
零依赖（不需要 npm install），只用 macOS 自带工具 + Node 内置能力。

## 为什么需要它

PLAN 里有四个问题**靠读文档回答不了，必须实测**：

| 问题 | 为什么文档答不了 | 哪个测试回答 |
|---|---|---|
| 音频每秒到底烧多少 Token | 官方说 7/s，但示例 `usage` 又可解读为 42/s（**6 倍差**） | `rate` |
| 每次白付的固定 prompt 开销 | 从未提及 | `rate` |
| 日语识别质量 | 只有营销话术 | `recognize` |
| 抖动频率 | 只能看真实输出 | `recognize` |

## 用法

```bash
cd tools/m1-bench

# 1) 先放 Key（.env.local 已被 gitignore）
echo 'DASHSCOPE_API_KEY=sk-你的真实key' > .env.local

# 2) 鉴权与协议（不发音频，成本≈0）—— 先跑这个
node probe.mjs ping

# 3) 日语识别全流程
node probe.mjs recognize

# 4) Token 率与固定开销（本次最贵，约 ¥0.01）
node probe.mjs rate

# 全套
node probe.mjs all
```

Key 也可以走环境变量或 `--key`：
```bash
export DASHSCOPE_API_KEY=sk-xxx
node probe.mjs ping --key sk-xxx
```

### 常用参数

| 参数 | 说明 |
|---|---|
| `--model` | 默认 `qwen-audio-3.1-asr-flash-message` |
| `--workspace` | 业务空间 ID → 改用官方推荐的专属域名 |
| `--voice` | 日语 TTS 音色，默认 `Kyoko` |
| `--text` | 自定义日语测试文本 |
| `--speed` | 音频发送加速倍数（`rate` 默认 8x，省等待） |
| `--durations` | `rate` 的长度序列，默认 `5,10,20,40` |
| `--verbose` | 打印每一帧进出（排查协议问题用） |

## 各测试在做什么

### `ping` —— 鉴权与协议

三层递进，把「为什么连不上」拆开：

1. **HTTPS 预检**（`compatible-mode/v1/models`）—— `fetch` 能读状态码 → 定性为 `Key 无效 (401)` / `网络不通 (0)` / `正常 (200)`
2. **裸 TLS 握手**（`lib/handshake.mjs`）—— 直接读 HTTP 状态行，顺带验证 `Origin: chrome-extension://` 是否被接受
3. **真实 WebSocket + 协议往返** —— `run-task` → `task-started` → `finish-task` → `task-finished`

> ⚠️ 三层里的第 1、2 层是**探针专属**的调试能力。
> 浏览器扩展里 `WebSocket.onerror` **拿不到 HTTP 状态码**（只有 `close 1006` + 空 reason），
> 所以扩展的「测试」按钮要靠第 1 层的 `fetch` 预检来区分失败原因（见 PLAN D62/D72）。

### `recognize` —— 日语识别

用 macOS `say` 合成日语 → 转 16kHz 单声道 PCM → 流式识别。输出：

- **草稿序列** —— 同一句被重写了几次（= 抖动频率，直接对应 PLAN 模式 1 的验收线）
- **定稿文本** —— 与原文对照
- **句级 / 字级时间戳** —— 稳定化算法的前提，验证文档承诺是否属实
- **usage 与费用** —— 真实 Token 数

### `rate` —— Token 率（最重要）

同一段日语补静音到不同长度，各跑一次**全新连接**，然后最小二乘拟合：

```
input_tokens = F + r × 音频秒数
               ↑     ↑
        固定 prompt  每秒音频 Token 数
```

`r` 解开 6 倍不确定（7 还是 42），`F` 是每次白付的开销。
最后自动换算成 **¥/小时**，并与 PLAN 的 `≤ ¥1.5/h` 门槛对照。

## 已知环境要求

- **macOS**（依赖 `say` 和 `afconvert`）
- **Node ≥ 22**（需要内置 `WebSocket`；实测 24.20）

## 产物

- `audio/` —— 音频素材（gitignore，版权原因不入库）
- `out/run-*.json` —— 每次运行的结构化结果，便于事后对比

## 安全

- Key 只出现在 WebSocket URL 的 query 里，所有输出都经 `redact` 过滤
- `.env.local` 已在 `.gitignore`，不会被提交
- **测试音频永不提交**（版权）
