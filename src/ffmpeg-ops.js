const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { ffmpegPath, ffprobePath } = require('./ffmpeg-bin');

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args);
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('error', reject); // e.g. binary missing / not executable
    proc.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${path.basename(bin)} exited with code ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

// ---- probe: duration/width/height/codec/fps via ffprobe -----------------
async function probe(filePath) {
  const args = ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath];
  const { stdout } = await run(ffprobePath(), args);
  const data = JSON.parse(stdout);
  const vStream = (data.streams || []).find((s) => s.codec_type === 'video') || {};
  const aStream = (data.streams || []).find((s) => s.codec_type === 'audio');
  let fps = 0;
  if (vStream.avg_frame_rate && vStream.avg_frame_rate !== '0/0') {
    const [n, d] = vStream.avg_frame_rate.split('/').map(Number);
    fps = d ? n / d : 0;
  }
  return {
    duration: parseFloat(data.format?.duration || vStream.duration || 0),
    width: vStream.width || 0,
    height: vStream.height || 0,
    fps,
    videoCodec: vStream.codec_name || '',
    hasAudio: !!aStream,
    audioCodec: aStream?.codec_name || '',
  };
}

// ---- shot-cut detection ------------------------------------------------------
// Decodes every frame to a tiny thumbnail (one ffmpeg pass) and decides, in scene-detect.js,
// whether the picture before a point is a different shot from the picture after it. This
// replaced the plain `select=gt(scene,X)` threshold, which chopped continuous shots with
// motion/flicker into many clips (low slider) and missed real cuts + crossfades (high slider).
// The slider keeps its meaning: 5-150, LOWER = MORE cuts.
async function detectScenes(filePath, sensitivity) {
  const { extractThumbs } = require('./thumb-extract');
  const { detectCuts } = require('./scene-detect');
  const { thumbs, n, pts } = await extractThumbs(ffmpegPath(), filePath);
  if (n < 4) throw new Error('video has too few frames to scan');
  const r = detectCuts(thumbs, n, pts, sensitivity);
  return {
    times: r.cuts.map((c) => c.time),          // cut boundary timestamps in seconds (excluding 0 and the end)
    cuts: r.cuts,                              // same, with kind ('hard' | 'dissolve' | 'dip') and score
    frames: n,
    fps: r.fps,
    hardCandidates: r.hardCandidates,
    merged: r.merged,
    threshold: r.params.hardFloor,             // kept for older UI code
    rawCount: r.hardCandidates + r.gradCandidates,
  };
}

// Old method (ffmpeg `scene` score + time-window clustering). Kept only as a fallback.
function sensitivityToThreshold(sensitivity) {
  const s = Math.max(5, Math.min(150, sensitivity || 30));
  return Math.max(0.03, Math.min(0.6, s / 200));
}

// ---- lightweight preview proxy (720p H.264) -------------------------------
async function makeProxy(filePath) {
  const outDir = path.join(os.tmpdir(), 'vem-proxies');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${path.basename(filePath, path.extname(filePath))}-${Date.now()}.mp4`);

  const baseArgs = ['-y', '-i', filePath, '-vf', "scale=-2:720", '-c:a', 'aac', '-b:a', '128k'];
  try {
    // Prefer Apple's hardware encoder (fast, low CPU) where available.
    await run(ffmpegPath(), [...baseArgs, '-c:v', 'h264_videotoolbox', '-b:v', '4M', outPath]);
  } catch (err) {
    // Falls back to software encode on non-mac dev machines, or if
    // VideoToolbox isn't available for some reason.
    await run(ffmpegPath(), [...baseArgs, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', outPath]);
  }
  return outPath;
}

module.exports = { probe, detectScenes, makeProxy, sensitivityToThreshold };
