const { ipcRenderer } = require('electron');
const { getCurrentSession, supabase } = require('./auth');
const { upsertOwnDevice, heartbeat, renameDevice, createInvite } = require('./devices');
const { ICE_SERVERS, STREAM_PRESETS } = require('./config');

const nameInput = document.getElementById('nameInput');
const saveNameBtn = document.getElementById('saveNameBtn');
const statusEl = document.getElementById('status');
const inviteCodeEl = document.getElementById('inviteCode');
const inviteBtn = document.getElementById('inviteBtn');
const monitorSelect = document.getElementById('monitorSelect');
const qualitySelect = document.getElementById('qualitySelect');
const saveCaptureBtn = document.getElementById('saveCaptureBtn');
const clearHistoryBtn = document.getElementById('clearHistoryBtn');
const logEl = document.getElementById('log');

const rtcConfig = { iceServers: ICE_SERVERS };
const MAX_CLIPBOARD_CHARS = 1_000_000;

let session;
let deviceId;
let pc;
let dataChannel;
let channel;
let heartbeatTimer;
let clipboardTimer;
let currentCaptureSettings = { monitorName: null, quality: 'balanced' };

function appendLogLine(timestamp, msg) {
  const line = document.createElement('div');
  line.textContent = `${new Date(timestamp).toLocaleTimeString()} — ${msg}`;
  logEl.prepend(line);
}

function log(msg) {
  const timestamp = new Date().toISOString();
  appendLogLine(timestamp, msg);
  void ipcRenderer.invoke('host-history-append', { timestamp, message: msg });
}

async function loadHistory() {
  try {
    const entries = await ipcRenderer.invoke('host-history-load');
    logEl.innerHTML = '';
    entries.slice().reverse().forEach((entry) => appendLogLine(entry.timestamp, entry.message));
  } catch (err) {
    console.warn('Could not load connection history:', err.message);
  }
}

function renderMonitorOptions(sources, preferredName) {
  monitorSelect.innerHTML = '';
  sources.forEach((source, index) => {
    const option = document.createElement('option');
    option.value = source.name;
    option.textContent = `${source.name}${index === 0 ? ' (primary)' : ''}`;
    monitorSelect.appendChild(option);
  });

  if (preferredName && sources.some((source) => source.name === preferredName)) {
    monitorSelect.value = preferredName;
  } else if (sources.length) {
    monitorSelect.selectedIndex = 0;
  }
}

function renderQualityOptions(selected) {
  qualitySelect.innerHTML = '';
  Object.entries(STREAM_PRESETS).forEach(([key, preset]) => {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = preset.label;
    qualitySelect.appendChild(option);
  });
  qualitySelect.value = STREAM_PRESETS[selected] ? selected : 'balanced';
}

async function refreshCaptureSources() {
  const sources = await ipcRenderer.invoke('get-sources');
  if (!sources.length) throw new Error('No screen sources available.');
  renderMonitorOptions(sources, currentCaptureSettings.monitorName);
  return sources;
}

async function saveCaptureSettings() {
  currentCaptureSettings.monitorName = monitorSelect.value || null;
  currentCaptureSettings.quality = qualitySelect.value in STREAM_PRESETS ? qualitySelect.value : 'balanced';
  await ipcRenderer.invoke('app-settings-set', currentCaptureSettings);
  log(`Saved capture settings: ${currentCaptureSettings.monitorName || 'primary display'} · ${STREAM_PRESETS[currentCaptureSettings.quality].label}`);
}

function parseInputMessage(raw) {
  try {
    const msg = JSON.parse(raw);
    if (msg && msg.type) return msg;
  } catch {
    // Ignore malformed data-channel messages.
  }
  return null;
}

async function handleInputMessage(raw) {
  const msg = parseInputMessage(raw);
  if (!msg) return;

  if (msg.type === 'clipboard') {
    if (typeof msg.text !== 'string' || msg.text.length > MAX_CLIPBOARD_CHARS) return;
    try {
      await ipcRenderer.invoke('clipboard-write', msg.text);
      lastClipboardText = msg.text;
    } catch (err) {
      console.warn('Could not write remote clipboard:', err.message);
    }
    return;
  }

  switch (msg.type) {
    case 'move':
      ipcRenderer.send('robot-move', { x: msg.x, y: msg.y });
      break;
    case 'click':
      ipcRenderer.send('robot-click', { button: msg.button });
      break;
    case 'scroll':
      ipcRenderer.send('robot-scroll', { dx: msg.dx, dy: msg.dy });
      break;
    case 'key':
      ipcRenderer.send('robot-keytap', { key: msg.key, modifiers: msg.modifiers });
      break;
  }
}

