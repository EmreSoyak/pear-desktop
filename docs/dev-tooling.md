# Dev Tooling: Build, Run, Test, Diagnose

Everything here lives in the repo root or [`z_development/`](../z_development/README.md).
**Read [`z_development/LESSONS.md`](../z_development/LESSONS.md) before building or testing.**

## Build and install

| Script | What it does |
|---|---|
| [`build.bat`](../build.bat) | `pnpm clean` → `pnpm build` → `electron-builder --win dir:x64 -p never`, output `pack/win-unpacked/`. **`pnpm clean` deletes `pack/`.** Fine for a normal rebuild, but a failed packaging step leaves no app |
| [`start.bat`](../start.bat) | launches `pack\win-unpacked\YouTube Music.exe` |
| [`diagnose.bat`](../diagnose.bat) | kills the app, relaunches with `--remote-debugging-port=9222`, runs `monitor.cjs` |
| [`update-shortcut.ps1`](../update-shortcut.ps1) | desktop shortcut → the packaged exe |
| [`pin-shortcut.ps1`](../pin-shortcut.ps1) | desktop shortcut → `pnpm dev` (old dev-mode setup) |
| [`make-icon.ps1`](../make-icon.ps1) | `assets/icon.png` → `icon.ico` |

**Safe iteration build** (LESSONS #1). The app must be closed for the last step:

```bash
pnpm build
SCRATCH=<scratch dir outside the repo>; rm -rf "$SCRATCH"
./node_modules/.bin/electron-builder --win dir:x64 -p never --config.directories.output="$SCRATCH"
ls "$SCRATCH/win-unpacked" | wc -l          # must be 20
# (the winCodeSign symlink error is cosmetic)
cp -rf "$SCRATCH/win-unpacked/." pack/win-unpacked/
```

The installed shortcuts (taskbar pin "YouTube Music (2).lnk" and the Start Menu
entry) point at `Z:\z_youtube_player\pack\win-unpacked\YouTube Music.exe`. The
app is a single instance: launching it again while it runs (including from the
tray) just focuses the running copy, **so extra flags like
`--remote-debugging-port` are ignored unless you kill it first.**

User data and config: `%APPDATA%\YouTube Music\` (`config.json`).

`autoUpdates` is `true` in config, but the packaged `dir` build has no
`app-update.yml`, so nothing has ever auto-updated. "It got updated" has so far
always meant YouTube changed the web page (LESSONS #13).

## Checks

| Command | Notes |
|---|---|
| `pnpm typecheck` | **41 pre-existing errors** (audio-only, playback-recovery, api-server websocket). Filter to your files: `pnpm typecheck 2>&1 \| grep <file>` |
| `pnpm lint` | does not run (`eslint-plugin-perfectionist` missing) |

## Live-app test harnesses (CDP)

All of them need the app started with `--remote-debugging-port=9222`, and the
core IPC test also needs `--inspect=9229`. They use `ws` from `node_modules`, so
run them from the repo root.

| Harness | Covers |
|---|---|
| [`z_development/player-bar/tests/core-ipc-test.cjs`](../z_development/player-bar/tests/core-ipc-test.cjs) | real main-process IPC: prev/next, repeat, like, mute, volume, shuffle state, plus the time/repeat/like/shuffle/fullscreen feeds. Run it on a **fresh** app session: the feeds are singletons |
| [`z_development/limited-repeat/tests/lr-newbar-test.cjs`](../z_development/limited-repeat/tests/lr-newbar-test.cjs) | LR on the new bar: real mouse, accuracy against YouTube's own seek, mask flicker, overlap strip, loop overshoot plus timer cadence, cancel rules |
| [`z_development/limited-repeat/tests/lr-calib.cjs`](../z_development/limited-repeat/tests/lr-calib.cjs) | seek-bar geometry calibration at two widths (retargeted to the new bar). Leaves the viewport emulated, so restart the app afterwards (LESSONS #16) |
| `lr-test.cjs`, `lr-loop-test.cjs`, `lr-accuracy.cjs`, `lr-shift-test.cjs` | **old bar only**: kept for history and the A/B-test fallback |

Testing rules that cost real time to learn (LESSONS #2):

- Use `Input.dispatchMouseEvent`, never synthetic `dispatchEvent`, which skips hit-testing.
- Derive expectations independently of the code under test.
- Report measured numbers.

## Diagnostics

| Tool | What it does |
|---|---|
| [`monitor.cjs`](../monitor.cjs) | CDP watcher that logs play/pause/stall/error/dialog/network events with timestamps |
| [`inject-lightweight.cjs`](../inject-lightweight.cjs) | the runtime prototype of audio-only mode, injected over CDP (superseded by the [audio-only plugin](custom/audio-only.md)) |
| [`lightweight-mode.md`](../lightweight-mode.md) | the RAM findings behind audio-only |

## Git remotes

`origin` = th-ch/youtube-music (upstream, **never push**). `fork` =
EmreSoyak/pear-desktop. Integration branch: `master` → `git push fork master`.
Never commit or push without asking (LESSONS #12).
