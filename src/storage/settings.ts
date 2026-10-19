/**
 * 设置读写（PLAN §6.3 的 `src/storage/`）。
 *
 * ⚠️ 与 `tools/m1-bench/.env.local` 完全无关：那是 M1 命令行探针读的文件，
 * 而**扩展没有任何文件系统权限**，读不到它。扩展的 Key 只能来自
 * `chrome.storage.local`（D26/D70：不加密存储，与浏览器 profile 同级隔离；
 * 自用工具、且 Key 本来就在同一台机器上，加密收益有限而复杂度高）。
 *
 * 本文件是 Chrome API 的边界（`core/` 不碰它），所以刻意保持很薄。
 */

/** 存储键：整个设置对象放在一个键下，避免读两次 */
const STORAGE_KEY = 'settings';

export interface Settings {
  /** 百炼 API Key（`sk-...`）。空字符串 = 未配置 */
  apiKey: string;
  /** ASR 模型名；未设则用 core 里的默认值（D76：`-streaming` 变体） */
  model?: string;
}

export const EMPTY_SETTINGS: Settings = { apiKey: '' };

export async function loadSettings(): Promise<Settings> {
  // ⚠️ 这里**刻意不 catch**（曾经 catch 过，后果很隐蔽）：
  // 存储读取失败时若静默返回空设置，用户看到的是「未配置 API Key」——
  // 一个与实际原因（storage 读不到）毫无关系的提示，排查会绕很久。
  // 让它抛出去，由调用方区分「没配」和「读失败」。
  const got = (await browser.storage.local.get(STORAGE_KEY)) as Record<string, Partial<Settings> | undefined>;
  const raw = got[STORAGE_KEY];
  if (!raw) return { ...EMPTY_SETTINGS };
  return {
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
    ...(typeof raw.model === 'string' && raw.model ? { model: raw.model } : {}),
  };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next: Settings = { ...(await loadSettings()), ...patch };
  await browser.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}

/**
 * 订阅设置变化 —— SW 里注册的 listener 会因为「打开设置页保存」而立即拿到新值，
 * 不需要用户重新点图标。
 */
export function onSettingsChanged(cb: (settings: Settings) => void): void {
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const change = changes[STORAGE_KEY];
    if (!change) return;
    const value = change.newValue as Partial<Settings> | undefined;
    cb({
      apiKey: typeof value?.apiKey === 'string' ? value.apiKey : '',
      ...(typeof value?.model === 'string' && value.model ? { model: value.model } : {}),
    });
  });
}
