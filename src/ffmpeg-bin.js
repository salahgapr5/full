// Resolves the ffmpeg/ffprobe binary paths bundled via the ffmpeg-static /
// ffprobe-static npm packages. In a packaged Electron app, files inside
// node_modules get put into app.asar, but a binary can't execute from inside
// an asar archive — electron-builder's `asarUnpack` (see package.json) copies
// these two binaries out into an `app.asar.unpacked` folder next to it. We
// just need to rewrite the path from one to the other when packaged.
const { app } = require('electron');

function unpackedPath(p) {
  if (!app.isPackaged) return p;
  return p.replace(`${path_sep()}app.asar${path_sep()}`, `${path_sep()}app.asar.unpacked${path_sep()}`);
}

function path_sep() {
  return process.platform === 'win32' ? '\\' : '/';
}

function ffmpegPath() {
  if (process.env.VEM_FFMPEG) return process.env.VEM_FFMPEG; // debug override
  const p = require('ffmpeg-static');
  return unpackedPath(p);
}

function ffprobePath() {
  if (process.env.VEM_FFPROBE) return process.env.VEM_FFPROBE; // debug override
  const p = require('ffprobe-static').path;
  return unpackedPath(p);
}

module.exports = { ffmpegPath, ffprobePath };
