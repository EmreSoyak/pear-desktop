# Limited Repeat (`limited-repeat`)

**Origin:** custom (Emre, 2026-09-03; ported to YouTube's new player bar 2026-10-01)
**Type:** renderer plugin · **Default:** off · **restartNeeded:** false · **User config:** on

## What it does

An A-B loop for part of a track. An **LR button** sits in the player controls,
right after Repeat. Clicking it puts two draggable markers, `[` and `]`, on the
seek bar at 0:00 and at the end of the track. Playback then loops between them.

It is deliberately **disposable**:

| Action | Effect |
|---|---|
| Click LR again | off |
| Any other control in the player bar (repeat, shuffle, next, previous, like, volume, track info) | spent |
| **Play/pause** | safe: LR stays armed |
| **Seeking on the bar** (including the strip YouTube's right section overlaps) | safe |
| Song change | spent, and never restored |
| Repeat-mode change from anywhere (button, API server, shortcuts) | spent |

Hold **Shift** for a much larger grab area on the markers. Nothing is saved to
config.

## Why it exists

Repeat-one replays the whole song. LR is for learning a few bars, re-hearing a
solo, or transcribing a lyric.

## How it works

All of it is in [`src/plugins/limited-repeat/index.ts`](../../src/plugins/limited-repeat/index.ts), renderer only.

| Concern | Mechanism |
|---|---|
| Button | Inserted after `.ytmusicPlayerControlsRepeatButton` inside `.ytmusicPlayerControlsMainControls`. In the new layout it gets `data-layout="new"` (a 48px round button), and on purpose **not** YouTube's control classes, which YouTube's code queries. Falls back to the old `#right-controls .repeat` |
| Re-attach | A body-wide `MutationObserver` (`watchPlayerBar`) re-creates the button or overlay whenever YouTube re-renders them away |
| Markers | A fixed overlay `#limited-repeat-overlay`, vertically centred on the 3px seek bar. Only the two `.lr-handle`s take pointer events, so seeking keeps working everywhere else. Handles use `setPointerCapture` and swallow `pointerdown`/`mousedown`/`click` in capture phase, so a drag never seeks |
| Geometry | `getTrack()`. New bar: track = `rect.left + 6px`, width `rect.width - 12px` (`NEW_BAR_TRACK_INSET`, half the 12px slider thumb, calibrated). Old bar: left 0, element width (LESSONS #3) |
| Mask | YouTube's red progress line is masked outside A–B with `mask-image`, **through a `<style id="limited-repeat-mask">` rule**. It is never inline, because YouTube rewrites the seek bar's `style` attribute as it plays and would wipe an inline mask (that was the flicker). `mask-image` rather than `clip-path` so the masked bar still takes clicks (LESSONS #4) |
| Loop | `timeupdate` (~4 Hz) is the coarse guard. Within 1s of B a 25ms `setInterval` takes over (`startFineTimer`). At B, `video.currentTime = A`, resuming only if it was already playing (`jumpToA`) |
| Pause rule | `play` outside the range jumps to A. `ended` always restarts at A. Seeking past B drops back to A, and seeking before A is left alone |
| Repeat-mode cancel | `watchRepeatMode` subscribes to the app store (`#queue`.queue.store) and spends LR when `queue.repeatMode` changes. That covers real clicks *and* `element.click()` from the `peard:switch-repeat` IPC path, which fires no `pointerdown`. This replaced patching `ytmusic-player-bar.onRepeatButtonClick`, which no longer exists |
| Other-control cancel | A capture-phase `pointerdown` on the document (`onPointerDown`). It ignores clicks outside `ytmusic-miniplayer, ytmusic-player-bar`, on the seek bar or inside its horizontal strip, and on play/pause |
| Song change | `videodatachange` with `name === 'dataloaded'` → `cancel('song-changed')` |
| State export | `window.__limitedRepeatActive` (boolean) and `window.__limitedRepeat` (`{active, a, b}`), read by [playback-recovery](playback-recovery.md) |

## Config

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plugins.limited-repeat.enabled` | boolean | false | |
| `plugins.limited-repeat.logToConsole` | boolean | false | log state changes and loop points (menu checkbox) |

i18n: `plugins.limited-repeat.*` in `src/i18n/resources/en.json`.

## DOM anchors

New bar: `.ytmusicPlayerControlsRepeatButton`, `.ytmusicPlayerControlsMainControls`,
`input.ytMusicMiniPlayerProgressBar`, `.ytMusicMiniPlayerProgressBarWrapper`,
`.ytmusicPlayerControlsPlayPauseButton`, `ytmusic-miniplayer`, `#queue` (store), `video`.
Old bar fallback: `#right-controls .repeat`, `.right-controls-buttons`, `#progress-bar`,
`#play-pause-button`, `ytmusic-player-bar`. Lookups go through
[`src/providers/dom-elements.ts`](../../src/providers/dom-elements.ts).

## Measured (2026-10-01, new bar)

`z_development/limited-repeat/tests/lr-newbar-test.cjs`, 23/23 passing, all real
mouse input:

- Marker vs YouTube's own seek at the same x: **0.42s** error, where one pixel is 2.45s on a one-hour track
- The mask survived every one of YouTube's style rewrites
- Loop overshoot past B: **~3ms** when timers run on time, **84–145ms** when the hidden window throttles timers to 250ms

## Known limits

- **Hidden-window throttling.** In the tray, Chromium fires the 25ms fine timer about every 250ms, so the loop point can overshoot by up to ~150ms. Fixing it needs `backgroundThrottling: false`, at a CPU cost (not set). See LESSONS #15.
- Marker layout refreshes every 400ms and on resize.
- One loop range per track, and it isn't persisted.

## History

- 2026-09-03: shipped as a separate button. A fourth repeat state could not intercept real clicks.
- 2026-10-01: ported to `ytmusic-miniplayer`. Track geometry recalibrated, method patch replaced by a store subscription, mask moved to a stylesheet (flicker fix), overlap-strip click no longer spends LR. See [../changelog.md](../changelog.md).

Deep design notes and the older harnesses: [`z_development/limited-repeat/`](../../z_development/limited-repeat/README.md).
