function roomName(deviceId) { return 'room-' + deviceId; }
function createOfferPlaceholder() { return { type: 'offer', sdp: 'v=0\r\n' }; }
module.exports = { roomName, createOfferPlaceholder };
