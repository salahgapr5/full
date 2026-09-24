# Video Editor → Mac App — Project Handoff

Paste this file (and the project zip) into a new Claude conversation at any time
and say "continue this project" — it has everything needed to pick up where we
left off.

## Goal
Turn the browser-based B-roll/avatar video editor (originally a section inside
a bigger `index.html` production-board site) into an installable Mac desktop
app: download a `.dmg`, drag to Applications, double-click to open. No Terminal
required to use it. Target: Apple Silicon (M4), later a universal build.

## The 4-step plan (step 3 was split in two)
1. **Step 1 — Electron shell (this delivery).** Extract the editor's HTML/CSS/JS
   out of the big site into a standalone page, wrap it in a minimal Electron
   app, and set up a GitHub Actions workflow that builds a `.dmg` on a cloud
   Mac (so the user never needs a command line). Editor behavior is unchanged
   from the browser version: still uses `<input type=file>`, the canvas-based
   preview/compositor, and the WebCodecs-based "Fast render (MP4)" button.
   Cut detection is still the old frame-seeking JS scan (slow, but unchanged).
2. **Step 2 — ffmpeg integration.** Bundle a macOS ffmpeg binary. Add:
   - `ffprobe`-based media info instead of guessing from `<video>` metadata.
   - One-pass ffmpeg scan to replace the slow JS cut-detection scan (rewritten in v0.4.1, see "Cut detection rewrite").
   - Lightweight preview proxies (720p H.264) for any clip Chromium can't play
     natively, so the in-app preview stays smooth regardless of source codec.
   - Native open/save dialogs via Electron's `dialog` module (replacing the
     `<input type=file>` pickers), and reading/writing API keys through
     `safeStorage` (macOS Keychain) instead of `localStorage`.
   - IPC bridge in `preload.js` (`window.vem.*`) connecting the page to these
     main-process capabilities.
3. **Step 3A — ffmpeg render pipeline.** Replace the in-browser canvas/MediaRecorder
   export with an ffmpeg render that matches the preview (crossfades, Ken Burns zoom,
   rounded corners, border ring, background layer). 1080p / 2K / 4K, native save dialog,
   progress + cancel.
4. **Step 3B — polish + packaging.** App icon, ad-hoc code signing of the app and the
   bundled ffmpeg, CI sanity checks, final `.dmg`.

## STATUS: Steps 1, 2, 3A and 3B are DONE (code-complete). Next: user builds the .dmg and tests on the Mac.

## Cut detection rewrite (v0.4.1) — replaces the old ffmpeg `scene` threshold
Problem seen on real footage: one continuous shot (motion/flicker) was chopped into ~25 half-second
clips at the default slider, and raising the slider lost real cuts (and crossfades were never found).
A per-frame "how big is the jump" threshold can't fix both at once.

