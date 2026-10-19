/**
 * 字幕浮层（content script）。
 *
 * 两条硬约束（PLAN §7 / D30）：
 *   1. **零 B 站 DOM 依赖** —— 只往 `document.body`（或全屏元素）挂自己的节点，
 *      不查询、不修改 B 站任何元素。B 站改版不会影响它。
 *   2. **样式必须隔离** —— 用 **Shadow DOM**：B 站的全局样式改不到浮层内，
 *      浮层的样式也不会漏到页面上（若直接塞 `<div>` + 类名，两边一定会互相污染）。
 *
 * M3 只显示**日文原文**（两级：草稿 / 定稿，D10）。中文译文是 M4；
 * 位置/样式配置、拖动、历史面板是 M5。
 */
import { isSubtitleMessage, type SessionState, type SubtitleMessage } from '@/shared/subtitle';

const HOST_ID = 'vtb-voice-translate-overlay';

/**
 * 8 态 → 浮层底部那行小字的文案（§13.1）。
 *
 * `running` 刻意不给文案 —— 正常的时候**不应该有字**，否则每天都在看着一行废话。
 * “不打断”的底线是：异常时符号会变，但永远不弹窗、不遮遑、不占位（D56）。
 */
const STATE_TEXT: Record<SessionState, string> = {
  idle: '',
  starting: '正在连接语音识别…',
  running: '',
  degraded: '⚠ 部分降级（见下）',
  reconnecting: '↻ 连接中断，正在重连…',
  auth_failed: '⛔ API Key 无效或欠费 —— 请到选项页修改',
  gave_up: '✕ 多次重连失败，已停止',
  stopped: '',
};

/** 浮层里要渲染的一行：日文原文 +（可能还没到的）中文译文 */
interface Line {
  source: string;
  target: string | null;
}

class Overlay {
  readonly #host: HTMLElement;
  readonly #gapEl: HTMLElement;
  readonly #prevEl: HTMLElement;
  readonly #curEl: HTMLElement;
  readonly #srcEl: HTMLElement;
  readonly #statusEl: HTMLElement;

