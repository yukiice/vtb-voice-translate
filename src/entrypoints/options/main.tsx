/**
 * 设置页（PLAN §6.4 的 Q30：Preact）。
 *
 * 只做一件事：把 API Key 存进扩展的本地存储，顺便**当场验证它能不能用**。
 *
 * 为什么不从 `tools/m1-bench/.env.local` 自动导入：扩展没有文件系统权限（也不该有），
 * 那个文件只有命令行探针读得到 —— 两者虽然都在同一台机器上，但活在完全不同的沙箱里。
 */
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import { checkApiKey, type PreflightResult } from '@/core/asr/preflight';
import { DEFAULT_MODEL } from '@/core/asr/protocol';
import { loadSettings, saveSettings } from '@/storage/settings';

function App() {
  const [apiKey, setApiKey] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [result, setResult] = useState<PreflightResult | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    loadSettings()
      .then((s) => setApiKey(s.apiKey))
      // loadSettings 现在不吞异常（读失败 ≠ 没配置），所以这里得接住
      .catch((e) => setNote(`⚠ 读取已有设置失败：${e instanceof Error ? e.message : String(e)}`))
      .finally(() => setLoaded(true));
  }, []);

  const dirty = apiKey.trim().length > 0;

  const save = async (): Promise<void> => {
    setResult(null);
    const key = apiKey.trim();
    try {
      await saveSettings({ apiKey: key });
      // 写完立刻读回来比对 —— 存储异常（配额/权限）时不会报错但也没写进去，
      // 光看「已保存」提示会让人白折腾很久。
      const back = await loadSettings();
      setNote(
        back.apiKey === key
          ? `已保存（本扩展 ID ${browser.runtime.id}）。回到直播间刷新页面后点扩展图标即可开始。`
          : '⚠ 保存后读回不一致，请再试一次',
      );
    } catch (e) {
      setNote(`⚠ 保存失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const test = async (): Promise<void> => {
    setTesting(true);
    setNote(null);
    setResult(await checkApiKey(apiKey));
    setTesting(false);
  };

  if (!loaded) return <main class="wrap muted">读取设置…</main>;

  return (
    <main class="wrap">
      <h1>VTB Voice Translate</h1>
      <p class="muted" style="margin:0">
        B 站直播 · 日语 → 简体中文 实时字幕（纯扩展，无本地后端）
      </p>

      <label class="field">
        <span>百炼 API Key</span>
        <input
          type="password"
          value={apiKey}
          placeholder="sk-…"
          autocomplete="off"
          spellcheck={false}
          onInput={(e) => {
            setApiKey((e.currentTarget as HTMLInputElement).value);
            setNote(null);
          }}
        />
      </label>

      <div class="row">
        <button onClick={() => void save()} disabled={!dirty}>
          保存
        </button>
        <button class="ghost" onClick={() => void test()} disabled={testing || !dirty}>
          {testing ? '测试中…' : '测试连接'}
        </button>
      </div>

      {note && <p class="ok">{note}</p>}
      {result && <p class={result.ok ? 'ok' : 'bad'}>{result.message}</p>}

      <hr />
      <ul class="muted small">
        <li>
          Key 存在扩展自己的 <code>chrome.storage.local</code> 里，不上传、不跨设备同步；按 D70
          <strong>不加密</strong>（与浏览器 profile 同级隔离，自用可接受）。
        </li>
        <li>
          与 <code>tools/m1-bench/.env.local</code> 无关 —— 扩展读不到文件系统。若你在终端里已经用过探针，
          把那个文件的 <code>DASHSCOPE_API_KEY</code> 值复制过来即可。
        </li>
        <li>
          识别模型：<code>{DEFAULT_MODEL}</code>（D76：不要换 <code>-message</code> 变体，它的草稿会把日语当中文识别）。
        </li>
        <li>
          本页所属扩展 ID：<code>{browser.runtime.id}</code>
          <br />如果你加载了多份副本（比如 <code>.output/chrome-mv3</code> 和 <code>dist/chrome-mv3</code>），它们是
          <strong>两个独立扩展、各有各的存储</strong> —— 请确认这个 ID 与 Service Worker 日志里打印的一致，
          否则 Key 就存在了另一个副本里。
        </li>
      </ul>
    </main>
  );
}

const root = document.getElementById('app');
if (root) render(<App />, root);
