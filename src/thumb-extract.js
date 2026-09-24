const { spawn } = require('child_process');
const { PIX, TW, TH } = require('./scene-detect');

// Decodes every frame of the first video stream to a TWxTH RGB thumbnail (raw bytes on stdout)
// and reads each frame's presentation time from showinfo (stderr), in the same order.
function runOnce(ffmpegBin, filePath, passthroughFlag) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-nostats', '-loglevel', 'info', '-nostdin',
      '-i', filePath,
      '-map', '0:v:0', '-an', '-sn', '-dn',
      '-vf', `scale=${TW}:${TH}:flags=area,format=rgb24,showinfo`,
      ...passthroughFlag,
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
    ];
    const proc = spawn(ffmpegBin, args);
    const chunks = [];
    const pts = [];
    let left = '', errTail = '';
    proc.stdout.on('data', (d) => chunks.push(d));
    proc.stderr.on('data', (d) => {
      const s = left + d.toString('latin1');
      const lines = s.split(/\r?\n/);
      left = lines.pop();
      for (const line of lines) {
        const m = line.match(/Parsed_showinfo.*\bn:\s*\d+\s+pts:\s*-?\d+\s+pts_time:\s*(-?[\d.]+)/);
        if (m) pts.push(parseFloat(m[1]));
        else if (line.trim()) errTail = (errTail + '\n' + line).slice(-1500);
      }
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited with code ${code}: ${errTail}`));
      const buf = Buffer.concat(chunks);
      const n = Math.floor(buf.length / PIX);
      resolve({ thumbs: buf, n, pts: pts.slice(0, n), ptsCount: pts.length });
    });
  });
}

async function extractThumbs(ffmpegBin, filePath) {
  let r;
  try {
    r = await runOnce(ffmpegBin, filePath, ['-fps_mode', 'passthrough']);
  } catch (err) {
    if (/Unrecognized option|fps_mode/i.test(String(err.message))) r = await runOnce(ffmpegBin, filePath, ['-vsync', '0']);
    else throw err;
  }
  // Safety: if showinfo lines were lost or mismatched, fall back to a constant-rate clock.
  if (r.pts.length !== r.n) {
    const step = r.pts.length > 1 ? (r.pts[r.pts.length - 1] - r.pts[0]) / (r.pts.length - 1) : 1 / 30;
    r.pts = Array.from({ length: r.n }, (_, i) => (r.pts[0] || 0) + i * step);
  }
  return r;
}

module.exports = { extractThumbs };
