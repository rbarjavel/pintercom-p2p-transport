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
      --border: rgba(255, 255, 255, 0.07);
      --border-subtle: rgba(255, 255, 255, 0.03);
      
      --text-main: #f0f2f5;
      --text-muted: #848b99;
      --text-dim: #545b69;
      
      --accent: #82aaff;
      --accent-dim: rgba(130, 170, 255, 0.12);
      
      --dot-idle: #4ade80;
      --dot-thinking: #c084fc;
      --dot-busy: #fb923c;
      
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
      padding: max(20px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(32px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
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
      margin-bottom: 20px;
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

    /* Filters & Search */
    .controls {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-bottom: 20px;
    }

    .filter-pills {
      display: flex;
      gap: 6px;
      overflow-x: auto;
      scrollbar-width: none;
    }
    .filter-pills::-webkit-scrollbar { display: none; }

    .pill {
      background: transparent;
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 5px 12px;
      font-size: 0.75rem;
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
      transition: border-color 0.15s ease;
    }

    .agent-card:active {
      background: var(--card-hover);
    }

    /* Card header */
    .card-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 6px;
      gap: 12px;
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

    .model-badge {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.68rem;
      color: var(--text-dim);
      background: rgba(255, 255, 255, 0.03);
      padding: 2px 7px;
      border-radius: 4px;
      border: 1px solid var(--border-subtle);
      white-space: nowrap;
      flex-shrink: 0;
    }

    /* State subtitle */
    .state-line {
      font-size: 0.74rem;
      color: var(--text-muted);
      margin-bottom: 10px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .state-label {
      color: var(--text-main);
      font-weight: 500;
    }

    .state-busy { color: var(--dot-busy); }
    .state-thinking { color: var(--dot-thinking); }
    .state-idle { color: var(--text-muted); }

    /* Card meta info */
    .meta-block {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 0.75rem;
      color: var(--text-muted);
    }

    .meta-path {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.72rem;
      color: var(--text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .meta-sub {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.7rem;
      color: var(--text-dim);
    }

    /* Context line */
    .context-track-wrap {
      margin-top: 10px;
      padding-top: 8px;
      border-top: 1px solid var(--border-subtle);
    }

    .context-text {
      display: flex;
      justify-content: space-between;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.66rem;
      color: var(--text-dim);
      margin-bottom: 4px;
    }

    .context-bar {
      height: 3px;
      background: rgba(255, 255, 255, 0.06);
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

    /* Empty state */
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

    <button class="icon-btn" id="notif-btn" onclick="toggleNotifications()" aria-label="Notifications">
      <svg viewBox="0 0 24 24">
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
        <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
      </svg>
    </button>
  </header>

  <div class="offline-notice" id="offline-bar">
    Connexion au flux interrompue. Reconnexion en cours...
  </div>

  <div class="controls">
    <div class="filter-pills">
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

    <input type="text" class="search-input" id="search-input" placeholder="Filtrer (nom, machine, dossier, modèle)..." oninput="renderAgents()">
  </div>

  <main class="agent-list" id="agent-list">
    <div class="empty-state">Recherche d'agents sur le réseau local...</div>
  </main>

  <script>
    let sessions = [];
    let currentFilter = 'all';
    let prevStatusMap = new Map();
    let notificationsEnabled = (typeof Notification !== 'undefined' && Notification.permission === 'granted');

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
              notifyUser(name + " terminé", "L'agent est de nouveau au repos.");
            } else if (currentSt.startsWith("tool:")) {
              const tool = currentSt.replace("tool:", "");
              notifyUser(name, "Outil en cours : " + tool);
            }
          }
        }
        nextMap.set(id, currentSt);
      }
      prevStatusMap = nextMap;
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
        return name.includes(query) || host.includes(query) || cwd.includes(query) || model.includes(query) || status.includes(query);
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

        return \`
          <article class="agent-card">
            <div class="card-head">
              <div class="agent-identity">
                <span class="status-dot \${dotClass}"></span>
                <span class="agent-name">\${name}</span>
              </div>
              \${model ? \`<span class="model-badge">\${model}</span>\` : ''}
            </div>

            <div class="state-line">
              <span class="state-label \${stateClass}">\${stateText}</span>
              \${lastAct ? \`<span>· actif il y a \${lastAct}</span>\` : ''}
            </div>

            <div class="meta-block">
              <div class="meta-path" title="\${cwd}">\${cwd}</div>
              <div class="meta-sub">
                <span>\${host}</span>
                <span>·</span>
                <span>PID \${s.pid || '?'}</span>
              </div>
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
          </article>
        \`;
      }).join('');
    }

    let eventSource = null;
    function connectSSE() {
      if (eventSource) eventSource.close();
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
      };

      eventSource.addEventListener('sessions', (e) => {
        try {
          sessions = JSON.parse(e.data);
          checkStatusChanges(sessions);
          renderAgents();
        } catch (err) {}
      });
    }

    fetch('/api/sessions')
      .then(res => res.json())
      .then(data => {
        sessions = data;
        checkStatusChanges(sessions);
        renderAgents();
      })
      .catch(() => {});

    connectSSE();
    setInterval(renderAgents, 5000);
  </script>
</body>
</html>`;
}