New method (`src/scene-detect.js`, frames come from `src/thumb-extract.js`):
- ONE ffmpeg pass decodes every frame to a 32x18 RGB thumbnail (+ exact pts from showinfo).
- Hard cut = spike that stands out from the LOCAL motion level AND the picture 3 frames before vs 3 after
  is really different (low quantile, so 1-2 frame flashes/pops don't count) AND that difference is clearly
  bigger than the jitter inside each side. Different pictures, not just big jumps.
- Crossfade/dissolve = colour+layout of the picture 0.5 s before vs 0.5 s after differs, with a stable
  shot on both sides and clearly above the surrounding change level. Reported at the centre.
- Dip to black / white flash = near-black/white run between two different pictures -> one cut at its centre.
- Min shot length 0.2 s enforced by strongest-wins non-max suppression (no chain merging), then adjacent
  segments that still look like the same shot are merged.
- Boundary time = midpoint between last old frame and first new frame, so no repeated frame at clip starts.
- Slider unchanged (5-150, lower = more cuts) but now it only removes WEAK cuts; obvious cuts survive at 150.
- The editor status line shows "N cuts (H hard, F fades)" and the devtools console prints a table of every
  cut with kind + score (View > Toggle Developer Tools) — send that table if a cut is ever wrong.
- Old `scene`-score approach is gone from detectScenes; the in-page JS scanner is still the fallback if
  ffmpeg fails.

Tested only on synthetic footage generated with ffmpeg (hard cuts, jittery single shot with pops, similar
shots, crossfades, 24->30 fps duplicate frames, 0.6 s rapid cuts, dip-to-black, slow-zoom stills):
default slider = every cut found, 0 false cuts; old method: 25-42 false cuts in the single shot at low
slider, only 3/7 real cuts at slider 100. NOT yet tested on the user's real footage.

## What Step 3B added (on top of 3A; everything else in this zip is the 3A code)
- `build/icon.png` (1024px, generated; replace with your own art any time, same path).
- `scripts/adhoc-sign.js` (electron-builder `afterPack`): ad-hoc `codesign -s -` on the bundled
  ffmpeg/ffprobe first, then the whole .app. `mac.identity: null` so electron-builder does not try
  to sign with a certificate that doesn't exist.
- package.json v0.4.0: arm64-only dmg target, icon, hardenedRuntime off.
- Workflow: new "Sanity-check the packaged app" step prints the bundled ffmpeg version, whether it has
  h264_videotoolbox / libx264, and `codesign --verify`. Read that step's log first if anything is off.

### Not verified (needs a Mac / the Actions run)
- The afterPack signing script and the sanity step have never run (no macOS here). If `codesign`
  complains in CI, the log will say which path.
- Whether ffmpeg-static's mac arm64 build includes h264_videotoolbox: the sanity step answers it.
  If it does not, renders silently use libx264 (slower, GPL note above still applies).
- Intel Macs are not supported by this build (arm64 only). Add `x64` to the dmg arch list later.

### How the ffmpeg render works (src/ffmpeg-render.js)
- Timeline is cut into frame-exact pieces: STEADY (one segment) and ZONE (crossfade between
  two neighbours, via `xfade`). Each piece is a small ffmpeg run encoded with
  h264_videotoolbox (libx264 fallback if the first piece fails), written as MPEG-TS.
  Pieces are joined with the concat demuxer (stream copy) and the avatar audio is muxed as AAC.
- Each "layer" = background (looped bg clip or black) + foreground stretched into the frame box,
  Ken Burns via `perspective`, rounded-corner `alphamerge` mask, overlay, border-ring overlay.
- The renderer draws the mask and border PNGs (canvas) at the exact output size, using
  `vem:get-geometry` for the numbers. Radius and border width are scaled by outH / RENDER_H.
- Avatar file is the master clock (N = avatar duration x 30). B-roll is retimed by `rate`.
- Output is always 30 fps H.264 + AAC, .mp4.

### What Step 3A changed in editor.html
- New "Export size" select (1080p / 2K / 4K) and **Render video (ffmpeg)** + **Cancel render**
  buttons. In the desktop app the old canvas "Fast render" button is hidden; the old code is
  still in the file (used only if window.vem is missing, i.e. plain browser).
- `buildRenderSpec()` collects settings + file paths + mask/border PNG and calls `window.vem.render`.
- "Replace clip" now uses a native dialog (`pickMedia`) and stores `seg.replacePath`
  (ffmpeg needs a real path). Background path is tracked in `bgPath`.
- Image segments (AI-generated) are sent as data URLs and written to temp files in main.

### Verified vs NOT verified
- Verified (Linux sandbox, system ffmpeg 6.1.1 via VEM_FFMPEG): full render of a 6 s test with
  broll + avatar + replaced-image (mirrored) + background + crossfades + border + rounded corners
  -> 1920x1080, exactly 180 frames, 6.000 s, AAC audio; frames inspected by eye.
- Fixed during testing: broll/replaced-video inputs now get `tpad` (clone last frame) so a source
  that ends a hair early can't crash a piece.
- Sandbox quirk (NOT an app bug, probably): the Linux `ffmpeg-static` binary segfaults when reading
  any MPEG-TS file here. Untested whether the macOS build has any issue; if the .dmg render fails at
  "Joining pieces", switch the piece container from mpegts to mp4/matroska in ffmpeg-render.js
  (the `-f mpegts` and `.ts` spots) and use concat-demuxer with mp4 pieces.
- NOT verified: anything on a real Mac (VideoToolbox bitrate/quality, 2K/4K speed, save dialog,
  progress UI, cancel). Not tested with a 2nd render started after a cancelled one.
- Zoom + crop + `replaced` video timing follow the canvas math but were only tested with an image
  replacement; test a replaced *video* clip and a broll crop on real footage.

## v0.5.0 — Production Board shell, Cutter & Compress, admin-access switch
Built from your `index.html` (the full production-board website) plus the standalone
`silence-cutter` Python tool, merged into this Electron app per your last set of
instructions. Nothing in this round has been run — no Electron, no Mac, no macOS
runtime is available where this was built. Test it and report back.

### What changed
- **App shell (`src/shell.html`, now the file `main.js` loads).** Two tab rows:
  - Top row: one button per person in the site's own `PEOPLE` array (Omar, Amr,
    Ahmed, Mahmoud — refreshed every 2.5s from the site itself, so a member Salah
    adds later shows up here too, no rebuild needed), then Salah, Links,
    Informations, Accounts.
  - Tools row (fixed): Video Editor, Audio Maker, Cutter & Compress, Thumbnail.
  - Under the hood: three `<webview>` guests stacked in `#content` — `site.html`
    (the trimmed production-board website), `editor.html` (unchanged ffmpeg video
    editor), `cutter.html` (new). Only one is visible at a time. Top-row and
    Audio Maker / Thumbnail clicks call `webview.executeJavaScript('activePerson=…;
    renderTabs(); renderBoard();')` inside the site guest and bring it to the
    front; Video Editor / Cutter & Compress just switch which webview is shown.
  - `main.js` now sets `webviewTag: true` on the main window and adds
    `vem:get-app-dir` (IPC) so the shell can build an absolute `file://` path to
    `preload.js` for the editor/cutter webviews (the `preload` attribute on
    `<webview>` needs an absolute path; the shell page itself has no Node access
    to compute one otherwise).
  - **Not verified:** whether Electron's `<webview>` tag behaves exactly like this
    on a real build (executeJavaScript timing, dom-ready ordering, default
    partition/session persistence for Firebase auth across app restarts). This is
    the single biggest unknown in this release — if the top row never appears, or
    clicking a person tab does nothing, check devtools on both the shell page and
    the site webview (right-click → Inspect works on `<webview>` too).

