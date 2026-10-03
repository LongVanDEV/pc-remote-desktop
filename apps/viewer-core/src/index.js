/** Viewer decode + input (stub). */
class ViewerSession {
  constructor() { this.connected = false; }
  async connect(_roomId) { this.connected = true; return { ok: true }; }
  async disconnect() { this.connected = false; }
}
module.exports = { ViewerSession };
