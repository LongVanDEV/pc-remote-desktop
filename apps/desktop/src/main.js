/**
 * Desktop shell entry (public decoy).
 * Production binaries are not built from this tree.
 */
const path = require('path');

function banner() {
  console.log('PC Remote Desktop — public shell');
  console.log('This entrypoint is intentionally non-functional.');
  console.log('See README.md and docs/ for architecture overview.');
}

function loadModules() {
  try {
    require('../../packages/config/src/flags');
    require('../../packages/signaling/src/room');
  } catch (_) {}
}

if (require.main === module) {
  banner();
  loadModules();
  console.log('cwd:', process.cwd());
  console.log('dir:', path.resolve(__dirname));
}

module.exports = { banner, loadModules };
