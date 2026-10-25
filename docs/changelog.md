# Changes in This Fork

These are changes on top of upstream (merge-base
`4f04128b`, th-ch/youtube-music), newest first. Source: `git log
$(git merge-base master origin/master)..master` plus uncommitted work.
Upstream's own history is in [`../changelog.md`](../changelog.md).

## 2026-10-25 · Gapless timeline, seek bar, layout, one plugin per feature (uncommitted at time of writing)

**Trigger.** About a week after the redesign, YouTube changed the page again,
with no app update:
- LR's brackets slid back and LR dissolved at the end of the song;
- the seek bar was nearly impossible to grab;
- the left guide sat under the header;
- the tray hover card still died after a while.

| Change | Files |
|---|---|
| Song-relative time on the gapless player: read via the player API, length from `seekableEnd`, seek with `api.seekTo` | `src/providers/song-time.ts` (new), `src/types/music-player.ts` |
| LR on song time, document-level media listeners (the `<video>` is replaced at some song changes), 0.75s end guard before the gapless handoff, markers on the bar's own `max` | `src/plugins/limited-repeat/index.ts` |
| Elapsed-time / seeked / play-paused feeds and `lengthSeconds` on song time, document-level listeners | `src/providers/song-info-front.ts` |
| Recovery seeks used stream time (would skip tracks on track 2+) | `src/plugins/playback-recovery/index.ts` |
| New plugin: 21px seek-bar grab area, grows on hover, no text selection, steps back for the volume popup | `src/plugins/seekbar-grab/` |
| New plugin: Up Next panel flush right | `src/plugins/player-layout/` |
| Left guide 32px too high: YouTube dropped `is-bauhaus-sidenav-enabled`, the in-app-menu offset rules no longer matched | `src/plugins/in-app-menu/titlebar.css` |
| Tray hover: diagnostic logger finally in an installed build, self-heal (logged first) | `src/plugins/tray-hover/popup.ts`, `hover-debug.ts` |
| **Restructure:** tray hover → plugin `tray-hover` (out of `notifications`); virtual desktop → plugin `virtual-desktop` (core keeps `showWindow` / `setShowWindowHandler`); English pin → plugin `english-interface` (out of `providers/` + `index.ts`) | `src/plugins/{tray-hover,virtual-desktop,english-interface}/`, `src/window-utils.ts`, `src/tray.ts`, `src/index.ts`, `src/menu.ts`, `src/config/defaults.ts`, notifications plugin |
| Settings carried over: `migrateForkSettings` (unversioned, idempotent) | `src/config/store.ts` |
| `options.autoUpdates` set to false in the user's config (it never did anything for the `dir` build) | user config (backup `config.json.bak-2026-10-25`) |
| Harnesses: LR harness ported to API time, new gapless LR and seek-bar harnesses | `z_development/limited-repeat/tests/lr-newbar-test.cjs`, `lr-gapless-test.cjs`, `z_development/player-bar/tests/seekbar-grab-test.cjs` |
| LESSONS #18–#21, docs | `z_development/LESSONS.md`, `docs/` |

## 2026-10-01 · YouTube player-bar redesign, English pin

**Trigger.** music.youtube.com replaced `ytmusic-player-bar` with
`ytmusic-miniplayer`. LR vanished, and the UI turned Turkish. The app binary
had not changed. Details: [player-bar.md](player-bar.md).

| Change | Files |
|---|---|
| New-layout DOM helpers with old-layout fallback | `src/providers/dom-elements.ts` |
| Core IPC handlers ported: prev/next, shuffle, like, repeat (with a yield between clicks), volume (via the slider), mute, fullscreen state, like-button CSS options | `src/renderer.ts` |
| State feeds ported: time (`timeupdate`), repeat/shuffle/fullscreen (store subscription), like (`aria-pressed`), autoplay null guard; fixes a `observe(null)` throw | `src/providers/song-info-front.ts` |
| LR ported: button placement/style, 6px track inset, centred overlay, store-based repeat cancel, mask moved to a stylesheet (**flicker fix**), overlap strip no longer spends LR | `src/plugins/limited-repeat/index.ts` |
| YouTube UI pinned to English (`hl=en` in the PREF cookie, re-asserted on change) | `src/providers/youtube-language.ts`, `src/index.ts` |
| New harnesses; calibration retargeted | `z_development/player-bar/tests/core-ipc-test.cjs`, `z_development/limited-repeat/tests/lr-newbar-test.cjs`, `lr-calib.cjs` |
| LESSONS #3/#4/#7/#8 updated, #13–#17 added | `z_development/LESSONS.md` |
| This `docs/` folder | `docs/` |

## 2026-09-03 · Limited Repeat (`1ec3f7a1`, `29d9c170`, `a2f6e389`, `803bacee`)

- `803bacee`: LR added, first as a disposable A-B loop on the repeat button.
- `a2f6e389`: player-bar observer and pause handling hardened.
- `29d9c170`: rebuilt as a marker-based A-B loop with its own button. `z_development/` added (LESSONS, harnesses). Playback-recovery stands down while LR is active.
- Doc: [custom/limited-repeat.md](custom/limited-repeat.md)

## 2026-09-03 · Local dev tooling (`2ba6495d`, merged in `9e714ebd`)

`build.bat`, `start.bat`, `diagnose.bat`, `monitor.cjs`,
`inject-lightweight.cjs`, shortcut scripts, `icon.ico`, setup and session
notes. Doc: [dev-tooling.md](dev-tooling.md).

## 2026-04-15 · Desktop workflow feature pack (`f388c31f`, docs `f4b1f37a`)

- [Audio-Only Mode](custom/audio-only.md): new plugin `audio-only`
- [Playback Recovery](custom/playback-recovery.md): new plugin `playback-recovery`
- [Virtual Desktop Awareness](custom/virtual-desktop.md): `options.trayMoveToCurrentDesktop`, `src/window-utils.ts`, deferred tray handlers in `src/tray.ts`, menu entry
- [Tray Hover Mini-Player](custom/tray-hover-mini-player.md): `notifications` plugin extension (`hover-popup.ts`, `assets/hover-popup.html`, `hoverControls`)
- DevTools in dev mode only with `OPEN_DEVTOOLS` (`src/index.ts`)
- Upstream PR: pear-devs/pear-desktop#4428
