// ffmpeg-based export. Mirrors the canvas compositor in editor.html
// (drawSegVisual / compositeFrame) so the file matches the in-app preview.
//
// Strategy ("piece by piece"): the timeline is cut into frame-exact pieces:
//   - a STEADY piece = one segment on its own
//   - a ZONE piece   = crossfade between two neighbouring segments
// Each piece is its own small ffmpeg run (encoded with VideoToolbox, or x264 as
// a fallback), then all pieces are joined with the concat demuxer (stream copy,
// no re-encode) and the avatar's audio is muxed in. This keeps every ffmpeg
// filter graph tiny no matter how many cuts there are.
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { ffmpegPath } = require('./ffmpeg-bin');
const ops = require('./ffmpeg-ops');

const FPS = 30;
const RES_HEIGHT = { '1080p': 1080, '2k': 1440, '4k': 2160 };
const BITRATE = { 1080: '14M', 1440: '24M', 2160: '50M' };

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

// Single source of truth for output geometry; the renderer asks for this
// (vem:get-geometry) so it can draw the mask/border PNGs at the exact size.
function computeGeometry({ renderW, renderH, res, framePct }) {
  const outH = even(RES_HEIGHT[res] || 1080);
  const scale = outH / renderH;
  const outW = even(renderW * scale);
  const boxW = even(outW * (framePct / 100));
  const boxH = even(outH * (framePct / 100));
  const boxX = 2 * Math.floor((outW - boxW) / 4);
  const boxY = 2 * Math.floor((outH - boxH) / 4);
  return { outW, outH, boxW, boxH, boxX, boxY, scale };
}

