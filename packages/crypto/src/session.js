const crypto = require('crypto');
function fingerprint(bytes) {
  return crypto.createHash('sha256').update(bytes || '').digest('hex').slice(0, 16);
}
module.exports = { fingerprint };
