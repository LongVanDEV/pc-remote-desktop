const { ipcRenderer } = require('electron');
const { getCurrentSession } = require('./auth');
const {
  listPairedViewers,
  removePairedViewer,
  banAndRemovePairing,
  listBans,
  addBan,
  removeBan,
  deleteDevice,
  isAdmin
} = require('./devices');

const titleEl = document.getElementById('deviceTitle');
const pairedListEl = document.getElementById('pairedList');
const pairedEmptyEl = document.getElementById('pairedEmpty');
const banListEl = document.getElementById('banList');
const banEmptyEl = document.getElementById('banEmpty');
const banKindEl = document.getElementById('banKind');
const banValueEl = document.getElementById('banValue');
const banReasonEl = document.getElementById('banReason');
const banScopeEl = document.getElementById('banScope');
const banBtn = document.getElementById('banBtn');
const deleteDeviceBtn = document.getElementById('deleteDeviceBtn');
const msgEl = document.getElementById('msg');

let session;
let deviceId;

function showMsg(text, kind) {
  msgEl.textContent = text;
  msgEl.className = kind || '';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString();
}

async function refreshPaired() {
  const rows = await listPairedViewers(deviceId);
  pairedListEl.innerHTML = '';
  if (!rows.length) {
    pairedEmptyEl.style.display = 'block';
    return;
  }
  pairedEmptyEl.style.display = 'none';
  rows.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `
      <div class="main">
        <div class="primary">${escapeHtml(r.viewer_email)}</div>
        <div class="meta">Added ${fmtDate(r.created_at)}</div>
      </div>
      <div class="actions">
        <button class="btn-neutral" data-remove="${r.id}">Remove</button>
        <button class="btn-danger" data-ban="${r.id}" data-email="${escapeHtml(r.viewer_email)}">Ban</button>
      </div>
    `;
    pairedListEl.appendChild(row);
  });

  pairedListEl.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await removePairedViewer(btn.dataset.remove);
        await refreshPaired();
      } catch (err) {
        showMsg(err.message, 'error');
        btn.disabled = false;
      }
    });
  });

  pairedListEl.querySelectorAll('[data-ban]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await banAndRemovePairing(session.user.id, deviceId, btn.dataset.ban, btn.dataset.email);
        await Promise.all([refreshPaired(), refreshBans()]);
        showMsg(`Banned ${btn.dataset.email}.`, 'ok');
      } catch (err) {
        showMsg(err.message, 'error');
        btn.disabled = false;
      }
    });
  });
}

async function refreshBans() {
  const rows = await listBans(deviceId);
  banListEl.innerHTML = '';
  if (!rows.length) {
    banEmptyEl.style.display = 'block';
    return;
  }
  banEmptyEl.style.display = 'none';
  rows.forEach((b) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `
      <div class="main">
        <div class="primary"><span class="badge">${escapeHtml(b.kind)}</span>${escapeHtml(b.value)}</div>
        <div class="meta">
          ${b.is_global ? '<span class="badge badge-global">Network</span>Entire network' : b.device_id ? 'This PC only' : 'All your PCs'}${b.reason ? ' — ' + escapeHtml(b.reason) : ''}
        </div>
      </div>
      <div class="actions">
        <button class="btn-neutral" data-unban="${b.id}">Unban</button>
      </div>
    `;
    banListEl.appendChild(row);
  });

  banListEl.querySelectorAll('[data-unban]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await removeBan(btn.dataset.unban);
        await refreshBans();
      } catch (err) {
        showMsg(err.message, 'error');
        btn.disabled = false;
      }
    });
  });
}

banBtn.addEventListener('click', async () => {
  const kind = banKindEl.value;
  const value = banValueEl.value;
  const reason = banReasonEl.value;
  const scope = banScopeEl.value;
  banBtn.disabled = true;
  try {
    await addBan(session.user.id, deviceId, kind, value, reason, scope);
    banValueEl.value = '';
    banReasonEl.value = '';
    await Promise.all([refreshBans(), refreshPaired()]);
    showMsg('Banned.', 'ok');
  } catch (err) {
    showMsg(err.message, 'error');
  } finally {
    banBtn.disabled = false;
  }
});

deleteDeviceBtn.addEventListener('click', async () => {
  const ok = confirm('Remove this PC? Anyone paired to it will lose access, and it will disappear from your My PCs list.');
  if (!ok) return;
  deleteDeviceBtn.disabled = true;
  try {
    await deleteDevice(deviceId);
    window.close();
  } catch (err) {
    showMsg(err.message, 'error');
    deleteDeviceBtn.disabled = false;
  }
});

(async () => {
  const params = new URLSearchParams(window.location.search);
  deviceId = params.get('deviceId');
  titleEl.textContent = `Manage “${params.get('deviceName') || 'PC'}”`;

  session = await getCurrentSession();
  if (!session || !deviceId) {
    showMsg('Missing session or device — close this window and try again from the dashboard.', 'error');
    return;
  }

  try {
    await Promise.all([refreshPaired(), refreshBans()]);
  } catch (err) {
    showMsg(err.message, 'error');
  }

  if (await isAdmin()) {
    const opt = document.createElement('option');
    opt.value = 'global';
    opt.textContent = 'Entire network (all PCs, any owner)';
    banScopeEl.appendChild(opt);
  }
})();
