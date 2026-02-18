'use strict';

// Global crash guards — keep the server alive on unhandled errors
process.on('uncaughtException', (err) => {
  console.error('[Server] Uncaught exception:', err.stack || err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Server] Unhandled rejection:', reason);
});

const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const { WebSocketServer } = require('ws');
const { URL } = require('url');

const ConfigWatcher = require('./config-watcher');
const SessionManager = require('./session-manager');
const auth = require('./auth');

// ── Paths ──────────────────────────────────────────────────────────────────
const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const SESSIONS_PATH = path.join(ROOT, 'sessions.json');
const CLIENT_DIR = path.join(ROOT, 'client');

// ── .env loading ───────────────────────────────────────────────────────────
ConfigWatcher.loadEnvFile(path.join(ROOT, '.env'));

// ── Config bootstrap ───────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  port: 3000,
  pin: '',
  appName: 'CLI Cockpit',
  appShortName: 'Cockpit',
  projects: [],
};

function ensureConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.warn('[Server] config.json not found — creating default config.');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
  }
}

ensureConfig();

// ── Config Watcher ─────────────────────────────────────────────────────────
const configWatcher = new ConfigWatcher(CONFIG_PATH);
configWatcher.start();

function getConfig() {
  return configWatcher.getConfig() || DEFAULT_CONFIG;
}

// Apply ENV overrides
function getEffectiveConfig() {
  const c = { ...getConfig() };
  if (process.env.PORT) c.port = parseInt(process.env.PORT, 10);
  if (process.env.PIN) c.pin = process.env.PIN;
  return c;
}

// ── Session Manager ────────────────────────────────────────────────────────
const sessionManager = new SessionManager(SESSIONS_PATH);

// ── Express ────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Auth middleware factory (uses live config)
const requireAuth = auth.authMiddleware(getEffectiveConfig);

// Serve static client files
app.use('/static', express.static(CLIENT_DIR));

// SPA root
app.get('/', (req, res) => {
  res.sendFile(path.join(CLIENT_DIR, 'index.html'));
});

