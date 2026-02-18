/**
 * CLI Cockpit — Main App Module (Glass Bridge v2)
 * WebSocket client, authentication, state management, event bus,
 * glass bridge UI (edge glow, status badge, quick keys, deck, swipe gestures)
 */

import { LightBar } from './light-bar.js';
import { TerminalManager } from './terminal.js';
import { VoiceInput } from './voice-input.js';
import { ProjectDrawer } from './project-drawer.js';

// ── Event Bus ─────────────────────────────────────────────────────────────
const listeners = new Map();

function emit(event, data) {
  const handlers = listeners.get(event) || [];
  handlers.forEach(fn => {
    try { fn(data); } catch (err) { console.error(`[EventBus] Error in handler for "${event}":`, err); }
  });
}

function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, []);
  listeners.get(event).push(fn);
  return () => off(event, fn);
}

function off(event, fn) {
  const handlers = listeners.get(event) || [];
  const idx = handlers.indexOf(fn);
  if (idx !== -1) handlers.splice(idx, 1);
}

// ── Completion Sound ─────────────────────────────────────────────────────
const BUNDLED_SOUNDS = [
  { id: 'click', name: 'Claude Click', src: '/static/sounds/click.wav' },
  { id: 'achievement-bell', name: 'Achievement Bell', src: '/static/sounds/achievement-bell.wav' },
  { id: 'confirmation-tone', name: 'Confirmation Tone', src: '/static/sounds/confirmation-tone.wav' },
  { id: 'retro-game', name: 'Retro Game', src: '/static/sounds/retro-game-notification.wav' },
  { id: 'arcade-bonus', name: 'Arcade Bonus', src: '/static/sounds/arcade-bonus-alert.wav' },
  { id: 'quick-win', name: 'Quick Win', src: '/static/sounds/quick-win-video-game-notification.wav' },
  { id: 'coin-win', name: 'Coin Win', src: '/static/sounds/coin-win-notification.wav' },
  { id: 'video-game-win', name: 'Video Game Win', src: '/static/sounds/video-game-win.wav' },
  { id: 'melodic-bonus', name: 'Melodic Bonus', src: '/static/sounds/melodic-bonus-collect.wav' },
  { id: 'fairy-sparkle', name: 'Fairy Sparkle', src: '/static/sounds/fairy-arcade-sparkle.wav' },
  { id: 'sci-fi', name: 'Sci-Fi Confirm', src: '/static/sounds/sci-fi-confirmation.wav' },
  { id: 'bubble-pop', name: 'Bubble Pop', src: '/static/sounds/bubble-pop-up-alert-notification.wav' },
  { id: 'chime', name: 'Synth Chime', src: null },  // Web Audio API generated
  { id: 'none', name: 'Silent', src: null },
];

let audioCtx = null;
let cachedAudio = null;
let cachedSoundId = null;

function getSelectedSound() {
  return localStorage.getItem('clit.ui.sound') || 'chime';
}

function playCompletionBeep() {
  const soundId = getSelectedSound();
  if (soundId === 'none') return;

  if (soundId === 'chime') {
    playSynthChime();
    return;
  }

  // Check for custom uploaded sound
  if (soundId === 'custom') {
    const dataUrl = localStorage.getItem('clit.ui.sound.custom');
    if (dataUrl) {
      try { new Audio(dataUrl).play(); } catch { /* ignore */ }
    }
    return;
  }

  // Bundled sound file
  const entry = BUNDLED_SOUNDS.find(s => s.id === soundId);
  if (!entry || !entry.src) return;

  try {
    // Reuse cached Audio object for same sound (better mobile performance)
    if (cachedSoundId !== soundId || !cachedAudio) {
      cachedAudio = new Audio(entry.src);
      cachedSoundId = soundId;
    }
    cachedAudio.currentTime = 0;
    cachedAudio.play();
  } catch { /* ignore audio errors */ }
}

