#!/usr/bin/env node
/**
 * 校验 **构建产物** `audio-worklet.js`（不是源码）。
 *
 * 为什么需要它：worklet 跑在 AudioWorkletGlobalScope 里，浏览器里只能靠「真机点击 + 看日志」
 * 验证，成本高且容易漏 —— 而它恰好是整条音频链路上最容易静默出错的一环
 * （直通忘了写 → 用户听不到声音；攒块/transfer 写错 → 音频断流）。
 *
 * 这里用 vm 造一个最小 worklet 环境（`AudioWorkletProcessor` / `registerProcessor` / `sampleRate`），
 * 加载真实产物、喂合成音频，检查：
 *   ① 直通：output 与 input 逐样点相等（用户还能听见直播）
 *   ② 下混 + 重采样：48kHz stereo → 16kHz mono，且长度比例正确
 *   ③ 攒块：1024 样点/块，块大小恒定
 *   ④ dBFS：与理论值一致（再用它做 VAD 门控才不会整体偏移）
 *   ⑤ 频率：1kHz 正弦重采样后仍是 1kHz（没有混叠/变调）
 *   ⑥ transfer 之后仍能继续产出（`buffer` 被转移后必须重新分配）
 *
 * 用法：node tools/check-worklet.mjs   （需先 npm run build；产物在 dist/chrome-mv3/）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKLET = path.join(HERE, '..', 'dist', 'chrome-mv3', 'audio-worklet.js');

const IN_RATE = 48000;
const OUT_RATE = 16000;
const BLOCK = 128; // Chrome 的固定渲染量化
const FLUSH = 1024;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? `  ${detail}` : ''}`);
};

if (!fs.existsSync(WORKLET)) {
  console.error(`❌ 找不到构建产物：${WORKLET}\n   先跑一次 npm run build`);
  process.exit(1);
}

// ── 最小 worklet 环境 ──
const messages = [];
let registered = null;

class FakePort {
  postMessage(msg, transfer) {
    messages.push({ msg, transfer });
  }
}

class FakeAudioWorkletProcessor {
  constructor() {
    this.port = new FakePort();
  }
}

const sandbox = {
  sampleRate: IN_RATE,
  AudioWorkletProcessor: FakeAudioWorkletProcessor,
  registerProcessor(name, ctor) {
    registered = { name, ctor };
  },
  console,
};
vm.createContext(sandbox);

const code = fs.readFileSync(WORKLET, 'utf8');
vm.runInContext(code, sandbox);

console.log('\n  worklet 产物校验（Node + stub worklet 全局）');
console.log(`  产物 ${path.relative(process.cwd(), WORKLET)}（${(code.length / 1024).toFixed(1)} KB）\n`);

check('加载即注册处理器', registered !== null, registered ? `name="${registered.name}"` : '');

const proc = new registered.ctor();
const inCh = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
const outCh = [new Float32Array(BLOCK), new Float32Array(BLOCK)];

/** 生成一块 1kHz 正弦（左右同相，便于下混后仍能准确估频） */
let phase = 0;
const FILL_HZ = 1000;
const AMP = 0.5;
function fillBlock() {
  for (let i = 0; i < BLOCK; i++) {
    const v = AMP * Math.sin((2 * Math.PI * FILL_HZ * (phase + i)) / IN_RATE);
    inCh[0][i] = v;
    inCh[1][i] = v;
  }
  phase += BLOCK;
}

// ── ① 直通 ──
fillBlock();
const expected = Float32Array.from(inCh[0]);
proc.process([inCh], [outCh], {});
let passthroughOk = true;
for (let i = 0; i < BLOCK; i++) {
  if (outCh[0][i] !== expected[i]) passthroughOk = false;
}
check('直通：output[0] 与 input[0] 逐样点相等（否则原标签页会被静音）', passthroughOk);

// ── 跑满 1 秒（375 块 = 48000 样点） ──
for (let b = 1; b < IN_RATE / BLOCK; b++) {
  fillBlock();
  proc.process([inCh], [outCh], {});
}

const audioMsgs = messages.filter((m) => m.msg.type === 'audio');
check(
  '攒块：1 秒音频产出 15 块（16000/1024 = 15.6）',
  audioMsgs.length === 15,
  `实际 ${audioMsgs.length} 块`,
);
check(
  '每块长度恒为 1024 样点',
  audioMsgs.every((m) => m.msg.pcm.length === FLUSH),
  audioMsgs.map((m) => m.msg.pcm.length).join(',').slice(0, 40),
);
const totalSamples = audioMsgs.at(-1)?.msg.totalSamples ?? 0;
check(
  '采样率：1 秒输入 → ≈15360 个 16k 样点',
  Math.abs(totalSamples - 15 * FLUSH) === 0,
  `totalSamples=${totalSamples}`,
);

// ── ④ dBFS（0.5 振幅正弦 → RMS 0.3536 → -9.03 dBFS） ──
const db = audioMsgs.at(-1)?.msg.db ?? 0;
check('dBFS 与理论值一致（-9.03 ±0.6）', Math.abs(db - -9.03) < 0.6, `实测 ${db.toFixed(2)} dBFS`);

// ── ⑤ 频率 ──
const all = new Int16Array(audioMsgs.length * FLUSH);
audioMsgs.forEach((m, i) => all.set(m.msg.pcm, i * FLUSH));
let cross = 0;
let first = -1;
let last = -1;
for (let i = 1; i < all.length; i++) {
  if (all[i - 1] <= 0 && all[i] > 0) {
    if (first < 0) first = i;
    last = i;
    cross++;
  }
}
const freq = cross > 1 ? ((cross - 1) * OUT_RATE) / (last - first) : 0;
check('频率保持 1kHz（±3%，没有混叠/变调）', Math.abs(freq - FILL_HZ) / FILL_HZ < 0.03, `实测 ${freq.toFixed(1)} Hz`);

// ── ⑥ transfer 与后续可用性 ──
check(
  'PCM buffer 被 transfer（零拷贝）',
  audioMsgs.every((m) => m.transfer.length === 1 && m.transfer[0] === m.msg.pcm.buffer),
);

const before = messages.length;
for (let b = 0; b < IN_RATE / BLOCK / 10; b++) {
  fillBlock();
  proc.process([inCh], [outCh], {});
}
const after = messages.filter((m) => m.msg.type === 'audio').length;
check('transfer 之后继续产出（攒块缓冲已重新分配）', after > audioMsgs.length, `${audioMsgs.length} → ${after} 块`);

// ── 非整数倍采样率必须明确失败，而不是静默降质 ──
messages.length = 0;
const badSandbox = {
  sampleRate: 44100,
  AudioWorkletProcessor: FakeAudioWorkletProcessor,
  registerProcessor(name, ctor) {
    registered = { name, ctor };
  },
  console,
};
vm.createContext(badSandbox);
vm.runInContext(code, badSandbox);
const badProc = new registered.ctor();
const err = messages.find((m) => m.msg.type === 'error');
check('44100Hz 时明确上报 error（不静默降质）', Boolean(err), err ? err.msg.message.slice(0, 40) + '…' : '');

const failed = results.filter((r) => !r.ok);
console.log(`\n  ${failed.length === 0 ? '✅ 全部通过' : `❌ ${failed.length} 项失败`}（共 ${results.length} 项）\n`);
process.exit(failed.length === 0 ? 0 : 1);
