const { ipcRenderer } = require('electron');
const { signInWithGoogle, getCurrentSession, signOut } = require('./auth');
const { listMyDevices, isOnline, createInvite, redeemInvite } = require('./devices');

const signedOutEl = document.getElementById('signedOut');
const dashboardEl = document.getElementById('dashboard');
const googleBtn = document.getElementById('googleBtn');
const signInMsg = document.getElementById('signInMsg');
const signOutBtn = document.getElementById('signOutBtn');
const avatarEl = document.getElementById('avatar');
const nameEl = document.getElementById('accountName');
const emailEl = document.getElementById('accountEmail');
const deviceListEl = document.getElementById('deviceList');
const deviceEmptyEl = document.getElementById('deviceEmpty');
const hostBtn = document.getElementById('hostBtn');
const inviteInput = document.getElementById('inviteInput');
const inviteBtn = document.getElementById('inviteBtn');
const msgEl = document.getElementById('msg');
const autoStartCheck = document.getElementById('autoStartCheck');
const autoHostCheck = document.getElementById('autoHostCheck');
const settingsMsgEl = document.getElementById('settingsMsg');

let refreshTimer = null;
let currentUserId = null;

function showMsg(text, kind) {
  msgEl.textContent = text;
  msgEl.className = kind || '';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function renderDevices(devices) {
  deviceListEl.innerHTML = '';
  if (!devices.length) {
    deviceEmptyEl.style.display = 'block';
    return;
  }
  deviceEmptyEl.style.display = 'none';

  devices.forEach((d) => {
    const online = isOnline(d);
    const owned = d.owner_user_id === currentUserId;
    const row = document.createElement('div');
    row.className = 'device-row';
    row.innerHTML = `
      <div class="device-info">
        <span class="dot ${online ? 'online' : ''}"></span>
        <div>
          <div class="device-name">${escapeHtml(d.name)}</div>
          <div class="device-meta">${online ? 'Online' : 'Offline'}</div>
        </div>
      </div>
      <div class="device-actions">
        ${owned ? `<button class="manage-btn" title="Manage" data-manage-id="${d.id}" data-manage-name="${escapeHtml(d.name)}">⚙</button>` : ''}
        <button class="connect-btn" ${online ? '' : 'disabled'} data-id="${d.id}" data-name="${escapeHtml(d.name)}">
          Connect
        </button>
      </div>
    `;
    deviceListEl.appendChild(row);
  });

  deviceListEl.querySelectorAll('.manage-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      ipcRenderer.invoke('open-window', 'manage.html', {
        deviceId: btn.dataset.manageId,
        deviceName: btn.dataset.manageName
      });
    });
  });

  deviceListEl.querySelectorAll('.connect-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      ipcRenderer.invoke('open-window', 'viewer.html', {
        deviceId: btn.dataset.id,
        deviceName: btn.dataset.name
      });
    });
  });
}

async function refreshDevices() {
  try {
    renderDevices(await listMyDevices());
  } catch (err) {
    console.warn('Failed to load devices:', err.message);
  }
}

async function loadAppSettings() {
  try {
    const settings = await ipcRenderer.invoke('app-settings-get');
    autoStartCheck.checked = !!settings.autoStart;
    autoHostCheck.checked = !!settings.autoHost;
  } catch (err) {
    settingsMsgEl.textContent = `Could not load background settings: ${err.message}`;
  }
}

async function saveAppSetting(key, value) {
  try {
    await ipcRenderer.invoke('app-settings-set', { [key]: value });
    settingsMsgEl.textContent = key === 'autoHost'
      ? (value ? 'Background hosting enabled.' : 'Background hosting stopped.')
      : (value ? 'Windows startup enabled.' : 'Windows startup disabled.');
  } catch (err) {
    settingsMsgEl.textContent = `Could not save setting: ${err.message}`;
    if (key === 'autoStart') autoStartCheck.checked = !value;
    if (key === 'autoHost') autoHostCheck.checked = !value;
  }
}

function showDashboard(session) {
  signedOutEl.style.display = 'none';
  dashboardEl.style.display = 'block';
  currentUserId = session.user.id;

  const user = session.user;
  const meta = user.user_metadata || {};
  nameEl.textContent = meta.full_name || meta.name || user.email;
  emailEl.textContent = user.email;
  const avatarUrl = meta.avatar_url || meta.picture;
  if (avatarUrl) {
    avatarEl.src = avatarUrl;
    avatarEl.style.display = 'block';
  }

  refreshDevices();
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshDevices, 15000);
}

function showSignedOut() {
  dashboardEl.style.display = 'none';
  signedOutEl.style.display = 'flex';
  if (refreshTimer) clearInterval(refreshTimer);
}

googleBtn.addEventListener('click', async () => {
  googleBtn.disabled = true;
  signInMsg.textContent = 'Opening your browser to sign in…';
  try {
    const session = await signInWithGoogle();
    signInMsg.textContent = '';
    showDashboard(session);
  } catch (err) {
    signInMsg.textContent = `Sign-in failed: ${err.message}`;
  } finally {
    googleBtn.disabled = false;
  }
});

signOutBtn.addEventListener('click', async () => {
  await signOut();
  showSignedOut();
});

hostBtn.addEventListener('click', () => {
  ipcRenderer.invoke('open-window', 'host.html');
});

autoStartCheck.addEventListener('change', () => saveAppSetting('autoStart', autoStartCheck.checked));
autoHostCheck.addEventListener('change', () => saveAppSetting('autoHost', autoHostCheck.checked));

inviteBtn.addEventListener('click', async () => {
  const code = inviteInput.value.trim();
  if (!code) return;
  inviteBtn.disabled = true;
  showMsg('Adding…');
  try {
    const device = await redeemInvite(code);
    showMsg(`Added "${device.name}".`, 'ok');
    inviteInput.value = '';
    refreshDevices();
  } catch (err) {
    showMsg(err.message || 'Could not redeem that code.', 'error');
  } finally {
    inviteBtn.disabled = false;
  }
});

(async () => {
  await loadAppSettings();
  const session = await getCurrentSession();
  if (session) showDashboard(session);
  else showSignedOut();
})();