function previewSound(soundId) {
  if (soundId === 'none') return;
  if (soundId === 'chime') { playSynthChime(); return; }
  if (soundId === 'custom') {
    const dataUrl = localStorage.getItem('clit.ui.sound.custom');
    if (dataUrl) try { new Audio(dataUrl).play(); } catch { /* ignore */ }
    return;
  }
  const entry = BUNDLED_SOUNDS.find(s => s.id === soundId);
  if (entry && entry.src) {
    try { const a = new Audio(entry.src); a.play(); } catch { /* ignore */ }
  }
}

function playSynthChime() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const now = audioCtx.currentTime;
    [523.25, 659.25].forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now + i * 0.12);
      gain.gain.linearRampToValueAtTime(0.15, now + i * 0.12 + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.12 + 0.5);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(now + i * 0.12);
      osc.stop(now + i * 0.12 + 0.5);
    });
  } catch { /* ignore */ }
}

// ── App State ─────────────────────────────────────────────────────────────
export const sessions = new Map();   // id → session object
export let activeSessionId = null;
export let config = {};
export let themes = [];

let ws = null;
let wsReconnectDelay = 1000;
let wsReconnectTimer = null;
let currentToken = null;
let hasCheckedRecovery = false;

// ── Session Helpers ───────────────────────────────────────────────────────
export function setActiveSession(id) {
  activeSessionId = id;
  emit('session:active', id);
  // Update glass bridge HUD for new active session
  const s = sessions.get(id);
  if (s) {
    updateEdgeGlow(s.state);
    updateStatusBadge(s.state);
  }
  // Subscribe if not already
  if (id && ws && ws.readyState === WebSocket.OPEN) {
    send({ type: 'session_subscribe', sessionId: id });
  }
}

export function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ── PIN Login ─────────────────────────────────────────────────────────────
const loginScreen = document.getElementById('login-screen');
const appEl = document.getElementById('app');
const loginError = document.getElementById('login-error');

let pinBuffer = [];

function setupPinKeypad() {
  document.querySelectorAll('.pin-key').forEach(btn => {
    btn.addEventListener('click', () => {
      const digit = btn.dataset.digit;
      if (digit === 'back') {
        pinBuffer.pop();
      } else if (digit === 'clear') {
        pinBuffer = [];
      } else if (pinBuffer.length < 4) {
        pinBuffer.push(digit);
        if (pinBuffer.length === 4) submitPin();
      }
      updatePinDots();
    });
  });

  // Keyboard support for PIN entry
  document.addEventListener('keydown', (e) => {
    if (loginScreen.classList.contains('hidden')) return;
    if (e.key >= '0' && e.key <= '9' && pinBuffer.length < 4) {
      pinBuffer.push(e.key);
      if (pinBuffer.length === 4) submitPin();
      updatePinDots();
    } else if (e.key === 'Backspace') {
      pinBuffer.pop();
      updatePinDots();
    } else if (e.key === 'Escape') {
      pinBuffer = [];
      updatePinDots();
    }
  });
}

function updatePinDots() {
  for (let i = 0; i < 4; i++) {
    const dot = document.getElementById(`pin-dot-${i}`);
    if (dot) dot.classList.toggle('filled', i < pinBuffer.length);
  }
}

async function submitPin() {
  const pin = pinBuffer.join('');
  pinBuffer = [];
  updatePinDots();
  loginError.textContent = '';

  try {
    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    const data = await res.json();
    if (!res.ok) {
      loginError.textContent = data.error || 'Invalid PIN';
      return;
    }
    currentToken = data.token;
    sessionStorage.setItem('clit.token', currentToken);
    showApp();
  } catch (err) {
    loginError.textContent = 'Connection error. Is the server running?';
  }
}

function showApp() {
  loginScreen.classList.add('hidden');
  appEl.classList.remove('hidden');
  connectWebSocket();
  applyLayout();
}

