// Tweak, as a desktop app. One window, no terminal, no separate browser.
import { app, BrowserWindow, shell, dialog } from 'electron';
import pkg from 'electron-updater';
const { autoUpdater } = pkg;
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { appendCapped } from './lib/log.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Settings live beside your tweaks, not inside the app folder, so they survive
// an update. The app writes them; nothing is sent anywhere.
const HOME = process.env.TWEAK_HOME || path.join(app.getPath('home'), 'Tweak');
process.env.TWEAK_HOME = HOME;

async function loadSettings() {
  try {
    const raw = await fs.readFile(path.join(HOME, 'settings.json'), 'utf8');
    const s = JSON.parse(raw);
    if (s.hfToken && !process.env.TWEAK_HF_TOKEN) process.env.TWEAK_HF_TOKEN = s.hfToken;
    if (s.fallbackModel && !process.env.TWEAK_FALLBACK_MODEL) process.env.TWEAK_FALLBACK_MODEL = s.fallbackModel;
    if (s.ollamaHost && !process.env.OLLAMA_HOST) process.env.OLLAMA_HOST = s.ollamaHost;
    return s;
  } catch { return {}; }
}

let win;

async function start() {
  await fs.mkdir(HOME, { recursive: true });
  await loadSettings();

  // the companion lives outside the app package, so Chrome can load it
  const barSrc = path.join(HERE, 'companion');
  const barDst = path.join(HOME, 'chrome-bar');
  try {
    await fs.mkdir(barDst, { recursive: true });
    for (const f of await fs.readdir(barSrc)) await fs.copyFile(path.join(barSrc, f), path.join(barDst, f));
  } catch {}

  // the same local server the browser version used, now inside the app.
  // A known port, so the Chrome bar can find it.
  const { startServer } = await import('./server.js');
  let port = 0;
  for (const p of [4317, 4318, 4319, 0]) {
    try { port = await startServer(p); break; } catch {}
  }

  win = new BrowserWindow({
    width: 1180, height: 860, minWidth: 720, minHeight: 560,
    title: 'Tweak', backgroundColor: '#111112', autoHideMenuBar: true,
    icon: path.join(HERE, 'build', 'icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  win.setMenuBarVisibility(false);
  await win.loadURL(`http://127.0.0.1:${port}/`);

  // links to the outside world open in the real browser, not inside the app
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });

  setTimeout(() => checkForUpdates(), 4000);

  win.webContents.on('render-process-gone', () => {
    dialog.showErrorBox('Tweak stopped responding', 'The window crashed. Close and open Tweak again.');
  });
}

start().catch(e => {
  dialog.showErrorBox('Tweak could not start', String(e && e.stack || e));
  app.quit();
});

// Updates arrive on their own, once a place to publish them is set in
// package.json. Nothing is downloaded until you say yes.
async function checkForUpdates() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = false;
  autoUpdater.on('update-available', async info => {
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['Update now', 'Later'],
      defaultId: 0,
      title: 'A new Tweak is ready',
      message: `Tweak ${info.version} is available. You have ${app.getVersion()}.`,
      detail: 'It downloads in the background and installs when you close the app.'
    });
    if (response === 0) autoUpdater.downloadUpdate().catch(() => {});
  });
  autoUpdater.on('update-downloaded', async () => {
    const { response } = await dialog.showMessageBox(win, {
      type: 'info', buttons: ['Restart now', 'When I next open it'], defaultId: 0,
      title: 'Update ready', message: 'The new version is ready to install.'
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });
  // Never nag about a failed check, but keep it in logs\updater.log (Settings,
  // Open logs folder). Every check and download failure arrives here.
  autoUpdater.on('error', e => {
    const line = `${new Date().toISOString()} v${app.getVersion()} ${e && e.stack || e}\n`;
    appendCapped(path.join(app.getPath('logs'), 'updater.log'), line).catch(() => {}); // nowhere left to report it
  });
  try { await autoUpdater.checkForUpdates(); } catch {} // already logged by the error event
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) start(); });
