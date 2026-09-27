const {
  app,
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  shell,
  safeStorage,
  Tray,
  Menu,
  nativeImage,
  clipboard
} = require('electron');
const { spawn, exec } = require('child_process');
const http = require('http');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { autoUpdater } = require('electron-updater');

// ---------------------------------------------------------------------
// Persistent app settings, tray/background hosting, and Windows startup.
// ---------------------------------------------------------------------

const DEFAULT_APP_SETTINGS = {
  autoStart: false,
  autoHost: false,
  monitorName: null,
  quality: 'balanced'
};

let appSettings = { ...DEFAULT_APP_SETTINGS };
let tray = null;
let isQuitting = false;
let launcherWindow = null;
let updateStatus = 'GitHub updater not configured';
const hostWindows = new Set();

function settingsFilePath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function hostHistoryFilePath() {
  return path.join(app.getPath('userData'), 'host-history.json');
}

function loadAppSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFilePath(), 'utf8'));
    appSettings = {
      ...DEFAULT_APP_SETTINGS,
      ...parsed,
      autoStart: !!parsed.autoStart,
      autoHost: !!parsed.autoHost
    };
  } catch {
    appSettings = { ...DEFAULT_APP_SETTINGS };
  }
}

function saveAppSettings() {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(settingsFilePath(), JSON.stringify(appSettings, null, 2), 'utf8');
}

function applyLoginItemSetting() {
  if (process.platform !== 'win32') return;
  // Login-item registration is useful for the packaged app. In development,
  // auto-starting the Electron runtime itself is surprising, so we leave it off.
  app.setLoginItemSettings({
    openAtLogin: app.isPackaged && appSettings.autoStart,
    path: app.getPath('exe'),
    name: 'PC Remote Desktop'
  });
}

function getTrayIcon() {
  const iconPath = path.join(__dirname, 'tray-icon.png');
  if (fs.existsSync(iconPath)) return nativeImage.createFromPath(iconPath);
  return nativeImage.createEmpty();
}

