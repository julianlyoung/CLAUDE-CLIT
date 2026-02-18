/**
 * CLI Cockpit — Voice Input (v2 — Stub)
 * No input bar in Glass Bridge v2. Voice module kept as a no-op placeholder
 * so app.js import doesn't break. Can be extended later for voice-to-terminal.
 */

export class VoiceInput {
  constructor({ emit, on }) {
    this.emit = emit;
    this.on = on;
    this._supported = false;
  }

  init() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;
    this._SpeechRecognition = SpeechRecognition;
    this._supported = true;
  }
}
