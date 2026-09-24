// Shot-boundary detection on tiny per-frame thumbnails (32x18 RGB, every frame).
//
// Why not ffmpeg's `scene` score alone? It only says "this frame differs from the
// previous one by X". A continuous shot with motion, camera shake, flicker or
// compression pops produces lots of X-sized jumps (=> one shot chopped into many
// clips), while a crossfade never produces a big jump at all (=> real cuts missed).
// Raising the threshold to fix one makes the other worse.
//
// This detector instead asks "is the picture BEFORE this point a different shot
// from the picture AFTER it?", which is what a cut actually is:
//
//   HARD CUTS   a frame-to-frame spike that (a) stands out from the local motion
//               level and (b) separates two genuinely different pictures. The
//               separation is measured robustly (3 frames before vs 3 after, using
//               a low quantile) so 1-2 frame flashes/pops don't count.
//   DISSOLVES   the picture 0.5 s before vs 0.5 s after differs a lot in colour
//               distribution, yet there was no single spike. Reported at the centre
//               of the transition.
//   Then a minimum shot length is enforced with non-maximum suppression (keep the
//   strongest, never chain-merge), and adjacent segments that still look like the
//   same shot are merged.
//
// Boundaries are returned as the midpoint between the last frame of the old shot
// and the first frame of the new one, so neither the browser seek nor ffmpeg's -ss
// can land a frame early and show one repeated frame of the previous shot.

const TW = 32, TH = 18, PIX = TW * TH * 3;
const HB = 16;                       // histogram bins per channel
const GX = 4, GY = 3;                // coarse layout grid (cells of 8x6 px): ignores shake / small motion

