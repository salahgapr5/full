const { app, BrowserWindow, shell, ipcMain, dialog } = require('electron');
const path = require('path');
const ffmpegOps = require('./ffmpeg-ops');
const keystore = require('./keystore');
const ffmpegRender = require('./ffmpeg-render');
const silenceCutter = require('./silence-cutter');

const VIDEO_FILTERS = [
  { name: 'Video files', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi'] },
  { name: 'All files', extensions: ['*'] },
];

let mainWin = null;
function createWindow() {
  const win = mainWin = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1100,
    minHeight: 720,
    title: 'Production Board',
    backgroundColor: '#f4f7fc',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The shell hosts the site / editor / cutter as <webview> guests, each with
      // their own `preload` (set from JS, computed from vem.getAppDir()) so every
      // guest gets the same window.vem bridge as the top-level page.
      webviewTag: true,
      // WebCodecs (used by the editor's legacy "Fast render" path) needs a secure context;
      // file:// loads already count as secure in Electron, so no flags needed here.
    },
  });

  win.loadFile(path.join(__dirname, 'shell.html'));

  // Open any target="_blank" links (from the shell page or any webview) in the
  // system browser instead of a new Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() === 'webview') {
      contents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
      });
    }
  });
}

// ---- IPC bridge for window.vem (see preload.js) --------------------------
ipcMain.handle('vem:pick-video', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Choose a video',
    properties: ['openFile'],
    filters: VIDEO_FILTERS,
  });
  if (canceled || !filePaths[0]) return null;
  return filePaths[0];
});

ipcMain.handle('vem:probe', async (_e, filePath) => {
  try {
    return { ok: true, data: await ffmpegOps.probe(filePath) };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('vem:detect-scenes', async (_e, filePath, sensitivity) => {
  try {
    return { ok: true, data: await ffmpegOps.detectScenes(filePath, sensitivity) };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('vem:make-proxy', async (_e, filePath) => {
  try {
    return { ok: true, data: await ffmpegOps.makeProxy(filePath) };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

const MEDIA_FILTERS = [
  { name: 'Video or image', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'png', 'jpg', 'jpeg', 'webp'] },
];
ipcMain.handle('vem:pick-media', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Choose a replacement clip or image',
    properties: ['openFile'],
    filters: MEDIA_FILTERS,
  });
  if (canceled || !filePaths[0]) return null;
  return filePaths[0];
});

ipcMain.handle('vem:pick-save-path', async (_e, defaultName) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWin, {
    title: 'Save rendered video',
    defaultPath: String(defaultName || 'rendered.mp4'),
    filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
  });
  return canceled ? null : filePath;
});

// The renderer asks for the exact output geometry so it can draw the
// rounded-corner mask and border PNGs at the right pixel size.
ipcMain.handle('vem:get-geometry', (_e, args) => ffmpegRender.computeGeometry(args));

let activeRender = null;
ipcMain.handle('vem:render', async (e, spec) => {
  if (activeRender) return { ok: false, error: 'A render is already running.' };
  const ctl = { cancelled: false, proc: null };
  activeRender = ctl;
  try {
    const data = await ffmpegRender.render(
      spec,
      (p) => { if (!e.sender.isDestroyed()) e.sender.send('vem:render-progress', p); },
      ctl
    );
    return { ok: true, data };
  } catch (err) {
    const msg = String(err.message || err);
    return { ok: false, cancelled: msg === 'cancelled', error: msg };
  } finally {
    activeRender = null;
  }
});
ipcMain.handle('vem:cancel-render', () => {
  if (activeRender) {
    activeRender.cancelled = true;
    if (activeRender.proc) { try { activeRender.proc.kill('SIGKILL'); } catch (_) {} }
  }
  return true;
});

ipcMain.handle('vem:get-key', (_e, name) => keystore.getKey(name));
ipcMain.handle('vem:set-key', (_e, name, value) => keystore.setKey(name, value));

// Lets the shell page build an absolute file:// path to preload.js for each
// <webview> it creates (site / editor / cutter), since the `preload` attribute
// needs an absolute path and the shell page itself has no Node access to compute one.
ipcMain.handle('vem:get-app-dir', () => __dirname);

// ---- Cutter & Compress (silence-cutter, see silence-cutter.js) -----------
ipcMain.handle('vem:cutter-pick-video', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Choose a video to cut',
    properties: ['openFile'],
    filters: VIDEO_FILTERS,
  });
  if (canceled || !filePaths[0]) return null;
  return filePaths[0];
});

ipcMain.handle('vem:cutter-pick-save-path', async (_e, defaultName) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWin, {
    title: 'Save cut video',
    defaultPath: String(defaultName || 'cut.mp4'),
    filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
  });
  return canceled ? null : filePath;
});

let activeCutterRun = false;
ipcMain.handle('vem:cutter-run', async (e, inputPath, outputPath, opts) => {
  if (activeCutterRun) return { ok: false, error: 'A cutter run is already in progress.' };
  activeCutterRun = true;
  try {
    const data = await silenceCutter.cutSilences(inputPath, outputPath, opts, (fraction, stage) => {
      if (!e.sender.isDestroyed()) e.sender.send('vem:cutter-progress', { fraction, stage });
    });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  } finally {
    activeCutterRun = false;
  }
});
ipcMain.handle('vem:cutter-cancel', () => {
  silenceCutter.cancel();
  return true;
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
