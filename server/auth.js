'use strict';
const crypto = require('crypto');

// In-memory token store
const activeTokens = new Set();

// Rate limiter: Map<ip, { count, resetAt }>
const rateLimiter = new Map();
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 60 * 1000;

function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

function validatePin(submitted, configPin) {
  if (!configPin) return true; // No PIN configured = open access
  return submitted === configPin;
}

function checkRateLimit(ip) {
  const now = Date.now();
  const record = rateLimiter.get(ip);
  if (!record) return true;
  if (record.resetAt < now) {
    rateLimiter.delete(ip);
    return true;
  }
  return record.count < MAX_ATTEMPTS;
}

function recordFailedAttempt(ip) {
  const now = Date.now();
  const record = rateLimiter.get(ip) || { count: 0, resetAt: now + LOCKOUT_MS };
  record.count++;
  if (record.count >= MAX_ATTEMPTS) record.resetAt = now + LOCKOUT_MS;
  rateLimiter.set(ip, record);
}

// Express middleware: validates Bearer token or ?token= query param
function authMiddleware(configGetter) {
  return (req, res, next) => {
    const config = configGetter();
    if (!config.pin) return next(); // No PIN = open

    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : req.query.token;

    if (!token || !activeTokens.has(token)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  };
}

// Validates token for WebSocket connections
function wsAuthMiddleware(token, configGetter) {
  const config = configGetter();
  if (!config.pin) return true;
  return token && activeTokens.has(token);
}

// Handler for POST /api/auth
function validateAndIssueToken(req, res, configGetter) {
  const config = configGetter();
  const ip = req.ip || req.connection.remoteAddress;
  const { pin } = req.body;

  if (!config.pin) {
    // No PIN configured - return a token anyway for consistency
    const token = generateToken();
    activeTokens.add(token);
    return res.json({ token });
  }

  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many failed attempts. Try again in 60 seconds.' });
  }

  if (!validatePin(pin, config.pin)) {
    recordFailedAttempt(ip);
    return res.status(401).json({ error: 'Invalid PIN' });
  }

  // Success: clear rate limit, issue token
  rateLimiter.delete(ip);
  const token = generateToken();
  activeTokens.add(token);
  res.json({ token });
}

module.exports = {
  generateToken,
  activeTokens,
  rateLimiter,
  authMiddleware,
  wsAuthMiddleware,
  validateAndIssueToken,
};
