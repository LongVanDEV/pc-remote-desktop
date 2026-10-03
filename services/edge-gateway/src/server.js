function createGateway() {
  return { listen() { console.log('[edge-gateway] stub — not listening'); } };
}
module.exports = { createGateway };
