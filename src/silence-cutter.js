// Cutter & Compress — ports silence-cutter's silence_cutter.py (Python + ffmpeg CLI)
// into pure JS running against the app's bundled ffmpeg. "Compress" is part of the
// tool's name only: this still just detects silent gaps and cuts them out, re-encoding
// once via a single filter_complex trim+concat pass (which is also what keeps file size
// down versus a copy of every silent gap) — there is no separate size/quality feature.
const { spawn } = require('child_process');
const path = require('path');
const { ffmpegPath, ffprobePath } = require('./ffmpeg-bin');

const DEFAULTS = {
  thresholdDb: -30,   // how quiet counts as "silence"
  minDuration: 0.5,   // shortest gap worth cutting; shorter gaps are natural speech pauses
  padding: 0.1,        // seconds of buffer kept on each side of every cut
};

function run(bin, args, onStderrLine) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args);
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      if (onStderrLine) onStderrLine(s);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr, proc });
      else reject(new Error(`${path.basename(bin)} exited with code ${code}: ${stderr.slice(-2000)}`));
    });
    // Let the caller kill this run (cancel button).
    run.lastProc = proc;
  });
}

async function getDuration(filePath) {
  const args = ['-v', 'quiet', '-print_format', 'json', '-show_format', filePath];
  const { stdout } = await run(ffprobePath(), args);
  const data = JSON.parse(stdout);
  return parseFloat(data.format?.duration || 0);
}

// ffmpeg's silencedetect filter only reports through stderr while it actually decodes
// the file (there is no faster "scan only" mode), so this pass takes roughly as long
// as playing the file once. `-f null -` discards the decoded frames instead of writing
// them anywhere.
async function detectSilences(filePath, thresholdDb, minDuration) {
  const args = [
    '-i', filePath,
    '-af', `silencedetect=noise=${thresholdDb}dB:d=${minDuration}`,
    '-f', 'null', '-',
  ];
  let stderr = '';
  try {
    const r = await run(ffmpegPath(), args, (s) => { stderr += s; });
    stderr = r.stderr;
  } catch (err) {
    // silencedetect always makes ffmpeg exit 0 when it can decode the file at all;
    // a non-zero exit here means the input itself is bad, so surface that instead
    // of silently returning "no silence found".
    throw err;
  }
  const starts = [...stderr.matchAll(/silence_start:\s*([\d.]+)/g)].map((m) => parseFloat(m[1]));
  const ends = [...stderr.matchAll(/silence_end:\s*([\d.]+)/g)].map((m) => parseFloat(m[1]));
  const silences = [];
  for (let i = 0; i < starts.length; i++) {
    if (i < ends.length) silences.push([starts[i], ends[i]]);
    // else: silence runs to end of file — the duration clamp in computeKeepSegments handles it.
  }
  return silences;
}

function computeKeepSegments(duration, silences, padding) {
  const trimmed = silences
    .map(([s, e]) => [s + padding, e - padding])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);

  const keep = [];
  let cursor = 0;
  for (const [s, e] of trimmed) {
    if (s > cursor) keep.push([cursor, s]);
    cursor = Math.max(cursor, e);
  }
  if (cursor < duration) keep.push([cursor, duration]);

  return keep.filter(([s, e]) => e - s > 0.01);
}

// One ffmpeg run: trims every keep segment and concatenates them in a single
// filter_complex, so the output is re-encoded exactly once (not once per cut).
async function renderKeepSegments(filePath, keepSegments, outPath, onProgress) {
  if (!keepSegments.length) throw new Error('No non-silent segments found — nothing to keep.');

  const filterParts = [];
  const concatInputs = [];
  keepSegments.forEach(([s, e], i) => {
    filterParts.push(`[0:v]trim=start=${s.toFixed(3)}:end=${e.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
    filterParts.push(`[0:a]atrim=start=${s.toFixed(3)}:end=${e.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
    concatInputs.push(`[v${i}][a${i}]`);
  });
  const n = keepSegments.length;
  const filterComplex = filterParts.join(';') + ';' + concatInputs.join('') + `concat=n=${n}:v=1:a=1[outv][outa]`;

  const args = [
    '-y', '-i', filePath,
    '-filter_complex', filterComplex,
    '-map', '[outv]', '-map', '[outa]',
    '-c:v', 'libx264', '-c:a', 'aac',
    '-preset', 'veryfast',
    '-progress', 'pipe:2', '-nostats',
    outPath,
  ];

  const totalOut = keepSegments.reduce((sum, [s, e]) => sum + (e - s), 0);
  let ctl = { proc: null };
  const promise = new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath(), args);
    ctl.proc = proc;
    let stderr = '';
    proc.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      const m = s.match(/out_time_ms=(\d+)/) || s.match(/out_time=(\d+):(\d+):([\d.]+)/);
      if (onProgress && totalOut > 0) {
        let seconds = null;
        const msMatch = s.match(/out_time_ms=(\d+)/);
        if (msMatch) seconds = parseInt(msMatch[1], 10) / 1e6;
        if (seconds != null) onProgress(Math.min(1, seconds / totalOut));
      }
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-2000)}`));
    });
  });
  return { promise, ctl };
}

// Full pipeline, matching silence_cutter.py's cut_silences(). `opts` may override
// thresholdDb / minDuration / padding; onProgress(fraction, stage) is optional.
async function cutSilences(filePath, outPath, opts, onProgress) {
  const { thresholdDb, minDuration, padding } = { ...DEFAULTS, ...(opts || {}) };
  if (onProgress) onProgress(0, 'probing');
  const duration = await getDuration(filePath);
  if (onProgress) onProgress(0, 'scanning');
  const silences = await detectSilences(filePath, thresholdDb, minDuration);
  const keepSegments = computeKeepSegments(duration, silences, padding);
  if (onProgress) onProgress(0, 'rendering');
  const { promise, ctl } = await renderKeepSegments(filePath, keepSegments, outPath, (f) => {
    if (onProgress) onProgress(f, 'rendering');
  });
  cutSilences.activeCtl = ctl;
  await promise;
  cutSilences.activeCtl = null;

  const keptDuration = keepSegments.reduce((sum, [s, e]) => sum + (e - s), 0);
  return {
    originalDuration: Math.round(duration * 100) / 100,
    outputDuration: Math.round(keptDuration * 100) / 100,
    cutsMade: silences.length,
    secondsRemoved: Math.round((duration - keptDuration) * 100) / 100,
  };
}

function cancel() {
  if (cutSilences.activeCtl && cutSilences.activeCtl.proc) {
    try { cutSilences.activeCtl.proc.kill('SIGKILL'); } catch (_) {}
  }
}

module.exports = { cutSilences, cancel, DEFAULTS };