async function startClipboardSync() {
  if (clipboardTimer) clearInterval(clipboardTimer);
  try {
    lastClipboardText = await ipcRenderer.invoke('clipboard-read');
  } catch {
    lastClipboardText = '';
  }
  clipboardTimer = setInterval(async () => {
    if (!dataChannel || dataChannel.readyState !== 'open') return;
    try {
      const current = await ipcRenderer.invoke('clipboard-read');
      if (current !== lastClipboardText && current.length <= MAX_CLIPBOARD_CHARS) {
        lastClipboardText = current;
        dataChannel.send(JSON.stringify({ type: 'clipboard', text: current }));
      }
    } catch {
      // Clipboard access may fail temporarily while Windows apps change focus.
    }
  }, 1500);
}

let lastClipboardText = '';

async function startCapture() {
  const sources = await ipcRenderer.invoke('get-sources');
  if (!sources.length) throw new Error('No screen sources available.');

  const preferred = currentCaptureSettings.monitorName;
  const selected = sources.find((source) => source.name === preferred) || sources[0];
  const preset = STREAM_PRESETS[currentCaptureSettings.quality] || STREAM_PRESETS.balanced;

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: selected.id
      }
    }
  });

  const track = stream.getVideoTracks()[0];
  if (track?.applyConstraints) {
    try {
      await track.applyConstraints({
        width: { max: preset.width },
        height: { max: preset.height },
        frameRate: { max: preset.frameRate }
      });
    } catch (err) {
      console.warn('Capture constraints were not accepted; continuing with source defaults:', err.message);
    }
  }

  return stream;
}

async function setupPeerConnection(stream) {
  pc = new RTCPeerConnection(rtcConfig);
  stream.getTracks().forEach((track) => pc.addTrack(track, stream));

  const sender = pc.getSenders().find((item) => item.track?.kind === 'video');
  if (sender) {
    try {
      const preset = STREAM_PRESETS[currentCaptureSettings.quality] || STREAM_PRESETS.balanced;
      const params = sender.getParameters();
      params.encodings = params.encodings?.length ? params.encodings : [{}];
      params.encodings[0].maxBitrate = preset.maxBitrate;
      params.encodings[0].maxFramerate = preset.frameRate;
      await sender.setParameters(params);
    } catch (err) {
      console.warn('Could not apply video encoder limits:', err.message);
    }
  }

  dataChannel = pc.createDataChannel('input', { ordered: true });
  dataChannel.onmessage = (e) => void handleInputMessage(e.data);
  dataChannel.onopen = () => {
    void startClipboardSync();
    log('Remote control channel connected.');
  };
  dataChannel.onclose = () => {
    if (clipboardTimer) clearInterval(clipboardTimer);
    log('Remote control channel closed.');
  };

  pc.onconnectionstatechange = () => {
    if (!pc) return;
    if (pc.connectionState === 'connected') statusEl.textContent = 'Connected — someone is viewing/controlling this PC.';
    if (['failed', 'disconnected'].includes(pc.connectionState)) {
      statusEl.textContent = `Connection ${pc.connectionState}.`;
      log(`WebRTC connection ${pc.connectionState}.`);
    }
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      channel.send({
        type: 'broadcast',
        event: 'ice-candidate',
        payload: { from: 'host', candidate: e.candidate }
      });
    }
  };
}

async function isTrusted(viewerId, viewerEmail) {
  if (viewerId === session.user.id) return true;
  const { data, error } = await supabase
    .from('paired_viewers')
    .select('id')
    .eq('device_id', deviceId)
    .eq('viewer_email', viewerEmail)
    .maybeSingle();
  if (error) {
    console.warn('Pairing check failed:', error.message);
    return false;
  }
  return !!data;
}

async function isBanned(payload) {
  const { data, error } = await supabase
    .from('bans')
    .select('kind, value')
    .or(`device_id.eq.${deviceId},device_id.is.null`);
  if (error) {
    console.warn('Ban check failed:', error.message);
    return false;
  }
  return data.some((b) => {
    if (b.kind === 'email') return b.value === payload.email;
    if (b.kind === 'hwid') return payload.hwid && b.value === payload.hwid;
    if (b.kind === 'ip') return payload.ip && b.value === payload.ip;
    return false;
  });
}

