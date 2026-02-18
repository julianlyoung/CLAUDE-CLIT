/* CLI Cockpit — Service Worker */
const CACHE_NAME = 'clit-v9';

const APP_SHELL = [
  '/',
  '/static/css/style.css',
  '/static/js/app.js',
  '/static/js/terminal.js',
  '/static/js/light-bar.js',
  '/static/js/voice-input.js',
  '/static/js/project-drawer.js',
  '/static/icon.svg',
  '/static/icon-192.png',
  '/static/icon-512.png',
  '/static/sounds/click.wav',
  '/static/sounds/achievement-bell.wav',
  '/static/sounds/confirmation-tone.wav',
  '/static/sounds/retro-game-notification.wav',
  '/static/sounds/arcade-bonus-alert.wav',
  '/static/sounds/quick-win-video-game-notification.wav',
  '/static/sounds/coin-win-notification.wav',
  '/static/sounds/video-game-win.wav',
  '/static/sounds/melodic-bonus-collect.wav',
  '/static/sounds/fairy-arcade-sparkle.wav',
  '/static/sounds/sci-fi-confirmation.wav',
  '/static/sounds/bubble-pop-up-alert-notification.wav',
  'https://cdn.jsdelivr.net/npm/@xterm/xterm@5/css/xterm.css',
  'https://cdn.jsdelivr.net/npm/@xterm/xterm@5/lib/xterm.js',
  'https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10/lib/addon-fit.js',
  'https://cdn.jsdelivr.net/npm/@xterm/addon-web-links@0.11/lib/addon-web-links.js',
];

// Install: cache app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: cache-first for app shell, network-only for API and WS
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Network-only: API calls and WebSocket upgrades
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') {
    return; // Let browser handle normally
  }

  // Network-only: manifest.json (served dynamically)
  if (url.pathname === '/manifest.json') {
    return;
  }

  // Cache-first for everything else
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        // Cache valid GET responses
        if (event.request.method === 'GET' && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Offline fallback for navigation
        if (event.request.mode === 'navigate') {
          return caches.match('/');
        }
      });
    })
  );
});