// ── Auth check on load ────────────────────────────────────────────────────
async function init() {
  setupPinKeypad();
  applyLayout();

  const stored = sessionStorage.getItem('clit.token');
  if (stored) {
    // Try to connect with stored token; if it fails, show login
    currentToken = stored;
    connectWebSocket();
  } else {
    // Try no-auth first (server with no PIN)
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '' }),
      });
      if (res.ok) {
        const data = await res.json();
        currentToken = data.token;
        sessionStorage.setItem('clit.token', currentToken);
        showApp();
        return;
      }
    } catch { /* ignore */ }
    // Show login screen
    loginScreen.classList.remove('hidden');
  }
}

// ── WebSocket ─────────────────────────────────────────────────────────────
function connectWebSocket() {
  appEl.classList.remove('hidden');
  loginScreen.classList.add('hidden');

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${location.host}/ws?token=${currentToken || ''}`;

  ws = new WebSocket(url);

  ws.onopen = () => {
    console.log('[WS] Connected');
    wsReconnectDelay = 1000;
    clearTimeout(wsReconnectTimer);
  };

  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    handleMessage(msg);
  };

  ws.onclose = (event) => {
    console.log('[WS] Closed', event.code, event.reason);
    if (event.code === 4001) {
      // Auth failure — show login
      sessionStorage.removeItem('clit.token');
      currentToken = null;
      appEl.classList.add('hidden');
      loginScreen.classList.remove('hidden');
      loginError.textContent = 'Session expired. Please re-enter PIN.';
      return;
    }
    scheduleReconnect();
  };

  ws.onerror = (err) => {
    console.error('[WS] Error', err);
  };
}

function scheduleReconnect() {
  clearTimeout(wsReconnectTimer);
  wsReconnectTimer = setTimeout(() => {
    console.log(`[WS] Reconnecting (delay: ${wsReconnectDelay}ms)…`);
    connectWebSocket();
    wsReconnectDelay = Math.min(wsReconnectDelay * 2, 30000);
  }, wsReconnectDelay);
}

// ── Visibility-based instant reconnect ────────────────────────────────────
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && ws) {
    // If WS is closed/closing, reconnect immediately (no backoff delay)
    if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      console.log('[WS] App foregrounded — reconnecting immediately');
      clearTimeout(wsReconnectTimer);
      wsReconnectDelay = 1000;
      connectWebSocket();
    }
  }
});

// ── Client-side keepalive ping ───────────────────────────────────────────
// Send a lightweight message every 25s to prevent idle timeout
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ping' }));
  }
}, 25000);

// ── Message Dispatch ──────────────────────────────────────────────────────
function handleMessage(msg) {
  switch (msg.type) {
    case 'sessions_list': {
      sessions.clear();
      for (const s of msg.sessions) sessions.set(s.id, s);
      if (msg.config) {
        config = msg.config;
        document.title = 'CLAUDE CLIT';
      }
      if (msg.themes) themes = msg.themes;
      emit('sessions:updated', Array.from(sessions.values()));
      emit('themes:updated', themes);

      // Auto-select first session if none active
      if (!activeSessionId && sessions.size > 0) {
        setActiveSession(sessions.keys().next().value);
      }

      // Check recovery only on first connect
      if (!hasCheckedRecovery) {
        hasCheckedRecovery = true;
        checkRecovery();
      }
      break;
    }

    case 'terminal_output': {
      emit(`output:${msg.sessionId}`, msg.data);
      break;
    }

    case 'session_buffer': {
      emit(`buffer:${msg.sessionId}`, msg.data);
      break;
    }

    case 'session_state_changed': {
      const s = sessions.get(msg.sessionId);
      if (s) {
        const prevState = s.state;
        s.state = msg.state;
        // Gentle beep when a session finishes work (working → ready)
        if (prevState === 'working' && msg.state === 'ready') {
          playCompletionBeep();
        }
        emit('session:state', { sessionId: msg.sessionId, state: msg.state });
        emit('sessions:updated', Array.from(sessions.values()));
      }
      break;
    }

    case 'session_created': {
      sessions.set(msg.session.id, msg.session);
      emit('sessions:updated', Array.from(sessions.values()));
      // Auto-switch to new session
      setActiveSession(msg.session.id);
      break;
    }

    case 'session_killed': {
      sessions.delete(msg.sessionId);
      emit('session:removed', msg.sessionId);
      emit('sessions:updated', Array.from(sessions.values()));
      // If the killed session was active, switch to another
      if (activeSessionId === msg.sessionId) {
        const next = sessions.keys().next().value || null;
        setActiveSession(next);
      }
      break;
    }

    case 'session_updated': {
      const s = sessions.get(msg.sessionId);
      if (s && msg.label !== undefined) s.label = msg.label;
      emit('sessions:updated', Array.from(sessions.values()));
      break;
    }

    case 'config_updated': {
      if (msg.config) {
        config = { ...config, ...msg.config };
        document.title = 'CLAUDE CLIT';
      }
      if (msg.themes) themes = msg.themes;
      emit('config:updated', config);
      emit('themes:updated', themes);
      break;
    }

    case 'error': {
      console.error('[Server error]', msg.message);
      showToast(msg.message, 'error');
      break;
    }

    default:
      break;
  }
}

// ── Recovery ──────────────────────────────────────────────────────────────
async function checkRecovery() {
  try {
    const res = await fetch('/api/recovery', {
      headers: { Authorization: `Bearer ${currentToken}` },
    });
    if (!res.ok) return;
    const recovered = await res.json();
    if (recovered && recovered.length > 0) {
      emit('recovery:available', recovered);
    }
  } catch { /* ignore */ }
}

// ── Layout ────────────────────────────────────────────────────────────────
const mq = window.matchMedia('(min-width: 900px)');

function applyLayout() {
  document.body.classList.toggle('layout--desktop', mq.matches);
  document.body.classList.toggle('layout--mobile', !mq.matches);
}

mq.addEventListener('change', applyLayout);

// ── Theme system ──────────────────────────────────────────────────────────
export function applyTheme(theme) {
  if (!theme) return;
  for (const [key, val] of Object.entries(theme.colors || {})) {
    document.documentElement.style.setProperty(key, val);
  }
  localStorage.setItem('clit.ui.theme', theme.id);
  emit('theme:applied', theme);
}

export function resetToDefaultTheme() {
  const defaultVars = [
    '--bg','--bg-deep','--bg-surface','--text','--text-muted','--border',
    '--accent','--ready','--working','--dead','--error','--surface-hover','--surface-active',
  ];
  defaultVars.forEach(v => document.documentElement.style.removeProperty(v));
  localStorage.setItem('clit.ui.theme', 'default');
}

on('themes:updated', (allThemes) => {
  const storedId = localStorage.getItem('clit.ui.theme') || 'default';
  const theme = allThemes.find(t => t.id === storedId);
  if (theme && theme.id !== 'default') applyTheme(theme);
});

// ── Sound Picker ─────────────────────────────────────────────────────────
function setupSoundPicker() {
  const picker = document.getElementById('sound-picker');
  const uploadInput = document.getElementById('custom-sound-upload');
  const uploadBtn = document.getElementById('upload-sound-btn');
  const customName = document.getElementById('custom-sound-name');
  if (!picker) return;

  function render() {
    const current = getSelectedSound();
    const hasCustom = !!localStorage.getItem('clit.ui.sound.custom');
    const allSounds = [...BUNDLED_SOUNDS];
    if (hasCustom) allSounds.push({ id: 'custom', name: localStorage.getItem('clit.ui.sound.custom.name') || 'Custom', src: null });

    picker.innerHTML = '';
    allSounds.forEach(s => {
      const isActive = current === s.id;
      const row = document.createElement('div');
      row.className = [
        'flex items-center gap-1 rounded-md border overflow-hidden transition-colors duration-150',
        isActive ? 'border-accent bg-accent/10' : 'border-border bg-bg-surface hover:border-white/15',
      ].join(' ');

      const selectBtn = document.createElement('button');
      selectBtn.className = [
        'flex-1 px-2.5 py-1.5 text-left text-xs cursor-pointer bg-transparent border-none',
        isActive ? 'text-accent' : 'text-text',
      ].join(' ');
      selectBtn.textContent = s.name;
      selectBtn.addEventListener('click', () => {
        localStorage.setItem('clit.ui.sound', s.id);
        render();
      });

      row.appendChild(selectBtn);

      if (s.id !== 'none') {
        const playBtn = document.createElement('button');
        playBtn.className = 'px-2.5 py-1.5 border-l border-border text-text-muted text-[11px] hover:text-accent cursor-pointer bg-transparent transition-colors duration-150';
        playBtn.textContent = '\u25B6';
        playBtn.title = 'Preview';
        playBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          previewSound(s.id);
        });
        row.appendChild(playBtn);
      }

      picker.appendChild(row);
    });

    if (customName) {
      const name = localStorage.getItem('clit.ui.sound.custom.name');
      customName.textContent = name ? name : '';
    }
  }

  if (uploadBtn && uploadInput) {
    uploadBtn.addEventListener('click', () => uploadInput.click());
    uploadInput.addEventListener('change', () => {
      const file = uploadInput.files[0];
      if (!file) return;
      if (file.size > 500 * 1024) {
        showToast('Sound file must be under 500KB', 'error');
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        localStorage.setItem('clit.ui.sound.custom', reader.result);
        localStorage.setItem('clit.ui.sound.custom.name', file.name);
        localStorage.setItem('clit.ui.sound', 'custom');
        render();
        playCompletionBeep();
      };
      reader.readAsDataURL(file);
    });
  }

  render();
}

// ── Toast notifications ───────────────────────────────────────────────────
export function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = 'toast fixed bottom-6 left-1/2 -translate-x-1/2 bg-bg-surface border border-border rounded-lg px-4 py-2 text-[13px] z-[3000]';
  toast.textContent = message;
  if (type === 'error') toast.style.borderColor = 'var(--error)';
  if (type === 'success') toast.style.borderColor = 'var(--ready)';
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}

// ── Settings panel ────────────────────────────────────────────────────────
const settingsBtn = document.getElementById('settings-btn');
const settingsPanel = document.getElementById('settings-panel');
const settingsClose = document.getElementById('settings-close');
const panelOverlay = document.getElementById('panel-overlay');

if (settingsBtn) {
  settingsBtn.addEventListener('click', () => {
    settingsPanel.classList.toggle('open');
    panelOverlay.classList.toggle('hidden', !settingsPanel.classList.contains('open'));
  });
}
if (settingsClose) {
  settingsClose.addEventListener('click', () => {
    settingsPanel.classList.remove('open');
    panelOverlay.classList.add('hidden');
  });
}
if (panelOverlay) {
  panelOverlay.addEventListener('click', () => {
    settingsPanel.classList.remove('open');
    panelOverlay.classList.add('hidden');
  });
}

// ── Model dropdown (global close on outside click) ───────────────────────
document.addEventListener('click', (e) => {
  const modelBtn = document.getElementById('model-btn');
  const modelDropdown = document.getElementById('model-dropdown');
  if (!modelBtn || !modelDropdown) return;
  if (!modelBtn.contains(e.target) && !modelDropdown.contains(e.target)) {
    modelDropdown.classList.add('hidden');
  }
});

// ── Glass Bridge: Edge Glow ───────────────────────────────────────────────
function updateEdgeGlow(state) {
  const el = document.getElementById('edge-glow');
  if (el) el.dataset.state = state || '';
}

on('session:state', ({ sessionId, state }) => {
  if (sessionId === activeSessionId) updateEdgeGlow(state);
});

on('session:active', (id) => {
  const s = sessions.get(id);
  if (s) updateEdgeGlow(s.state);
});

// ── Glass Bridge: Status Badge ────────────────────────────────────────────
function updateStatusBadge(state) {
  const badge = document.getElementById('status-badge');
  const text = document.getElementById('status-text');
  if (badge) badge.dataset.state = state || '';
  if (text) text.textContent = (state || '').toUpperCase().replace('_', ' ');
}

on('session:state', ({ sessionId, state }) => {
  if (sessionId === activeSessionId) updateStatusBadge(state);
});

on('session:active', (id) => {
  const s = sessions.get(id);
  if (s) updateStatusBadge(s.state);
});

// ── Glass Bridge: Quick Keys ──────────────────────────────────────────────
const quickKeysBtn = document.getElementById('quick-keys-btn');
const quickKeys = document.getElementById('quick-keys');
let quickKeysVisible = false;

if (quickKeysBtn) {
  quickKeysBtn.addEventListener('click', () => {
    quickKeysVisible = !quickKeysVisible;
    quickKeys?.classList.toggle('visible', quickKeysVisible);
  });
}

// Wire quick key buttons — each .qk sends its data-key to the active session
document.querySelectorAll('.qk').forEach(btn => {
  btn.addEventListener('click', () => {
    const key = btn.dataset.key;
    if (key && activeSessionId) {
      send({ type: 'terminal_input', sessionId: activeSessionId, data: key });
    }
  });
});

// ── Glass Bridge: Deck Toggle ─────────────────────────────────────────────
const deckBtn = document.getElementById('deck-btn');
const drawerBtn = document.getElementById('drawer-btn');
const deckOverlay = document.getElementById('deck-overlay');
const deckClose = document.getElementById('deck-close');

function toggleDeck() {
  const open = deckOverlay?.classList.toggle('open');
  document.getElementById('hud-top')?.classList.toggle('deck-active', open);
  // Close quick keys when deck opens
  if (open && quickKeysVisible) {
    quickKeysVisible = false;
    quickKeys?.classList.remove('visible');
  }
}

deckBtn?.addEventListener('click', toggleDeck);
drawerBtn?.addEventListener('click', toggleDeck);
deckClose?.addEventListener('click', toggleDeck);

// ── Glass Bridge: Swipe Gestures on Terminal View ─────────────────────────
(function setupSwipeGestures() {
  const terminalView = document.getElementById('terminal-view');
  if (!terminalView) return;

  let touchStartX = 0;
  let touchStartY = 0;

  // Global touch listener for left-edge swipe to open deck
  document.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = Math.abs(e.changedTouches[0].clientY - touchStartY);
    // Left edge swipe (start within 20px of left edge, drag > 80px, mostly horizontal)
    if (touchStartX < 20 && dx > 80 && dy < 60 && !deckOverlay?.classList.contains('open')) {
      toggleDeck();
    }
  }, { passive: true });

  // Horizontal swipe on terminal viewport to switch sessions
  let swipeStartX = 0;

  terminalView.addEventListener('touchstart', (e) => {
    swipeStartX = e.touches[0].clientX;
  }, { passive: true });

  terminalView.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - swipeStartX;
    if (Math.abs(dx) < 60) return;

    const ids = Array.from(sessions.keys());
    if (ids.length < 2) return;
    const currentIdx = ids.indexOf(activeSessionId);
    if (currentIdx === -1) return;

    if (dx < -60 && currentIdx < ids.length - 1) {
      // Swipe left → next session
      setActiveSession(ids[currentIdx + 1]);
    } else if (dx > 60 && currentIdx > 0) {
      // Swipe right → previous session
      setActiveSession(ids[currentIdx - 1]);
    }
  }, { passive: true });
})();

// ── Service Worker ────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/static/sw.js').catch(() => {});
}

// ── Export event bus and public API ──────────────────────────────────────
export { emit, on, off };

// ── Initialize sub-modules ────────────────────────────────────────────────
const lightBar = new LightBar({ emit, on, sessions, setActiveSession, send });
const terminalMgr = new TerminalManager({ emit, on, sessions, send, showToast });
const voiceInput = new VoiceInput({ emit, on });
const projectDrawer = new ProjectDrawer({ emit, on, sessions, getConfig: () => config, send, showToast, setActiveSession, currentToken: () => currentToken });

lightBar.init();
terminalMgr.init();
voiceInput.init();
projectDrawer.init();

// ── Sound picker ─────────────────────────────────────────────────────────
setupSoundPicker();

// ── Config panel (desktop) ────────────────────────────────────────────────
setupConfigPanel();

function setupConfigPanel() {
  const projectList = document.getElementById('project-list');
  const addProjectBtn = document.getElementById('add-project-btn');
  const projectEditForm = document.getElementById('project-edit-form');
  const cancelEditBtn = document.getElementById('cancel-edit-btn');
  const saveProjectBtn = document.getElementById('save-project-btn');
  const deleteProjectBtn = document.getElementById('delete-project-btn');
  const configStatus = document.getElementById('config-status');

  function renderProjectList() {
    if (!projectList) return;
    const projects = config.projects || [];
    projectList.innerHTML = '';
    projects.forEach((p, idx) => {
      const card = document.createElement('div');
      card.className = 'flex items-center gap-2.5 px-3 py-2.5 rounded-lg border border-border bg-bg-deep relative';
      card.innerHTML = `
        <div class="w-[3px] h-full absolute left-0 top-0 rounded-l-lg" style="background:${p.color || '#3498DB'}"></div>
        <span class="text-lg">${p.icon || '\uD83D\uDCC1'}</span>
        <div class="flex-1 min-w-0">
          <div class="text-[13px] font-medium">${p.name}</div>
          <div class="text-[11px] text-text-muted overflow-hidden text-ellipsis whitespace-nowrap">${p.path}</div>
        </div>
        <div class="flex gap-1">
          <button data-edit="${idx}" class="px-2 py-1 text-[11px] border border-border rounded hover:bg-surface-hover transition-all duration-150 cursor-pointer">Edit</button>
        </div>
      `;
      card.querySelector('[data-edit]').addEventListener('click', () => openEditForm(idx));
      projectList.appendChild(card);
    });
  }

  function openEditForm(idx) {
    if (!projectEditForm) return;
    projectEditForm.classList.remove('hidden');
    const isNew = idx === -1;
    document.getElementById('edit-form-title').textContent = isNew ? 'Add Project' : 'Edit Project';
    document.getElementById('proj-edit-index').value = idx;
    document.getElementById('delete-project-btn').style.display = isNew ? 'none' : '';

    if (!isNew) {
      const p = (config.projects || [])[idx] || {};
      document.getElementById('proj-name').value = p.name || '';
      document.getElementById('proj-path').value = p.path || '';
      document.getElementById('proj-icon').value = p.icon || '';
      document.getElementById('proj-color').value = p.color || '#3498DB';
      document.getElementById('proj-autostart').checked = !!p.autoStart;
      document.getElementById('proj-autostart-type').value = p.autoStartType || 'new-claude';
      document.getElementById('proj-autostart-dangerous').checked = !!p.autoStartDangerous;
    } else {
      document.getElementById('proj-name').value = '';
      document.getElementById('proj-path').value = '';
      document.getElementById('proj-icon').value = '\uD83D\uDE80';
      document.getElementById('proj-color').value = '#3498DB';
      document.getElementById('proj-autostart').checked = false;
      document.getElementById('proj-autostart-type').value = 'new-claude';
      document.getElementById('proj-autostart-dangerous').checked = false;
    }
  }

  function closeEditForm() {
    if (projectEditForm) projectEditForm.classList.add('hidden');
  }

  async function saveConfig(updatedProjects) {
    if (configStatus) {
      configStatus.textContent = 'Saving...';
      configStatus.className = 'text-xs min-h-5 text-center text-working';
    }
    try {
      const res = await fetch('/api/config', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${currentToken}`,
        },
        body: JSON.stringify({ ...config, projects: updatedProjects }),
      });
      if (!res.ok) throw new Error('Save failed');
      // Update local config immediately (don't wait for WS broadcast)
      config = { ...config, projects: updatedProjects };
      emit('config:updated', config);
      if (configStatus) {
        configStatus.textContent = 'Saved';
        configStatus.className = 'text-xs min-h-5 text-center text-ready';
        setTimeout(() => { configStatus.textContent = ''; configStatus.className = 'text-xs min-h-5 text-center text-text-muted'; }, 3000);
      }
    } catch (err) {
      if (configStatus) {
        configStatus.textContent = 'Error: ' + err.message;
        configStatus.className = 'text-xs min-h-5 text-center text-error';
      }
    }
  }

  if (addProjectBtn) addProjectBtn.addEventListener('click', () => openEditForm(-1));
  if (cancelEditBtn) cancelEditBtn.addEventListener('click', closeEditForm);

  if (saveProjectBtn) {
    saveProjectBtn.addEventListener('click', async () => {
      const idx = parseInt(document.getElementById('proj-edit-index').value, 10);
      const updated = [...(config.projects || [])];
      const proj = {
        name: document.getElementById('proj-name').value.trim(),
        path: document.getElementById('proj-path').value.trim(),
        icon: document.getElementById('proj-icon').value.trim(),
        color: document.getElementById('proj-color').value,
        autoStart: document.getElementById('proj-autostart').checked,
        autoStartType: document.getElementById('proj-autostart-type').value,
        autoStartDangerous: document.getElementById('proj-autostart-dangerous').checked,
      };
      if (!proj.name || !proj.path) { showToast('Name and path required', 'error'); return; }
      if (idx === -1) updated.push(proj);
      else updated[idx] = proj;
      await saveConfig(updated);
      closeEditForm();
    });
  }

  if (deleteProjectBtn) {
    deleteProjectBtn.addEventListener('click', async () => {
      const idx = parseInt(document.getElementById('proj-edit-index').value, 10);
      if (idx < 0) return;
      if (!confirm('Delete this project?')) return;
      const updated = [...(config.projects || [])];
      updated.splice(idx, 1);
      await saveConfig(updated);
      closeEditForm();
    });
  }

  on('config:updated', () => {
    renderProjectList();
  });
  on('sessions:updated', renderProjectList);
}