- **`src/site.html`** — your `index.html`, with:
  - The Video Editor tab/panel removed entirely: markup (`#videoEditorHost` and
    its CSS), the ~800-line inline B-roll/avatar script, and its tab-row entry are
    all deleted. The app's `editor.html` (ffmpeg-based) is now the only editor.
  - Audio Maker and Thumbnail tab-row entries removed (their `renderAudioBoard()`
    / `renderThumbnailBoard()` functions are untouched — the shell's tools row
    reaches them via `activePerson = AUDIO_ID / THUMB_ID`).
  - `nav.tabs` hidden via `body.embedded nav.tabs{ display:none }` — the shell
    adds `.embedded` to `<body>` on `dom-ready`. Opening `site.html` directly in a
    browser (not through the shell) still shows its own nav bar as before.
  - Admin-access switch: `memberAccounts[id].adminAccess` (boolean). `isAdmin()`
    now returns true for the real Salah login **or** a member with `adminAccess`
    on; `isRealAdmin()` is the strict Salah-only check. Salah → Member Accounts
    gets a per-member "Admin access" checkbox, editable only when `isRealAdmin()`
    is true (an admin-enabled member sees their own row's switch as a read-only
    label, can't grant/revoke it for themselves or anyone else). Logging in as an
    admin-enabled member still lands on that member's own page (`activePerson =
    memberId`, per your instruction), but with full admin powers and access to
    the Salah tab.
  - New defaults: sensitivity 20, trim 0.3, frame size 95%, transition 0.3,
    border 10px, corner radius 20px, crop 0 (unchanged) — same as `editor.html`.

- **`src/cutter.html` + `src/silence-cutter.js`** — Cutter & Compress. A straight
  JS port of `silence_cutter.py`'s pipeline (ffmpeg `silencedetect` → shrink each
  gap by `padding` on both sides → complement = keep-segments → one
  `filter_complex` trim+concat ffmpeg pass, re-encoded once) running on the app's
  bundled ffmpeg instead of a Python subprocess. Same defaults as the original
  tool: -30dB threshold, 0.5s minimum gap, 0.1s padding (all exposed as
  "Advanced settings" in the UI, collapsed by default). Native open/save dialogs,
  progress bar (parses ffmpeg's `-progress pipe:2` output), cancel button.
  "Compress" is the name only — same as the original tool, there's no separate
  size/quality step. New IPC: `vem:cutter-pick-video`, `vem:cutter-pick-save-path`,
  `vem:cutter-run`, `vem:cutter-cancel`, `vem:cutter-progress` (progress event).
  **Not verified:** never run against a real video file (no ffmpeg execution
  environment here) — the `silencedetect` regex parsing and the `-progress
  pipe:2` `out_time_ms` parsing are the two spots most likely to need a fix
  after your first real run.

- **`package.json`** — version 0.5.0, productName "Production Board" (was "Video
  Editor"), main window title updated to match.

### What to ask the user when resuming this round
- Did the `.dmg` build and open? Do the two tab rows render, with all four
  members (or however many exist) in the top row?
- Clicking a person tab / Salah / Links / Informations / Accounts / Audio Maker /
  Thumbnail — does the site content actually switch, or does the content area
  stay blank / show the wrong page?
- Cutter & Compress: pick a video, run it — does it produce a cut file? Check the
  status line / error box for anything from ffmpeg if it fails.
- Admin access: as Salah, toggle a member's "Admin access" on, log out, log back
  in as that member — do they land on their own page with the Salah tab visible
  and edit/delete powers, but no way to change anyone's admin switch?
- Firebase sync/login: does it still work exactly as before, now that the site
  runs inside a `<webview>` instead of being the top-level page?

## Step 3B plan (now implemented, kept for reference)
1. App icon (build/icon.png, referenced from package.json).
2. Ad-hoc signing of the .app and the bundled ffmpeg/ffprobe (afterPack hook), arm64 target.
3. CI sanity step: print `ffmpeg -version` and check for `h264_videotoolbox` from the packaged app.
4. Final Actions run -> .dmg; user does the "unidentified developer" right-click Open once.

## Source of truth
The editor's HTML/CSS/JS in `src/editor.html` was extracted verbatim from the
video-editor section of the user's uploaded `index.html` (originally lines
~926–987 for the panel markup and ~3525–4314 for the script, inside a
larger multi-page site — those line numbers won't mean anything to a fresh
Claude session, they're just provenance). The extraction was a straight copy;
no logic was changed in Step 1. If the user's original `index.html` is
uploaded again in a future session, a diff against that file is the fastest
way to check nothing drifted.

## Known constraints / decisions carried forward
- Electron (not Tauri): the editor uses canvas + WebCodecs heavily; Tauri's
  Safari-based WebView has weaker WebCodecs support.
- ffmpeg builds using libx264 are GPL-licensed — fine for personal use, but
  flag it if the user ever wants to distribute the app publicly. Prefer
  VideoToolbox (Apple's hardware encoder) where possible to sidestep this.
- No Apple Developer account assumed yet ($99/yr) — ad-hoc signing only,
  "unidentified developer" warning is expected and is a one-time click-through.
- Architecture: building for arm64 (M-series) first; add x64 later only if
  the user needs Intel Mac support, bundling the matching ffmpeg binary for
  each.

## What to ask the user when resuming
- Did the Step 3B `.dmg` build (check the Actions "Sanity-check" step output) and open? Does Render video (ffmpeg) finish and play back?
- Speed at 1080p vs 4K (frames/s shown in the status line)? Any error text in the status line?
- Anything to change in the editor itself now that export works?
