import preact from '@preact/preset-vite';
import { defineConfig } from 'wxt';

/**
 * WXT 配置（PLAN §6.1 技术栈）。
 *
 * 关于 Preact 集成：WXT 官方的 `@wxt-dev/module-preact` **在 npm 上不存在**（2026-10-17 实查 404，
 * 而 `wxt@0.21.4` 是真的），所以走通用 Vite 插件方式 —— WXT 本身就是 Vite 驱动，
 * 把 `@preact/preset-vite` 挂进 `vite` 配置效果等价。
 *
 * ⚠️ `srcDir: 'src'` 是显式写死的，不依赖 WXT 的「有 src 就用 src」自动探测：
 * PLAN §6.3 已经把目录结构定死了，配置与文档必须一致，不能靠隐式约定。
 */
export default defineConfig({
  srcDir: 'src',
  /**
   * 输出到 `dist/`，而不是 WXT 默认的 `.output/`。
   *
   * 原因不是洁癖，而是这一步要**用人眼在文件选择框里操作**：`chrome://extensions`
   * 的「加载已解压的扩展程序」是个 Finder 选目录弹框，而 `.output` 以点开头 ——
   * Finder 默认不显示隐藏目录，必须 `Cmd+Shift+G` 手输路径才能选到，很容易卡住。
   * `dist/` 是普通可见目录，直接点就能选中。（`.gitignore` 两者都忽略。）
   */
  outDir: 'dist',
  vite: () => ({
    plugins: [preact()],
  }),
  manifest: {
    name: 'VTB Voice Translate',
    description: 'B 站直播 日语→简体中文 实时字幕（纯扩展，无本地后端）',
    // D61：不做 popup，点击图标直接启动 —— 所以 action 里**没有** default_popup
    action: { default_title: '启动 / 停止字幕' },
    permissions: [
      'tabCapture', // 抓标签页音频（M2-0 spike 已实测通过）
      'offscreen', // MV3 里唯一能长期跑 WebAudio + WebSocket 的上下文（§6.2）
      'storage', // 配置与 API Key（D70：不加密，与浏览器 profile 同级隔离）
    ],
    host_permissions: [
      // 百炼：ASR 走 wss、翻译走 compatible-mode，同一 origin
      'https://dashscope.aliyuncs.com/*',
      // 直播间：content script 的注入范围；同时保证 offscreen 的 tabs.sendMessage 能把字幕推过去
      'https://live.bilibili.com/*',
    ],
  },
});
