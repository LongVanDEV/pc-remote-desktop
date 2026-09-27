const { ipcRenderer } = require('electron');
const { getCurrentSession, supabase } = require('./auth');
const { ICE_SERVERS } = require('./config');

const statusEl = document.getElementById('status');
const deviceLabelEl = document.getElementById('deviceLabel');
const video = document.getElementById('remoteVideo');

const rtcConfig = { iceServers: ICE_SERVERS };
const MAX_CLIPBOARD_CHARS = 1_000_000;

let pc;
let dataChannel;
let clipboardTimer;
let lastClipboardText = '';
let remoteScreenSize = { width: 1920, height: 1080 };

function sendInput(msg) {
  if (dataChannel && dataChannel.readyState === 'open') {
    dataChannel.send(JSON.stringify(msg));
  }
}

function collectModifiers(e) {
  const mods = [];
  if (e.shiftKey) mods.push('shift');
  if (e.ctrlKey) mods.push('control');
  if (e.altKey) mods.push('alt');
  if (e.metaKey) mods.push('command');
  return mods;
}

async function handleDataMessage(raw) {
  try {
    const msg = JSON.parse(raw);
    if (msg.type !== 'clipboard' || typeof msg.text !== 'string') return;
    if (msg.text.length > MAX_CLIPBOARD_CHARS) return;
    await ipcRenderer.invoke('clipboard-write', msg.text);
    lastClipboardText = msg.text;
  } catch (err) {
    console.warn('Could not update local clipboard:', err.message);
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
        sendInput({ type: 'clipboard', text: current });
      }
    } catch {
      // Ignore temporary clipboard access failures.
    }
  }, 1500);
}

function attachControlListeners() {
  video.addEventListener('mousemove', (e) => {
    const rect = video.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const xRatio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const yRatio = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    sendInput({
      type: 'move',
      x: Math.round(xRatio * remoteScreenSize.width),
      y: Math.round(yRatio * remoteScreenSize.height)
    });
  });

  video.addEventListener('mousedown', (e) => {
    sendInput({ type: 'click', button: e.button === 2 ? 'right' : 'left' });
  });

  video.addEventListener('wheel', (e) => {
    e.preventDefault();
    sendInput({ type: 'scroll', dx: e.deltaX, dy: e.deltaY });
  }, { passive: false });

  video.addEventListener('contextmenu', (e) => e.preventDefault());

  window.addEventListener('keydown', (e) => {
    e.preventDefault();
    sendInput({ type: 'key', key: e.key.toLowerCase(), modifiers: collectModifiers(e) });
  });
}

video.addEventListener('loadedmetadata', () => {
  remoteScreenSize = { width: video.videoWidth, height: video.videoHeight };
});

async function fetchHwid() {
  try {
    return await ipcRenderer.invoke('get-hwid');
  } catch {
    return null;
  }
}

async function fetchPublicIp() {
  try {
    const res = await fetch('https://api.ipify.org?format=json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return json.ip || null;
  } catch {
    return null;
  }
}

async function connect() {
  const params = new URLSearchParams(window.location.search);
  const deviceId = params.get('deviceId');
  const deviceName = params.get('deviceName') || 'PC';
  deviceLabelEl.textContent = deviceName;

  if (!deviceId) {
    statusEl.textContent = 'No device specified — go back and pick one from My PCs.';
    return;
  }

  const session = await getCurrentSession();
  if (!session) {
    statusEl.textContent = 'Please sign in from the main window first.';
    return;
  }

  statusEl.textContent = 'Connecting…';

  const [hwid, ip] = await Promise.all([fetchHwid(), fetchPublicIp()]);

  const channel = supabase.channel(`room-${deviceId}`, {
    config: { broadcast: { self: false }, private: true }
  });

  pc = new RTCPeerConnection(rtcConfig);

  pc.ontrack = (e) => {
    video.srcObject = e.streams[0];
  };

  pc.onconnectionstatechange = () => {
    if (!pc) return;
    if (pc.connectionState === 'connected') statusEl.textContent = 'Connected.';
    if (['failed', 'disconnected'].includes(pc.connectionState)) {
      statusEl.textContent = `Connection ${pc.connectionState}.`;
    }
  };

  pc.ondatachannel = (e) => {
    dataChannel = e.channel;
    dataChannel.onmessage = (event) => void handleDataMessage(event.data);
    dataChannel.onopen = () => {
      attachControlListeners();
      void startClipboardSync();
    };
    dataChannel.onclose = () => {
      if (clipboardTimer) clearInterval(clipboardTimer);
    };
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      channel.send({
        type: 'broadcast',
        event: 'ice-candidate',
        payload: { from: 'viewer', candidate: e.candidate }
      });
    }
  };

  channel
    .on('broadcast', { event: 'offer' }, async ({ payload }) => {
      try {
        await pc.setRemoteDescription(payload.sdp);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        channel.send({ type: 'broadcast', event: 'answer', payload: { sdp: answer } });
        statusEl.textContent = 'Negotiating…';
      } catch (err) {
        statusEl.textContent = `Failed to negotiate: ${err.message}`;
      }
    })
    .on('broadcast', { event: 'ice-candidate' }, async ({ payload }) => {
      if (payload.from === 'host' && pc) {
        try {
          await pc.addIceCandidate(payload.candidate);
        } catch (err) {
          console.warn('Failed to add ICE candidate:', err);
        }
      }
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        channel.send({
          type: 'broadcast',
          event: 'viewer-ready',
          payload: {
            id: session.user.id,
            email: session.user.email,
            name: session.user.user_metadata?.full_name,
            hwid,
            ip
          }
        });
        statusEl.textContent = 'Waiting for host…';
      }
    });

  window.addEventListener('beforeunload', () => {
    if (clipboardTimer) clearInterval(clipboardTimer);
    if (pc) pc.close();
    channel.unsubscribe();
  });
}

connect();
