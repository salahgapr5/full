// Exposes window.vem to the editor page. Only fixed, named operations cross
// the bridge; the renderer never gets ipcRenderer or Node access.
const { contextBridge, ipcRenderer } = require('electron');

const KEY_NAMES = new Set(['anthropic', 'gemini']);

contextBridge.exposeInMainWorld('vem', {
  pickVideo: () => ipcRenderer.invoke('vem:pick-video'),          // -> path | null
  probe: (p) => ipcRenderer.invoke('vem:probe', p),                // -> {ok,data|error}
  detectScenes: (p, sensitivity) => ipcRenderer.invoke('vem:detect-scenes', p, sensitivity),
  makeProxy: (p) => ipcRenderer.invoke('vem:make-proxy', p),
  pickMedia: () => ipcRenderer.invoke('vem:pick-media'),          // video or image -> path | null
  pickSavePath: (name) => ipcRenderer.invoke('vem:pick-save-path', name),
  getGeometry: (args) => ipcRenderer.invoke('vem:get-geometry', args),
  render: (spec) => ipcRenderer.invoke('vem:render', spec),        // -> {ok,data|error,cancelled}
  cancelRender: () => ipcRenderer.invoke('vem:cancel-render'),
  onRenderProgress: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('vem:render-progress', h);
    return () => ipcRenderer.removeListener('vem:render-progress', h);
  },
  getKey: (name) => KEY_NAMES.has(name) ? ipcRenderer.invoke('vem:get-key', name) : Promise.resolve(''),
  setKey: (name, value) => KEY_NAMES.has(name)
    ? ipcRenderer.invoke('vem:set-key', name, String(value || ''))
    : Promise.resolve({ ok: false, error: 'Unknown key name' }),

  // Used only by shell.html, to build absolute preload paths for its <webview>s.
  getAppDir: () => ipcRenderer.invoke('vem:get-app-dir'),

  // ---- Cutter & Compress ----
  cutterPickVideo: () => ipcRenderer.invoke('vem:cutter-pick-video'),
  cutterPickSavePath: (name) => ipcRenderer.invoke('vem:cutter-pick-save-path', name),
  cutterRun: (inputPath, outputPath, opts) => ipcRenderer.invoke('vem:cutter-run', inputPath, outputPath, opts),
  cutterCancel: () => ipcRenderer.invoke('vem:cutter-cancel'),
  onCutterProgress: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('vem:cutter-progress', h);
    return () => ipcRenderer.removeListener('vem:cutter-progress', h);
  },
});
