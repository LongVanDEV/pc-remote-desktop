/** Handler stub 2 */
module.exports = function handler_02(msg) {
  return { handled: false, id: 2, type: msg && msg.type };
};
