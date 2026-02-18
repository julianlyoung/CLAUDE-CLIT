# CLIT — Command Line Interface Terminal

A mobile-first PWA that lets you manage multiple Claude Code AI agent sessions from your phone. Run it on your Windows PC, open it on your phone, lean back on the couch, and command your AI agents by voice or text — no hunching over a keyboard required.

## Why This Exists

The author built this because his neck was destroyed. Months of hunching over a desk, squinting at terminal output, and hammering CLI commands into Claude Code had taken its toll. Bad posture, constant keyboard input, and the simple fact that Claude Code is a *command-line tool* with no remote interface meant being physically chained to the PC.

CLIT fixes that. It puts a full terminal cockpit on your phone so you can lie on the couch, sit in the garden, or pace around the room — while your PC does the heavy lifting. Voice input means you don't even need to type. The session light bar tells you at a glance which agents are working, which are waiting, and which have finished (with a gentle chime so you don't have to keep checking).

It was built entirely with Claude Code, which feels appropriate.

## What It Does

- **Multi-session terminal management** — Spawn and manage multiple Claude Code or PowerShell sessions simultaneously
- **Real-time terminal rendering** — Full xterm.js terminal output streamed over WebSocket
- **Voice input** — Dictate commands using your phone's microphone via the Web Speech API
- **Session state detection** — Automatically detects when Claude is working, idle, or finished
- **Completion chime** — Gentle two-tone beep when a task finishes so you don't have to watch the screen
- **Mobile-first design** — Designed for phones first, works great on desktop too
- **Session light bar** — Colored dots show all your sessions at a glance. Tap to switch, long-press for quick actions
- **Installable PWA** — Add to your home screen for a full-screen app experience
- **Themeable** — Multiple built-in themes, or create your own
- **PIN authentication** — Simple PIN lock to keep your sessions private
- **LAN or remote access** — Works on your local network out of the box, or expose it to the internet via Cloudflare Tunnel

## Prerequisites

- **Windows 10/11** (uses ConPTY for terminal emulation)
- **Node.js 18+** — [Download here](https://nodejs.org/)
- **Visual Studio Build Tools** — Required by `node-pty` for native compilation
- **Claude Code** — Anthropic's CLI tool, if you want to run AI agent sessions

### Installing Visual Studio Build Tools

`node-pty` is a native module that needs a C++ compiler. The easiest way:

```powershell
npm install -g windows-build-tools
```

Or install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) manually — select the "Desktop development with C++" workload.

### Installing Claude Code

```bash
npm install -g @anthropic-ai/claude-code
```

You'll need an Anthropic API key or a Claude subscription. See [Claude Code docs](https://docs.anthropic.com/en/docs/claude-code) for setup.

## Quick Start

```bash
# Clone the repo
git clone https://github.com/your-username/CLIT---Command-Line-Interface-Terminal.git
cd CLIT---Command-Line-Interface-Terminal

# Install dependencies
npm install

# Start the server
npm start
```

The server starts on port 3000 by default. Open `http://localhost:3000` in your browser, or on your phone use your PC's local IP address (e.g. `http://192.168.1.50:3000`).

To find your PC's IP address:

```powershell
ipconfig
```

Look for the `IPv4 Address` under your active network adapter (usually Wi-Fi or Ethernet).

## Configuration

All configuration lives in `config.json` in the project root. It's created automatically on first run with sensible defaults.

```json
{
  "port": 3000,
  "pin": "1234",
  "appName": "CLI Cockpit",
  "appShortName": "Cockpit",
  "projects": [
    {
      "name": "MyProject",
      "path": "C:/Projects/my-project",
      "icon": "🚀",
      "color": "#E74C3C",
      "autoStart": false,
      "autoStartType": "new-claude",
      "autoStartDangerous": false
    }
  ]
}
```

### Setting a PIN

Edit `config.json` and set the `"pin"` field to any string. When you open the app, you'll be prompted to enter the PIN on a numeric keypad. Set it to `""` (empty string) to disable authentication entirely.

```json
{
  "pin": "5678"
}
```

The PIN and port can also be set via environment variables, which take priority over `config.json`:

```bash
PIN=9999 PORT=8080 npm start
```

Or create a `.env` file in the project root:

```
PORT=3000
PIN=5678
```

### Adding Projects

Projects can be added through the desktop config panel (visible on screens wider than 900px) or by editing `config.json` directly. Each project defines:

| Field | Description |
|---|---|
| `name` | Display name shown in the session drawer |
| `path` | Absolute path to the project folder on your PC |
| `icon` | Emoji shown on session dots and in the drawer |
| `color` | Hex color for the session dot in the light bar |
| `autoStart` | Whether to launch a session automatically when the server starts |
| `autoStartType` | `"new-claude"`, `"resume-claude"`, or `"plain-shell"` |
| `autoStartDangerous` | If `true`, launches Claude with `--dangerously-skip-permissions` |

## Installing as a PWA (Full-Screen on Your Phone)

For the best experience, install CLIT as a PWA on your phone:

