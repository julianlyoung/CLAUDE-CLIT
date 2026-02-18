'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

class ConfigWatcher extends EventEmitter {
  constructor(configPath) {
    super();
    this.configPath = configPath;
    this._watcher = null;
    this._debounceTimer = null;
    this._config = null;
  }

  start() {
    // Load initial config
    this._config = this._readConfig();

    // Watch for changes
    this._watcher = fs.watch(this.configPath, (eventType) => {
      if (eventType !== 'change') return;
      clearTimeout(this._debounceTimer);
      this._debounceTimer = setTimeout(() => {
        const newConfig = this._readConfig();
        if (newConfig) {
          this._config = newConfig;
          this.emit('change', this._config);
        }
      }, 500);
    });

    this._watcher.on('error', (err) => {
      console.error('[ConfigWatcher] Watch error:', err.message);
    });

    return this;
  }

  stop() {
    if (this._watcher) {
      this._watcher.close();
      this._watcher = null;
    }
    clearTimeout(this._debounceTimer);
  }

  getConfig() {
    return this._config;
  }

  _readConfig() {
    try {
      const raw = fs.readFileSync(this.configPath, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      console.error('[ConfigWatcher] Failed to read/parse config:', err.message);
      return null;
    }
  }

  // Minimal .env parser - reads KEY=VALUE lines, sets process.env if not already set by OS
  static loadEnvFile(envPath) {
    try {
      const raw = fs.readFileSync(envPath, 'utf8');
      raw.split('\n').forEach(line => {
        line = line.trim();
        if (!line || line.startsWith('#')) return;
        const eqIdx = line.indexOf('=');
        if (eqIdx < 0) return;
        const key = line.slice(0, eqIdx).trim();
        const value = line.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
        if (key && !(key in process.env)) {
          process.env[key] = value;
        }
      });
    } catch (err) {
      // .env file is optional, silently skip
    }
  }
}

module.exports = ConfigWatcher;