function median(arr) {
  if (!arr.length) return 0;
  const a = arr.slice().sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length & 1 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// sensitivity slider (5..150, LOWER = MORE cuts) -> detector parameters
function paramsFor(sensitivity) {
  const s = Math.max(5, Math.min(150, Number(sensitivity) || 30));
  const t = (s - 5) / 145;           // 0..1
  return {
    t,
    hardFloor:  0.04 + 0.14 * t,     // min frame-to-frame jump
    hardRatio:  2.2 + 2.3 * t,       // jump must be this many x the local motion level
    hardCross:  0.045 + 0.10 * t,    // min robust before/after separation
    hardSep:    1.4 + 1.0 * t,       // ...and that many x the variation inside each side
    gradThresh: 0.22 + 0.25 * t,     // min 0.5s-apart colour separation for dissolves
    mergeThresh: 0.03 + 0.06 * t,    // adjacent segments closer than this are one shot
    minShot:    0.20,                // seconds
  };
}

function buildFeatures(thumbs, n) {
  const hist = new Float32Array(n * HB * 3);
  const grid = new Float32Array(n * GX * GY * 3);
  const cw = TW / GX, ch = TH / GY;
  for (let i = 0; i < n; i++) {
    const o = i * PIX, h = i * HB * 3, g = i * GX * GY * 3;
    for (let p = 0; p < TW * TH; p++) {
      const b = o + p * 3;
      hist[h + (thumbs[b] >> 4)]++;
      hist[h + HB + (thumbs[b + 1] >> 4)]++;
      hist[h + 2 * HB + (thumbs[b + 2] >> 4)]++;
      const x = p % TW, y = (p / TW) | 0;
      const gi = g + (((y / ch) | 0) * GX + ((x / cw) | 0)) * 3;
      grid[gi] += thumbs[b]; grid[gi + 1] += thumbs[b + 1]; grid[gi + 2] += thumbs[b + 2];
    }
    for (let k = 0; k < HB * 3; k++) hist[h + k] /= TW * TH;
    for (let k = 0; k < GX * GY * 3; k++) grid[g + k] /= (cw * ch * 255);
  }
  return { hist, grid };
}

function makeDist(thumbs, F) {
  const { hist, grid } = F;
  const G = GX * GY * 3, H = HB * 3;
  const pix = (a, b) => { let s = 0; const oa = a * PIX, ob = b * PIX; for (let k = 0; k < PIX; k++) s += Math.abs(thumbs[oa + k] - thumbs[ob + k]); return s / (PIX * 255); };
  const hst = (a, b) => { let s = 0; const oa = a * H, ob = b * H; for (let k = 0; k < H; k++) s += Math.abs(hist[oa + k] - hist[ob + k]); return s / 6; }; // 0..1
  const lay = (a, b) => { let s = 0; const oa = a * G, ob = b * G; for (let k = 0; k < G; k++) s += Math.abs(grid[oa + k] - grid[ob + k]); return s / G; };
  return {
    // "how different are these two pictures": any of the three views can flag it
    full: (a, b) => Math.max(pix(a, b), hst(a, b), lay(a, b)),
    // colour-distribution + coarse layout only (ignores shake / small motion): used to judge
    // "is this a different picture", for cross-checks, dissolves and merging
    tone: (a, b) => Math.max(hst(a, b), lay(a, b)),
    pix, hst, lay,
  };
}

/**
 * @param {Buffer|Uint8Array} thumbs  n * 32*18*3 RGB bytes
 * @param {number} n                  frame count
 * @param {Float64Array|number[]} pts presentation time of each frame (seconds)
 * @param {number} sensitivity        slider value
 */
function detectCuts(thumbs, n, pts, sensitivity) {
  const P = paramsFor(sensitivity);
  const out = { cuts: [], params: P, frames: n, fps: 0, hardCandidates: 0, gradCandidates: 0, merged: 0 };
  if (n < 4) return out;

  const dts = [];
  for (let i = 1; i < n; i++) { const d = pts[i] - pts[i - 1]; if (d > 0) dts.push(d); }
  const fdur = median(dts) || 1 / 30;
  const fps = 1 / fdur; out.fps = fps;
  const t0 = pts[0];

  const F = buildFeatures(thumbs, n);
  const D = makeDist(thumbs, F);

  // ---- adjacent-frame change signal ----
  const c = new Float32Array(n);
  for (let i = 1; i < n; i++) c[i] = D.full(i - 1, i);

  // ---- 0) dips: fade through black (or a white flash) between two different pictures ----
  const tau0 = Math.max(3, Math.round(0.5 * fps));
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) { let sum = 0; const o = i * PIX; for (let k = 0; k < PIX; k++) sum += thumbs[o + k]; lum[i] = sum / (PIX * 255); }
  const dips = [];
  for (const mode of ['black', 'white']) {
    const ext = (i) => (mode === 'black' ? lum[i] : 1 - lum[i]);   // small = extreme
    let i = 0;
    while (i < n) {
      if (ext(i) >= 0.10) { i++; continue; }
      let j = i; while (j + 1 < n && ext(j + 1) < 0.10) j++;
      const a = i, b = j; i = j + 1;
      if (b - a > 2 * tau0 * 2) continue;                       // a long black/white scene is content, not a transition
      const before = a - tau0, after = b + tau0;
      if (before < 0 || after >= n) continue;
      if (ext(before) < 0.2 || ext(after) < 0.2) continue;       // shots on either side must be normal
      if (D.tone(before, after) < P.gradThresh) continue;        // same picture on both sides: a blink, not a cut
      dips.push({ a, b, frame: Math.round((a + b) / 2), kind: 'dip', score: D.tone(before, after), ratio: 0 });
    }
  }
  const inDip = (f) => dips.some((d) => f >= d.a - tau0 && f <= d.b + tau0);

  // ---- 1) hard cuts ----
  const W = 12;
  const minFrames = Math.max(2, Math.round(P.minShot * fps));
  const hard = [];
  for (let k = Math.max(1, minFrames); k < n - minFrames; k++) {
    const ck = c[k];
    if (inDip(k)) continue;
    if (ck < P.hardFloor) continue;
    let isMax = true;
    for (let j = Math.max(1, k - 2); j <= Math.min(n - 1, k + 2); j++) if (j !== k && c[j] > ck) { isMax = false; break; }
    if (!isMax) continue;
    // ties (equal neighbours): keep the first
    if (k > 1 && c[k - 1] === ck) continue;

    // local motion level: median of nearby jumps, ignoring the candidate area and duplicate frames
    const nb = [];
    for (let j = Math.max(1, k - W); j <= Math.min(n - 1, k + W); j++) {
      if (Math.abs(j - k) <= 2) continue;
      if (c[j] > 0.002) nb.push(c[j]);
    }
    const base = nb.length ? median(nb) : 0.01;
    const ratio = ck / Math.max(base, 0.012);
    if (ratio < P.hardRatio) continue;

    // robust before/after separation (low quantile of the 3x3 cross distances)
    const A = [], B = [];
    for (let j = 1; j <= 3; j++) { if (k - j >= 0) A.push(k - j); if (k - 1 + j < n) B.push(k - 1 + j); }
    const ds = [];
    for (const a of A) for (const b of B) ds.push(D.full(a, b));
    ds.sort((x, y) => x - y);
    const cross = ds[Math.min(2, ds.length - 1)];
    if (cross < P.hardCross) continue;
    // ...and it must stand out from how much each side varies on its own (shake, motion, pops):
    // jitter makes before/after look about as different as the frames inside each side do.
    const intra = (side) => {
      const v = [];
      for (let x = 0; x < side.length; x++) for (let y = x + 1; y < side.length; y++) v.push(D.full(side[x], side[y]));
      if (!v.length) return 0;
      v.sort((x, y) => x - y);
      return v[Math.floor(0.3 * (v.length - 1))]; // low quantile: one odd frame can't inflate it
    };
    const A5 = [], B5 = [];
    for (let j = 1; j <= 5; j++) { if (k - j >= 0) A5.push(k - j); if (k - 1 + j < n) B5.push(k - 1 + j); }
    const spread = Math.max(intra(A5), intra(B5));
    if (cross < P.hardSep * spread) continue;

    hard.push({ frame: k, kind: 'hard', score: Math.min(ck, cross), ratio });
  }
  // A fast dissolve makes several spikes in a row with the signal staying elevated in between;
  // two real hard cuts drop back to the motion baseline between them. Collapse the former into
  // ONE boundary at the middle of the transition.
  {
    const merged = [];
    let grp = [];
    const flush = () => {
      if (!grp.length) return;
      if (grp.length === 1) merged.push(grp[0]);
      else {
        const fr = Math.round(grp.reduce((a, g) => a + g.frame, 0) / grp.length);
        merged.push({ frame: fr, kind: 'dissolve', score: Math.max(...grp.map((g) => g.score)), ratio: 0 });
      }
      grp = [];
    };
    for (const h of hard) {
      if (grp.length) {
        const prev = grp[grp.length - 1];
        const span = h.frame - prev.frame;
        let valley = Infinity;
        for (let j = prev.frame + 1; j < h.frame; j++) valley = Math.min(valley, c[j]);
        const sameTransition = span <= Math.round(0.6 * fps) && valley > 0.4 * Math.min(c[prev.frame], c[h.frame]);
        if (!sameTransition) flush();
      }
      grp.push(h);
    }
    flush();
    hard.length = 0; hard.push(...merged);
  }
  out.hardCandidates = hard.length;

  // ---- 2) dissolves / fades: 0.5 s before vs 0.5 s after ----
  const tau = Math.max(3, Math.round(0.5 * fps));
  const grad = [];
  if (n > 2 * tau + 2) {
    const S = new Float32Array(n);
    const offs = [-2, 0, 2];
    for (let i = tau; i < n - tau; i++) {
      const v = [];
      for (const a of offs) for (const b of offs) {
        const l = Math.max(0, Math.min(n - 1, i - tau + a)), r = Math.max(0, Math.min(n - 1, i + tau + b));
        v.push(D.tone(l, r));
      }
      v.sort((x, y) => x - y);
      S[i] = v[2]; // a single odd frame (flash/pop) at an endpoint can't fake a transition
    }
    let i = tau;
    while (i < n - tau) {
      if (S[i] < P.gradThresh) { i++; continue; }
      let j = i, peak = 0;
      while (j < n - tau && S[j] >= P.gradThresh) { if (S[j] > peak) peak = S[j]; j++; }
      // the transition sits at the centre of the plateau
      const centre = Math.round((i + j - 1) / 2);
      // if a hard cut already explains this region, don't add a dissolve on top of it
      const explained = hard.some((h) => h.frame >= i - tau && h.frame <= j + tau) || inDip(centre);
      // A real dissolve is a bounded step: the picture is stable on both sides of it. If the
      // same amount of change is also present one window earlier/later, or the plateau is very
      // wide, it's continuous drift or motion inside a shot, not a transition.
      const flanks = [];
      for (const q of [centre - 3 * tau, centre + 3 * tau]) if (q >= tau && q < n - tau) flanks.push(S[q]);
      const stable = flanks.length ? Math.min(...flanks) <= 0.5 * peak : false;
      // ...and it has to clearly beat the ordinary amount of change in the surrounding footage
      const around = [];
      for (let q = Math.max(tau, centre - 4 * tau); q <= Math.min(n - tau - 1, centre + 4 * tau); q++) {
        if (Math.abs(q - centre) > 1.5 * tau) around.push(S[q]);
      }
      const bg = around.length ? median(around) : 0;
      const stands = peak >= 2.2 * Math.max(bg, 0.03);
      const width = j - i;
      if (!explained && stable && stands && width <= 4.5 * tau) grad.push({ frame: centre, kind: 'dissolve', score: peak, ratio: 0 });
      i = j;
    }
  }
  out.gradCandidates = grad.length;

  // ---- 3) minimum shot length: strongest wins, no chain merging ----
  const all = hard.concat(grad, dips).sort((a, b) => b.score - a.score);
  const keep = [];
  for (const cand of all) {
    if (keep.every((k) => Math.abs(k.frame - cand.frame) >= minFrames)) keep.push(cand);
  }
  keep.sort((a, b) => a.frame - b.frame);

  // ---- 4) merge neighbours that are still the same shot ----
  // signature of a segment = mean colour histogram + mean layout of frames sampled away from its edges
  const sig = (f0, f1) => {
    const pad = Math.min(3, Math.floor((f1 - f0) / 4));
    const a = f0 + pad, b = Math.max(a, f1 - 1 - pad);
    const cnt = Math.min(12, b - a + 1);
    const idx = []; for (let q = 0; q < cnt; q++) idx.push(a + Math.round((cnt === 1 ? 0 : q * (b - a) / (cnt - 1))));
    const h = new Float32Array(HB * 3), g = new Float32Array(GX * GY * 3);
    for (const f of idx) {
      for (let k = 0; k < h.length; k++) h[k] += F.hist[f * h.length + k] / idx.length;
      for (let k = 0; k < g.length; k++) g[k] += F.grid[f * g.length + k] / idx.length;
    }
    return { h, g };
  };
  const sigDist = (A, B) => {
    let sh = 0, sg = 0;
    for (let k = 0; k < A.h.length; k++) sh += Math.abs(A.h[k] - B.h[k]);
    for (let k = 0; k < A.g.length; k++) sg += Math.abs(A.g[k] - B.g[k]);
    return Math.max(sh / 6, sg / A.g.length);
  };
  let changed = true;
  while (changed && keep.length) {
    changed = false;
    const edges = [0, ...keep.map((k) => k.frame), n];
    let worst = -1, worstD = Infinity;
    for (let q = 0; q < keep.length; q++) {
      const d = sigDist(sig(edges[q], edges[q + 1]), sig(edges[q + 1], edges[q + 2]));
      // strong hard cuts are never merged away, only weak/ambiguous ones
      if (keep[q].kind === 'hard' && keep[q].score >= 0.35) continue;
      if (d < P.mergeThresh && d < worstD) { worstD = d; worst = q; }
    }
    if (worst >= 0) { keep.splice(worst, 1); out.merged++; changed = true; }
  }

  out.cuts = keep.map((k) => {
    let time;
    if (k.kind === 'hard') time = (pts[k.frame - 1] + pts[k.frame]) / 2 - t0;
    else time = pts[k.frame] - t0;
    return { time, frame: k.frame, kind: k.kind, score: +k.score.toFixed(3), ratio: +k.ratio.toFixed(1) };
  });
  return out;
}

module.exports = { detectCuts, paramsFor, TW, TH, PIX };
