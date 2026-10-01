# Playback Recovery (`playback-recovery`)

**Origin:** custom (Emre, 2026-04-15) · **Type:** renderer plugin · **Default:** off · **restartNeeded:** false · **User config:** on

## What it does

A watchdog that notices when playback is stuck (the UI says playing but nothing
moves) and recovers on its own, escalating to skipping the track.

## Why it exists

During long sessions, after sleep, or on a flaky connection, the web player can
freeze while still showing "playing". The only manual fix was to skip or reload.

## How it works

All in [`src/plugins/playback-recovery/index.ts`](../../src/plugins/playback-recovery/index.ts):

**Health tracking.** `timeupdate` with `currentTime > 0` and not paused records
`lastGoodTime` and `lastGoodTimestamp`, and resets the failure count.

**Watchdog** (every 3s, `startWatchdog`). It skips while `recovering`, while
[Limited Repeat](limited-repeat.md) is active (`window.__limitedRepeatActive`),
or unless `api.getPlayerState() === 1` (playing):

| Case | Condition | Reason tag |
|---|---|---|
| Dead | `readyState === 0`, not paused, no progress for more than `stallTimeoutMs` | `dead-playback` |
| Frozen | not paused, `currentTime > 0`, no progress for more than `stallTimeoutMs` | `frozen-playback` |
| Buffer exhausted | `buffered.end - currentTime <= 0` and `readyState < 3` | `buffer-exhausted` |

**Event hooks.** `error` triggers immediate recovery. `stalled` re-checks after
`stallTimeoutMs` (`readyState < 3` → `stall-timeout`). `waiting` re-checks after
`stallTimeoutMs` (`readyState < 2` → `buffer-timeout`). A body-wide
`MutationObserver` re-attaches the hooks to a recreated `<video>` (each element
is marked with `__pbRecovery`).

**Escalation** (`attemptRecovery`, one at a time with a 4s settle):

| Attempt | Strategy |
|---|---|
| 1–2 | `api.seekTo(currentTime)` + `playVideo()` |
| 3–4 | `api.seekTo(currentTime + 1)` + `playVideo()` |
| more than `maxRetries` | `api.nextVideo()`, then a 5s grace period |

## Config

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plugins.playback-recovery.enabled` | boolean | false | |
| `plugins.playback-recovery.stallTimeoutMs` | number | 8000 | how long a stall or freeze must last |
| `plugins.playback-recovery.maxRetries` | number | 5 | failures before skipping |
| `plugins.playback-recovery.logToConsole` | boolean | true | menu checkbox |

## DOM anchors

`video` only. It uses the player API (`getPlayerState`, `seekTo`, `playVideo`,
`nextVideo`). New player bar (2026-10): **unaffected**.

## Gotchas

- LR loops make `currentTime` oscillate, which looks frozen, so recovery stands
  down while LR is armed.
- `pnpm typecheck` reports about 33 errors here: helper methods missing from the
  `createPlugin` generic. They're harmless at runtime (LESSONS #10).