// ── Recovery modal ────────────────────────────────────────────────────────
on('recovery:available', (recovered) => {
  const modal = document.getElementById('recovery-modal');
  const list = document.getElementById('recovery-list');
  const skipBtn = document.getElementById('recovery-skip');
  const restoreBtn = document.getElementById('recovery-restore');
  if (!modal || !list) return;

  list.innerHTML = '';
  recovered.forEach((s, idx) => {
    const item = document.createElement('label');
    item.className = 'flex items-center gap-1.5 min-w-0 p-2 border border-border rounded-md text-[13px] cursor-pointer hover:bg-surface-hover transition-colors duration-150';
    item.innerHTML = `
      <input type="checkbox" checked data-idx="${idx}" class="shrink-0 accent-accent">
      <span class="overflow-hidden text-ellipsis whitespace-nowrap min-w-0">${s.projectIcon || '\uD83D\uDCC1'} ${s.projectName}</span>
      <span class="text-[11px] text-text-muted shrink-0">${s.sessionType === 'plain-shell' ? 'SH' : (s.dangerouslySkipPermissions ? 'CD' : 'C')}</span>
    `;
    list.appendChild(item);
  });

  modal.classList.remove('hidden');

  skipBtn.onclick = () => modal.classList.add('hidden');
  restoreBtn.onclick = () => {
    modal.classList.add('hidden');
    const checked = list.querySelectorAll('input[type=checkbox]:checked');
    checked.forEach(cb => {
      const s = recovered[parseInt(cb.dataset.idx, 10)];
      if (!s) return;
      send({
        type: 'session_create',
        projectName: s.projectName,
        sessionType: s.sessionType || 'new-claude',
        dangerouslySkipPermissions: !!s.dangerouslySkipPermissions,
      });
    });
  };
});

// ── Start ─────────────────────────────────────────────────────────────────
init();