async function handleViewerReady(payload) {
  const idBits = `email: ${payload.email || '—'} · hwid: ${payload.hwid || '—'} · ip: ${payload.ip || '—'}`;

  if (await isBanned(payload)) {
    log(`Blocked a banned viewer — ${idBits}`);
    return;
  }

  const trusted = await isTrusted(payload.id, payload.email);
  if (!trusted) {
    log(`Ignored connection attempt (not paired to this PC) — ${idBits}`);
    return;
  }

  log(`${payload.name || payload.email || 'Viewer'} connecting — ${idBits}`);
  statusEl.textContent = 'Connecting…';
  try {
    if (pc) {
      try { pc.close(); } catch {}
      pc = null;
      dataChannel = null;
    }
    const stream = await startCapture();
    await setupPeerConnection(stream);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    channel.send({ type: 'broadcast', event: 'offer', payload: { sdp: offer } });
    log('Sent WebRTC offer.');
  } catch (err) {
    statusEl.textContent = `Failed to start screen share: ${err.message}`;
    log(`Failed to start screen share: ${err.message}`);
  }
}

async function init() {
  await loadHistory();
  const settings = await ipcRenderer.invoke('app-settings-get');
  currentCaptureSettings = {
    monitorName: settings.monitorName || null,
    quality: settings.quality in STREAM_PRESETS ? settings.quality : 'balanced'
  };
  renderQualityOptions(currentCaptureSettings.quality);

  session = await getCurrentSession();
  if (!session) {
    statusEl.textContent = 'Please sign in from the main window first.';
    return;
  }

  const local = await ipcRenderer.invoke('device-get-local');
  deviceId = local.id;
  nameInput.value = local.name;

  try {
    await refreshCaptureSources();
    await upsertOwnDevice(session.user.id, deviceId, local.name);
  } catch (err) {
    statusEl.textContent = `Could not register this device: ${err.message}`;
    log(`Startup failed: ${err.message}`);
    return;
  }

  heartbeatTimer = setInterval(() => heartbeat(deviceId).catch(() => {}), 20000);
  channel = supabase.channel(`room-${deviceId}`, {
    config: { broadcast: { self: false }, private: true }
  });

  channel
    .on('broadcast', { event: 'viewer-ready' }, ({ payload }) => handleViewerReady(payload))
    .on('broadcast', { event: 'answer' }, async ({ payload }) => {
      if (!pc) return;
      try {
        await pc.setRemoteDescription(payload.sdp);
        statusEl.textContent = 'Connected — someone is viewing/controlling this PC.';
        log('WebRTC answer received; connection negotiating.');
      } catch (err) {
        log(`Failed to apply answer: ${err.message}`);
      }
    })
    .on('broadcast', { event: 'ice-candidate' }, async ({ payload }) => {
      if (payload.from === 'viewer' && pc) {
        try {
          await pc.addIceCandidate(payload.candidate);
        } catch (err) {
          console.warn('Failed to add ICE candidate:', err);
        }
      }
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        statusEl.textContent = 'Ready — waiting for a connection.';
        log('Hosting is ready.');
      }
    });
}

saveNameBtn.addEventListener('click', async () => {
  const name = nameInput.value.trim();
  if (!name || !deviceId) return;
  await ipcRenderer.invoke('device-set-local-name', name);
  try {
    await renameDevice(deviceId, name);
    log('Renamed this device.');
  } catch (err) {
    log(`Failed to save name: ${err.message}`);
  }
});

saveCaptureBtn.addEventListener('click', async () => {
  try {
    await saveCaptureSettings();
  } catch (err) {
    log(`Failed to save capture settings: ${err.message}`);
  }
});

clearHistoryBtn.addEventListener('click', async () => {
  await ipcRenderer.invoke('host-history-clear');
  logEl.innerHTML = '';
  appendLogLine(new Date().toISOString(), 'Local connection history cleared.');
});

inviteBtn.addEventListener('click', async () => {
  if (!deviceId) return;
  inviteBtn.disabled = true;
  try {
    const code = await createInvite(deviceId);
    inviteCodeEl.textContent = code;
    log('Invite code generated — valid 10 minutes, one-time use.');
  } catch (err) {
    inviteCodeEl.textContent = 'Error';
    log(`Failed to create invite: ${err.message}`);
  } finally {
    inviteBtn.disabled = false;
  }
});

window.addEventListener('beforeunload', () => {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (clipboardTimer) clearInterval(clipboardTimer);
  if (pc) pc.close();
  if (channel) channel.unsubscribe();
});

init();
