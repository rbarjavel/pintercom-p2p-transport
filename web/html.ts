export function renderDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, maximum-scale=1.0, user-scalable=no">
  <title>Intercom Monitor</title>
  <meta name="theme-color" content="#090a0d">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <link rel="manifest" href="/manifest.json">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">

  <style>
    :root {
      --bg: #090a0d;
      --card: #111318;
      --card-hover: #15181f;
      --card-active: #181c24;
      --border: rgba(255, 255, 255, 0.07);
      --border-subtle: rgba(255, 255, 255, 0.04);
      --border-focus: rgba(130, 170, 255, 0.4);
      
      --text-main: #f0f2f5;
      --text-muted: #848b99;
      --text-dim: #545b69;
      
      --accent: #82aaff;
      --accent-dim: rgba(130, 170, 255, 0.12);
      --accent-text: #0b1326;
      
      --dot-idle: #4ade80;
      --dot-thinking: #c084fc;
      --dot-busy: #fb923c;
      
      --terminal-bg: #060709;
      
      --radius: 12px;
      --radius-sm: 6px;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      -webkit-tap-highlight-color: transparent;
    }

    body {
      background-color: var(--bg);
      color: var(--text-main);
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      padding: max(16px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(32px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
      max-width: 640px;
      margin: 0 auto;
      min-height: 100vh;
      -webkit-font-smoothing: antialiased;
    }

    /* Header */
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .brand-title {
      font-size: 1.05rem;
      font-weight: 600;
      letter-spacing: -0.02em;
      color: var(--text-main);
    }

    .live-status {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 0.72rem;
      color: var(--text-muted);
      font-weight: 400;
    }

    .live-pulse {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--dot-idle);
    }

    .live-pulse.reconnecting {
      background: #f87171;
      animation: blink 1.2s infinite ease-in-out;
    }

    @keyframes blink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.2; }
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .icon-btn {
      background: var(--card);
      border: 1px solid var(--border);
      color: var(--text-muted);
      width: 36px;
      height: 36px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .icon-btn:active {
      background: var(--card-hover);
      transform: scale(0.96);
    }

    .icon-btn.active {
      color: var(--accent);
      border-color: rgba(130, 170, 255, 0.35);
      background: var(--accent-dim);
    }

    .icon-btn svg {
      width: 16px;
      height: 16px;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.8;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    /* Controls & Filters */
    .controls {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-bottom: 18px;
    }

    .filter-pills {
      display: flex;
      gap: 6px;
      overflow-x: auto;
      scrollbar-width: none;
      padding-bottom: 2px;
    }
    .filter-pills::-webkit-scrollbar { display: none; }

    .pill {
      background: transparent;
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 5px 12px;
      font-size: 0.74rem;
      font-weight: 500;
      color: var(--text-muted);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      white-space: nowrap;
      transition: all 0.15s ease;
    }

    .pill-count {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.68rem;
      opacity: 0.7;
    }

    .pill.active {
      background: var(--card);
      border-color: rgba(255, 255, 255, 0.2);
      color: var(--text-main);
    }

    .pill.active .pill-count {
      color: var(--accent);
      opacity: 1;
    }

    .search-input {
      width: 100%;
      background: var(--card);
      border: 1px solid var(--border);
      color: var(--text-main);
      padding: 9px 14px;
      border-radius: var(--radius-sm);
      font-size: 0.82rem;
      font-family: inherit;
      outline: none;
      transition: border-color 0.15s;
    }

    .search-input::placeholder {
      color: var(--text-dim);
    }

    .search-input:focus {
      border-color: rgba(130, 170, 255, 0.5);
    }

    /* Agents List */
    .agent-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .agent-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 14px 16px;
      cursor: pointer;
      transition: background 0.15s ease, border-color 0.15s ease;
      position: relative;
    }

    .agent-card:active {
      background: var(--card-hover);
    }

    .agent-card.expanded {
      background: var(--card-active);
      border-color: rgba(255, 255, 255, 0.14);
    }

    /* Card Head */
    .card-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 6px;
      gap: 8px;
    }

    .agent-identity {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .dot-idle { background: var(--dot-idle); }
    .dot-thinking { background: var(--dot-thinking); animation: blink 1.2s infinite ease-in-out; }
    .dot-busy { background: var(--dot-busy); animation: blink 1.2s infinite ease-in-out; }

    .agent-name {
      font-size: 0.9rem;
      font-weight: 500;
      color: var(--text-main);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      letter-spacing: -0.01em;
    }

    .head-right {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }

    .model-badge {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.68rem;
      color: var(--text-dim);
      background: rgba(255, 255, 255, 0.03);
      padding: 2px 7px;
      border-radius: 4px;
      border: 1px solid var(--border-subtle);
      white-space: nowrap;
    }

    .chevron {
      width: 14px;
      height: 14px;
      stroke: var(--text-dim);
      fill: none;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
      transition: transform 0.2s ease;
    }

    .agent-card.expanded .chevron {
      transform: rotate(180deg);
      stroke: var(--text-main);
    }

    /* State subtitle */
    .state-line {
      font-size: 0.74rem;
      color: var(--text-muted);
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }

    .state-label {
      color: var(--text-main);
      font-weight: 500;
    }

    .state-busy { color: var(--dot-busy); }
    .state-thinking { color: var(--dot-thinking); }
    .state-idle { color: var(--text-muted); }

    /* Compact Summary in closed card */
    .compact-meta {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 0.71rem;
      color: var(--text-dim);
      gap: 8px;
    }

    .compact-cwd {
      font-family: 'JetBrains Mono', monospace;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 70%;
    }

    /* Context Track */
    .context-track-wrap {
      margin-top: 10px;
      padding-top: 6px;
      border-top: 1px solid var(--border-subtle);
    }

    .context-text {
      display: flex;
      justify-content: space-between;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.65rem;
      color: var(--text-dim);
      margin-bottom: 3px;
    }

    .context-bar {
      height: 3px;
      background: rgba(255, 255, 255, 0.05);
      border-radius: 2px;
      overflow: hidden;
    }

    .context-fill {
      height: 100%;
      background: var(--text-muted);
      border-radius: 2px;
      transition: width 0.3s ease;
    }
    .context-fill.warn { background: #fb923c; }
    .context-fill.crit { background: #f87171; }

    /* Expanded Details Drawer */
    .card-drawer {
      display: none;
      margin-top: 14px;
      padding-top: 12px;
      border-top: 1px solid var(--border);
      flex-direction: column;
      gap: 12px;
      cursor: default;
    }

    .agent-card.expanded .card-drawer {
      display: flex;
    }

    /* Terminal Command Box */
    .cmd-box {
      background: var(--terminal-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 10px 12px;
      position: relative;
    }

    .cmd-label {
      font-size: 0.68rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--text-dim);
      margin-bottom: 6px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .cmd-text {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.76rem;
      color: #79c0ff;
      word-break: break-all;
      white-space: pre-wrap;
      line-height: 1.4;
    }

    .cmd-text.last {
      color: var(--text-muted);
    }

    /* Action buttons in expanded card */
    .drawer-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    .action-btn {
      background: var(--card);
      border: 1px solid var(--border);
      color: var(--text-main);
      padding: 7px 12px;
      border-radius: var(--radius-sm);
      font-size: 0.74rem;
      font-family: inherit;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.15s ease;
    }

    .action-btn.primary {
      background: var(--accent-dim);
      border-color: rgba(130, 170, 255, 0.35);
      color: var(--accent);
      font-weight: 500;
    }

    .action-btn:hover, .action-btn:active {
      background: var(--card-hover);
      border-color: rgba(255, 255, 255, 0.2);
    }

    .action-btn svg {
      width: 13px;
      height: 13px;
      stroke: currentColor;
      fill: none;
      stroke-width: 1.8;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    /* Technical Key-Values */
    .kv-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 8px;
      background: rgba(0, 0, 0, 0.2);
      border-radius: var(--radius-sm);
      padding: 10px;
      font-size: 0.72rem;
    }

    .kv-item {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }

    .kv-k {
      color: var(--text-dim);
      font-size: 0.66rem;
    }

    .kv-v {
      color: var(--text-main);
      font-family: 'JetBrains Mono', monospace;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* Modal / Bottom Sheet for Contact */
    .modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.7);
      backdrop-filter: blur(4px);
      display: none;
      align-items: flex-end;
      justify-content: center;
      z-index: 2000;
      padding: 0;
    }

    .modal-overlay.open {
      display: flex;
    }

    .modal-dialog {
      background: #16181f;
      border: 1px solid var(--border);
      border-bottom: none;
      border-radius: 16px 16px 0 0;
      width: 100%;
      max-width: 640px;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 14px;
      box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.5);
      animation: slideUp 0.2s cubic-bezier(0.2, 0, 0, 1);
    }

    @keyframes slideUp {
      from { transform: translateY(100%); }
      to { transform: translateY(0); }
    }

    .modal-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .modal-title {
      font-size: 0.95rem;
      font-weight: 600;
      color: var(--text-main);
    }

    .modal-close {
      background: transparent;
      border: none;
      color: var(--text-dim);
      font-size: 1.2rem;
      cursor: pointer;
      padding: 4px 8px;
    }

    .modal-textarea {
      width: 100%;
      height: 90px;
      background: var(--terminal-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text-main);
      padding: 10px 12px;
      font-family: inherit;
      font-size: 0.85rem;
      outline: none;
      resize: none;
    }

    .modal-textarea:focus {
      border-color: var(--border-focus);
    }

    .modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }

    .btn-cancel {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-muted);
      padding: 8px 14px;
      border-radius: var(--radius-sm);
      font-size: 0.78rem;
      cursor: pointer;
    }

    .btn-send {
      background: var(--accent);
      border: none;
      color: var(--accent-text);
      font-weight: 600;
      padding: 8px 16px;
      border-radius: var(--radius-sm);
      font-size: 0.78rem;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .btn-send:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    /* Empty state & Alerts */
    .empty-state {
      text-align: center;
      padding: 48px 16px;
      color: var(--text-dim);
      font-size: 0.8rem;
    }

    .offline-notice {
      background: rgba(248, 113, 113, 0.08);
      border: 1px solid rgba(248, 113, 113, 0.2);
      color: #f87171;
      padding: 8px 12px;
      border-radius: var(--radius-sm);
      font-size: 0.74rem;
      margin-bottom: 14px;
      display: none;
    }

    .toast {
      position: fixed;
      bottom: max(20px, env(safe-area-inset-bottom));
      left: 50%;
      transform: translateX(-50%) translateY(100px);
      background: #1c2128;
      border: 1px solid var(--border);
      color: var(--text-main);
      padding: 8px 16px;
      border-radius: 20px;
      font-size: 0.75rem;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
      transition: transform 0.2s cubic-bezier(0.2, 0, 0, 1);
      z-index: 3000;
      pointer-events: none;
    }

    .toast.show {
      transform: translateX(-50%) translateY(0);
    }
  </style>
</head>
<body>

  <header>
    <div class="brand">
      <div class="brand-title">Intercom</div>
      <div class="live-status">
        <span class="live-pulse" id="live-dot"></span>
        <span id="live-label">en direct</span>
      </div>
    </div>

    <div class="header-actions">
      <button class="icon-btn" id="refresh-btn" onclick="manualRefresh()" aria-label="Rafraîchir" title="Rafraîchir">
        <svg viewBox="0 0 24 24">
          <polyline points="23 4 23 10 17 10"></polyline>
          <polyline points="1 20 1 14 7 14"></polyline>
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
        </svg>
      </button>

      <button class="icon-btn" id="notif-btn" onclick="toggleNotifications()" aria-label="Notifications" title="Notifications">
        <svg viewBox="0 0 24 24">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
          <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
        </svg>
      </button>
    </div>
  </header>

  <div class="offline-notice" id="offline-bar">
    Connexion au flux interrompue. Reconnexion en cours...
  </div>

  <div class="controls">
    <div class="filter-pills" id="filter-pills">
      <div class="pill active" data-filter="all" onclick="setFilter('all')">
        Tous <span class="pill-count" id="count-all">0</span>
      </div>
      <div class="pill" data-filter="busy" onclick="setFilter('busy')">
        En cours <span class="pill-count" id="count-busy">0</span>
      </div>
      <div class="pill" data-filter="idle" onclick="setFilter('idle')">
        Au repos <span class="pill-count" id="count-idle">0</span>
      </div>
    </div>

    <input type="text" class="search-input" id="search-input" placeholder="Filtrer (nom, machine, dossier, modèle, commande)..." oninput="renderAgents()">
  </div>

  <main class="agent-list" id="agent-list">
    <div class="empty-state">Recherche d'agents sur le réseau local...</div>
  </main>

  <!-- Modal Contacter -->
  <div class="modal-overlay" id="contact-modal" onclick="closeContactModal(event)">
    <div class="modal-dialog" onclick="event.stopPropagation()">
      <div class="modal-head">
        <div class="modal-title" id="contact-title">Contacter l'agent</div>
        <button class="modal-close" onclick="closeContactModal()">✕</button>
      </div>
      <textarea class="modal-textarea" id="contact-text" placeholder="Écrire un message ou une instruction pour cet agent..."></textarea>
      <div class="modal-actions">
        <button class="btn-cancel" onclick="closeContactModal()">Annuler</button>
        <button class="btn-send" id="btn-send-msg" onclick="sendIntercomMessage()">Envoyer</button>
      </div>
    </div>
  </div>

  <div class="toast" id="toast">Copié dans le presse-papier</div>

  <script>
    let sessions = [];
    let currentFilter = 'all';
    let prevStatusMap = new Map();
    let expandedSessions = new Set();
    let notificationsEnabled = (typeof Notification !== 'undefined' && Notification.permission === 'granted');
    let activeContactTarget = null;

    function showToast(msg) {
      const toast = document.getElementById('toast');
      toast.textContent = msg;
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 2000);
    }

    function copyToClipboard(text, msg = "Copié dans le presse-papier") {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
          showToast(msg);
        }).catch(() => fallbackCopy(text, msg));
      } else {
        fallbackCopy(text, msg);
      }
    }

    function fallbackCopy(text, msg) {
      try {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(textarea);
        if (ok) {
          showToast(msg);
        } else {
          prompt("Copier le texte :", text);
        }
      } catch (e) {
        prompt("Copier le texte :", text);
      }
    }

    function openContactModal(targetId, targetName) {
      activeContactTarget = { id: targetId, name: targetName };
      document.getElementById('contact-title').textContent = "Contacter " + targetName;
      document.getElementById('contact-text').value = "";
      document.getElementById('btn-send-msg').disabled = false;
      document.getElementById('btn-send-msg').textContent = "Envoyer";
      document.getElementById('contact-modal').classList.add('open');
      setTimeout(() => document.getElementById('contact-text').focus(), 150);
    }

    function closeContactModal(e) {
      document.getElementById('contact-modal').classList.remove('open');
      activeContactTarget = null;
    }

    async function sendIntercomMessage() {
      if (!activeContactTarget) return;
      const text = document.getElementById('contact-text').value.trim();
      if (!text) return;

      const btn = document.getElementById('btn-send-msg');
      btn.disabled = true;
      btn.textContent = "Envoi...";

      try {
        const res = await fetch('/api/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: activeContactTarget.id, message: text })
        });
        const data = await res.json();
        if (res.ok && data.ok) {
          showToast("Message envoyé à " + activeContactTarget.name);
          closeContactModal();
        } else {
          alert("Erreur d'envoi: " + (data.error || "Échec"));
          btn.disabled = false;
          btn.textContent = "Envoyer";
        }
      } catch (err) {
        alert("Erreur réseau: " + err.message);
        btn.disabled = false;
        btn.textContent = "Envoyer";
      }
    }

    function toggleExpand(id, event) {
      if (event && (event.target.closest('button') || event.target.closest('.cmd-box') || event.target.closest('.modal-overlay'))) {
        return;
      }
      if (expandedSessions.has(id)) {
        expandedSessions.delete(id);
      } else {
        expandedSessions.add(id);
      }
      renderAgents();
    }

    function updateNotifBtn() {
      const btn = document.getElementById('notif-btn');
      btn.classList.toggle('active', notificationsEnabled);
    }
    updateNotifBtn();

    async function toggleNotifications() {
      if (typeof Notification === 'undefined') return;
      if (Notification.permission === 'granted') {
        notificationsEnabled = !notificationsEnabled;
        updateNotifBtn();
        return;
      }
      const perm = await Notification.requestPermission();
      if (perm === 'granted') {
        notificationsEnabled = true;
        updateNotifBtn();
        notifyUser("Notifications activées", "Vous recevrez les alertes d'activité.");
      }
    }

    function playBeep() {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.setValueAtTime(587.33, ctx.currentTime);
        gain.gain.setValueAtTime(0.03, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.18);
      } catch (e) {}
    }

    function notifyUser(title, body) {
      if (notificationsEnabled && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try {
          new Notification(title, { body: body });
          playBeep();
        } catch (e) {}
      }
    }

    function timeAgo(ts) {
      if (!ts) return "";
      const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
      if (s < 60) return s + "s";
      const m = Math.floor(s / 60);
      if (m < 60) return m + "m";
      const h = Math.floor(m / 60);
      return h + "h " + (m % 60) + "m";
    }

    function formatTokens(count) {
      if (count === undefined || count === null) return "?";
      if (count >= 1000000) return (count / 1000000).toFixed(1) + "M";
      if (count >= 1000) return (count / 1000).toFixed(0) + "k";
      return count.toString();
    }

    function setFilter(filter) {
      currentFilter = filter;
      document.querySelectorAll('.pill').forEach(p => {
        p.classList.toggle('active', p.dataset.filter === filter);
      });
      renderAgents();
    }

    function manualRefresh() {
      fetch('/api/sessions')
        .then(r => r.json())
        .then(data => {
          sessions = data;
          checkStatusChanges(sessions);
          renderAgents();
          showToast("Liste actualisée");
        })
        .catch(() => {});
    }

    function checkStatusChanges(newSessions) {
      const nextMap = new Map();
      for (const s of newSessions) {
        const id = s.id;
        const currentSt = s.status || "idle";
        const name = s.name || id.slice(0, 8);
        if (prevStatusMap.has(id)) {
          const oldSt = prevStatusMap.get(id);
          if (oldSt !== currentSt) {
            if ((oldSt.startsWith("tool:") || oldSt === "thinking") && currentSt === "idle") {
              notifyUser(name + " · terminé", "L'agent est de nouveau au repos.");
            } else if (currentSt.startsWith("tool:")) {
              const cmd = s.activeToolDetail ? " : " + s.activeToolDetail : "";
              notifyUser(name, "Outil" + cmd);
            }
          }
        }
        nextMap.set(id, currentSt);
      }
      prevStatusMap = nextMap;
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    function renderAgents() {
      const query = document.getElementById('search-input').value.toLowerCase().trim();
      const container = document.getElementById('agent-list');

      let busyCount = 0;
      let idleCount = 0;
      sessions.forEach(s => {
        const st = s.status || "idle";
        if (st === "thinking" || st.startsWith("tool:")) busyCount++;
        else idleCount++;
      });
      document.getElementById('count-all').textContent = sessions.length;
      document.getElementById('count-busy').textContent = busyCount;
      document.getElementById('count-idle').textContent = idleCount;

      const filtered = sessions.filter(s => {
        const st = s.status || "idle";
        const isBusy = st === "thinking" || st.startsWith("tool:");
        if (currentFilter === 'busy' && !isBusy) return false;
        if (currentFilter === 'idle' && isBusy) return false;

        if (!query) return true;
        const name = (s.name || '').toLowerCase();
        const host = (s.hostname || '').toLowerCase();
        const cwd = (s.cwd || '').toLowerCase();
        const model = (s.model || '').toLowerCase();
        const status = (s.status || '').toLowerCase();
        const cmd = (s.activeToolDetail || '').toLowerCase();
        const lastCmd = (s.lastToolDetail || '').toLowerCase();
        return name.includes(query) || host.includes(query) || cwd.includes(query) || model.includes(query) || status.includes(query) || cmd.includes(query) || lastCmd.includes(query);
      });

      if (filtered.length === 0) {
        container.innerHTML = \`
          <div class="empty-state">
            \${query ? 'Aucun agent correspondant' : 'Aucun agent détecté'}
          </div>\`;
        return;
      }

      container.innerHTML = filtered.map(s => {
        const st = s.status || "idle";
        let dotClass = "dot-idle";
        let stateText = "au repos";
        let stateClass = "state-idle";

        if (st === "thinking") {
          dotClass = "dot-thinking";
          stateText = "réflexion en cours";
          stateClass = "state-thinking";
        } else if (st.startsWith("tool:")) {
          dotClass = "dot-busy";
          stateText = "outil : " + st.replace("tool:", "");
          stateClass = "state-busy";
        }

        const name = s.name || ("session-" + s.id.slice(0, 8));
        const host = s.hostname || "local";
        const cwd = s.cwd || "~";
        const model = s.model || "";
        const pct = (typeof s.contextPct === 'number') ? s.contextPct : null;
        let progClass = "";
        if (pct !== null && pct > 80) progClass = "crit";
        else if (pct !== null && pct > 55) progClass = "warn";

        const lastAct = timeAgo(s.lastActivity);
        const isExpanded = expandedSessions.has(s.id);
        const hasActiveCmd = Boolean(s.activeToolDetail);
        const hasLastCmd = Boolean(s.lastToolDetail);

        return \`
          <article class="agent-card \${isExpanded ? 'expanded' : ''}" onclick="toggleExpand('\${s.id}', event)">
            <div class="card-head">
              <div class="agent-identity">
                <span class="status-dot \${dotClass}"></span>
                <span class="agent-name">\${escapeHtml(name)}</span>
              </div>
              <div class="head-right">
                \${model ? \`<span class="model-badge">\${escapeHtml(model)}</span>\` : ''}
                <svg class="chevron" viewBox="0 0 24 24">
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
              </div>
            </div>

            <div class="state-line">
              <span class="state-label \${stateClass}">\${stateText}</span>
              \${lastAct ? \`<span>· actif il y a \${lastAct}</span>\` : ''}
            </div>

            <div class="compact-meta">
              <div class="compact-cwd" title="\${escapeHtml(cwd)}">\${escapeHtml(cwd)}</div>
              <div>\${escapeHtml(host)}</div>
            </div>

            \${pct !== null ? \`
              <div class="context-track-wrap">
                <div class="context-text">
                  <span>Contexte</span>
                  <span>\${pct}% · \${formatTokens(s.contextTokens)}/\${formatTokens(s.contextWindow)}</span>
                </div>
                <div class="context-bar">
                  <div class="context-fill \${progClass}" style="width: \${Math.min(100, Math.max(0, pct))}%"></div>
                </div>
              </div>
            \` : ''}

            <!-- Drawer unfolded on click -->
            <div class="card-drawer">
              \${hasActiveCmd ? \`
                <div class="cmd-box">
                  <div class="cmd-label">
                    <span>Commande en cours</span>
                    <button class="action-btn" onclick="copyToClipboard('\${escapeHtml(s.activeToolDetail).replace(/'/g, "\\\\'")}', 'Commande copiée')">
                      <svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                      Copier
                    </button>
                  </div>
                  <div class="cmd-text">$ \${escapeHtml(s.activeToolDetail)}</div>
                </div>
              \` : (hasLastCmd ? \`
                <div class="cmd-box">
                  <div class="cmd-label">
                    <span>Dernière action</span>
                    <button class="action-btn" onclick="copyToClipboard('\${escapeHtml(s.lastToolDetail).replace(/'/g, "\\\\'")}', 'Action copiée')">
                      <svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                      Copier
                    </button>
                  </div>
                  <div class="cmd-text last">$ \${escapeHtml(s.lastToolDetail)}</div>
                </div>
              \` : '')}

              <div class="drawer-actions">
                <button class="action-btn primary" onclick="openContactModal('\${s.id}', '\${escapeHtml(name).replace(/'/g, "\\\\'")}')">
                  <svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
                  Contacter
                </button>
                <button class="action-btn" onclick="copyToClipboard('/intercom to:\${s.name || s.id}', 'Commande intercom copiée')">
                  <svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                  Copier /intercom
                </button>
                <button class="action-btn" onclick="copyToClipboard('\${escapeHtml(cwd).replace(/'/g, "\\\\'")}', 'Chemin copié')">
                  <svg viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
                  Copier chemin
                </button>
              </div>

              <div class="kv-grid">
                <div class="kv-item">
                  <span class="kv-k">Machine</span>
                  <span class="kv-v">\${escapeHtml(host)} (\${escapeHtml(s.os || 'os')})</span>
                </div>
                <div class="kv-item">
                  <span class="kv-k">PID</span>
                  <span class="kv-v">\${s.pid || '?'}</span>
                </div>
                <div class="kv-item">
                  <span class="kv-k">Session ID</span>
                  <span class="kv-v" title="\${s.id}">\${s.id.slice(0, 12)}...</span>
                </div>
                <div class="kv-item">
                  <span class="kv-k">Tmux</span>
                  <span class="kv-v">\${s.tmuxPane || 'hors tmux'}</span>
                </div>
              </div>
            </div>
          </article>
        \`;
      }).join('');
    }

    let eventSource = null;
    let syncIntervalTimer = null;

    function applyNewSessions(newSessions) {
      if (!Array.isArray(newSessions)) return;
      sessions = newSessions;
      checkStatusChanges(sessions);
      renderAgents();
    }

    function fetchAndSync() {
      fetch('/api/sessions')
        .then(res => res.json())
        .then(data => {
          applyNewSessions(data);
        })
        .catch(() => {});
    }

    function connectSSE() {
      if (eventSource) {
        try { eventSource.close(); } catch (e) {}
      }
      eventSource = new EventSource('/api/events');

      eventSource.onopen = () => {
        document.getElementById('offline-bar').style.display = 'none';
        document.getElementById('live-dot').className = 'live-pulse';
        document.getElementById('live-label').textContent = 'en direct';
      };

      eventSource.onerror = () => {
        document.getElementById('offline-bar').style.display = 'block';
        document.getElementById('live-dot').className = 'live-pulse reconnecting';
        document.getElementById('live-label').textContent = 'reconnexion...';
        // En cas d'erreur SSE (ex: mise en veille iOS), le polling de secours prend le relais immédiat
        fetchAndSync();
      };

      eventSource.addEventListener('sessions', (e) => {
        try {
          applyNewSessions(JSON.parse(e.data));
        } catch (err) {}
      });

      eventSource.onmessage = (e) => {
        try {
          applyNewSessions(JSON.parse(e.data));
        } catch (err) {}
      };
    }

    // Polling automatique de secours toutes les 2 secondes pour garantir un direct absolu
    syncIntervalTimer = setInterval(fetchAndSync, 2000);

    // Resynchronisation instantanée au réveil du smartphone
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        fetchAndSync();
        connectSSE();
      }
    });

    fetchAndSync();
    connectSSE();
    setInterval(renderAgents, 5000);
  </script>
</body>
</html>`;
}