function destroyTray() {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

function showLauncher() {
  if (!launcherWindow || launcherWindow.isDestroyed()) {
    launcherWindow = createWindow('launcher.html');
  }
  launcherWindow.show();
  launcherWindow.focus();
}

function hasActiveHost() {
  return [...hostWindows].some((win) => win && !win.isDestroyed());
}

function startHost(background = false) {
  for (const win of hostWindows) {
    if (!win.isDestroyed()) {
      if (!background) {
        win.show();
        win.focus();
      }
      return win;
    }
  }
  return createWindow('host.html', background ? { background: '1' } : undefined, { background, isHost: true });
}

function stopHosting() {
  for (const win of [...hostWindows]) {
    if (!win.isDestroyed()) win.close();
  }
  hostWindows.clear();
}

function configureAutoUpdater() {
  if (!app.isPackaged || process.platform !== 'win32') {
    updateStatus = 'GitHub updater is available in packaged Windows builds';
    return;
  }

  try {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('checking-for-update', () => {
      updateStatus = 'Checking for updates…';
      rebuildTrayMenu();
    });
    autoUpdater.on('update-available', (info) => {
      updateStatus = `Update ${info.version} downloading…`;
      rebuildTrayMenu();
    });
    autoUpdater.on('update-downloaded', (info) => {
      updateStatus = `Update ${info.version} ready`;
      rebuildTrayMenu();
    });
    autoUpdater.on('update-not-available', () => {
      updateStatus = 'Up to date';
      rebuildTrayMenu();
    });
    autoUpdater.on('error', (err) => {
      updateStatus = `Update error: ${err.message}`;
      console.warn('[updater]', err);
      rebuildTrayMenu();
    });
    void autoUpdater.checkForUpdates();
  } catch (err) {
    updateStatus = `Updater unavailable: ${err.message}`;
  }
}

async function checkForUpdates() {
  if (!app.isPackaged || process.platform !== 'win32') {
    updateStatus = 'Updates require a packaged Windows build';
    rebuildTrayMenu();
    return;
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    updateStatus = `Update error: ${err.message}`;
    rebuildTrayMenu();
  }
}

function rebuildTrayMenu() {
  if (!tray) return;
  const template = [
    { label: 'Open Dashboard', click: () => showLauncher() },
    {
      label: hasActiveHost() ? 'Hosting this PC' : 'Host this PC',
      enabled: !hasActiveHost(),
      click: () => startHost(false)
    },
    {
      label: 'Stop Hosting',
      enabled: hasActiveHost(),
      click: () => stopHosting()
    },
    { type: 'separator' },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: appSettings.autoStart,
      click: (item) => {
        appSettings.autoStart = item.checked;
        saveAppSettings();
        applyLoginItemSetting();
        rebuildTrayMenu();
      }
    },
    {
      label: 'Auto-host in background',
      type: 'checkbox',
      checked: appSettings.autoHost,
      click: (item) => {
        appSettings.autoHost = item.checked;
        saveAppSettings();
        if (item.checked) startHost(true);
        else stopHosting();
        rebuildTrayMenu();
      }
    },
    { type: 'separator' },
    { label: `Updates: ${updateStatus}`, enabled: false },
    { label: 'Check for updates', enabled: !!autoUpdater, click: () => void checkForUpdates() },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function ensureTray() {
  if (tray) return;
  tray = new Tray(getTrayIcon());
  tray.setToolTip('PC Remote Desktop');
  tray.on('double-click', () => showLauncher());
  rebuildTrayMenu();
}

// ---------------------------------------------------------------------
// Remote input, via a persistent PowerShell process (Windows only).
// ---------------------------------------------------------------------

const PS_SETUP = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class RemoteInput {
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
`;

let psProcess = null;

function ensurePowerShell() {
  if (process.platform !== 'win32') throw new Error('Remote input is currently supported on Windows hosts only.');
  if (psProcess && !psProcess.killed) return psProcess;
  psProcess = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', '-'], {
    windowsHide: true
  });
  psProcess.stdin.write(PS_SETUP + '\n');
  psProcess.stderr.on('data', (d) => console.warn('[powershell]', d.toString().trim()));
  psProcess.on('exit', () => {
    psProcess = null;
  });
  return psProcess;
}

function runPs(cmd) {
  const ps = ensurePowerShell();
  ps.stdin.write(cmd + '\n');
}

function moveMouse(x, y) {
  runPs(
    `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${Math.round(x)}, ${Math.round(y)})`
  );
}

function clickMouse(button) {
  const down = button === 'right' ? 0x0008 : 0x0002;
  const up = button === 'right' ? 0x0010 : 0x0004;
  runPs(
    `[RemoteInput]::mouse_event(${down},0,0,0,[UIntPtr]::Zero); [RemoteInput]::mouse_event(${up},0,0,0,[UIntPtr]::Zero)`
  );
}

function scroll(dx, dy) {
  if (dy) {
    const delta = dy > 0 ? -120 : 120;
    runPs(`[RemoteInput]::mouse_event(0x0800,0,0,${delta},[UIntPtr]::Zero)`);
  }
  if (dx) {
    const delta = dx > 0 ? 120 : -120;
    runPs(`[RemoteInput]::mouse_event(0x01000,0,0,${delta},[UIntPtr]::Zero)`);
  }
}

const VK_SPECIAL = {
  enter: 0x0d,
  tab: 0x09,
  escape: 0x1b,
  backspace: 0x08,
  delete: 0x2e,
  ' ': 0x20,
  arrowup: 0x26,
  arrowdown: 0x28,
  arrowleft: 0x25,
  arrowright: 0x27,
  capslock: 0x14,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  pagedown: 0x22,
  insert: 0x2d,
  ';': 0xba,
  '=': 0xbb,
  ',': 0xbc,
  '-': 0xbd,
  '.': 0xbe,
  '/': 0xbf,
  '`': 0xc0,
  '[': 0xdb,
  '\\': 0xdc,
  ']': 0xdd,
  "'": 0xde
};

const MODIFIER_VK = { shift: 0x10, control: 0x11, alt: 0x12, command: 0x5b };

function keyToVk(rawKey) {
  const key = rawKey.toLowerCase();
  if (key in VK_SPECIAL) return VK_SPECIAL[key];
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) return 0x70 + (parseInt(key.slice(1), 10) - 1);
  if (/^[a-z]$/.test(key)) return key.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(key)) return key.charCodeAt(0);
  return null;
}

function keyTap(key, modifiers = []) {
  const vk = keyToVk(key);
  if (vk === null) return;
  const modVks = modifiers.map((m) => MODIFIER_VK[m]).filter((v) => v !== undefined);

  const seq = [];
  modVks.forEach((v) => seq.push(`[RemoteInput]::keybd_event(${v},0,0,[UIntPtr]::Zero)`));
  seq.push(`[RemoteInput]::keybd_event(${vk},0,0,[UIntPtr]::Zero)`);
  seq.push(`[RemoteInput]::keybd_event(${vk},0,2,[UIntPtr]::Zero)`);
  [...modVks].reverse().forEach((v) => seq.push(`[RemoteInput]::keybd_event(${v},0,2,[UIntPtr]::Zero)`));

  runPs(seq.join('; '));
}

