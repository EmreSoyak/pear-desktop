# Audio-Only Mode (`audio-only`)

**Origin:** custom (Emre, 2026-04-15) · **Type:** renderer plugin · **Default:** off · **restartNeeded:** true · **User config:** on

## What it does

Forces YouTube Music into its audio-only playback path: the video is hidden,
album art is shown, and the lowest video quality is requested.

## Why it exists

YouTube Music streams and decodes video even when the window is hidden in the
tray. For a music-only desktop app that wasted about 300 MB of RAM (measured
with `monitor.cjs` / `inject-lightweight.cjs`; see
[`../../lightweight-mode.md`](../../lightweight-mode.md)).

## How it works

All in [`src/plugins/audio-only/index.ts`](../../src/plugins/audio-only/index.ts):

| Step | Code |
|---|---|
| `start()` | Sets `playback-mode="ATV_PREFERRED"` and `margin: auto 0px` on `ytmusic-player`, then locks the attribute (`lockPlaybackMode`) |
| Lock | A `MutationObserver` on `ytmusic-player` filtered to `playback-mode` puts `ATV_PREFERRED` back whenever YouTube changes it |
| `onPlayerApiReady` | `setAudioOnly()`: calls `#movie_player.setPlaybackQualityRange('tiny')` and `setPlaybackQuality('tiny')` when present, then `applyVisualMode()` |
| `applyVisualMode()` | Hides `#song-video.ytmusic-player` and the `video` element (`display:none`) and shows `#song-image` |
| Song change | Re-applies both on `videodatachange` / `dataloaded` |

## Config

| Key | Type | Default |
|---|---|---|
| `plugins.audio-only.enabled` | boolean | false |

No menu.

## DOM anchors

`ytmusic-player`, `#movie_player`, `#song-video.ytmusic-player`, `#song-image`, `video`.
All still exist on the 2026-10 layout (verified live).

## Gotchas

- The i18n description (`plugins.audio-only.description`) claims it "blocks all
  video streams at network and player level". The code works at **player level
  only**: there is no network blocking.
- It hides the `video` element with `display:none`. Other code that needs the
  element (LR, playback-recovery, song-info) still finds it with
  `querySelector('video')`. Its layout box is zero, which matters only if
  something measures it.
- New player bar (2026-10): **unaffected**.