1. Open the app URL in **Chrome on Android**
2. Wait a moment for Chrome to detect the PWA manifest
3. Tap the three-dot menu and select **"Install app"** (not "Add to Home Screen" — that creates a browser shortcut)
4. Launch from your home screen — it runs full-screen with no browser chrome

If you previously added it as a shortcut and it shows a browser bar, remove the old shortcut and use "Install app" instead.

## Remote Access with Cloudflare Tunnel

You can access CLIT from anywhere — not just your local network — using a free Cloudflare Tunnel. This creates a secure connection from your PC to a public URL without opening any ports on your router.

### Step 1: Get a Domain

You need a domain name. You can:
- Buy one from any registrar (Namecheap, Google Domains, etc.)
- Use a free subdomain service
- Transfer an existing domain to Cloudflare

### Step 2: Add Your Domain to Cloudflare

1. Create a free account at [dash.cloudflare.com](https://dash.cloudflare.com)
2. Click **"Add a site"** and enter your domain
3. Select the **Free plan**
4. Cloudflare will give you two nameservers — update your domain registrar to point to these nameservers
5. Wait for DNS propagation (can take a few minutes to 24 hours)

### Step 3: Install Cloudflared

Download and install `cloudflared` from [Cloudflare's GitHub releases](https://github.com/cloudflare/cloudflared/releases):

```powershell
# Or install via winget
winget install Cloudflare.cloudflared
```

### Step 4: Authenticate

```bash
cloudflared tunnel login
```

This opens a browser window where you select your domain and authorize the tunnel.

### Step 5: Create a Tunnel

```bash
cloudflared tunnel create clit
```

This generates a tunnel ID and credentials file. Note the tunnel UUID printed in the output.

### Step 6: Configure DNS

```bash
cloudflared tunnel route dns clit clit.yourdomain.com
```

Replace `clit.yourdomain.com` with whatever subdomain you want.

### Step 7: Create a Config File

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: YOUR-TUNNEL-UUID
credentials-file: C:\Users\YourUser\.cloudflared\YOUR-TUNNEL-UUID.json

ingress:
  - hostname: clit.yourdomain.com
    service: http://localhost:3000
  - service: http_status:404
```

### Step 8: Run It

```bash
cloudflared tunnel run clit
```

Your CLIT instance is now available at `https://clit.yourdomain.com` from anywhere in the world.

### Optional: Create a Launch Script

Create a `start-remote.bat` file to start both the server and tunnel together:

```batch
@echo off
title CLI Cockpit — Remote Server

:: Start the CLIT server in the background
start /B cmd /c "cd /d %~dp0 && node server\index.js"

:: Wait for server to be ready
timeout /t 3 /nobreak >nul

:: Start the Cloudflare tunnel
cloudflared tunnel run clit
```

Double-click the batch file to launch everything. Add `start-remote.bat` to your `.gitignore` since it contains your domain info.

### Security Notes

- **Always set a PIN** when exposing CLIT remotely. Without one, anyone with the URL has full terminal access to your PC.
- CLIT sessions run with your user's permissions. Claude Code with `--dangerously-skip-permissions` can do anything your user account can do.
- Cloudflare Tunnel provides HTTPS encryption automatically.
- The PIN is rate-limited (5 attempts per 15 minutes per IP) to prevent brute-force attacks.

## Session Types

When creating a new session, you can choose from three types:

| Type | Description |
|---|---|
| **New Claude Code** | Launches a fresh `claude` session in the project directory |
| **Resume Claude Code** | Launches `claude --resume` to continue the last conversation |
| **Plain Shell** | Opens a PowerShell terminal — useful for running builds, git, etc. |

The `--dangerously-skip-permissions` checkbox launches Claude Code without permission prompts, so it can edit files and run commands freely. Use with caution.

## Usage Tips

- **Tap a dot** in the light bar to switch between sessions
- **Long-press a dot** for quick actions: restart, resume, kill, rename
- **Swipe the light bar** to scroll through sessions when you have many
- **Green dot** = session is idle/ready, **orange dot** = working, **grey dot** = dead
- **Voice input**: tap the mic icon, speak your command, it auto-sends after 2 seconds of silence
- The terminal plays a **gentle chime** when a session transitions from working to ready
- On desktop (900px+), the config panel appears as a sidebar for managing projects

## Tech Stack

- **Server**: Node.js, Express, ws (WebSocket), node-pty (PTY management)
- **Client**: Vanilla JS (ES modules), xterm.js (terminal rendering), Web Speech API
- **Zero build step** — no webpack, no bundler, no framework. Just files served by Express.

## Sound Effects

The bundled completion sounds in `client/sounds/` are sourced from [Mixkit](https://mixkit.co/free-sound-effects/) and are used under the [Mixkit Sound Effects Free License](https://mixkit.co/license/#sfxFree). This license permits free use in any project (including commercial) without attribution. The sounds are bundled as part of the application experience and are not redistributed as standalone assets.

You can also upload your own custom sound via the Settings panel.

## License

MIT