function runFfmpeg(args, ctl, onFrame) {
  return new Promise((resolve, reject) => {
    if (ctl.cancelled) return reject(new Error('cancelled'));
    const proc = spawn(ffmpegPath(), args);
    ctl.proc = proc;
    let tail = '';
    proc.stderr.on('data', (d) => {
      const s = d.toString();
      tail = (tail + s).slice(-3000);
      if (onFrame) {
        const m = s.match(/frame=\s*(\d+)/g);
        if (m) onFrame(parseInt(m[m.length - 1].replace(/\D/g, ''), 10));
      }
    });
    proc.on('error', reject);
    proc.on('close', (code, signal) => {
      ctl.proc = null;
      if (code === null) return reject(new Error(`ffmpeg was killed (${signal || 'unknown signal'}): ${tail.slice(-800)}`));
      if (ctl.cancelled) reject(new Error('cancelled'));
      else if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${tail.slice(-1500)}`));
    });
  });
}

function dataUrlToFile(dataUrl, dir, name) {
  const m = /^data:([\w/+.-]+);base64,(.*)$/s.exec(dataUrl || '');
  if (!m) throw new Error('Bad image data');
  const ext = m[1].includes('png') ? 'png' : m[1].includes('webp') ? 'webp' : 'jpg';
  const p = path.join(dir, `${name}.${ext}`);
  fs.writeFileSync(p, Buffer.from(m[2], 'base64'));
  return p;
}

// ---- timeline -> list of pieces ------------------------------------------
function planPieces(segs, T, rate, N) {
  // boundaries with (clamped) crossfade half-widths, in b-roll source seconds
  const zones = [];
  for (let i = 0; i < segs.length - 1; i++) {
    const L = segs[i], R = segs[i + 1];
    let zs = null, ze = null, mid = Math.round((L.vEnd / rate) * FPS);
    if (T > 0) {
      const h = Math.min(T / 2, (L.end - L.start) / 2, (R.end - R.start) / 2);
      zs = Math.round(((L.vEnd - h) / rate) * FPS);
      ze = Math.round(((R.vStart + h) / rate) * FPS);
    }
    if (zs === null || ze <= zs) { zs = ze = mid; }
    zones.push({ zs, ze });
  }
  const pieces = [];
  let c = 0;
  for (let i = 0; i < segs.length; i++) {
    const zs = i < segs.length - 1 ? Math.min(zones[i].zs, N) : N;
    if (zs > c) pieces.push({ kind: 'steady', seg: i, f0: c, n: zs - c });
    c = Math.max(c, zs);
    if (i < segs.length - 1) {
      const ze = Math.min(zones[i].ze, N);
      if (ze > c) pieces.push({ kind: 'zone', left: i, right: i + 1, f0: c, n: ze - c });
      c = Math.max(c, ze);
    }
  }
  if (c < N && pieces.length) pieces[pieces.length - 1].n += N - c; // rounding remainder
  return pieces;
}

// ---- filtergraph for one segment "layer" ----------------------------------
function makeLayer(ctx, seg, f0, n, label, inputs) {
  const { g, spec, media } = ctx;
  const { outW, outH, boxW, boxH, boxX, boxY } = g;
  const rate = spec.rate, D = n / FPS, tw0 = f0 / FPS; // wall-clock start of piece
  const add = (args) => { inputs.push(args); return inputs.length - 1; };
  const parts = [];

  if (seg.type === 'avatar') {
    const a = add(['-ss', tw0.toFixed(4), '-t', (D + 0.4).toFixed(4), '-i', spec.avatarPath]);
    parts.push(`[${a}:v]setpts=PTS-STARTPTS,fps=${FPS},scale=${outW}:${outH}:flags=bicubic,setsar=1,format=yuv420p,tpad=stop_mode=clone:stop_duration=3[${label}]`);
    return parts;
  }

  // ---- background ----
  if (spec.bgPath && media.bgDur > 0) {
    const off = tw0 % media.bgDur;
    const b = add(['-stream_loop', '-1', '-i', spec.bgPath]);
    parts.push(`[${b}:v]trim=start=${off.toFixed(4)}:duration=${(D + 0.4).toFixed(4)},setpts=PTS-STARTPTS,fps=${FPS},scale=${outW}:${outH}:flags=bicubic,setsar=1,format=yuv420p[${label}bg]`);
  } else {
    parts.push(`color=c=black:s=${outW}x${outH}:r=${FPS}:d=${(D + 1).toFixed(3)},setsar=1,format=yuv420p[${label}bg]`);
  }

  // ---- foreground source (stretched into the frame box, like the canvas does) ----
  const T = spec.transDur, L = Math.max(0.001, seg.end - seg.start);
  const flip = seg.mirrored ? ',hflip' : '';
  let head; // filter chain that ends with a boxW x boxH stream
  const fin = `scale=${boxW}:${boxH}:flags=bicubic,setsar=1${flip}`;
  if (seg.type === 'broll') {
    // tw0*rate is the position on the gap-free virtual timeline; subtract how far this
    // segment's virtual start has drifted from its real start (i.e. how much trimmed
    // footage has been skipped before it) to land on the correct real source-file time.
    const t0 = tw0 * rate - seg.vStart + seg.start;
    const i = add(['-ss', t0.toFixed(4), '-t', (D * rate + 0.6).toFixed(4), '-i', spec.brollPath]);
    let crop = '';
    if (spec.brollCrop > 0) {
      const k = media.brollW / Math.max(1, spec.previewBrollW || media.brollW); // preview px -> source px
      const cp = Math.max(0, Math.min(Math.round(spec.brollCrop * k), media.brollW / 2 - 2, media.brollH / 2 - 2));
      if (cp > 0) crop = `crop=iw-${2 * cp}:ih-${2 * cp}:${cp}:${cp},`;
    }
    head = `[${i}:v]setpts=(PTS-STARTPTS)/${rate},fps=${FPS},tpad=stop_mode=clone:stop_duration=3,${crop}${fin}`;
  } else if (seg.type === 'image' || (seg.type === 'replaced' && seg.replaceKind === 'image')) {
    const i = add(['-loop', '1', '-framerate', String(FPS), '-t', (D + 0.4).toFixed(4), '-i', seg._file]);
    head = `[${i}:v]setpts=PTS-STARTPTS,fps=${FPS},${fin}`;
  } else if (seg.type === 'replaced') {
    const dur = seg._dur || 1;
    const u0 = Math.min(Math.max(0, (dur * ((tw0 * rate) - seg.vStart + T)) / L), Math.max(0, dur - 0.1));
    const k = (dur * rate) / L; // source seconds of the clip consumed per wall second
    const i = add(['-ss', u0.toFixed(4), '-t', (D * k + 0.6).toFixed(4), '-i', seg.replacePath]);
    head = `[${i}:v]setpts=(PTS-STARTPTS)/${k.toFixed(6)},fps=${FPS},tpad=stop_mode=clone:stop_duration=3,${fin}`;
  } else {
    throw new Error('Unknown segment type: ' + seg.type);
  }

  // ---- Ken Burns zoom (sub-pixel via perspective, driven by source-time progress) ----
  const zp = spec.zoomPct / 100;
  let zoom = '';
  if (zp > 0) {
    const p = `clip((((${f0}+in)/${FPS})*${rate}-${seg.vStart})/${L},0,1)`;
    const z = `(1+${zp}*${p})`;
    const a = `(W/2*(1-1/${z}))`, b = `(W/2*(1+1/${z}))`, c = `(H/2*(1-1/${z}))`, d = `(H/2*(1+1/${z}))`;
    zoom = `,perspective=x0='${a}':y0='${c}':x1='${b}':y1='${c}':x2='${a}':y2='${d}':x3='${b}':y3='${d}':eval=frame:interpolation=cubic`;
  }
  parts.push(`${head}${zoom},format=yuv420p[${label}fg]`);

  // ---- rounded-corner mask, overlay onto the background, then border ring ----
  const m = add(['-loop', '1', '-framerate', String(FPS), '-t', (D + 0.4).toFixed(4), '-i', ctx.maskPath]);
  parts.push(`[${m}:v]format=gray,fps=${FPS}[${label}m]`);
  parts.push(`[${label}fg][${label}m]alphamerge[${label}fa]`);
  if (ctx.borderPath) {
    const bo = add(['-loop', '1', '-framerate', String(FPS), '-t', (D + 0.4).toFixed(4), '-i', ctx.borderPath]);
    parts.push(`[${label}bg][${label}fa]overlay=${boxX}:${boxY}:format=auto[${label}o]`);
    parts.push(`[${bo}:v]format=rgba,fps=${FPS}[${label}b]`);
    parts.push(`[${label}o][${label}b]overlay=${boxX}:${boxY}:format=auto,format=yuv420p[${label}]`);
  } else {
    parts.push(`[${label}bg][${label}fa]overlay=${boxX}:${boxY}:format=auto,format=yuv420p[${label}]`);
  }
  return parts;
}

// ---- main entry -------------------------------------------------------------
// spec: see editor.html (buildRenderSpec). onProgress({pct, fps, etaSec, phase})
async function render(spec, onProgress, ctl) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vem-render-'));
  const t0 = Date.now();
  try {
    const segs = spec.segments;
    if (!segs.length) throw new Error('Nothing to render.');
    const g = computeGeometry(spec);

    // temp files for masks + generated images
    const maskPath = path.join(work, 'mask.png');
    fs.writeFileSync(maskPath, Buffer.from(spec.maskPng.split(',')[1], 'base64'));
    let borderPath = null;
    if (spec.borderPng) {
      borderPath = path.join(work, 'border.png');
      fs.writeFileSync(borderPath, Buffer.from(spec.borderPng.split(',')[1], 'base64'));
    }
    const media = { bgDur: 0 };
    const bp = await ops.probe(spec.brollPath);
    media.brollW = bp.width; media.brollH = bp.height;
    if (spec.bgPath) media.bgDur = (await ops.probe(spec.bgPath)).duration;
    const ap = await ops.probe(spec.avatarPath);
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (s.type === 'image') s._file = dataUrlToFile(s.imgData, work, `img${i}`);
      if (s.type === 'replaced' && s.replaceKind === 'image') s._file = s.replacePath;
      if (s.type === 'replaced' && s.replaceKind === 'video') s._dur = (await ops.probe(s.replacePath)).duration;
    }

    const N = Math.round(ap.duration * FPS);
    const pieces = planPieces(segs, spec.transDur, spec.rate, N);
    const ctx = { g, spec, media, maskPath, borderPath };
    const bitrate = BITRATE[g.outH] || '20M';
    let useHw = true, doneFrames = 0;
    const listLines = [];

    const emit = (cur, phase) => {
      const frames = Math.min(N, doneFrames + cur);
      const el = (Date.now() - t0) / 1000;
      onProgress && onProgress({
        pct: Math.min(99, (frames / N) * 100),
        fps: frames / Math.max(el, 0.001),
        etaSec: frames ? (el / frames) * (N - frames) : null,
        phase: phase || 'Rendering',
      });
    };

    for (let pi = 0; pi < pieces.length; pi++) {
      const pc = pieces[pi];
      const inputs = [];
      let parts;
      if (pc.kind === 'steady') {
        parts = makeLayer(ctx, segs[pc.seg], pc.f0, pc.n, 'A', inputs);
        parts.push('[A]null[v]');
      } else {
        parts = [
          ...makeLayer(ctx, segs[pc.left], pc.f0, pc.n, 'A', inputs),
          ...makeLayer(ctx, segs[pc.right], pc.f0, pc.n, 'B', inputs),
          `[A][B]xfade=transition=fade:duration=${(pc.n / FPS).toFixed(4)}:offset=0[v]`,
        ];
      }
      const out = path.join(work, `p${String(pi).padStart(5, '0')}.ts`);
      const base = ['-y', '-hide_banner', '-loglevel', 'error', '-stats'];
      inputs.forEach((a) => base.push(...a));
      base.push('-filter_complex', parts.join(';'), '-map', '[v]', '-frames:v', String(pc.n), '-an', '-r', String(FPS));
      const hwArgs = ['-c:v', 'h264_videotoolbox', '-b:v', bitrate, '-pix_fmt', 'yuv420p', '-profile:v', 'high'];
      const swArgs = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p', '-profile:v', 'high'];
      const onFrame = (f) => emit(f);
      if (useHw) {
        try {
          await runFfmpeg([...base, ...hwArgs, '-f', 'mpegts', out], ctl, onFrame);
        } catch (err) {
          if (String(err.message) === 'cancelled') throw err;
          if (pi > 0) throw err; // encoder worked before: a real failure, not "no hardware"
          useHw = false;
        }
      }
      if (!useHw) await runFfmpeg([...base, ...swArgs, '-f', 'mpegts', out], ctl, onFrame);
      doneFrames += pc.n;
      listLines.push(`file '${out.replace(/'/g, "'\\''")}'`);
      emit(0);
    }

    emit(0, 'Joining pieces and adding audio');
    const list = path.join(work, 'list.txt');
    fs.writeFileSync(list, listLines.join('\n'));
    const fin = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list];
    if (ap.hasAudio) fin.push('-i', spec.avatarPath);
    fin.push('-map', '0:v');
    if (ap.hasAudio) fin.push('-map', '1:a', '-c:a', 'aac', '-b:a', '192k', '-shortest');
    fin.push('-c:v', 'copy', '-movflags', '+faststart', spec.outPath);
    await runFfmpeg(fin, ctl);
    onProgress && onProgress({ pct: 100, fps: 0, etaSec: 0, phase: 'Done' });
    return { outPath: spec.outPath, seconds: (Date.now() - t0) / 1000, frames: N, pieces: pieces.length, hardware: useHw };
  } catch (err) {
    try { if (spec.outPath && fs.existsSync(spec.outPath)) fs.unlinkSync(spec.outPath); } catch (_) {}
    throw err;
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = { render, computeGeometry, planPieces, RES_HEIGHT };
