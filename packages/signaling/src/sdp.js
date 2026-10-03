function stripCandidates(sdp) {
  return String(sdp || '').split('\n').filter((l) => !l.startsWith('a=candidate')).join('\n');
}
module.exports = { stripCandidates };
