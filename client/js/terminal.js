/**
 * CLI Cockpit — Terminal Manager (Glass Bridge v2)
 * Manages xterm.js Terminal instances for all sessions.
 *
 * v2 changes: terminal fills full viewport (top:48px to bottom:0),
 * no input bar below — users type directly into xterm.js.
 * Channel-switch animation on session change.
 * Font priority: JetBrains Mono first.
 */

export class TerminalManager {
  constructor({ emit, on, sessions, send, showToast }) {
    this.emit = emit;
    this.on = on;
    this.sessions = sessions;
    this.send = send;
    this.showToast = showToast;

    this.terminals = new Map();   // sessionId → { terminal, fitAddon, unsubOutput, unsubBuffer }
    this.activeSessionId = null;
    this.resizeDebounce = null;

    this._container = document.getElementById('terminal-container');
    this._terminalView = document.getElementById('terminal-view');
    this._modelBtn = document.getElementById('model-btn');
    this._modelDropdown = document.getElementById('model-dropdown');
  }

  init() {
    this.on('session:active', (id) => this._switchToSession(id));
    this.on('session:removed', (id) => this._disposeSession(id));
    this.on('theme:applied', (theme) => this._updateTheme(theme));

    // Handle model button
    if (this._modelBtn) {
      this._modelBtn.addEventListener('click', () => {
        this._modelDropdown?.classList.toggle('hidden');
      });
    }

    if (this._modelDropdown) {
      this._modelDropdown.querySelectorAll('button[data-model]').forEach(btn => {
        btn.addEventListener('click', () => {
          const modelId = btn.dataset.model;
          const shortName = this._modelShortName(modelId);
          this.send({ type: 'terminal_input', sessionId: this.activeSessionId, data: `/model ${modelId}\r` });
          if (this._modelBtn) this._modelBtn.textContent = shortName;
          this._modelDropdown.classList.add('hidden');
          // Update active checkmark
          this._modelDropdown.querySelectorAll('button').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
        });
      });
    }

    // Window resize → fit
    window.addEventListener('resize', () => {
      clearTimeout(this.resizeDebounce);
      this.resizeDebounce = setTimeout(() => this._fitActive(), 150);
    });
  }

  _modelShortName(modelId) {
    if (modelId.includes('opus')) return 'Opus';
    if (modelId.includes('haiku')) return 'Haiku';
    return 'Sonnet';
  }

  _getOrCreateTerminal(sessionId) {
    if (this.terminals.has(sessionId)) {
      return this.terminals.get(sessionId);
    }

    if (typeof Terminal === 'undefined') {
      console.error('[TerminalManager] xterm.js not loaded — CDN scripts may have failed');
      this.showToast('Terminal library failed to load. Check your connection.', 'error');
      return null;
    }

    const terminal = new Terminal({
      theme: this._buildTheme(),
      fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Consolas', monospace",
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 5000,
      convertEol: true,
      cursorBlink: true,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon.FitAddon();
    const webLinksAddon = new WebLinksAddon.WebLinksAddon((event, url) => {
      window.open(url, '_blank');
    });

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);

    // Direct keyboard input → PTY (keystrokes go straight to the server)
    terminal.onData((data) => {
      this.send({ type: 'terminal_input', sessionId, data });
    });

    // Subscribe to output stream
    const unsubOutput = this.on(`output:${sessionId}`, (data) => {
      terminal.write(data);
    });

    // Subscribe to buffer (one-time replay)
    const unsubBuffer = this.on(`buffer:${sessionId}`, (data) => {
      terminal.clear();
      terminal.reset();
      if (data) terminal.write(data);
      terminal.scrollToBottom();
      this._fitActive();
    });

    const entry = { terminal, fitAddon, unsubOutput, unsubBuffer };
    this.terminals.set(sessionId, entry);
    return entry;
  }

  _disposeSession(sessionId) {
    const entry = this.terminals.get(sessionId);
    if (entry) {
      if (entry.unsubOutput) entry.unsubOutput();
      if (entry.unsubBuffer) entry.unsubBuffer();
      try { entry.terminal.dispose(); } catch { /* ignore */ }
      this.terminals.delete(sessionId);
    }
    // If the disposed session was displayed, clear the container
    if (this.activeSessionId === sessionId) {
      if (this._container) this._container.innerHTML = '';
    }
  }

  _switchToSession(sessionId) {
    if (!sessionId) return;
    this.activeSessionId = sessionId;
    const container = this._container;
    if (!container) return;

    // Channel-switch animation
    if (this._terminalView) {
      this._terminalView.classList.add('terminal-switching');
      setTimeout(() => this._terminalView.classList.remove('terminal-switching'), 350);
    }

    // Detach all terminals from DOM
    container.innerHTML = '';

    // Get or create terminal
    const entry = this._getOrCreateTerminal(sessionId);
    if (!entry) return;
    const { terminal, fitAddon } = entry;

    // Create mount div
    const termDiv = document.createElement('div');
    termDiv.style.width = '100%';
    termDiv.style.height = '100%';
    container.appendChild(termDiv);

    // Open or move terminal
    if (!terminal.element) {
      terminal.open(termDiv);
    } else {
      termDiv.appendChild(terminal.element);
    }

    // Request buffer
    this.send({ type: 'session_subscribe', sessionId });

    // Fit after DOM settles
    setTimeout(() => {
      try {
        fitAddon.fit();
        this.send({ type: 'terminal_resize', sessionId, cols: terminal.cols, rows: terminal.rows });
        terminal.focus();
      } catch { /* ignore */ }
    }, 50);

    this._updateModelIndicator(sessionId);
  }

  _fitActive() {
    if (!this.activeSessionId) return;
    const entry = this.terminals.get(this.activeSessionId);
    if (!entry) return;
    try {
      entry.fitAddon.fit();
      this.send({
        type: 'terminal_resize',
        sessionId: this.activeSessionId,
        cols: entry.terminal.cols,
        rows: entry.terminal.rows,
      });
    } catch { /* ignore */ }
  }

  _updateModelIndicator(sessionId) {
    const session = this.sessions.get(sessionId);
    const isClaudeSession = session && session.sessionType !== 'plain-shell' && session.state !== 'dead';
    if (this._modelBtn) {
      this._modelBtn.classList.toggle('hidden', !isClaudeSession);
    }
  }

  _buildTheme() {
    const style = getComputedStyle(document.documentElement);
    const get = (v) => style.getPropertyValue(v).trim();
    return {
      background:    get('--bg') || '#0a0a1a',
      foreground:    get('--text') || '#c8ccd4',
      cursor:        get('--text') || '#c8ccd4',
      cursorAccent:  get('--bg') || '#0a0a1a',
      black:         '#0a0a1a',
      red:           '#ef4444',
      green:         get('--ready') || '#22c55e',
      yellow:        get('--working') || '#f59e0b',
      blue:          get('--accent') || '#3b82f6',
      magenta:       '#a855f7',
      cyan:          '#06b6d4',
      white:         '#c8ccd4',
      brightBlack:   get('--dead') || '#404040',
      brightRed:     '#f87171',
      brightGreen:   '#4ade80',
      brightYellow:  '#fbbf24',
      brightBlue:    '#60a5fa',
      brightMagenta: '#c084fc',
      brightCyan:    '#22d3ee',
      brightWhite:   '#ffffff',
    };
  }

  _updateTheme(theme) {
    const newTheme = this._buildTheme();
    for (const [, entry] of this.terminals) {
      try {
        entry.terminal.options.theme = newTheme;
      } catch { /* ignore */ }
    }
  }
}
