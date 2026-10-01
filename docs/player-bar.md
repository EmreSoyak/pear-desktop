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

## When YouTube changes the bar again

1. Run `core-ipc-test.cjs` and `lr-newbar-test.cjs`. Failures point to what broke.
2. Probe the bottom of the page over CDP (LESSONS #13 has the recipe).
3. Update `dom-elements.ts` first, so everything that goes through it follows.

Plugins with known old-bar dependencies are listed under `newPlayerBarStatus`
in [index.json](index.json).
