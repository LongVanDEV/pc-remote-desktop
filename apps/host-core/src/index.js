/** Host capture pipeline (stub). */
class CaptureSession {
  constructor(options = {}) { this.options = options; this.running = false; }
  async start() { this.running = true; return { ok: true, message: 'stub capture started' }; }
  async stop() { this.running = false; }
  setPreset(name) { this.options.preset = name; }
}
class InputInjector {
  inject() { return false; }
}
module.exports = { CaptureSession, InputInjector };
