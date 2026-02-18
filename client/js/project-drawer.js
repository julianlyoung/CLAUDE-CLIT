/**
 * CLI Cockpit — Project Drawer (Deck Overlay)
 * Manages: deck overlay session card grid, session creation modal, theme picker
 */

export class ProjectDrawer {
  constructor({ emit, on, sessions, getConfig, send, showToast, setActiveSession, currentToken }) {
    this.emit = emit;
    this.on = on;
    this.sessions = sessions;
    this.getConfig = getConfig || (() => ({}));
    this.send = send;
    this.showToast = showToast;
    this.setActiveSession = setActiveSession || (() => {});
    this.currentToken = currentToken;

    this._deckOverlay = document.getElementById('deck-overlay');
    this._deckGrid = document.getElementById('deck-grid');
    this._createModal = document.getElementById('session-create-modal');
    this._projectSelectList = document.getElementById('project-select-list');
    this._cancelCreateBtn = document.getElementById('cancel-create-btn');
    this._confirmCreateBtn = document.getElementById('confirm-create-btn');
    this._dangerousFlag = document.getElementById('dangerous-flag-label');
    this._dangerousCheck = document.getElementById('dangerous-skip');

    this._selectedProject = null;
    this._selectedSessionType = 'new-claude';
    this._activeSessionId = null;
  }

  init() {
    // Listen for session updates → render deck grid + telemetry
    this.on('sessions:updated', (sessions) => {
      this._renderDeckGrid(sessions);
      this._updateTelemetry(sessions);
    });

    // Track active session
    this.on('session:active', (id) => {
      this._activeSessionId = id;
    });

    // Config updated — no-op, config used lazily
    this.on('config:updated', () => {});

    // Theme picker
    this.on('themes:updated', (themes) => this._renderThemePicker(themes));

    // Wire session type radios
    document.querySelectorAll('input[name="session-type"]').forEach(radio => {
      radio.addEventListener('change', () => {
        this._selectedSessionType = radio.value;
        this._updateDangerousVisibility();
      });
    });

    // Cancel create modal
    if (this._cancelCreateBtn) {
      this._cancelCreateBtn.addEventListener('click', () => this._hideCreateModal());
    }

    // Confirm create session
    if (this._confirmCreateBtn) {
      this._confirmCreateBtn.addEventListener('click', () => this._createSession());
    }
  }

  // ── Deck Grid Render ─────────────────────────────────────────────────────

  _renderDeckGrid(sessions) {
    const grid = this._deckGrid;
    if (!grid) return;
    grid.innerHTML = '';
    const sessionArr = Array.isArray(sessions) ? sessions : Array.from(sessions.values());

    sessionArr.forEach(session => {
      const card = document.createElement('div');
      card.className = 'deck-card' + (session.id === this._activeSessionId ? ' active-card' : '');

      // Header with color bar, icon, name, state dot
      const header = document.createElement('div');
      header.className = 'deck-card-header';
      header.innerHTML = `
        <div class="color-bar" style="background:${session.projectColor || '#3b82f6'}"></div>
        <span style="font-size:14px">${session.projectIcon || '\u{1F4C1}'}</span>
        <span style="font-size:11px;font-weight:600;letter-spacing:0.04em;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${session.label || session.projectName}</span>
        <span class="state-dot ${this._stateClass(session.state)}" style="width:7px;height:7px"></span>
      `;

      // Preview area (shows session type or status)
      const preview = document.createElement('div');
      preview.className = 'deck-card-preview';
      preview.textContent = session.sessionType + (session.state === 'dead' ? ' [exited]' : '');

      card.appendChild(header);
      card.appendChild(preview);

      // Click → switch to session and close deck
      card.addEventListener('click', () => {
        this.setActiveSession(session.id);
        this._closeDeck();
      });

      grid.appendChild(card);
    });

    // "New Session" card
    const newCard = document.createElement('div');
    newCard.className = 'deck-new-card';
    newCard.innerHTML = '<span style="font-size:22px;font-weight:300">+</span><span style="font-size:10px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase">New Session</span>';
    newCard.addEventListener('click', () => {
      this._closeDeck();
      this._showCreateModal();
    });
    grid.appendChild(newCard);
  }

  // ── Telemetry Update ─────────────────────────────────────────────────────

  _updateTelemetry(sessions) {
    const arr = Array.isArray(sessions) ? sessions : Array.from(sessions.values());
    const total = arr.length;
    const working = arr.filter(s => s.state === 'working').length;
    const ready = arr.filter(s => s.state === 'ready' || s.state === 'waiting_input').length;
    const dead = arr.filter(s => s.state === 'dead').length;

    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('telem-total', total);
    set('telem-working', working);
    set('telem-ready', ready);
    set('telem-dead', dead);
  }

  // ── State Class ──────────────────────────────────────────────────────────

  _stateClass(state) {
    switch (state) {
      case 'ready': return 'state-ready';
      case 'working': return 'state-working';
      case 'waiting_input': return 'state-waiting';
      case 'dead': return 'state-dead';
      default: return 'state-dead';
    }
  }

  // ── Deck Open/Close ──────────────────────────────────────────────────────

