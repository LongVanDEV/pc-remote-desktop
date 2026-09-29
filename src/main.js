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
  clipboard,
  dialog
} = require('electron');
const { spawn, exec } = require('child_process');
const http = require('http');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { autoUpdater } = require('electron-updater');

// Single-instance + updater fixes live in the full local copy.
// If this stub is still present, push src/main.js from your machine:
//   git add src/main.js && git commit -m "fix: main.js" && git push

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

console.error('[pc-remote-desktop] Incomplete main.js on GitHub — push the full file from your local project (artifacts/remote-desktop-app/src/main.js).');
app.whenReady().then(() => {
  const { dialog } = require('electron');
  dialog.showErrorBox(
    'Incomplete build',
    'This GitHub copy of main.js is incomplete. Push the full src/main.js from your local project, then rebuild.'
  );
  app.quit();
});