// ---------------------------------------------------------------------
// Google sign-in + encrypted local session storage.
// ---------------------------------------------------------------------

let oauthServer = null;

function sessionFilePath() {
  return path.join(app.getPath('userData'), 'session.dat');
}

function deviceFilePath() {
  return path.join(app.getPath('userData'), 'device.json');
}

ipcMain.handle('oauth-authorize', (event, { url, port }) => {
  return new Promise((resolve, reject) => {
    if (oauthServer) {
      oauthServer.close();
      oauthServer = null;
    }

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Sign-in timed out — please try again.'));
    }, 5 * 60 * 1000);

    function cleanup() {
      clearTimeout(timeout);
      if (oauthServer) {
        oauthServer.close();
        oauthServer = null;
      }
    }

    oauthServer = http.createServer((req, res) => {
      let reqUrl;
      try {
        reqUrl = new URL(req.url, `http://127.0.0.1:${port}`);
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      if (reqUrl.pathname !== '/callback') {
        res.writeHead(404);
        res.end();
        return;
      }
      const code = reqUrl.searchParams.get('code');
      const errorParam = reqUrl.searchParams.get('error_description') || reqUrl.searchParams.get('error');

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<html><body style="font-family:sans-serif;background:#0b0f14;color:#e6edf3;' +
          'display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">' +
          '<p>Signed in — you can close this tab and go back to the app.</p></body></html>'
      );

      cleanup();
      if (errorParam) reject(new Error(errorParam));
      else if (code) resolve(code);
      else reject(new Error('No authorization code received.'));
    });

    oauthServer.on('error', (err) => {
      cleanup();
      reject(err);
    });

    oauthServer.listen(port, '127.0.0.1', () => {
      shell.openExternal(url);
    });
  });
});

ipcMain.handle('auth-save-session', (event, sessionJson) => {
  const file = sessionFilePath();
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  if (safeStorage.isEncryptionAvailable()) {
    fs.writeFileSync(file, safeStorage.encryptString(sessionJson));
  } else {
    fs.writeFileSync(file, sessionJson, 'utf8');
  }
});

ipcMain.handle('auth-load-session', () => {
  try {
    const buf = fs.readFileSync(sessionFilePath());
    if (safeStorage.isEncryptionAvailable()) {
      try {
        return safeStorage.decryptString(buf);
      } catch {
        return buf.toString('utf8');
      }
    }
    return buf.toString('utf8');
  } catch {
    return null;
  }
});

ipcMain.handle('auth-clear-session', () => {
  try {
    fs.unlinkSync(sessionFilePath());
  } catch {
    // nothing to clear
  }
});

// ---------------------------------------------------------------------
// Stable local device identity + HWID.
// ---------------------------------------------------------------------

ipcMain.handle('device-get-local', () => {
  try {
    return JSON.parse(fs.readFileSync(deviceFilePath(), 'utf8'));
  } catch {
    const record = { id: crypto.randomUUID(), name: os.hostname() };
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(deviceFilePath(), JSON.stringify(record));
    return record;
  }
});

ipcMain.handle('device-set-local-name', (event, name) => {
  const record = JSON.parse(fs.readFileSync(deviceFilePath(), 'utf8'));
  record.name = name;
  fs.writeFileSync(deviceFilePath(), JSON.stringify(record));
  return record;
});

let cachedHwid = null;

ipcMain.handle('get-hwid', () => {
  if (cachedHwid) return Promise.resolve(cachedHwid);
  return new Promise((resolve) => {
    exec(
      'powershell -NoProfile -Command "(Get-CimInstance -ClassName Win32_ComputerSystemProduct).UUID"',
      { windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        cachedHwid = stdout.trim() || null;
        resolve(cachedHwid);
      }
    );
  });
});

// ---------------------------------------------------------------------
// Clipboard + persistent host connection history.
// ---------------------------------------------------------------------

const MAX_CLIPBOARD_CHARS = 1_000_000;
const MAX_HISTORY_ENTRIES = 500;

ipcMain.handle('clipboard-read', () => clipboard.readText().slice(0, MAX_CLIPBOARD_CHARS));

ipcMain.handle('clipboard-write', (event, text) => {
  if (typeof text !== 'string') throw new Error('Clipboard content must be text.');
  clipboard.writeText(text.slice(0, MAX_CLIPBOARD_CHARS));
});

ipcMain.handle('host-history-load', () => {
  try {
    const items = JSON.parse(fs.readFileSync(hostHistoryFilePath(), 'utf8'));
    return Array.isArray(items) ? items.slice(-MAX_HISTORY_ENTRIES) : [];
  } catch {
    return [];
  }
});