  _closeDeck() {
    this._deckOverlay?.classList.remove('open');
    document.getElementById('hud-top')?.classList.remove('deck-active');
  }

  // ── Create Modal ─────────────────────────────────────────────────────────

  _showCreateModal() {
    if (this._createModal) this._createModal.classList.remove('hidden');
    this._updateProjectList();
    this._selectedProject = null;
    this._selectedSessionType = 'new-claude';
    const defaultRadio = document.querySelector('input[name="session-type"][value="new-claude"]');
    if (defaultRadio) defaultRadio.checked = true;
    this._updateDangerousVisibility();
  }

  _hideCreateModal() {
    if (this._createModal) this._createModal.classList.add('hidden');
    this._selectedProject = null;
  }

  // ── Project List ─────────────────────────────────────────────────────────

  _updateProjectList() {
    if (!this._projectSelectList) return;
    this._projectSelectList.innerHTML = '';

    const configProjects = (this.getConfig() || {}).projects || [];

    if (configProjects.length === 0) {
      this._projectSelectList.innerHTML = '<p class="text-xs text-text-muted">No projects configured. Add one in the Config panel (desktop) or edit config.json.</p>';
      return;
    }

    configProjects.forEach(p => {
      const item = document.createElement('div');
      item.className = 'flex items-center gap-2.5 px-3 py-2 rounded-lg cursor-pointer border border-border hover:bg-surface-hover transition-all duration-150';
      item.innerHTML = `<span class="text-base">${p.icon || '\u{1F4C1}'}</span><div><div class="text-[13px] font-medium">${p.name}</div><div class="text-[11px] text-text-muted">${p.path}</div></div>`;
      item.addEventListener('click', () => {
        this._selectedProject = p;
        this._projectSelectList.querySelectorAll('div[class*="border"]').forEach(el => {
          el.classList.remove('border-accent', 'bg-accent/10');
          el.classList.add('border-border');
        });
        item.classList.remove('border-border');
        item.classList.add('border-accent', 'bg-accent/10');
      });
      this._projectSelectList.appendChild(item);
    });
  }

  // ── Dangerous Visibility ─────────────────────────────────────────────────

  _updateDangerousVisibility() {
    if (!this._dangerousFlag) return;
    const isClaudeType = this._selectedSessionType !== 'plain-shell';
    this._dangerousFlag.style.display = isClaudeType ? '' : 'none';
  }

  // ── Create Session ───────────────────────────────────────────────────────

  _createSession() {
    if (!this._selectedProject) {
      this.showToast('Select a project first', 'error');
      return;
    }
    this.send({
      type: 'session_create',
      projectName: this._selectedProject.name,
      sessionType: this._selectedSessionType || 'new-claude',
      dangerouslySkipPermissions: !!(this._dangerousCheck?.checked),
    });
    this._hideCreateModal();
  }

  // ── Theme Picker ─────────────────────────────────────────────────────────

  _renderThemePicker(themes) {
    const picker = document.getElementById('theme-picker');
    if (!picker) return;
    picker.innerHTML = '';

    const currentThemeId = localStorage.getItem('clit.ui.theme') || 'default';

    themes.forEach(theme => {
      const card = document.createElement('div');
      card.className = [
        'cursor-pointer text-center rounded-lg p-1 border-2 transition-all duration-200',
        theme.id === currentThemeId ? 'border-accent' : 'border-transparent hover:border-white/10',
      ].join(' ');

      const swatch = document.createElement('div');
      swatch.className = 'w-full h-12 rounded-md flex flex-wrap gap-1 p-1.5 items-center justify-center relative overflow-hidden';
      swatch.style.background = theme.colors?.['--bg'] || '#1A1A2E';

      const dotColors = [
        theme.colors?.['--accent'] || '#3498DB',
        theme.colors?.['--ready'] || '#2ECC71',
        theme.colors?.['--working'] || '#F39C12',
        theme.colors?.['--text'] || '#E0E0E0',
      ];
      dotColors.forEach(color => {
        const dot = document.createElement('div');
        dot.className = 'w-2.5 h-2.5 rounded-full';
        dot.style.background = color;
        swatch.appendChild(dot);
      });

      // Checkmark for active theme
      if (theme.id === currentThemeId) {
        const check = document.createElement('span');
        check.className = 'absolute top-0.5 right-1 text-[10px] text-accent';
        check.textContent = '\u2713';
        swatch.appendChild(check);
      }

      const name = document.createElement('div');
      name.className = 'text-[10px] text-text-muted mt-1 whitespace-nowrap overflow-hidden text-ellipsis';
      name.textContent = theme.name;

      card.appendChild(swatch);
      card.appendChild(name);

      card.addEventListener('click', () => {
        import('./app.js').then(({ applyTheme, resetToDefaultTheme }) => {
          if (theme.id === 'default') {
            resetToDefaultTheme();
          } else {
            applyTheme(theme);
          }
          // Update active state
          picker.querySelectorAll('div[class*="border-2"]').forEach(c => {
            c.classList.remove('border-accent');
            c.classList.add('border-transparent');
          });
          card.classList.remove('border-transparent');
          card.classList.add('border-accent');
        });
      });

      picker.appendChild(card);
    });
  }
}
