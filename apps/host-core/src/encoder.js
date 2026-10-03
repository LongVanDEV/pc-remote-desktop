function createEncoder(preset) {
  return { preset, encode() { return Buffer.alloc(0); } };
}
module.exports = { createEncoder };
