export function adminPage(): Response {
  return new Response(HTML, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
    },
  });
}

const HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>grok2api Worker 控制台</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #07080c;
      --bg-2: #0c0f16;
      --surface: rgba(255, 255, 255, .055);
      --surface-2: rgba(255, 255, 255, .082);
      --surface-3: rgba(255, 255, 255, .12);
      --line: rgba(255, 255, 255, .105);
      --line-2: rgba(255, 255, 255, .16);
      --text: #f6f8fb;
      --muted: rgba(246, 248, 251, .68);
      --soft: rgba(246, 248, 251, .46);
      --accent: #73f7c6;
      --accent-2: #8fb4ff;
      --danger: #ff7f8f;
      --warn: #ffd38b;
      --ok: #73f7c6;
      --radius: 24px;
      --shadow: 0 28px 90px rgba(0, 0, 0, .42);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      margin: 0;
      color: var(--text);
      background:
        radial-gradient(circle at 12% 0%, rgba(115, 247, 198, .18), transparent 34rem),
        radial-gradient(circle at 88% 14%, rgba(143, 180, 255, .18), transparent 32rem),
        linear-gradient(180deg, #05060a 0%, #0b0d13 48%, #06070a 100%);
      overflow: hidden;
    }

    button, input, textarea, select { font: inherit; color: inherit; }
    button { cursor: pointer; }
    a { color: inherit; }

    .app {
      width: min(1640px, calc(100vw - 20px));
      height: calc(100dvh - 20px);
      min-height: 0;
      margin: 10px auto;
      display: grid;
      grid-template-columns: 276px minmax(0, 1fr) 372px;
      gap: 10px;
      animation: enter .45s ease both;
    }

    @keyframes enter {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .rail, .chat, .tokens {
      min-width: 0;
      min-height: 0;
      height: 100%;
      border: 1px solid var(--line);
      background: linear-gradient(180deg, rgba(255,255,255,.075), rgba(255,255,255,.038));
      box-shadow: var(--shadow);
      backdrop-filter: blur(20px);
      overflow: hidden;
    }
    .rail { border-radius: 30px; display: flex; flex-direction: column; overflow: auto; scrollbar-gutter: stable; }
    .chat { border-radius: 30px; display: grid; grid-template-rows: auto 1fr auto; }
    .tokens { border-radius: 30px; display: grid; grid-template-rows: auto auto minmax(0, 1fr); }

    .brand {
      padding: 18px 18px 14px;
      border-bottom: 1px solid var(--line);
    }
    .mark {
      width: 34px;
      height: 34px;
      border-radius: 14px;
      display: grid;
      place-items: center;
      color: #02130d;
      font-weight: 900;
      background: linear-gradient(135deg, var(--accent), #dffff3);
      box-shadow: 0 14px 40px rgba(115, 247, 198, .22);
    }
    h1 {
      margin: 13px 0 6px;
      font-size: 24px;
      line-height: .95;
      letter-spacing: -.055em;
    }
    .sub { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.55; }

    .section { padding: 13px 14px; border-bottom: 1px solid var(--line); }
    .section:last-child { border-bottom: 0; }
    .section-title {
      margin: 0 0 9px;
      color: var(--soft);
      font-size: 11px;
      letter-spacing: .12em;
      text-transform: uppercase;
      font-weight: 750;
    }

    .field { display: grid; gap: 6px; margin-bottom: 9px; }
    .label { color: var(--muted); font-size: 12px; }
    .input, .select, .textarea {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 16px;
      background: rgba(0, 0, 0, .24);
      outline: none;
      transition: border-color .16s ease, background .16s ease, transform .16s ease;
    }
    .input, .select { height: 38px; padding: 0 11px; }
    .textarea { min-height: 66px; resize: vertical; padding: 10px 11px; line-height: 1.5; }
    .input:focus, .select:focus, .textarea:focus { border-color: rgba(115, 247, 198, .55); background: rgba(0,0,0,.32); }
    .select option:disabled { color: rgba(246, 248, 251, .32); }

    .btn {
      min-height: 36px;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 0 14px;
      background: rgba(255, 255, 255, .06);
      color: var(--text);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      transition: transform .16s ease, border-color .16s ease, background .16s ease, opacity .16s ease;
      user-select: none;
      white-space: nowrap;
    }
    .btn:hover { transform: translateY(-1px); border-color: rgba(115, 247, 198, .42); background: rgba(115, 247, 198, .10); }
    .btn:disabled { opacity: .5; cursor: not-allowed; transform: none; }
    .btn.primary { border-color: transparent; background: var(--accent); color: #02130d; font-weight: 800; }
    .btn.danger { border-color: rgba(255, 127, 143, .28); color: #ffd9de; background: rgba(255, 127, 143, .10); }
    .btn.ghost { background: transparent; }
    .btn.small { min-height: 30px; padding: 0 10px; font-size: 12px; }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .row.between { justify-content: space-between; }

    .chip {
      min-height: 26px;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 0 10px;
      color: var(--muted);
      background: rgba(255,255,255,.04);
      font-size: 12px;
      white-space: nowrap;
    }
    .chip::before {
      content: "";
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: currentColor;
      opacity: .85;
    }
    .chip.ok { color: var(--ok); border-color: rgba(115,247,198,.32); }
    .chip.warn { color: var(--warn); border-color: rgba(255,211,139,.30); }
    .chip.bad { color: var(--danger); border-color: rgba(255,127,143,.32); }
    .chip.plain::before { display: none; }

    .stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .stat {
      min-height: 58px;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 18px;
      background: rgba(255,255,255,.035);
    }
    .stat .k { color: var(--soft); font-size: 11px; }
    .stat .v { margin-top: 6px; font-size: 20px; line-height: 1; letter-spacing: -.04em; font-weight: 820; }
    .stat .n { margin-top: 5px; color: var(--soft); font-size: 11px; }
    .stat.ok .v { color: var(--ok); }
    .stat.bad .v { color: var(--danger); }

    .links { margin-top: auto; padding: 12px 14px; display: grid; gap: 7px; }
    .link {
      min-height: 36px;
      padding: 0 13px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border: 1px solid var(--line);
      border-radius: 16px;
      color: var(--muted);
      text-decoration: none;
      background: rgba(255,255,255,.03);
      font-size: 13px;
    }
    .link:hover { border-color: rgba(143,180,255,.35); color: var(--text); }

    .chat-head {
      min-height: 70px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--line);
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      align-items: center;
    }
    .chat-title { margin: 0; font-size: 20px; letter-spacing: -.025em; }
    .chat-meta { margin-top: 6px; color: var(--muted); font-size: 12px; display: flex; gap: 8px; flex-wrap: wrap; }

    .messages {
      overflow: auto;
      padding: 16px;
      scroll-behavior: smooth;
      background:
        linear-gradient(rgba(255,255,255,.025) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,.018) 1px, transparent 1px);
      background-size: 36px 36px;
    }
    .empty {
      height: 100%;
      min-height: 240px;
      display: grid;
      place-items: center;
      text-align: center;
      color: var(--muted);
    }
    .empty-inner { max-width: 520px; }
    .empty h2 { margin: 0 0 10px; font-size: clamp(30px, 4vw, 54px); line-height: .96; letter-spacing: -.06em; color: var(--text); }
    .empty p { margin: 0; line-height: 1.65; }

    .msg {
      display: grid;
      grid-template-columns: 36px minmax(0, 760px);
      gap: 12px;
      margin: 0 0 18px;
      align-items: start;
    }
    .msg.user { grid-template-columns: minmax(0, 760px) 36px; justify-content: end; }
    .avatar {
      width: 36px; height: 36px; border-radius: 14px;
      display: grid; place-items: center;
      border: 1px solid var(--line);
      background: rgba(255,255,255,.06);
      color: var(--muted);
      font-weight: 800;
      font-size: 12px;
    }
    .user .avatar { grid-column: 2; background: rgba(115,247,198,.14); color: var(--accent); border-color: rgba(115,247,198,.25); }
    .bubble {
      border: 1px solid var(--line);
      border-radius: 22px;
      padding: 14px 15px;
      background: rgba(255,255,255,.055);
      color: rgba(246,248,251,.92);
      line-height: 1.66;
      white-space: pre-wrap;
      word-break: break-word;
      box-shadow: 0 14px 48px rgba(0,0,0,.16);
    }
    .user .bubble { grid-column: 1; grid-row: 1; background: rgba(115,247,198,.13); border-color: rgba(115,247,198,.24); }
    .bubble.loading::after { content: ""; display: inline-block; width: 7px; height: 7px; margin-left: 4px; border-radius: 50%; background: var(--accent); animation: blink 1s ease infinite; }
    @keyframes blink { 50% { opacity: .2; transform: translateY(-1px); } }

    .composer {
      padding: 10px;
      border-top: 1px solid var(--line);
      background: rgba(0,0,0,.20);
    }
    .composer-box {
      border: 1px solid var(--line-2);
      border-radius: 24px;
      background: rgba(0,0,0,.26);
      overflow: hidden;
    }
    .composer textarea {
      width: 100%;
      min-height: 64px;
      max-height: 170px;
      resize: vertical;
      border: 0;
      outline: 0;
      background: transparent;
      padding: 15px 16px;
      line-height: 1.55;
    }
    .composer-actions {
      min-height: 44px;
      padding: 7px;
      border-top: 1px solid rgba(255,255,255,.075);
      display: flex;
      gap: 8px;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
    }
    .hint { color: var(--soft); font-size: 12px; }

    .tokens-head { padding: 14px 14px 10px; border-bottom: 1px solid var(--line); }
    .tokens-title { margin: 0; font-size: 18px; letter-spacing: -.025em; }
    .tokens-sub { margin: 5px 0 0; color: var(--muted); font-size: 12px; line-height: 1.45; }
    .add-box { padding: 10px 14px; border-bottom: 1px solid var(--line); }
    #tokenValueInput { min-height: 58px; max-height: 112px; }
    .import-strip {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 7px 0 9px;
      min-width: 0;
    }
    .import-strip .hint {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .token-list {
      min-height: 0;
      overflow: auto;
      padding: 8px;
      scrollbar-gutter: stable;
    }
    .token-card {
      border: 1px solid var(--line);
      border-radius: 16px;
      background: rgba(255,255,255,.042);
      padding: 9px;
      margin-bottom: 7px;
      transition: transform .16s ease, border-color .16s ease, background .16s ease;
    }
    .token-card:hover { transform: translateY(-1px); border-color: rgba(143,180,255,.26); background: rgba(255,255,255,.058); }
    .token-main { display: grid; gap: 2px; min-width: 0; }
    .token-label { font-weight: 760; letter-spacing: -.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; font-size: 11px; }
    .token-meta { color: var(--soft); font-size: 11px; display: flex; gap: 5px; flex-wrap: wrap; }
    .token-card .chip { min-height: 22px; padding: 0 7px; font-size: 11px; }
    .token-card .btn.small { min-height: 28px; padding: 0 9px; }
    .token-error { margin-top: 6px; color: #ffd7dc; background: rgba(255,127,143,.08); border: 1px solid rgba(255,127,143,.16); border-radius: 12px; padding: 6px 8px; font-size: 11px; line-height: 1.35; }
    .empty-list { color: var(--muted); padding: 22px 10px; text-align: center; line-height: 1.55; }

    .toast {
      position: fixed;
      left: 50%;
      bottom: 20px;
      transform: translateX(-50%) translateY(12px);
      opacity: 0;
      pointer-events: none;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: rgba(15,18,26,.92);
      box-shadow: 0 18px 70px rgba(0,0,0,.42);
      padding: 11px 14px;
      color: var(--text);
      transition: opacity .2s ease, transform .2s ease;
      z-index: 50;
    }
    .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }

    @media (max-width: 1180px) {
      body { overflow: auto; }
      .app { height: auto; grid-template-columns: 260px minmax(0, 1fr); }
      .rail, .chat { height: calc(100dvh - 20px); min-height: 560px; }
      .tokens { grid-column: 1 / -1; height: min(620px, calc(100dvh - 20px)); min-height: 420px; }
    }
    @media (max-width: 820px) {
      body { overflow: auto; }
      .app { width: min(100vw - 16px, 640px); height: auto; grid-template-columns: 1fr; margin: 8px auto; }
      .rail, .chat, .tokens { height: auto; min-height: auto; border-radius: 24px; }
      .chat { min-height: 76dvh; }
      .chat-head { grid-template-columns: 1fr; }
      .msg, .msg.user { grid-template-columns: 32px minmax(0, 1fr); }
      .msg.user .avatar { grid-column: 1; }
      .msg.user .bubble { grid-column: 2; }
      .stat-grid { grid-template-columns: repeat(2, minmax(0,1fr)); }
    }
    @media (prefers-reduced-motion: reduce) {
      * { animation-duration: .01ms !important; transition-duration: .01ms !important; scroll-behavior: auto !important; }
    }
  </style>
</head>
<body>
  <main class="app">
    <aside class="rail" aria-label="管理侧栏">
      <div class="brand">
        <div class="mark">G</div>
        <h1>grok2api<br />Worker</h1>
        <p class="sub">一个轻量的 AI 聊天与 Token 池管理工作台。模型列表只读取当前可用模型。</p>
      </div>

      <section class="section">
        <h2 class="section-title">运行状态</h2>
        <div class="row" style="margin-bottom:12px">
          <span id="statusChip" class="chip warn">连接中</span>
          <span id="egressChip" class="chip plain">egress --</span>
        </div>
        <div class="stat-grid">
          <div class="stat"><div class="k">模型</div><div id="modelCount" class="v">--</div><div class="n">/v1/models</div></div>
          <div class="stat"><div class="k">Token</div><div id="tokenCount" class="v">--</div><div class="n">total</div></div>
          <div class="stat ok"><div class="k">有效Token</div><div id="validTokenCount" class="v">--</div><div class="n">enabled</div></div>
          <div class="stat bad"><div class="k">失效Token</div><div id="invalidTokenCount" class="v">--</div><div class="n">disabled/auto</div></div>
        </div>
      </section>

      <section class="section">
        <h2 class="section-title">访问密钥</h2>
        <label class="field">
          <span class="label">API Key</span>
          <input id="apiKeyInput" class="input" type="password" placeholder="sk-..." autocomplete="off" />
        </label>
        <div class="row">
          <button id="saveKeyBtn" class="btn primary small" type="button">保存</button>
          <button id="toggleKeyBtn" class="btn small" type="button">显示</button>
          <button id="clearKeyBtn" class="btn ghost small" type="button">清除</button>
        </div>
        <div style="margin-top:10px"><span id="keyChip" class="chip warn">未保存</span></div>
      </section>

      <section class="section">
        <h2 class="section-title">模型选择</h2>
        <label class="field">
          <span class="label">可用模型</span>
          <select id="modelSelect" class="select"></select>
        </label>
        <div class="row">
          <button id="refreshBtn" class="btn small" type="button">刷新全部</button>
          <button id="clearChatBtn" class="btn ghost small" type="button">清空聊天</button>
        </div>
      </section>

      <div class="links">
        <a class="link" href="/health" target="_blank" rel="noreferrer"><span>/health</span><span>打开</span></a>
        <a class="link" href="/v1/models" target="_blank" rel="noreferrer"><span>/v1/models</span><span>打开</span></a>
      </div>
    </aside>

    <section class="chat" aria-label="AI 聊天窗口">
      <header class="chat-head">
        <div>
          <h2 class="chat-title">AI 聊天</h2>
          <div class="chat-meta">
            <span id="activeModel" class="chip plain">model --</span>
            <span class="chip ok">Chat Completions</span>
            <span id="roundRobinHint" class="chip plain">Token 轮询已接入</span>
          </div>
        </div>
        <div class="row">
          <select id="reasoningSelect" class="select" style="width:150px" aria-label="Reasoning effort">
            <option value="none">reasoning none</option>
            <option value="low">reasoning low</option>
            <option value="medium">reasoning medium</option>
            <option value="high">reasoning high</option>
          </select>
          <button id="copyCurlBtn" class="btn small" type="button">复制 curl</button>
        </div>
      </header>

      <div id="messages" class="messages" aria-live="polite"></div>

      <form id="chatForm" class="composer">
        <div class="composer-box">
          <textarea id="promptInput" placeholder="输入消息，Enter 发送，Shift+Enter 换行"></textarea>
          <div class="composer-actions">
            <span id="composerHint" class="hint">非流式聊天；如果某个 Token 返回 401/403，后端会自动禁用并切换下一个。</span>
            <div class="row">
              <button id="stopBtn" class="btn small ghost" type="button" disabled>停止</button>
              <button id="sendBtn" class="btn primary" type="submit">发送</button>
            </div>
          </div>
        </div>
      </form>
    </section>

    <aside class="tokens" aria-label="Token 池管理">
      <header class="tokens-head">
        <div class="row between">
          <div>
            <h2 class="tokens-title">Token 池</h2>
            <p class="tokens-sub">新增的 Token 存在 Worker KV；调用时按模型层级轮询。401/403 会记录错误、自动禁用并切换到下一个可用 Token。</p>
          </div>
          <button id="reloadTokensBtn" class="btn small" type="button">重载</button>
        </div>
      </header>

      <section class="add-box">
        <label class="field">
          <span class="label">Token 标签</span>
          <input id="tokenLabelInput" class="input" placeholder="例如 main console" maxlength="80" />
        </label>
        <div class="row" style="align-items:end">
          <label class="field" style="flex:1; margin-bottom:0">
            <span class="label">池</span>
            <select id="tokenPoolSelect" class="select">
              <option value="generic">generic fallback</option>
              <option value="basic">basic</option>
              <option value="super">super</option>
              <option value="heavy">heavy</option>
            </select>
          </label>
          <label class="row" style="min-height:42px; color:var(--muted); font-size:12px">
            <input id="tokenEnabledInput" type="checkbox" checked /> 启用
          </label>
        </div>
        <label class="field" style="margin-top:12px">
          <span class="label">SSO Token</span>
          <textarea id="tokenValueInput" class="textarea" placeholder="粘贴一个或多个 sso token；每行一个，保存后列表只显示脱敏值"></textarea>
        </label>
        <div class="import-strip">
          <button id="importTokenFileBtn" class="btn small" type="button">导入文件</button>
          <input id="tokenFileInput" type="file" accept=".txt,.text,.log,.csv,text/plain,text/*" multiple hidden />
          <span id="tokenImportHint" class="hint">支持 txt/log/csv，多行每行一个 Token</span>
        </div>
        <button id="addTokenBtn" class="btn primary" type="button" style="width:100%">添加粘贴 Token</button>
      </section>

      <div id="tokenList" class="token-list"></div>
    </aside>
  </main>

  <div id="toast" class="toast" role="status" aria-live="polite"></div>

  <script>
    (function () {
      var STORAGE_KEY = "grok2api_admin_key";
      var REASONING_OPTIONS = ["none", "minimal", "low", "medium", "high", "xhigh"];
      var state = {
        key: localStorage.getItem(STORAGE_KEY) || "",
        health: null,
        models: [],
        selectedModel: "",
        selectedEffort: "",
        reasoningByModel: {},
        tokens: [],
        counts: null,
        kvConfigured: false,
        messages: [],
        busy: false,
        aborter: null
      };

      function qs(id) { return document.getElementById(id); }
      function text(id, value) { qs(id).textContent = value == null ? "" : String(value); }
      function headers() {
        var h = { "Content-Type": "application/json" };
        if (state.key) h.Authorization = "Bearer " + state.key;
        return h;
      }
      function pretty(value) { return JSON.stringify(value, null, 2); }
      function sumTokenCounts(counts, field) {
        counts = counts || {};
        return ["generic", "basic", "super", "heavy"].reduce(function (sum, key) {
          return sum + Number((counts[key] && counts[key][field]) || 0);
        }, 0);
      }
      function tokenStats(counts, health) {
        counts = counts || (health && health.token_pool_counts) || null;
        if (!counts && health && health.token_pools) {
          var enabledOnly = Object.keys(health.token_pools).reduce(function (sum, key) {
            return sum + Number(health.token_pools[key] || 0);
          }, 0);
          return { total: enabledOnly, valid: enabledOnly, invalid: 0 };
        }
        if (!counts) return { total: null, valid: null, invalid: null };
        var valid = sumTokenCounts(counts, "enabled");
        var invalid = sumTokenCounts(counts, "disabled");
        var total = sumTokenCounts(counts, "total");
        if (!total && (valid || invalid)) total = valid + invalid;
        return { total: total, valid: valid, invalid: invalid };
      }
      function statText(value) {
        return value === null || value === undefined || value !== value ? "--" : value;
      }
      function timeAgo(ts) {
        if (!ts) return "never";
        var diff = Math.max(0, Math.floor(Date.now() / 1000) - Number(ts));
        if (diff < 60) return diff + "s ago";
        if (diff < 3600) return Math.floor(diff / 60) + "m ago";
        if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
        return Math.floor(diff / 86400) + "d ago";
      }
      function toast(message) {
        var el = qs("toast");
        el.textContent = message;
        el.classList.add("show");
        clearTimeout(toast._timer);
        toast._timer = setTimeout(function () { el.classList.remove("show"); }, 2600);
      }
      function authNeeded() {
        return state.health && state.health.auth_required && !state.key;
      }
      function requireKey() {
        if (authNeeded()) {
          toast("请先保存 API Key");
          return false;
        }
        return true;
      }

      async function fetchJson(path, init) {
        var res = await fetch(path, init || {});
        var raw = await res.text();
        var data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch (_) { data = { raw: raw }; }
        if (!res.ok) {
          var message = data && data.error && data.error.message ? data.error.message : "HTTP " + res.status;
          var err = new Error(message);
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      }

      async function loadHealth() {
        try {
          state.health = await fetchJson("/health?ts=" + Date.now());
        } catch (err) {
          state.health = { status: "error", error: err.message || String(err) };
        }
        renderStatus();
      }

      async function loadModels() {
        if (authNeeded()) {
          state.models = [];
          renderModels();
          return;
        }
        try {
          var data = await fetchJson("/v1/models?ts=" + Date.now(), { headers: headers() });
          state.models = Array.isArray(data.data) ? data.data : [];
        } catch (err) {
          state.models = [];
          toast("模型加载失败：" + (err.message || String(err)));
        }
        renderModels();
      }

      async function loadTokens() {
        if (authNeeded()) {
          state.tokens = [];
          state.counts = null;
          renderTokens();
          return;
        }
        try {
          var data = await fetchJson("/admin/api/tokens?ts=" + Date.now(), { headers: headers() });
          state.tokens = Array.isArray(data.data) ? data.data : [];
          state.counts = data.counts || null;
          state.kvConfigured = !!data.kv_configured;
        } catch (err) {
          state.tokens = [];
          state.counts = null;
          toast("Token 池加载失败：" + (err.message || String(err)));
        }
        renderTokens();
        renderStatus();
      }

      function renderStatus() {
        var h = state.health || {};
        var ok = h.status === "ok";
        var features = h.features || {};
        var stats = tokenStats(state.counts, h);
        var statusChip = qs("statusChip");
        statusChip.className = "chip " + (ok ? "ok" : "bad");
        statusChip.textContent = ok ? "online" : "offline";
        text("modelCount", state.models.length || h.available_models || "--");
        text("tokenCount", statText(stats.total));
        text("validTokenCount", statText(stats.valid));
        text("invalidTokenCount", statText(stats.invalid));
        var egress = features.vpc_egress && features.vpc_egress_binding ? "VPC" : "Direct";
        text("egressChip", "egress " + egress);
        var keyChip = qs("keyChip");
        keyChip.className = "chip " + (state.key ? "ok" : "warn");
        keyChip.textContent = state.key ? "已保存到浏览器" : "未保存";
      }

      function renderModels() {
        var select = qs("modelSelect");
        var old = state.selectedModel || select.value;
        select.textContent = "";
        if (!state.models.length) {
          var empty = document.createElement("option");
          empty.value = "";
          empty.textContent = authNeeded() ? "请先保存 API Key" : "暂无可用模型";
          select.appendChild(empty);
          state.selectedModel = "";
        } else {
          state.models.forEach(function (model) {
            var opt = document.createElement("option");
            opt.value = model.id;
            opt.textContent = model.id;
            select.appendChild(opt);
          });
          if (old && Array.prototype.some.call(select.options, function (o) { return o.value === old; })) select.value = old;
          else if (Array.prototype.some.call(select.options, function (o) { return o.value === "grok-4.3"; })) select.value = "grok-4.3";
          else select.selectedIndex = 0;
          state.selectedModel = select.value || "";
        }
        renderReasoningOptions();
        updateActiveModel();
        text("modelCount", state.models.length || "--");
      }

      function findModel(id) {
        for (var i = 0; i < state.models.length; i++) {
          if (state.models[i] && state.models[i].id === id) return state.models[i];
        }
        return null;
      }

      function reasoningEffortsFor(model) {
        var efforts = model && Array.isArray(model.reasoning_efforts) ? model.reasoning_efforts : ["none", "low", "medium", "high"];
        var seen = {};
        return efforts.map(function (x) { return String(x || "").trim(); }).filter(function (x) {
          if (!x || seen[x]) return false;
          seen[x] = true;
          return true;
        });
      }

      function renderReasoningOptions() {
        var select = qs("reasoningSelect");
        var model = findModel(state.selectedModel || qs("modelSelect").value || "");
        var supported = reasoningEffortsFor(model);
        var supportedSet = {};
        supported.forEach(function (x) { supportedSet[x] = true; });
        var old = model ? state.reasoningByModel[model.id] || "" : "";
        if (!old) old = state.selectedEffort || "";
        var fallback = model && model.default_reasoning_effort && supportedSet[model.default_reasoning_effort]
          ? model.default_reasoning_effort
          : (supportedSet.none ? "none" : supported[0] || "none");

        select.textContent = "";
        REASONING_OPTIONS.forEach(function (effort) {
          var opt = document.createElement("option");
          opt.value = effort;
          var ok = !!supportedSet[effort];
          opt.disabled = !ok;
          opt.textContent = ok ? "reasoning " + effort : "reasoning " + effort + "（不支持）";
          select.appendChild(opt);
        });

        state.selectedEffort = supportedSet[old] ? old : fallback;
        if (model && model.id) state.reasoningByModel[model.id] = state.selectedEffort;
        select.value = state.selectedEffort;
      }

      function updateActiveModel() {
        text("activeModel", "model " + (state.selectedModel || "--") + " · reasoning " + (state.selectedEffort || "none"));
      }

      function renderMessages() {
        var box = qs("messages");
        box.textContent = "";
        if (!state.messages.length) {
          var empty = document.createElement("div");
          empty.className = "empty";
          empty.innerHTML = '<div class="empty-inner"><h2>选择模型，开始聊天</h2><p>这里会像正常 AI 聊天窗口一样保留上下文。右侧可以管理 Token；失效 Token 会在后端自动禁用并切换。</p></div>';
          box.appendChild(empty);
          return;
        }
        state.messages.forEach(function (msg) {
          var row = document.createElement("div");
          row.className = "msg " + (msg.role === "user" ? "user" : "assistant");
          var avatar = document.createElement("div");
          avatar.className = "avatar";
          avatar.textContent = msg.role === "user" ? "U" : "AI";
          var bubble = document.createElement("div");
          bubble.className = "bubble" + (msg.loading ? " loading" : "");
          bubble.textContent = msg.content || "";
          row.appendChild(avatar);
          row.appendChild(bubble);
          box.appendChild(row);
        });
        box.scrollTop = box.scrollHeight;
      }

      function renderTokens() {
        var stats = tokenStats(state.counts, state.health || {});
        text("tokenCount", statText(stats.total));
        text("validTokenCount", statText(stats.valid));
        text("invalidTokenCount", statText(stats.invalid));
        var list = qs("tokenList");
        list.textContent = "";
        if (authNeeded()) {
          list.innerHTML = '<div class="empty-list">请先保存 API Key 后加载 Token 池。</div>';
          return;
        }
        if (!state.tokens.length) {
          list.innerHTML = '<div class="empty-list">暂无 Token。添加一个 managed token 后即可在 KV 中管理启用、禁用和删除。</div>';
          return;
        }
        var grouped = state.tokens.slice().sort(function (a, b) {
          return String(a.pool).localeCompare(String(b.pool)) || String(a.source).localeCompare(String(b.source)) || String(a.label).localeCompare(String(b.label));
        });
        grouped.forEach(function (tok) {
          var card = document.createElement("div");
          card.className = "token-card";

          var top = document.createElement("div");
          top.className = "row between";

          var main = document.createElement("div");
          main.className = "token-main";
          var label = document.createElement("div");
          label.className = "token-label";
          label.textContent = tok.label || "Token";
          var masked = document.createElement("div");
          masked.className = "mono";
          masked.style.color = "var(--muted)";
          masked.textContent = tok.masked || "******";
          main.appendChild(label);
          main.appendChild(masked);

          var actions = document.createElement("div");
          actions.className = "row";
          var enable = document.createElement("button");
          enable.className = "btn small " + (tok.enabled ? "" : "primary");
          enable.type = "button";
          enable.textContent = tok.enabled ? "禁用" : "启用";
          enable.addEventListener("click", function () { toggleToken(tok); });
          var del = document.createElement("button");
          del.className = "btn small danger";
          del.type = "button";
          del.textContent = "删除";
          del.addEventListener("click", function () { deleteToken(tok); });
          actions.appendChild(enable);
          actions.appendChild(del);

          top.appendChild(main);
          top.appendChild(actions);
          card.appendChild(top);

          var meta = document.createElement("div");
          meta.className = "token-meta";
          meta.style.marginTop = "10px";
          var status = tok.enabled ? "enabled" : "disabled";
          meta.innerHTML = '<span class="chip ' + (tok.enabled ? 'ok' : 'warn') + '">' + status + '</span>' +
            '<span class="chip plain">' + tok.pool + '</span>' +
            '<span class="chip plain">' + tok.source + '</span>' +
            '<span class="chip plain">fail ' + (tok.fail_count || 0) + '</span>' +
            '<span class="chip plain">last ' + timeAgo(tok.last_used_at) + '</span>';
          card.appendChild(meta);

          if (tok.last_error || tok.auto_disabled_reason) {
            var err = document.createElement("div");
            err.className = "token-error";
            err.textContent = tok.auto_disabled_reason || tok.last_error;
            card.appendChild(err);
          }
          list.appendChild(card);
        });
      }

      function selectedModel() {
        var value = qs("modelSelect").value || "";
        if (value !== state.selectedModel) state.selectedModel = value;
        return state.selectedModel || "";
      }
      function selectedEffort() {
        var value = qs("reasoningSelect").value || "none";
        state.selectedEffort = value;
        if (state.selectedModel) state.reasoningByModel[state.selectedModel] = value;
        return state.selectedEffort || "none";
      }
      function chatPayload(promptOnly, model, effort) {
        var messages = state.messages
          .filter(function (m) { return !m.loading && (m.role === "user" || m.role === "assistant"); })
          .map(function (m) { return { role: m.role, content: m.content }; });
        if (promptOnly) messages = [{ role: "user", content: promptOnly }];
        return { model: model || selectedModel(), messages: messages, stream: false, reasoning_effort: effort || selectedEffort() };
      }
      function extractReply(data) {
        if (!data) return "";
        if (data.error) return data.error.message || pretty(data.error);
        var choice = data.choices && data.choices[0];
        var msg = choice && choice.message;
        if (msg && typeof msg.content === "string") return msg.content;
        return pretty(data);
      }

      async function sendChat(event) {
        if (event) event.preventDefault();
        if (state.busy) return;
        if (!requireKey()) return;
        var model = selectedModel();
        if (!model) { toast("没有可用模型"); return; }
        var effort = selectedEffort();
        var input = qs("promptInput").value.trim();
        if (!input) return;

        state.messages.push({ role: "user", content: input });
        var assistant = { role: "assistant", content: "正在请求 " + model + " · reasoning " + effort, loading: true };
        state.messages.push(assistant);
        qs("promptInput").value = "";
        state.busy = true;
        state.aborter = new AbortController();
        qs("sendBtn").disabled = true;
        qs("stopBtn").disabled = false;
        renderMessages();

        try {
          var payload = chatPayload(null, model, effort);
          var started = Date.now();
          var res = await fetch("/v1/chat/completions", {
            method: "POST",
            headers: headers(),
            body: JSON.stringify(payload),
            signal: state.aborter.signal
          });
          var raw = await res.text();
          var data = null;
          try { data = raw ? JSON.parse(raw) : null; } catch (_) { data = { raw: raw }; }
          if (!res.ok) {
            var message = data && data.error && data.error.message ? data.error.message : "HTTP " + res.status;
            throw new Error(message);
          }
          assistant.content = extractReply(data) || "(empty response)";
          assistant.loading = false;
          text("composerHint", "HTTP " + res.status + " · " + (Date.now() - started) + "ms · " + model + " · reasoning " + effort);
        } catch (err) {
          assistant.loading = false;
          assistant.content = "请求失败：" + (err.message || String(err));
        } finally {
          state.busy = false;
          state.aborter = null;
          qs("sendBtn").disabled = false;
          qs("stopBtn").disabled = true;
          renderMessages();
          loadTokens();
          loadHealth().then(loadModels);
        }
      }

      function uniqueStrings(items) {
        var seen = {};
        var out = [];
        items.forEach(function (item) {
          var value = String(item || "").trim();
          if (!value || seen[value]) return;
          seen[value] = true;
          out.push(value);
        });
        return out;
      }

      function parseTokenLines(textValue) {
        return uniqueStrings(String(textValue || "").split(/\\r?\\n/g));
      }

      function setTokenWriteBusy(busy) {
        qs("addTokenBtn").disabled = busy;
        qs("importTokenFileBtn").disabled = busy;
      }

      function readFileText(file) {
        if (file && typeof file.text === "function") return file.text();
        return new Promise(function (resolve, reject) {
          var reader = new FileReader();
          reader.onload = function () { resolve(String(reader.result || "")); };
          reader.onerror = function () { reject(reader.error || new Error("file read failed")); };
          reader.readAsText(file);
        });
      }

      async function saveTokens(tokens, label) {
        var cleanTokens = uniqueStrings(tokens);
        if (!cleanTokens.length) throw new Error("token is required");
        return fetchJson("/admin/api/tokens", {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({
            tokens: cleanTokens,
            label: label || "",
            pool: qs("tokenPoolSelect").value,
            enabled: qs("tokenEnabledInput").checked
          })
        });
      }

      async function addToken() {
        if (!requireKey()) return;
        var tokens = parseTokenLines(qs("tokenValueInput").value);
        if (!tokens.length) { toast("请先粘贴 Token"); return; }
        setTokenWriteBusy(true);
        try {
          await saveTokens(tokens, qs("tokenLabelInput").value.trim());
          qs("tokenValueInput").value = "";
          qs("tokenLabelInput").value = "";
          toast(tokens.length + " 个 Token 已增加");
          await loadTokens();
          await loadModels();
        } catch (err) {
          toast("增加失败：" + (err.message || String(err)));
        } finally {
          setTokenWriteBusy(false);
        }
      }

      async function importTokenFile() {
        if (!requireKey()) {
          qs("tokenFileInput").value = "";
          return;
        }
        var input = qs("tokenFileInput");
        var files = Array.prototype.slice.call(input.files || []);
        if (!files.length) return;
        setTokenWriteBusy(true);
        try {
          var tokens = [];
          for (var i = 0; i < files.length; i++) {
            var textValue = await readFileText(files[i]);
            tokens = tokens.concat(parseTokenLines(textValue));
          }
          tokens = uniqueStrings(tokens);
          if (!tokens.length) {
            toast("文件中没有找到 Token");
            return;
          }
          var label = qs("tokenLabelInput").value.trim();
          if (!label && files.length === 1) {
            var name = String(files[0].name || "import");
            var dot = name.lastIndexOf(".");
            label = (dot > 0 ? name.slice(0, dot) : name).slice(0, 80);
          }
          qs("tokenImportHint").textContent = "正在导入 " + tokens.length + " 个 Token...";
          await saveTokens(tokens, label);
          qs("tokenValueInput").value = "";
          qs("tokenLabelInput").value = "";
          toast("已导入 " + tokens.length + " 个 Token");
          await loadTokens();
          await loadModels();
        } catch (err) {
          toast("导入失败：" + (err.message || String(err)));
        } finally {
          input.value = "";
          qs("tokenImportHint").textContent = "支持 txt/log/csv，多行每行一个 Token";
          setTokenWriteBusy(false);
        }
      }

      async function toggleToken(tok) {
        if (!requireKey()) return;
        try {
          await fetchJson("/admin/api/tokens/" + encodeURIComponent(tok.id), {
            method: "PATCH",
            headers: headers(),
            body: JSON.stringify({ enabled: !tok.enabled })
          });
          toast(tok.enabled ? "Token 已禁用" : "Token 已启用");
          await loadTokens();
          await loadModels();
        } catch (err) {
          toast("操作失败：" + (err.message || String(err)));
        }
      }

      async function deleteToken(tok) {
        if (!requireKey()) return;
        if (!confirm("确认删除/隐藏这个 Token？")) return;
        try {
          await fetchJson("/admin/api/tokens/" + encodeURIComponent(tok.id), {
            method: "DELETE",
            headers: headers()
          });
          toast("Token 已删除");
          await loadTokens();
          await loadModels();
        } catch (err) {
          toast("删除失败：" + (err.message || String(err)));
        }
      }

      function saveKey() {
        state.key = qs("apiKeyInput").value.trim();
        if (state.key) localStorage.setItem(STORAGE_KEY, state.key);
        else localStorage.removeItem(STORAGE_KEY);
        renderStatus();
        refreshAll();
      }
      function clearKey() {
        state.key = "";
        qs("apiKeyInput").value = "";
        localStorage.removeItem(STORAGE_KEY);
        renderStatus();
        renderModels();
        renderTokens();
      }
      function copyCurl() {
        var prompt = qs("promptInput").value.trim() || "请只回复 ok";
        var model = selectedModel() || "grok-4.3";
        var effort = selectedEffort();
        var body = { model: model, messages: [{ role: "user", content: prompt }], stream: false, reasoning_effort: effort };
        var key = state.key || "YOUR_API_KEY";
        var nl = " " + String.fromCharCode(92, 10);
        var cmd = "curl " + JSON.stringify(location.origin + "/v1/chat/completions") + nl + "  -H " + JSON.stringify("Authorization: Bearer " + key) + nl + "  -H " + JSON.stringify("Content-Type: application/json") + nl + "  -d " + JSON.stringify(JSON.stringify(body));
        navigator.clipboard.writeText(cmd).then(function () { toast("curl 已复制"); }, function () { toast("复制失败"); });
      }
      function stopRequest() {
        if (state.aborter) state.aborter.abort();
      }
      function clearChat() {
        if (state.busy) return;
        state.messages = [];
        renderMessages();
      }
      async function refreshAll() {
        await loadHealth();
        await Promise.all([loadModels(), loadTokens()]);
      }

      function bind() {
        qs("apiKeyInput").value = state.key;
        qs("saveKeyBtn").addEventListener("click", saveKey);
        qs("clearKeyBtn").addEventListener("click", clearKey);
        qs("toggleKeyBtn").addEventListener("click", function () {
          var input = qs("apiKeyInput");
          input.type = input.type === "password" ? "text" : "password";
          qs("toggleKeyBtn").textContent = input.type === "password" ? "显示" : "隐藏";
        });
        qs("modelSelect").addEventListener("change", function () {
          state.selectedModel = qs("modelSelect").value || "";
          renderReasoningOptions();
          updateActiveModel();
        });
        qs("reasoningSelect").addEventListener("change", function () {
          state.selectedEffort = qs("reasoningSelect").value || "none";
          if (state.selectedModel) state.reasoningByModel[state.selectedModel] = state.selectedEffort;
          updateActiveModel();
        });
        qs("refreshBtn").addEventListener("click", refreshAll);
        qs("reloadTokensBtn").addEventListener("click", loadTokens);
        qs("clearChatBtn").addEventListener("click", clearChat);
        qs("chatForm").addEventListener("submit", sendChat);
        qs("promptInput").addEventListener("keydown", function (event) {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            sendChat(event);
          }
        });
        qs("stopBtn").addEventListener("click", stopRequest);
        qs("copyCurlBtn").addEventListener("click", copyCurl);
        qs("addTokenBtn").addEventListener("click", addToken);
        qs("importTokenFileBtn").addEventListener("click", function () { qs("tokenFileInput").click(); });
        qs("tokenFileInput").addEventListener("change", importTokenFile);
      }

      bind();
      renderStatus();
      renderMessages();
      refreshAll();
    })();
  </script>
</body>
</html>`;
