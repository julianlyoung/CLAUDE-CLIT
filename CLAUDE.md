# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install        # Install dependencies (node-pty requires VS Build Tools on Windows)
npm start          # Start server (default port 3000)
```

On Windows, double-click `start.bat` to build CSS + start server + launch Cloudflare tunnel.

### CSS Build

The frontend uses Tailwind CSS v4. Source is `client/css/input.css`, compiled to `client/css/style.css`:

```bash
npx @tailwindcss/cli -i client/css/input.css -o client/css/style.css --minify
```

Rebuild CSS after any changes to `input.css` or Tailwind classes in HTML/JS files.

### Service Worker Cache

After deploying changes, bump `CACHE_NAME` version in `client/sw.js` (e.g. `clit-v9` → `clit-v10`) to force clients to re-cache.

## Architecture Overview

**CLI Cockpit** is a LAN-hosted PWA that provides a mobile-first terminal cockpit for managing multiple CLI sessions (primarily Claude Code AI agents) from a phone.

### Three-Tier Structure

```
Node.js Server (Windows PC, port 3000)
├── Express — HTTP + static file serving
├── ws — WebSocket server (real-time terminal I/O, 30s ping heartbeat)
├── node-pty — PTY process management (Windows ConPTY)
├── SessionManager — ring buffers, state detection, sessions.json persistence
├── ConfigWatcher — fs.watch on config.json (debounced 500ms)
└── Auth — PIN validation, hex tokens, per-IP rate limiting

PWA Client (Android Chrome / Desktop Browser)
├── xterm.js v5 — terminal rendering (CDN loaded)
├── Tailwind CSS v4 — compiled from input.css
├── Vanilla JS ES modules — no framework
├── Service Worker — cache-first for app shell, network-only for /api/*
└── Glass Bridge v2 — sci-fi HUD aesthetic (Oxanium + JetBrains Mono fonts)
```

### File Structure

```
server/
  index.js             # Entry: config → auto-start sessions → Express + WS + dynamic manifest
  session-manager.js   # SessionManager: PTY lifecycle, ring buffers (5000), state detection
  config-watcher.js    # ConfigWatcher: fs.watch with 500ms debounce
  auth.js              # PIN validation, token generation, rate limiting middleware
client/
  index.html           # SPA shell — Glass Bridge v2 HUD, deck overlay, quick keys
  sw.js                # Service worker (bump CACHE_NAME on deploy)
  icon.svg / *.png     # PWA icons
  css/input.css        # Tailwind v4 source — all custom styles, themes, animations
  css/style.css        # Compiled output (do not edit directly)
  js/app.js            # WebSocket client, event bus, sounds, themes, config panel, recovery
  js/light-bar.js      # HUD top bar session pills (icon + state dot), gestures
  js/terminal.js       # xterm.js lifecycle, session switching, channel-switch animation
  js/voice-input.js    # Web Speech API wrapper (stub — no input bar in V2)
  js/project-drawer.js # Deck overlay, session cards, create modal, telemetry, theme picker
themes/                # JSON theme files loaded by server
config.json            # Server config — port, PIN, projects (not tracked, see config.example.json)
config.example.json    # Template for config.json
sessions.json          # Auto-maintained session metadata (do not edit)
```

### Key Data Flows

- **Terminal output**: `PTY data → ring buffer → WS broadcast → xterm.js`
- **Terminal input**: `User keystroke → WS terminal_input → node-pty.write()`
- **Config reload**: `config.json saved → fs.watch → debounce → reload → WS broadcast`
- **State detection**: `PTY output → strip ANSI → filter noise → match patterns → 2s silence timer → state change`
- **Completion sound**: `State → 'ready' → Web Audio synth chime on client`
- **Reconnect**: `WS close → backoff retry + instant reconnect on visibility change`

### State Detection

Session state (`ready`, `working`, `waiting_input`, `dead`) is detected from PTY output in `session-manager.js`:

1. Strip ANSI escape sequences
2. Filter noise (spinner animations like `✶ Hyperspacing…`, title updates, usage notices)
3. Match against READY_PATTERNS (`❯` prompt with trailing whitespace) or WAITING_PATTERNS (`(y/n)`, `Allow once`, etc.)
4. On match, start a 2s silence timer — if no substantial output interrupts, state transitions
5. When already `ready`, any non-noise output transitions back to `working`
6. Short fragments (< 15 chars) while `working` don't cancel pending ready timers (spinner debris)

**Debug mode**: `STATE_DEBUG=1 node server/index.js > debug.log 2>&1` — logs all state detection decisions. Test by sending commands and watching for `READY match → Timer fired` in the log.

### WebSocket Protocol

All messages are JSON. Authentication via token query param on WS upgrade:
- Terminal I/O: `terminal_input` / `terminal_output` (both carry `sessionId` and `data`)
- Session events: `sessions_list`, `session_created`, `session_killed`, `session_state_changed`
- Buffer replay: client sends `session_subscribe` → server replies `session_buffer`
- Keepalive: client sends `ping` every 25s

### Configuration

Copy `config.example.json` to `config.json` and edit:

```json
{
  "port": 3000,
  "pin": "1234",
  "projects": [
    {
      "name": "MyProject",
      "path": "C:/Projects/my-project",
      "icon": "🚀",
      "color": "#3b82f6",
      "autoStart": false,
      "autoStartType": "new-claude",
      "autoStartDangerous": false
    }
  ]
}
```

**Important**: `config.json` is gitignored — never commit it (contains PIN and local paths).

### Windows-Specific Constraints

- **node-pty**: Requires Visual Studio Build Tools for native compilation
- **fs.watch**: Fires multiple events per save — debounce is mandatory
- **sessions.json writes**: Atomic temp file + rename to prevent corruption
- **PTY input**: Use `\r` not `\n` for command execution on Windows PTY
- **Claude Code in PTY**: Strip `CLAUDECODE` env var or it refuses to launch (nested session error)
- **Claude Code input**: Send text first, then `\r` after ~500ms delay for reliable submission
- **Claude Code terminal size**: 120×40 works; 80×24 corrupts the TUI layout
- **Ring buffer**: Store raw PTY chunks, NOT split by `\n` (corrupts ANSI sequences). Join with `''`
