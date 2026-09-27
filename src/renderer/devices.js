const { supabase } = require('./auth');

const ONLINE_WINDOW_MS = 45000; // matches the ~20s heartbeat interval in host.js
const INVITE_WINDOW_MS = 60_000;
const MAX_FAILED_INVITES_PER_WINDOW = 8;
let inviteFailures = [];

function randomInviteCode(length = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
  const random = new Uint32Array(length);
  crypto.getRandomValues(random);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += chars[random[i] % chars.length];
  }
  return out;
}

async function upsertOwnDevice(ownerUserId, deviceId, name) {
  const { error } = await supabase
    .from('devices')
    .upsert({ id: deviceId, owner_user_id: ownerUserId, name, last_seen: new Date().toISOString() });
  if (error) throw error;
}

async function heartbeat(deviceId) {
  const { error } = await supabase
    .from('devices')
    .update({ last_seen: new Date().toISOString() })
    .eq('id', deviceId);
  if (error) throw error;
}

async function renameDevice(deviceId, name) {
  const { error } = await supabase.from('devices').update({ name }).eq('id', deviceId);
  if (error) throw error;
}

async function listMyDevices() {
  const { data, error } = await supabase.from('devices').select('*').order('name');
  if (error) throw error;
  return data;
}

function isOnline(device) {
  if (!device.last_seen) return false;
  return Date.now() - new Date(device.last_seen).getTime() < ONLINE_WINDOW_MS;
}

async function createInvite(deviceId) {
  // crypto-backed code generation avoids Math.random() predictability.
  // A unique violation simply causes the caller to retry.
  const code = randomInviteCode();
  const { error } = await supabase.from('device_invites').insert({ code, device_id: deviceId });
  if (error) throw error;
  return code;
}

function enforceInviteAttemptLimit() {
  const now = Date.now();
  inviteFailures = inviteFailures.filter((time) => now - time < INVITE_WINDOW_MS);
  if (inviteFailures.length >= MAX_FAILED_INVITES_PER_WINDOW) {
    throw new Error('Too many invalid invite attempts. Try again in a minute.');
  }
}

async function redeemInvite(rawCode) {
  enforceInviteAttemptLimit();
  const code = rawCode.trim().toUpperCase();
  if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) {
    inviteFailures.push(Date.now());
    throw new Error('Invite codes are 6 letters/numbers.');
  }

  const { data, error } = await supabase.rpc('redeem_device_invite', { invite_code: code });
  if (error) {
    inviteFailures.push(Date.now());
    throw error;
  }
  inviteFailures = [];
  return data;
}

async function deleteDevice(deviceId) {
  const { error } = await supabase.from('devices').delete().eq('id', deviceId);
  if (error) throw error;
}

async function listPairedViewers(deviceId) {
  const { data, error } = await supabase
    .from('paired_viewers')
    .select('*')
    .eq('device_id', deviceId)
    .order('created_at');
  if (error) throw error;
  return data;
}

async function removePairedViewer(pairId) {
  const { error } = await supabase.from('paired_viewers').delete().eq('id', pairId);
  if (error) throw error;
}

async function listBans(deviceId) {
  const { data, error } = await supabase
    .from('bans')
    .select('*')
    .or(`device_id.eq.${deviceId},device_id.is.null`)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

async function addBan(ownerUserId, deviceId, kind, value, reason, scope) {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('Enter a value to ban.');
  const isGlobal = scope === 'global';
  const { error } = await supabase.from('bans').insert({
    owner_user_id: ownerUserId,
    device_id: scope === 'device' ? deviceId : null,
    is_global: isGlobal,
    kind,
    value: trimmed,
    reason: reason ? reason.trim() : null
  });
  if (error) throw error;
}

async function removeBan(banId) {
  const { error } = await supabase.from('bans').delete().eq('id', banId);
  if (error) throw error;
}

async function banAndRemovePairing(ownerUserId, deviceId, pairId, email) {
  await addBan(ownerUserId, deviceId, 'email', email, 'Banned from paired-viewer list', 'device');
  if (pairId) await removePairedViewer(pairId);
}

async function isAdmin() {
  const { data, error } = await supabase.rpc('is_admin');
  if (error) {
    console.warn('is_admin check failed:', error.message);
    return false;
  }
  return !!data;
}

module.exports = {
  upsertOwnDevice,
  heartbeat,
  renameDevice,
  listMyDevices,
  isOnline,
  createInvite,
  redeemInvite,
  deleteDevice,
  listPairedViewers,
  removePairedViewer,
  listBans,
  addBan,
  removeBan,
  banAndRemovePairing,
  isAdmin
};
