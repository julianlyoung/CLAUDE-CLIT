/**
 * CLI Cockpit — Light Bar (Glass Bridge v2)
 * Renders session pills into the HUD top bar with glass bridge aesthetic.
 * Oxanium font styling, state dots, tap/slide/long-press interactions.
 */

export class LightBar {
  constructor({ emit, on, sessions, setActiveSession, send }) {
    this.emit = emit;
    this.on = on;
    this.sessions = sessions;
    this.setActiveSession = setActiveSession;
    this.send = send;

    this._container = document.getElementById('dot-container');
    this._activeId = null;
    this._longPressTimer = null;
    this._longPressSessionId = null;
    this._touchStartX = null;
    this._touchStartY = null;
    this._isSliding = false;
    this._quickMenuSessionId = null;
  }

  init() {
    this.on('sessions:updated', (sessions) => this._render(sessions));
    this.on('session:active', (id) => {
      this._activeId = id;
      this._updateActivePill(id);
    });
    this.on('session:state', ({ sessionId, state }) => {
      this._handleStateChange(sessionId, state);
    });

    // Rename modal wiring
    const renameModal = document.getElementById('rename-modal');
    const renameInput = document.getElementById('rename-input');
    const renameCancel = document.getElementById('rename-cancel');
    const renameSave = document.getElementById('rename-save');

    if (renameCancel) {
      renameCancel.addEventListener('click', () => {
        renameModal.classList.add('hidden');
      });
    }
    if (renameSave) {
      renameSave.addEventListener('click', () => {
        const newLabel = renameInput.value.trim();
        if (newLabel && this._quickMenuSessionId) {
          this.send({ type: 'session_rename', sessionId: this._quickMenuSessionId, newLabel });
        }
        renameModal.classList.add('hidden');
      });
    }

    // Quick menu wiring
    const quickMenu = document.getElementById('quick-menu');
    if (quickMenu) {
      quickMenu.querySelectorAll('button[data-action]').forEach(btn => {
        btn.addEventListener('click', () => {
          this._handleQuickAction(btn.dataset.action);
          quickMenu.classList.add('hidden');
        });
      });
    }

    // Close quick menu on outside click
    document.addEventListener('click', (e) => {
      const qm = document.getElementById('quick-menu');
      if (qm && !qm.contains(e.target)) {
        qm.classList.add('hidden');
      }
    });
  }

  // ── Render ──────────────────────────────────────────────────────────────

  _render(sessions) {
    const container = this._container;
    if (!container) return;
    container.innerHTML = '';

    const sessionArr = Array.isArray(sessions) ? sessions : Array.from(sessions.values());

    sessionArr.forEach(session => {
      const isActive = session.id === this._activeId;

      const pill = document.createElement('button');
      pill.className = 'session-pill' + (isActive ? ' active' : '');
      pill.dataset.sessionId = session.id;

      // Icon span
      const icon = document.createElement('span');
      icon.style.fontSize = '13px';
      icon.style.lineHeight = '1';
      icon.textContent = session.projectIcon || '\u{1F4C1}';

      // State dot
      const stateDot = document.createElement('span');
      stateDot.className = 'state-dot ' + this._stateClass(session.state);
      stateDot.dataset.sessionId = session.id;

      pill.appendChild(icon);
      pill.appendChild(stateDot);

      // Pointer events for tap, slide, long-press
      pill.addEventListener('pointerdown', (e) => this._onPointerDown(e, session));
      pill.addEventListener('pointermove', (e) => this._onPointerMove(e, session));
      pill.addEventListener('pointerup', (e) => this._onPointerUp(e, session));
      pill.addEventListener('pointercancel', () => this._cancelPress());
      pill.addEventListener('contextmenu', (e) => e.preventDefault());

      container.appendChild(pill);
    });
  }

  // ── State class mapping ─────────────────────────────────────────────────

  _stateClass(state) {
    switch (state) {
      case 'ready':         return 'state-ready';
      case 'working':       return 'state-working';
      case 'waiting_input': return 'state-waiting';
      case 'dead':          return 'state-dead';
      default:              return 'state-dead';
    }
  }

  // ── Active pill update ──────────────────────────────────────────────────

  _updateActivePill(id) {
    const container = this._container;
    if (!container) return;

    container.querySelectorAll('.session-pill').forEach(pill => {
      if (pill.dataset.sessionId === id) {
        pill.classList.add('active');
      } else {
        pill.classList.remove('active');
      }
    });
  }

  // ── State change handling ───────────────────────────────────────────────