ipcMain.handle('host-history-append', (event, entry) => {
  if (!entry || typeof entry.message !== 'string') return;
  let items = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(hostHistoryFilePath(), 'utf8'));
    if (Array.isArray(parsed)) items = parsed;
  } catch {
    // start a fresh log
  }
  items.push({
    timestamp: entry.timestamp || new Date().toISOString(),
    message: entry.message.slice(0, 1000)
  });
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(hostHistoryFilePath(), JSON.stringify(items.slice(-MAX_HISTORY_ENTRIES), null, 2), 'utf8');
});

ipcMain.handle('host-history-clear', () => {
  try {
    fs.unlinkSync(hostHistoryFilePath());
  } catch {
    // nothing to clear
  }
});

// ---------------------------------------------------------------------
// User preferences.
// ---------------------------------------------------------------------

ipcMain.handle('app-settings-get', () => ({ ...appSettings }));

ipcMain.handle('app-settings-set', (event, partial) => {
  const next = { ...appSettings };
  if (typeof partial?.autoStart === 'boolean') next.autoStart = partial.autoStart;
  if (typeof partial?.autoHost === 'boolean') next.autoHost = partial.autoHost;
  if (typeof partial?.monitorName === 'string' || partial?.monitorName === null) next.monitorName = partial.monitorName;
  if (typeof partial?.quality === 'string') next.quality = partial.quality;
  appSettings = next;
  saveAppSettings();
  applyLoginItemSetting();
  if (appSettings.autoHost && !hasActiveHost()) startHost(true);
  if (!appSettings.autoHost && partial && partial.autoHost === false) stopHosting();
  rebuildTrayMenu();
  return { ...appSettings };
});

ipcMain.handle('open-window', (event, file, query) => {
  if (file === 'launcher.html') return showLauncher();
  if (file === 'host.html') return startHost(false);
  createWindow(file, query);
});

ipcMain.handle('stop-hosting', () => {
  stopHosting();
});

ipcMain.handle('get-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 240, height: 150 }
  });
  return sources.map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }));
});

// ---------------------------------------------------------------------
// Window management.
// ---------------------------------------------------------------------

function createWindow(file, query, options = {}) {
  const isHost = options.isHost || file === 'host.html';
  const background = options.background || false;

  const win = new BrowserWindow({
    width: 960,
    height: 680,
    backgroundColor: '#0b0f14',
    show: !background,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  if (isHost) {
    hostWindows.add(win);
    win.on('closed', () => {
      hostWindows.delete(win);
      rebuildTrayMenu();
    });
  } else if (file === 'launcher.html') {
    launcherWindow = win;
    win.on('close', (event) => {
      if (!isQuitting) {
        event.preventDefault();
        win.hide();
      }
    });
    win.on('closed', () => {
      if (launcherWindow === win) launcherWindow = null;
    });
  }

  win.loadFile(path.join(__dirname, 'renderer', file), query ? { query } : undefined);
  return win;
}

async function startConfiguredBackgroundHost() {
  if (!appSettings.autoHost) return;
  // The host renderer restores the encrypted Supabase session before it
  // registers the device. Starting it hidden makes the Windows-login path silent.
  startHost(true);
}

app.whenReady().then(async () => {
  loadAppSettings();
  applyLoginItemSetting();
  ensureTray();
  configureAutoUpdater();

  const loginState = process.platform === 'win32' ? app.getLoginItemSettings() : null;
  const launchedAtLogin = !!loginState?.wasOpenedAtLogin;

  // When Windows launches the app just to auto-host, keep the dashboard hidden.
  if (!(appSettings.autoHost && launchedAtLogin)) showLauncher();
  await startConfiguredBackgroundHost();

  app.on('activate', () => showLauncher());
});

app.on('window-all-closed', (event) => {
  // Keep running in the system tray until the user chooses Quit.
  if (!isQuitting) event.preventDefault();
});

app.on('before-quit', () => {
  isQuitting = true;
  stopHosting();
  destroyTray();
  if (psProcess) psProcess.kill();
  if (oauthServer) oauthServer.close();
});

ipcMain.on('robot-move', (event, { x, y }) => moveMouse(x, y));
ipcMain.on('robot-click', (event, { button = 'left' }) => clickMouse(button));
ipcMain.on('robot-scroll', (event, { dx = 0, dy = 0 }) => scroll(dx, dy));
ipcMain.on('robot-keytap', (event, { key, modifiers = [] }) => keyTap(key, modifiers));
