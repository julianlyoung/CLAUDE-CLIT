'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pty = require('node-pty');

const RING_BUFFER_SIZE = 5000;
const SESSIONS_SAVE_DEBOUNCE = 1000;
const STATE_SILENCE_THRESHOLD = 2000; // 2s silence = ready

// ANSI escape sequence stripper
function stripAnsi(str) {
  return str.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

// State detection patterns
const READY_PATTERNS = [
  /❯\s{2,}/,                         // Claude Code prompt "❯" followed by whitespace (idle)
  /^\s*>\s*$/m,                      // Claude Code prompt ">" alone on a line
  /\$\s*$/m,                         // Shell prompt "$"
  /What would you like to do\?/,
  /How can I help/,
  /waiting for your/i,
];
const WAITING_PATTERNS = [
  /Do you want to proceed/i,
  /\(y\/n\)/i,
  /\[Y\/n\]/i,
  /\[y\/N\]/i,
  /Press Enter to continue/i,
  /Are you sure/i,
  /Allow once/i,
  /Allow always/i,
];
// Noise patterns — spinner animations that should NOT reset state to working
const NOISE_PATTERNS = [
  /^[✢✶✻✽·*]?\s?\w+…/,              // Any spinner word ending in … (✶ Hyperspacing…, Channeling…, etc.)
  /^[✢✶✻✽·*]\s*$/,                   // Single spinner character (with optional trailing space)
  /^0;[⠐⠂✳⠈⠠⠄⠁]\s/,                // Terminal title updates (spinner in title)
  /running stop hook/i,              // Hook execution notice
  /^\d+ MCP server/,                 // MCP server status
  /You've used \d+% of/,            // Usage limit notice
];

class SessionManager {
  constructor(sessionsJsonPath) {
    this.sessionsJsonPath = sessionsJsonPath;
    this.sessions = new Map(); // id -> session
    this._saveTimer = null;
    this._broadcastFn = null; // Set by server: fn(sessionId, msg) or fn(msg)
  }

  setBroadcastFn(fn) {
    this._broadcastFn = fn;
  }

  createSession(projectConfig, sessionType, dangerouslySkipPermissions = false) {
    const id = crypto.randomUUID();

    // Determine launch command
    let cmd, args;
    const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';

    if (sessionType === 'plain-shell') {
      cmd = shell;
      args = [];
    } else if (sessionType === 'new-claude') {
      cmd = shell;
      args = dangerouslySkipPermissions
        ? ['-Command', 'claude --dangerously-skip-permissions']
        : ['-Command', 'claude'];
    } else if (sessionType === 'resume-claude') {
      cmd = shell;
      args = dangerouslySkipPermissions
        ? ['-Command', 'claude --resume --dangerously-skip-permissions']
        : ['-Command', 'claude --resume'];
    } else {
      throw new Error(`Unknown session type: ${sessionType}`);
    }

    const launchCommand = sessionType === 'plain-shell'
      ? shell
      : (args[1] || 'claude');

    // Validate cwd — fall back to home dir if path doesn't exist
    const requestedPath = projectConfig.path;
    let cwd = process.cwd();
    if (requestedPath) {
      if (fs.existsSync(requestedPath)) {
        cwd = requestedPath;
      } else {
        console.warn(`[SessionManager] Path "${requestedPath}" not found, falling back to home dir`);
        cwd = os.homedir();
      }
    }

    // Spawn PTY
    let ptyProcess;
    try {
      ptyProcess = pty.spawn(cmd, args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd,
        env: (() => {
          const env = { ...process.env, TERM: 'xterm-256color' };
          // Remove CLAUDECODE env var to prevent "nested session" detection
          delete env.CLAUDECODE;
          delete env.CLAUDE_CODE;
          return env;
        })(),
      });
    } catch (err) {
      console.error('[SessionManager] Failed to spawn PTY:', err.message);
      throw err;
    }

    const session = {
      id,
      projectName: projectConfig.name,
      projectPath: projectConfig.path,
      projectIcon: projectConfig.icon || '📁',
      projectColor: projectConfig.color || '#3498DB',
      label: projectConfig.name,
      launchCommand,
      sessionType,
      dangerouslySkipPermissions,
      state: 'ready',
      pty: ptyProcess,
      outputBuffer: [],
      createdAt: new Date().toISOString(),
      subscribers: new Set(),
      _stateTimer: null,
      _pendingState: null,
    };

    this.sessions.set(id, session);

    // PTY data handler
    ptyProcess.onData((data) => {
      this._handlePtyData(id, data);
    });

    // PTY exit handler
    ptyProcess.onExit(({ exitCode }) => {
      const s = this.sessions.get(id);
      if (!s) return;
      clearTimeout(s._stateTimer);
      s.state = 'dead';
      s.pty = null;
      this._broadcast({ type: 'session_state_changed', sessionId: id, state: 'dead' });
      this._scheduleSave();
      console.log(`[SessionManager] Session ${id} (${s.label}) exited with code ${exitCode}`);
    });

    this._scheduleSave();
    console.log(`[SessionManager] Created session ${id}: ${launchCommand} in ${projectConfig.path}`);
    return session;
  }

  _handlePtyData(sessionId, data) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Append raw chunks to ring buffer (preserve ANSI sequences intact)
    session.outputBuffer.push(data);
    if (session.outputBuffer.length > RING_BUFFER_SIZE) {
      session.outputBuffer.splice(0, session.outputBuffer.length - RING_BUFFER_SIZE);
    }

    // Broadcast to subscribers
    this._broadcastToSession(sessionId, {
      type: 'terminal_output',
      sessionId,
      data,
    });

    // State detection
    this._detectState(session, data);
  }

  _detectState(session, data) {
    if (session.state === 'dead') return;

    const stripped = stripAnsi(data);
    const trimmed = stripped.trim();

    // STATE DEBUG — set STATE_DEBUG=1 env var to enable, then check debug.log
    // To enable:  STATE_DEBUG=1 node server/index.js > debug.log 2>&1
    // To test:    send "say hello" to a terminal, wait for response, then send "how are you"
    // Look for:   READY match → Timer fired → working transition → READY match → Timer fired
    const DBG = process.env.STATE_DEBUG === '1';
    const preview = DBG ? trimmed.substring(0, 120).replace(/\n/g, '\\n').replace(/\r/g, '\\r') : '';
    if (DBG && trimmed.length > 0) {
      console.log(`[STATE-DBG] session=${session.id.substring(0,6)} state=${session.state} len=${trimmed.length} data="${preview}"`);
    }

    // Skip noise (spinner animations, title updates) — don't let them affect state
    const isNoise = NOISE_PATTERNS.some(p => p.test(trimmed));
    if (isNoise) {
      return;
    }

    // Check for waiting_input patterns first
    const isWaiting = WAITING_PATTERNS.some(p => p.test(stripped));
    // Check for ready patterns
    const isReady = READY_PATTERNS.some(p => p.test(stripped));

    if (isWaiting) {
      if (DBG) console.log(`[STATE-DBG] → WAITING match: ${WAITING_PATTERNS.find(p => p.test(stripped))}`);
      clearTimeout(session._stateTimer);
      session._stateTimer = setTimeout(() => {
        if (DBG) console.log(`[STATE-DBG] → Timer fired: waiting_input for ${session.id.substring(0,6)}`);
        this._setState(session, 'waiting_input');
      }, STATE_SILENCE_THRESHOLD);
      session._pendingState = 'waiting_input';
    } else if (isReady) {
      if (DBG) console.log(`[STATE-DBG] → READY match: ${READY_PATTERNS.find(p => p.test(stripped))}`);
      clearTimeout(session._stateTimer);
      session._pendingState = 'ready';
      session._stateTimer = setTimeout(() => {
        if (DBG) console.log(`[STATE-DBG] → Timer fired: ready for ${session.id.substring(0,6)}`);
        this._setState(session, 'ready');
      }, STATE_SILENCE_THRESHOLD);
    } else {
      if (trimmed.length > 0) {
        // If already ready/waiting, any real output means working again
        if (session.state === 'ready' || session.state === 'waiting_input') {
          if (DBG) console.log(`[STATE-DBG] → Was ${session.state}, real output → working. data="${preview}"`);
          clearTimeout(session._stateTimer);
          session._stateTimer = null;
          this._setState(session, 'working');
        } else if (session._stateTimer && trimmed.length < 15) {
          // While working with a pending ready timer, ignore short fragments (spinner debris)
          if (DBG) console.log(`[STATE-DBG] → IGNORED short fragment (timer preserved): "${preview}"`);
        } else {
          // Substantial output while working — cancel any pending ready timer
          if (DBG && session._stateTimer) console.log(`[STATE-DBG] → CANCELLED timer, back to working. data="${preview}"`);
          clearTimeout(session._stateTimer);
          session._stateTimer = null;
        }
      }
    }
  }

  _setState(session, newState) {
    if (session.state === newState) return;
    session.state = newState;
    this._broadcast({
      type: 'session_state_changed',
      sessionId: session.id,
      state: newState,
    });
  }

  killSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    clearTimeout(session._stateTimer);
    if (session.pty) {
      try { session.pty.kill(); } catch (e) { /* ignore */ }
    }
    session.state = 'dead';
    session.pty = null;
    this._broadcast({ type: 'session_state_changed', sessionId, state: 'dead' });
    this._scheduleSave();
  }

  writeToSession(sessionId, data) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.pty || session.state === 'dead') return;
    try {
      session.pty.write(data);
    } catch (e) {
      console.error(`[SessionManager] Write error for ${sessionId}:`, e.message);
    }
  }

  renameSession(sessionId, newLabel) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.label = newLabel;
    this._scheduleSave();
  }

  resizeSession(sessionId, cols, rows) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.pty || session.state === 'dead') return;
    try {
      session.pty.resize(cols, rows);
    } catch (e) {
      console.error(`[SessionManager] Resize error for ${sessionId}:`, e.message);
    }
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  getAllSessions() {
    return Array.from(this.sessions.values());
  }

  getOutputBuffer(sessionId) {
    const session = this.sessions.get(sessionId);
    return session ? session.outputBuffer : [];
  }

  addSubscriber(sessionId, ws) {
    const session = this.sessions.get(sessionId);
    if (session) session.subscribers.add(ws);
  }

  removeSubscriber(ws) {
    for (const session of this.sessions.values()) {
      session.subscribers.delete(ws);
    }
  }

  // Serialize sessions to JSON (no pty, no buffers, no subscribers)
  _toJSON() {
    return Array.from(this.sessions.values()).map(s => ({
      id: s.id,
      projectName: s.projectName,
      projectPath: s.projectPath,
      projectIcon: s.projectIcon,
      projectColor: s.projectColor,
      label: s.label,
      launchCommand: s.launchCommand,
      sessionType: s.sessionType,
      dangerouslySkipPermissions: s.dangerouslySkipPermissions,
      createdAt: s.createdAt,
      state: s.state,
    }));
  }

  _scheduleSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._saveSessions(), SESSIONS_SAVE_DEBOUNCE);
  }

  _saveSessions() {
    const data = JSON.stringify(this._toJSON(), null, 2);
    const tmpPath = this.sessionsJsonPath + '.tmp';
    try {
      fs.writeFileSync(tmpPath, data, 'utf8');
      fs.renameSync(tmpPath, this.sessionsJsonPath);
    } catch (err) {
      console.error('[SessionManager] Failed to save sessions.json:', err.message);
    }
  }

  static loadSessions(sessionsJsonPath) {
    try {
      const raw = fs.readFileSync(sessionsJsonPath, 'utf8');
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  _broadcast(msg) {
    if (this._broadcastFn) this._broadcastFn(msg);
  }

  _broadcastToSession(sessionId, msg) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const data = JSON.stringify(msg);
    for (const ws of session.subscribers) {
      try {
        if (ws.readyState === 1 /* OPEN */) ws.send(data);
      } catch (e) { /* ignore */ }
    }
  }

  getSessionsForClient() {
    return this.getAllSessions().map(s => ({
      id: s.id,
      projectName: s.projectName,
      projectPath: s.projectPath,
      projectIcon: s.projectIcon,
      projectColor: s.projectColor,
      label: s.label,
      launchCommand: s.launchCommand,
      sessionType: s.sessionType,
      dangerouslySkipPermissions: s.dangerouslySkipPermissions,
      state: s.state,
      createdAt: s.createdAt,
    }));
  }
}

module.exports = SessionManager;
