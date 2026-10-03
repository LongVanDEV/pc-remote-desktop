function track(event, props = {}) {
  if (process.env.PRD_DEBUG_METRICS) console.log('[metrics]', event, props);
}
module.exports = { track };
