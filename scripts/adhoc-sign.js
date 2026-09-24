// electron-builder afterPack hook: ad-hoc sign (no Apple Developer account needed).
// Apple Silicon refuses to run unsigned code, and editing the app bundle invalidates the
// signature Electron ships with, so we re-sign everything with the "-" (ad-hoc) identity.
// Inner binaries first (ffmpeg/ffprobe live in app.asar.unpacked), then the whole .app.
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

function walk(dir, out = []) {
  for (const n of fs.readdirSync(dir)) {
    const p = path.join(dir, n);
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

exports.default = async function (context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const unpacked = path.join(app, 'Contents', 'Resources', 'app.asar.unpacked');
  if (fs.existsSync(unpacked)) {
    for (const f of walk(unpacked)) {
      if (/[\\/](ffmpeg|ffprobe)$/.test(f)) {
        fs.chmodSync(f, 0o755);
        execFileSync('codesign', ['--force', '--sign', '-', f], { stdio: 'inherit' });
        console.log('ad-hoc signed', path.relative(app, f));
      }
    }
  }
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  console.log('ad-hoc signed', app);
};
