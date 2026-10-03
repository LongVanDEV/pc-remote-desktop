/** Handler stub 1 */
module.exports = function handler_01(msg) {
  return { handled: false, id: 1, type: msg && msg.type };
};