// Dynamic manifest.json
app.get('/manifest.json', (req, res) => {
  res.json({
    name: 'CLAUDE CLIT',
    short_name: 'CLIT',
    display: 'fullscreen',
    orientation: 'any',
    scope: '/',
    background_color: '#12122a',
    theme_color: '#12122a',
    start_url: '/',
    icons: [
      { src: '/static/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/static/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/static/icon.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
  });
});

// ── REST API ───────────────────────────────────────────────────────────────

// POST /api/auth — PIN login
app.post('/api/auth', (req, res) => {
  auth.validateAndIssueToken(req, res, getEffectiveConfig);
});

// GET /api/sessions
app.get('/api/sessions', requireAuth, (req, res) => {
  res.json(sessionManager.getSessionsForClient());
});

// POST /api/sessions
app.post('/api/sessions', requireAuth, (req, res) => {
  const { projectName, sessionType, dangerouslySkipPermissions } = req.body;
  const config = getEffectiveConfig();
  const projectConfig = config.projects.find(p => p.name === projectName);
  if (!projectConfig) {
    return res.status(404).json({ error: `Project "${projectName}" not found` });
  }
  try {
    const session = sessionManager.createSession(projectConfig, sessionType, !!dangerouslySkipPermissions);
    broadcastAll({ type: 'session_created', session: sessionToClient(session) });
    res.json(sessionToClient(session));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/sessions/:id
app.delete('/api/sessions/:id', requireAuth, (req, res) => {
  sessionManager.killSession(req.params.id);
  broadcastAll({ type: 'session_killed', sessionId: req.params.id });
  res.json({ ok: true });
});

// GET /api/config
app.get('/api/config', requireAuth, (req, res) => {
  const c = getEffectiveConfig();
  // Never expose pin
  const { pin, ...safe } = c;
  res.json(safe);
});

// PUT /api/config
app.put('/api/config', requireAuth, (req, res) => {
  const c = getEffectiveConfig();
  const updated = { ...c, ...req.body };
  // Protect pin and port from in-app editing
  updated.pin = c.pin;
  updated.port = c.port;

  try {
    const tmp = CONFIG_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(updated, null, 2), 'utf8');
    fs.renameSync(tmp, CONFIG_PATH);
    // Update in-memory config immediately (don't wait for fs.watch debounce)
    configWatcher._config = updated;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/recovery
app.get('/api/recovery', requireAuth, (req, res) => {
  res.json(recoveredSessions);
});

// GET /api/themes
app.get('/api/themes', requireAuth, (req, res) => {
  res.json(getThemes());
});

// ── Built-in Themes ────────────────────────────────────────────────────────
const BUILTIN_THEMES = [
  {
    id: 'default',
    name: 'Default Dark',
    author: 'Built-in',
    colors: {
      '--bg': '#1A1A2E',
      '--bg-deep': '#12122a',
      '--bg-surface': '#1f1f3d',
      '--text': '#E0E0E0',
      '--text-muted': 'rgba(224,224,224,0.6)',
      '--border': 'rgba(255,255,255,0.08)',
      '--accent': '#3498DB',
      '--ready': '#2ECC71',
      '--working': '#F39C12',
      '--dead': '#555555',
      '--error': '#E74C3C',
    },
  },
  {
    id: 'midnight-blue',
    name: 'Midnight Blue',
    author: 'Built-in',
    colors: {
      '--bg': '#0a1628',
      '--bg-deep': '#060f1d',
      '--bg-surface': '#0f1f3a',
      '--text': '#c8d6e5',
      '--text-muted': 'rgba(200,214,229,0.6)',
      '--accent': '#3498DB',
      '--ready': '#2ECC71',
      '--working': '#F39C12',
    },
  },
  {
    id: 'forest',
    name: 'Forest',
    author: 'Built-in',
    colors: {
      '--bg': '#0d1f0e',
      '--bg-deep': '#081408',
      '--bg-surface': '#152b16',
      '--text': '#d4edda',
      '--text-muted': 'rgba(212,237,218,0.6)',
      '--accent': '#2ECC71',
      '--ready': '#2ECC71',
      '--working': '#F39C12',
    },
  },
];

function getThemes() {
  const config = getEffectiveConfig();
  const configThemes = Array.isArray(config.themes) ? config.themes : [];

  // Load from themes/ directory
  const themesDir = path.join(ROOT, 'themes');
  const dirThemes = [];
  if (fs.existsSync(themesDir)) {
    try {
      const files = fs.readdirSync(themesDir).filter(f => f.endsWith('.json'));
      for (const f of files) {
        try {
          const theme = JSON.parse(fs.readFileSync(path.join(themesDir, f), 'utf8'));
          dirThemes.push(theme);
        } catch { /* skip invalid */ }
      }
    } catch { /* skip */ }
  }

  // Merge: builtin < dir < config (config takes precedence for same ID)
  const merged = new Map();
  for (const t of [...BUILTIN_THEMES, ...dirThemes, ...configThemes]) {
    merged.set(t.id, t);
  }
  return Array.from(merged.values());
}

// ── Session serializer ────────────────────────────────────────────────────
function sessionToClient(s) {
  return {
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
  };
}

// ── HTTP Server ────────────────────────────────────────────────────────────
const server = http.createServer(app);

// ── WebSocket Server ───────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

// Track all authenticated WS clients
const clients = new Set();

function broadcastAll(msg) {
  const data = JSON.stringify(msg);
  for (const ws of clients) {
    try {
      if (ws.readyState === 1) ws.send(data);
    } catch { /* ignore */ }
  }
}

// Inject broadcast function into session manager
sessionManager.setBroadcastFn((msg) => {
  if (msg.sessionId) {
    // Already broadcast to subscribers inside session-manager
    // Also broadcast state changes to all clients
    if (msg.type === 'session_state_changed') {
      broadcastAll(msg);
    }
  } else {
    broadcastAll(msg);
  }
});

// HTTP → WS upgrade
server.on('upgrade', (request, socket, head) => {
  const reqUrl = new URL(request.url, `http://${request.headers.host}`);
  const token = reqUrl.searchParams.get('token');

  if (!auth.wsAuthMiddleware(token, getEffectiveConfig)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request, token);
  });
});

// WS connection handler
wss.on('connection', (ws) => {
  clients.add(ws);

  // Send current sessions list immediately
  ws.send(JSON.stringify({
    type: 'sessions_list',
    sessions: sessionManager.getSessionsForClient(),
    config: (() => {
      const c = getEffectiveConfig();
      const { pin, ...safe } = c;
      return safe;
    })(),
    themes: getThemes(),
  }));

  // Ping/pong heartbeat
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    try {
      handleWsMessage(ws, msg);
    } catch (err) {
      console.error('[WS] Message handler error:', err.stack || err.message);
      try { ws.send(JSON.stringify({ type: 'error', message: 'Internal server error: ' + err.message })); } catch {}
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    sessionManager.removeSubscriber(ws);
  });

  ws.on('error', (err) => {
    console.error('[WS] Client error:', err.message);
    clients.delete(ws);
    sessionManager.removeSubscriber(ws);
  });
});

function handleWsMessage(ws, msg) {
  switch (msg.type) {
    case 'session_subscribe': {
      const { sessionId } = msg;
      sessionManager.addSubscriber(sessionId, ws);
      const buffer = sessionManager.getOutputBuffer(sessionId);
      ws.send(JSON.stringify({ type: 'session_buffer', sessionId, data: buffer.join('') }));
      break;
    }
    case 'terminal_input': {
      const { sessionId, data } = msg;
      sessionManager.writeToSession(sessionId, data);
      break;
    }
    case 'terminal_resize': {
      const { sessionId, cols, rows } = msg;
      sessionManager.resizeSession(sessionId, cols, rows);
      break;
    }
    case 'session_rename': {
      const { sessionId, newLabel } = msg;
      sessionManager.renameSession(sessionId, newLabel);
      broadcastAll({ type: 'session_updated', sessionId, label: newLabel });
      break;
    }
    case 'session_kill': {
      const { sessionId } = msg;
      sessionManager.killSession(sessionId);
      broadcastAll({ type: 'session_killed', sessionId });
      break;
    }
    case 'session_create': {
      const { projectName, sessionType, dangerouslySkipPermissions } = msg;
      const config = getEffectiveConfig();
      const projectConfig = config.projects.find(p => p.name === projectName);
      if (!projectConfig) {
        ws.send(JSON.stringify({ type: 'error', message: `Project "${projectName}" not found` }));
        break;
      }
      try {
        const session = sessionManager.createSession(projectConfig, sessionType, !!dangerouslySkipPermissions);
        broadcastAll({ type: 'session_created', session: sessionToClient(session) });
      } catch (err) {
        console.error('[WS] session_create error:', err.message);
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
      }
      break;
    }
    default:
      break;
  }
}

// Ping heartbeat (30s interval, 10s timeout)
const pingInterval = setInterval(() => {
  for (const ws of clients) {
    if (!ws.isAlive) {
      ws.terminate();
      clients.delete(ws);
      sessionManager.removeSubscriber(ws);
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

wss.on('close', () => clearInterval(pingInterval));

// ── Config hot-reload → broadcast ─────────────────────────────────────────
configWatcher.on('change', (newConfig) => {
  console.log('[Server] config.json reloaded.');
  const { pin, ...safe } = newConfig;
  broadcastAll({ type: 'config_updated', config: safe, themes: getThemes() });
});

// ── Recovery data ─────────────────────────────────────────────────────────
const recoveredSessions = SessionManager.loadSessions(SESSIONS_PATH);

// ── Auto-start sessions ───────────────────────────────────────────────────
function autoStartSessions() {
  const config = getEffectiveConfig();
  let count = 0;
  for (const project of config.projects) {
    if (!project.autoStart) continue;
    const type = project.autoStartType || 'new-claude';
    const dangerous = !!project.autoStartDangerous;
    try {
      sessionManager.createSession(project, type, dangerous);
      count++;
      console.log(`[Server] Auto-started session for "${project.name}" (${type})`);
    } catch (err) {
      console.error(`[Server] Failed to auto-start "${project.name}":`, err.message);
    }
  }
  return count;
}

// ── Start server ───────────────────────────────────────────────────────────
const effectiveConfig = getEffectiveConfig();
const PORT = effectiveConfig.port || 3000;

const autoStartCount = autoStartSessions();

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║         CLI Cockpit — Server Ready       ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`  Port      : ${PORT}`);
  console.log(`  Projects  : ${effectiveConfig.projects.length} configured`);
  console.log(`  Auto-start: ${autoStartCount} session(s) started`);
  console.log(`  Recovery  : ${recoveredSessions.length} session(s) recoverable`);
  console.log(`  Auth      : ${effectiveConfig.pin ? 'PIN required' : 'No PIN (open)'}`);
  console.log('');
  console.log(`  Open: http://localhost:${PORT}`);
  console.log('');
});

server.on('error', (err) => {
  console.error('[Server] Fatal error:', err.message);
  process.exit(1);
});