  #prev: Line | null = null;
  #cur: Line | null = null;
  /** 当前正在显示的句子 id；用来分辨「同一句推进」与「新的一句」 */
  #curId: number | null = null;
  #curFinal = false;
  /** 最近一次中断的秒数；0 = 没有中断过 */
  #gapSeconds = 0;
  /** 重连开始时刻（用来把「已中断 N 秒」跑起来） */
  #reconnectSince: number | null = null;
  #reconnectTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.#host = document.createElement('div');
    this.#host.id = HOST_ID;
    // 定位写在内联样式上：即便 shadow root 未生效（极少见），也不会影响页面布局
    Object.assign(this.#host.style, {
      position: 'fixed',
      left: '50%',
      bottom: '12%',
      transform: 'translateX(-50%)',
      zIndex: '2147483647',
      pointerEvents: 'none',
      maxWidth: '80vw',
    } satisfies Partial<CSSStyleDeclaration>);

    const shadow = this.#host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .box {
          display: none;
          font: 500 26px/1.5 -apple-system, "Hiragino Sans", "Yu Gothic", "PingFang SC", sans-serif;
          color: #fff;
          text-align: center;
          text-shadow: 0 2px 6px rgba(0,0,0,.9), 0 0 2px rgba(0,0,0,.9);
        }
        .box.on { display: block; }
        .prev {
          font-size: .68em;
          opacity: .62;
          margin-bottom: 6px;
        }
        .cur { white-space: pre-wrap; }
        /* 草稿态：略微透明 + 省略号提示「还会变」（D10 的两级视觉区分） */
        .cur.draft::after { content: " …"; opacity: .5; }
        .cur.draft { opacity: .88; }
        /* 有译文时，把日语原文降到下方小字作对照；没内容时不占高度 */
        .src {
          font-size: .58em;
          opacity: .52;
          margin-top: 4px;
          white-space: pre-wrap;
        }
        .src:empty { display: none; }
        .gap {
          font-size: .52em;
          opacity: .5;
          margin-top: 8px;
          letter-spacing: .08em;
        }
        .gap:empty { display: none; }
        .status {
          font: 500 14px/1.4 -apple-system, "PingFang SC", sans-serif;
          color: #fbbf24;
          text-shadow: 0 2px 6px rgba(0,0,0,.9);
          margin-top: 6px;
        }
        .status:empty { display: none; }
      </style>
      <div class="box" part="box">
        <div class="prev" part="prev"></div>
        <div class="cur" part="cur"></div>
        <div class="src" part="src"></div>
        <div class="gap" part="gap"></div>
        <div class="status" part="status"></div>
      </div>
    `;

    this.#prevEl = shadow.querySelector('.prev') as HTMLElement;
    this.#curEl = shadow.querySelector('.cur') as HTMLElement;
    this.#srcEl = shadow.querySelector('.src') as HTMLElement;
    this.#gapEl = shadow.querySelector('.gap') as HTMLElement;
    this.#statusEl = shadow.querySelector('.status') as HTMLElement;
  }

  get box(): HTMLElement {
    return this.#host.shadowRoot?.querySelector('.box') as HTMLElement;
  }

  /** 挂载点（Host 元素）；浮层自己的 DOM 全在它的 Shadow Root 里 */
  get host(): HTMLElement {
    return this.#host;
  }

  apply(msg: SubtitleMessage): void {
    if (msg.type === 'subtitle-status') {
      this.#setStatus(msg);
      return;
    }

    if (msg.type === 'subtitle-gap') {
      this.#setGap(msg.seconds);
      return;
    }

    if (msg.sentenceId !== this.#curId) {
      // 新的一句：把当前行降级成「上一句」
      if (this.#cur) this.#prev = this.#cur;
      this.#curId = msg.sentenceId;
      this.#cur = { source: msg.source, target: msg.target };
      this.#curFinal = false;
    } else {
      // 同一句的推进。⚠️ `target ?? 旧值` 不是笔误：定稿先推“只有日文”的那一版（target=null），
      //    译文到货后再推一次；不能因为 target 缺省就把已显示的译文抹掉。
      this.#cur = {
        source: msg.source || this.#cur?.source || '',
        target: msg.target ?? this.#cur?.target ?? null,
      };
    }
    if (msg.kind === 'final') this.#curFinal = true;

    this.#render();
  }

  #render(): void {
    const box = this.box;
    if (!box) return;
    box.classList.add('on');

    // 上一句：有译文就显示译文，否则退回原文
    const prev = this.#prev;
    this.#prevEl.textContent = prev ? (prev.target ?? prev.source) : '';

    const cur = this.#cur;
    const hasTarget = Boolean(cur?.target);
    this.#curEl.textContent = cur ? (cur.target ?? cur.source) : '';
    this.#srcEl.textContent = hasTarget ? (cur?.source ?? '') : '';

    // 省略号只在「还会变」时出现：草稿期，或者已定稿但译文还没到且不会再有草稿
    this.#curEl.classList.toggle('draft', !hasTarget && !this.#curFinal);
  }

  #setStatus(msg: Extract<SubtitleMessage, { type: 'subtitle-status' }>): void {
    const base = STATE_TEXT[msg.state] ?? '';

    if (msg.state === 'reconnecting') {
      // 把「已中断 N 秒」跑起来 —— 静默停摆最让人焦虑的地方就是**不知道停了多久**（§13.1）
      this.#reconnectSince = msg.since ?? Date.now();
      this.#tickReconnect();
      this.#startReconnectTimer();
      return;
    }

    this.#stopReconnectTimer();
    this.#reconnectSince = null;

    // `degraded` 时把具体降了什么接在后面（译者能看出差异）
    const detail = msg.state === 'degraded' || msg.state === 'auth_failed' || msg.state === 'gave_up' ? msg.detail : null;
    this.#statusEl.textContent = detail ? `${base}：${detail}` : base;
  }

  /** 断连分隔线（§13.4） */
  #setGap(seconds: number): void {
    this.#gapSeconds = Math.max(1, Math.round(seconds));
    // 浮层默认是隐藏的（等第一句字幕才显示）。如果断连发生在第一句之前，
    // 这里必须把盒子打开 —— 否则「中断 N 秒」永远不会被看到。
    this.box?.classList.add('on');
    this.#renderGap();
  }

  #renderGap(): void {
    this.#gapEl.textContent = this.#gapSeconds > 0 ? `—— 中断 ${this.#gapSeconds} 秒 ——` : '';
  }

  #startReconnectTimer(): void {
    if (this.#reconnectTimer != null) return;
    this.#reconnectTimer = setInterval(() => this.#tickReconnect(), 1000);
  }

  #stopReconnectTimer(): void {
    if (this.#reconnectTimer == null) return;
    clearInterval(this.#reconnectTimer);
    this.#reconnectTimer = null;
  }

  #tickReconnect(): void {
    if (this.#reconnectSince == null) return;
    const secs = Math.max(1, Math.round((Date.now() - this.#reconnectSince) / 1000));
    this.#statusEl.textContent = `↻ 连接中断 ${secs} 秒，正在重连…`;
  }
}

function mount(): void {
  let wired = false;

  const attach = (): void => {
    if (document.getElementById(HOST_ID)) return;
    const overlay = new Overlay();
    // 全屏时挂到全屏元素上，否则浮层不可见（§8 坑 3）；平时挂 body
    (document.fullscreenElement ?? document.body).appendChild(overlay.host);
    // 只注册一次消息监听器：全屏切换会重建 DOM，但不该重复监听
    if (!wired) {
      wire(overlay);
      wired = true;
    }
  };

  attach();
  document.addEventListener('fullscreenchange', () => {
    document.getElementById(HOST_ID)?.remove();
    attach();
  });
}

function wire(overlay: Overlay): void {
  browser.runtime.onMessage.addListener((raw) => {
    if (!isSubtitleMessage(raw)) return;
    overlay.apply(raw);
  });
}

export default defineContentScript({
  matches: ['https://live.bilibili.com/*'],
  runAt: 'document_idle',
  main() {
    mount();
  },
});
