# The Player Bar: DOM Anchors and the 2026-10 Redesign

Everything that controls playback or reads its state from the page depends on
YouTube's player bar. **YouTube can change it at any time, with no app
update.** On 2026-10-01 it replaced `ytmusic-player-bar` with
`ytmusic-miniplayer`. This file is the reference for both layouts and for how
each piece of the app talks to the bar.

## The new layout (2026-10-01)

Measured live at a 1552×872 viewport:

```
ytmusic-app > ytmusic-app-layout#layout > ytmusic-miniplayer[slot=player-bar]   (0,800 1550×72)
├─ div.ytMusicMiniPlayerProgressBarWrapper                         (0,789 full width × 23)
│   └─ input.ytMusicMiniPlayerProgressBar  type=range, 3px tall   (value = seconds, a PROPERTY)
├─ div.ytMusicMiniPlayerLeftSection
│   └─ ytmusic-track-info  (thumbnail, .ytmusicTrackInfoTitle, .ytmusicTrackInfoByline)
├─ div.ytMusicMiniPlayerMiddleSection
│   └─ ytmusic-wiz-player-controls
│       └─ div.ytmusicPlayerControlsMainControls   (flex, gap 16px)
│           ├─ div.ytmusicPlayerControlsShuffleButton    > button  (aria-pressed)
│           ├─ div.…PlaybackRateButton / SeekBackwardButton  [hidden]
│           ├─ div.ytmusicPlayerControlsPreviousButton   > button
│           ├─ div.ytmusicPlayerControlsPlayPauseButton  > button
│           ├─ div.…SeekForwardButton  [hidden]
│           ├─ div.ytmusicPlayerControlsNextButton       > button
│           ├─ div.ytmusicPlayerControlsRepeatButton     > button  (title "Repeat off/all/one")
│           └─ button#limited-repeat-button[data-layout=new]   ← ours (LR)
└─ div.ytMusicMiniPlayerRightSection        (OVERLAPS the bar's lower half from y=800!)
    ├─ div.ytMusicMiniPlayerTimeInfo
    ├─ yt-video-action-bar-view-model.ytMusicMiniPlayerActionBar
    │   └─ like-button-view-model / dislike-button-view-model > toggle-button-view-model > button (aria-pressed)
    ├─ div.ytMusicMiniPlayerVolumeWrapper > button (Mute) + .ytMusicMiniPlayerVolumePopup input#slider (0–100)
    └─ button[aria-label=MORE]
```

Control buttons are 48×48 with 24px icons, `border-radius: 24px`, white.