  _handleStateChange(sessionId, newState) {
    const container = this._container;
    if (!container) return;

    // Find state dot by data-session-id (the span inside the pill)
    const stateDot = container.querySelector(`span.state-dot[data-session-id="${sessionId}"]`);
    if (!stateDot) return;

    // Update state class
    stateDot.className = 'state-dot ' + this._stateClass(newState);
    stateDot.dataset.sessionId = sessionId;

    // Trigger ping animation for non-active sessions
    if (sessionId !== this._activeId) {
      stateDot.classList.remove('animate-ping-dot');
      void stateDot.offsetWidth; // Force reflow to restart animation
      stateDot.classList.add('animate-ping-dot');
      setTimeout(() => stateDot.classList.remove('animate-ping-dot'), 600);
    }
  }

  // ── Pointer events (tap / slide / long-press) ──────────────────────────

  _onPointerDown(e, session) {
    e.preventDefault();
    this._touchStartX = e.clientX;
    this._touchStartY = e.clientY;
    this._isSliding = false;

    this._longPressTimer = setTimeout(() => {
      this._longPressSessionId = session.id;
      this._showQuickMenu(e, session);
    }, 500);
  }

  _onPointerMove(e, session) {
    if (this._touchStartX == null) return;

    const dx = Math.abs(e.clientX - this._touchStartX);
    const dy = Math.abs(e.clientY - this._touchStartY);
    const moved = Math.sqrt(dx * dx + dy * dy);

    if (moved > 8) {
      clearTimeout(this._longPressTimer);
      this._isSliding = true;
    }

    // While sliding, switch sessions on hover over other pills
    if (this._isSliding) {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const pill = el?.closest('[data-session-id]');
      if (pill && pill.dataset.sessionId !== this._activeId) {
        const newId = pill.dataset.sessionId;
        this.setActiveSession(newId);
        try { navigator.vibrate(20); } catch (_) { /* ignore */ }
      }
    }
  }

  _onPointerUp(e, session) {
    clearTimeout(this._longPressTimer);

    const dx = Math.abs(e.clientX - (this._touchStartX || 0));
    const dy = Math.abs(e.clientY - (this._touchStartY || 0));
    const moved = Math.sqrt(dx * dx + dy * dy);

    // Simple tap — switch to this session
    if (!this._isSliding && moved < 8) {
      this.setActiveSession(session.id);
    }

    this._touchStartX = null;
    this._touchStartY = null;
    this._isSliding = false;
  }

  _cancelPress() {
    clearTimeout(this._longPressTimer);
    this._isSliding = false;
    this._touchStartX = null;
    this._touchStartY = null;
  }

  // ── Quick menu ──────────────────────────────────────────────────────────

  _showQuickMenu(e, session) {
    const quickMenu = document.getElementById('quick-menu');
    if (!quickMenu) return;

    this._quickMenuSessionId = session.id;

    // Show/hide "Resume Claude" button based on session type
    const resumeBtn = quickMenu.querySelector('[data-action="resume"]');
    if (resumeBtn) {
      resumeBtn.style.display = session.sessionType === 'plain-shell' ? 'none' : '';
    }

    quickMenu.classList.remove('hidden');

    // Position near the pill
    const rect = e.target.getBoundingClientRect();
    const menuW = 160;
    const menuH = 160;
    let left = rect.left + rect.width / 2 - menuW / 2;
    let top = rect.bottom + 8;

    // Clamp to viewport
    left = Math.max(8, Math.min(left, window.innerWidth - menuW - 8));
    if (top + menuH > window.innerHeight) {
      top = rect.top - menuH - 8;
    }

    quickMenu.style.left = `${left}px`;
    quickMenu.style.top = `${top}px`;
  }

  // ── Quick actions ───────────────────────────────────────────────────────

  _handleQuickAction(action) {
    const sessionId = this._quickMenuSessionId;
    if (!sessionId) return;

    const session = this.sessions.get(sessionId);

    switch (action) {
      case 'restart': {
        if (session) {
          this.send({ type: 'session_kill', sessionId });
          setTimeout(() => {
            this.send({
              type: 'session_create',
              projectName: session.projectName,
              sessionType: session.sessionType,
              dangerouslySkipPermissions: session.dangerouslySkipPermissions,
            });
          }, 500);
        }
        break;
      }
      case 'resume': {
        if (session) {
          this.send({
            type: 'session_create',
            projectName: session.projectName,
            sessionType: 'resume-claude',
            dangerouslySkipPermissions: session.dangerouslySkipPermissions,
          });
        }
        break;
      }
      case 'kill': {
        this.send({ type: 'session_kill', sessionId });
        break;
      }
      case 'rename': {
        const renameModal = document.getElementById('rename-modal');
        const renameInput = document.getElementById('rename-input');
        if (renameModal && renameInput) {
          renameInput.value = session?.label || '';
          renameModal.classList.remove('hidden');
          renameInput.focus();
          renameInput.select();
        }
        break;
      }
      default:
        break;
    }
  }
}