**App state.** `document.querySelector('#queue').queue.store` is a redux-style
store with `getState()` and `subscribe()`. It is the same object as
`ytmusic-app.getState()`. Useful fields: `queue.repeatMode` (`NONE|ALL|ONE`),
`queue.shuffleEnabled`, `queue.autoplay`, `player.fullscreened`,
`player.muted`, `player.volume` (doesn't follow slider changes),
`player.isPlaying`.

**Still present and unchanged:** `ytmusic-app`, `ytmusic-player-page`,
`ytmusic-player`, `#movie_player` (player API: `nextVideo`, `previousVideo`,
`setVolume`, `mute`, `getVideoData`, ...), `video`, `#song-image`,
`#song-video`, `#player`, `#queue`, `ytmusic-av-toggle`, `#layout`,
`#tabsContent`, `tp-yt-paper-tab`, `#side-panel`,
`.autoplay > tp-yt-paper-toggle-button`, `yt-icon-button.fullscreen-button`.

**Gone:** `ytmusic-player-bar` and every method on it (`onRepeatButtonClick`,
`updateVolume`, `onVolumeClick`, `getState`, `queue`, the `shuffle-on` and
`player-fullscreened` attributes), `#right-controls`, `#left-controls`,
`.middle-controls`, `.right-controls-buttons`, `#progress-bar`,
`#play-pause-button`, `#like-button-renderer`, `.previous-button`,
`.next-button`, `ytmusic-menu-renderer.ytmusic-player-bar`,
`.exit-fullscreen-button`.

## The gapless media timeline (2026-10)

Found 2026-10-25. YouTube now plays songs **gapless through one media stream**:

| Value | First track | Later tracks |
|---|---|---|
| `video.currentTime` | song time | **stream time**: starts where the previous song ended (measured: 254s while the song was 35s in) |
| `video.duration` | grows | the whole stream so far, **growing** as the next track buffers (328 → 371s on a 154s song) |
| `api.getCurrentTime()` (`#movie_player`) | song time | song time |
| `api.getDuration()` | | **what has loaded so far** while a track streams in (359 → 369s on a 392s track) |
| `api.getProgressState().seekableEnd` | | the song's real length (392.1s), = `videoDetails.lengthSeconds` |
| `input.ytMusicMiniPlayerProgressBar` `max` | | whole seconds, rounded up (393): what a click on the bar maps to |

More traps:
- The song change fires `videodatachange` `dataloaded` about 0.3s **before** the song's end (`html5_gapless_ended_transition_buffer_ms=200`), and `ended` doesn't fire.
- YouTube **replaces the `<video>` element** at some song changes (seen going from a song to a music video). Listeners attached to the old element go silent.
- Writing `video.currentTime` past what the stream has buffered clamps to the stream's end, and YouTube **skips to the next track**.

**The rules** (helpers in [`src/providers/song-time.ts`](../src/providers/song-time.ts)):
- read song time from the player API;
- take the length from `seekableEnd`;
- seek with `api.seekTo(s, true)` (measured exact to the millisecond, about 6ms);
- listen for media events on the document in the capture phase (they don't bubble), filtered to the player's video;
- for anything drawn on the seek bar, use the bar's own `max`.

What was broken by this and fixed on 2026-10-25:
- Limited Repeat: markers drifted, and the loop got spent at the end of the song.
- playback-recovery's seeks.
- The elapsed-time, seeked and play/pause feeds, plus `lengthSeconds`, in `song-info-front.ts`.

Synced-lyrics already used `getCurrentTime()`. Upstream plugins that read `video.currentTime` (crossfade, skip-silences, sponsorblock, downloader, music-together, lumiastream) are off for this user and weren't changed.

The timeline is player behaviour driven by server-side flags. It can't be pinned from the app.

## Helpers: [`src/providers/dom-elements.ts`](../src/providers/dom-elements.ts)

Each helper prefers the new layout and falls back to the old one, because
YouTube rolls layouts out gradually and can roll them back.

| Helper | Returns |
|---|---|
| `getPlayerControl('Shuffle'│'Previous'│'PlayPause'│'Next'│'Repeat')` | the control's `button` (new) or the legacy element |
| `getPlayerControlWrapper(control)` | the new layout's wrapper div (a sibling of the other controls) |
| `getPlayerBar()` | `ytmusic-miniplayer` ?? `ytmusic-player-bar` |
| `getProgressBar()` | `input.ytMusicMiniPlayerProgressBar` ?? `#progress-bar` |
| `isNewPlayerBar()` | whether the new seek bar exists |
| `getLikeButton('like'│'dislike')` | the new toggle buttons |
| `getMuteButton()`, `getVolumeSlider()` | new volume controls |
| `getAppStore()` | `#queue`.queue.store (`AppStore` type: `getState`, `subscribe`) |

## How each core path was ported (2026-10-01)

**Renderer IPC handlers.** [`src/renderer.ts`](../src/renderer.ts). Called from
the main process via [`src/providers/song-controls.ts`](../src/providers/song-controls.ts),
which the tray, the hover mini-player, the shortcuts plugin (media keys),
taskbar-mediacontrol and the API server all use.

| Channel | Old | New |
|---|---|---|
| `peard:previous-video` / `peard:next-video` | click `.previous-button.ytmusic-player-bar` | `getPlayerControl('Previous'/'Next').click()` |
| `peard:shuffle` | `ytmusic-player-bar.queue.shuffle()` | click the Shuffle button |
| `peard:get-shuffle` | `shuffle-on` attribute | `store.queue.shuffleEnabled` |
| `peard:update-like` | `#like-button-renderer.updateLikeStatus` | click like/dislike **only if not already `aria-pressed`** (they toggle) |
| `peard:switch-repeat` (n) | `onRepeatButtonClick()` × n | click Repeat n times, **yielding between clicks** (a same-task second click is ignored) |
| `peard:update-volume` | `ytmusic-player-bar.updateVolume` | set the slider's value with the native setter, then dispatch `input`/`change` (`api.setVolume` would leave the slider stale); falls back to `api.setVolume` |
| `peard:toggle-mute` | `onVolumeClick()` | click the mute button |
| fullscreen state | `player-fullscreened` attribute | `store.player.fullscreened` |
| like-buttons CSS options | `#like-button-renderer` | also `.ytMusicMiniPlayerActionBar` / the segmented wrapper |

**State feeds.** [`src/providers/song-info-front.ts`](../src/providers/song-info-front.ts).
Each feed is started by a `peard:setup-<x>-changed-listener` request and is a
singleton per page load:

| Feed | Old | New |
|---|---|---|
| `peard:time-changed` | observe `#progress-bar` `value` attribute | `video` `timeupdate`, sent once per whole second (the new seek bar's value is a property, so there is nothing to observe) |
| `peard:repeat-changed` | observe `#right-controls .repeat` `title` (**threw on null**) | `watchStoreValue(queue.repeatMode)` |
| `peard:like-changed` | observe `like-status` attribute | `MutationObserver` on the bar for `aria-pressed`, mapped to LIKE / DISLIKE / INDIFFERENT |
| `peard:shuffle-changed` | `shuffle-on` attribute | `watchStoreValue(queue.shuffleEnabled)` |
| `peard:fullscreen-changed` | `player-fullscreened` attribute | `watchStoreValue(player.fullscreened)` |
| `peard:autoplay-changed` | toggle element (`!`) | same element, now null-guarded |

`watchStoreValue` sends the initial value, then each change. When the old bar
is present, the legacy observer path is used instead.

**Limited Repeat:** see [custom/limited-repeat.md](custom/limited-repeat.md).
Seek-bar geometry, mask-as-stylesheet, store-based repeat cancel, and the
overlap strip.

## Verified

Against the live app, 2026-10-01:

- [`z_development/player-bar/tests/core-ipc-test.cjs`](../z_development/player-bar/tests/core-ipc-test.cjs): **18/18**. It sends real IPC from the main process (launch with `--inspect=9229`) and checks the page and the feeds.
- [`z_development/limited-repeat/tests/lr-newbar-test.cjs`](../z_development/limited-repeat/tests/lr-newbar-test.cjs): **23/23**.

**Not exercised:**

- The like toggle-*on* path and like-changed *change* events. The test track was already liked, and toggling writes to the account.
- The `peard:shuffle` action, which would reorder the user's queue.
- Fullscreen clicking. `.exit-fullscreen-button` no longer exists, so exiting fullscreen over IPC may not work.

## Known traps on the new bar

- **The right-hand section overlaps the bar's lower half** on the right side of
  the window. A click at the bar's centre line there hits the section and
  **doesn't seek** (that's YouTube's own behaviour). LR treats that strip as the
  bar. Test harnesses must click the bar's top pixel row.
- **YouTube rewrites the seek bar's `style` attribute** as it plays (that's how
  it draws the fill), so never put your own inline styles on it.
- Seek-bar track geometry: inset 6px each side, half the 12px thumb (LESSONS #3).
- **The bar is 3px tall.** Without the [seekbar-grab](custom/seekbar-grab.md) plugin it takes clicks in a 3px band on the left half and about 1px on the right. A drag that misses selects text.
- **The volume popup** (`.ytMusicMiniPlayerVolumePopup`, z-index 10 inside the right section's z-index 2 context) reaches down over the bar, y=668–804 at an 864px viewport, with the slider at 684–788. Anything raised over the bar must step back while it's open (inline `display: flex`).
- **Media time is not song time** on the gapless player (see [above](#the-gapless-media-timeline-2026-10)).
- **Left guide offset** (with the in-app menu): YouTube dropped `ytmusic-app[is-bauhaus-sidenav-enabled]` while keeping the sidenav. in-app-menu's `titlebar.css` gated its 32px guide-spacer correction on that attribute, so the guide sat 32px too high: Home under the header, a gap at the bottom. Fixed 2026-10-25 by dropping the gate.

## When YouTube changes the bar again

1. Run `core-ipc-test.cjs` and `lr-newbar-test.cjs`. Failures point to what broke.
2. Probe the bottom of the page over CDP (LESSONS #13 has the recipe).
3. Update `dom-elements.ts` first, so everything that goes through it follows.

Plugins with known old-bar dependencies are listed under `newPlayerBarStatus`
in [index.json](index.json).
