# Playback & audio plugins

Plugins that change what you hear (Web Audio graph, volume curve, output device, speed, silence skipping, crossfade), how the player starts (autoplay), video quality, and the audio visualizer.

**How the shared audio graph works.** Several of these plugins don't build their own audio pipeline. They all hook one `AudioContext` that the core renderer creates:
- [`src/renderer.ts:358-361`](../../src/renderer.ts) creates `new AudioContext()` and `createMediaElementSource(video)`, then connects `source -> destination`.
- It then calls each plugin's `onPlayerApiReady`.
- It dispatches the document event `peard:audio-can-play` with `detail: { audioContext, audioSource }`. This happens once immediately if `video.readyState === 4` (`:397-399`), and after every `loadstart` on the first `canplaythrough` (`:378-401`).
- The detail type is the global `Compressor` interface in [`src/reset.d.ts:12-19`](../../src/reset.d.ts).
- Consumers: audio-compressor, equalizer, skip-silences, custom-output-device, visualizer.

Other shared events:
- `videodatachange` (document `CustomEvent<VideoDataChanged>`) is dispatched from [`src/providers/song-info-front.ts:351`](../../src/providers/song-info-front.ts), and once from `src/renderer.ts:374-376` for the first `dataloaded`.
- `peard:src-changed` is dispatched on the `<video>` on every `dataloaded` ([`song-info-front.ts:29,379`](../../src/providers/song-info-front.ts)).

**Plugin IPC is unprefixed.** The `ipc` contexts send raw channel names. On the main side, [`src/loader/main.ts:36-52`](../../src/loader/main.ts) wraps `ipcMain.handle/on` and `win.webContents.send`. On the renderer side, [`src/loader/renderer.ts:26-42`](../../src/loader/renderer.ts) wraps `ipcRenderer.send/invoke/on`.

The `backend` entry runs in the Electron main process.

**Defaults and restarts:**
- A plugin without a `config` gets `{ enabled: false }` ([`src/loader/main.ts:25`](../../src/loader/main.ts), [`src/config/plugins.ts:16`](../../src/config/plugins.ts)).
- `restartNeeded: true` only shows a restart dialog when `enabled` is toggled ([`src/index.ts:231`](../../src/index.ts)).
- Config changes reach the renderer's `onConfigChange` via `config-changed` ([`src/renderer.ts:517-525`](../../src/renderer.ts)).

| Plugin | Summary | Default enabled | New player bar (2026-10) |
|---|---|---|---|
| [audio-compressor](#audio-compressor-audio-compressor) | Inserts a `DynamicsCompressorNode` into the shared audio graph | false (no config; loader default) | unaffected |
| [crossfade](#crossfade-beta-crossfade) | Fades the old song out over the new one using a muted Howler copy of the stream | false | partially affected: `.next-button` dead, so the early transition never fires |
| [equalizer](#equalizer-equalizer) | Adds BiquadFilter nodes (bass-booster preset plus custom filters) | false | unaffected |
| [exponential-volume](#exponential-volume-exponential-volume) | Patches `HTMLMediaElement.volume` to a cubic curve | false | unaffected |
| [precise-volume](#precise-volume-precise-volume) | Wheel/arrow/global-shortcut volume steps, HUD, and persisted volume | false | partially affected: `ytmusic-player-bar`/`#volume-slider` dead (bar wheel, slider save/sync, tooltips) |
| [playback-speed](#playback-speed-playback-speed) | Speed slider (0.07–16x) injected into the player-bar song menu | false | likely broken: `isPlayerMenu` requires `ytmusic-menu-renderer.ytmusic-player-bar`, so the slider is never injected |
| [quality-changer](#video-quality-changer-quality-changer) | Gear button on the video overlay that opens a native quality-picker dialog | false | unaffected |
| [skip-silences](#skip-silences-skip-silences) | AnalyserNode-based silence detection that seeks forward 0.2 s | false | unaffected |
| [custom-output-device](#custom-output-device-custom-output-device) | Routes the AudioContext to a chosen output via `setSinkId` | false | unaffected |
| [visualizer](#visualizer-visualizer) | Butterchurn / Vudio / Wave canvas visualizer over the player | false | unaffected |
| [disable-autoplay](#disable-autoplay-disable-autoplay) | Pauses each newly loaded track | false | unaffected |

---

## Audio Compressor (`audio-compressor`)
**What it does:** Applies dynamic range compression to the music: loud parts get quieter and soft parts relatively louder.

**Why it exists:** Evens out volume differences within and between tracks.

**How it works:**
- **Process:** renderer only. The whole plugin is [`src/plugins/audio-compressor.ts`](../../src/plugins/audio-compressor.ts).
- **The compressor node:** `createCompressorNode` (`:13-25`) builds a `DynamicsCompressorNode` with fixed values: threshold -50 dB, ratio 12, knee 40, attack 0, release 0.25.
- **Graph wiring:** the `Storage` class (`:27-84`) keeps the last source, context and compressor, plus a `WeakMap` of which compressor each source is wired to.
  - `connectToCompressor` (`:35-67`) disconnects `source -> destination` (or the previous compressor) and wires `source -> compressor -> destination`.
  - `disconnectCompressor` (`:69-83`) restores `source -> destination`.
- **`start()`** (`:117-126`) listens to `peard:audio-can-play`, creating a fresh compressor per event (`audioCanPlayHandler`, `:88-96`). It also re-wires the last known source when the plugin is re-enabled.
- **`stop()`** (`:128-131`) removes the listener and unwires the compressor.
- **`onPlayerApiReady`** (`:113-115`) calls `ensureAudioContextLoad` (`:98-106`). If the player is already playing (state 1) and no context has been captured, it reloads the current video at the current time with `loadVideoById`. That forces a new `canplaythrough`, so the compressor attaches.

**Config:** none declared.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plugins.audio-compressor.enabled` | boolean | `false` (loader fallback `{ enabled: false }`) | on/off |

`restartNeeded` is not set (falsy), so it toggles live.

**Menu:** none.

**Files:**
- [`src/plugins/audio-compressor.ts`](../../src/plugins/audio-compressor.ts): the whole plugin.

**IPC / events:**
- Listens to the DOM event `peard:audio-can-play`.
- No IPC.

**DOM anchors:** none. It uses only the player API and the Web Audio objects from the event.

**New player bar (2026-10):** unaffected. It uses no player-bar selectors.

**Gotchas:**
- It disconnects the dry `source -> destination` path. Equalizer and visualizer branches connect to the same source in parallel, so they are not removed.
- A new compressor node is created on every `peard:audio-can-play` (every track). The old one is disconnected first.

---

## Crossfade [Beta] (`crossfade`)
**What it does:** When the track changes, the previous song fades out while the new one fades in. Shortly before a song ends (`secondsBeforeEnd`), it skips to the next track to start the transition early.

**Why it exists:** YouTube Music has no gapless or crossfade playback.

**How it works:**
- **Backend** (main process, [`index.ts:169-178`](../../src/plugins/crossfade/index.ts)):
  - Creates a `youtubei.js` `Innertube` client using `getNetFetchAsFetch()`. The import string is unicode-escaped at `:1`.
  - Handles `audio-url(videoID)`: `getBasicInfo(videoID)`, then returns `streaming_data.formats[0].decipher(yt.session.player)`, a direct stream URL.
- **Renderer** (`:180-321`):
  - `start` stores config and ipc. `onConfigChange` updates config.
  - **Watching for track changes:** `watchVideoIDChanges` (`:202-224`) listens to the Navigation API (`window.navigation` `navigate`) and compares the `v` query param of the current and destination URLs.
    - If the Howl is loaded (`isReadyToCrossfade`, `:199-200`), it runs `crossfade()` first.
    - Otherwise it calls back directly.
  - **Shadow copy:** the callback (`:312-320`) awaits the previous transition, invokes `audio-url` for the new ID, then `createAudioForCrossfade` (`:226-237`). That makes a `Howl({ html5: true, volume: 0 })` playing the same song silently in sync with the `<video>`.
  - **Keeping the Howl in sync:** `syncVideoWithTransitionAudio` (`:239-283`) seeks the Howl to `video.currentTime` and mirrors `seeking`/`pause`/`play`.
  - **Fade-in:** on `play` it fades the `<video>` volume in from 0 with `VolumeFader` over `fadeInDuration`.
  - **Early transition:** a `timeupdate` handler `transitionBeforeEnd` (`:269-282`) clicks `.next-button` when `currentTime >= duration - secondsBeforeEnd`.
  - **Fade-out:** `crossfade()` (`:285-310`) sets `video.volume = 0`. It then fades the Howl's underlying `<audio>` (`transitionAudio._sounds[0]._node`) from the old video volume to 0 over `fadeOutDuration`, then resolves.
- **`VolumeFader`** ([`fader.ts`](../../src/plugins/crossfade/fader.ts)) is a vendored MIT library (Nick Schwarzenberg, v0.2.0):
  - It uses `requestAnimationFrame` (`updateVolume`, ~`:296-320`), `fadeTo` (`:255`) and `fadeIn`/`fadeOut` (`:286-291`).
  - Scaling: `'linear'` passes levels through. `'logarithmic'` or `undefined` uses a 60 dB dynamic range (`dynamicRange = 3`, `:121-127`). A positive number is a dB range, using `exponentialScaler`/`logarithmicScaler` (`:347`, `:370`).

**Config:** `restartNeeded: true`.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plugins.crossfade.enabled` | boolean | `false` | on/off |
| `plugins.crossfade.fadeInDuration` | number (ms) | `1500` | fade-in time of the new track's `<video>` volume |
| `plugins.crossfade.fadeOutDuration` | number (ms) | `5000` | fade-out time of the old track (Howl copy) |
| `plugins.crossfade.secondsBeforeEnd` | number (s) | `10` | how early before the end to skip to the next track |
| `plugins.crossfade.fadeScaling` | `'linear' \| 'logarithmic' \| number` | `'linear'` | fade curve (a number is a dB range) |

**Menu:** "Advanced" opens a `custom-electron-prompt` multi-input (`:65-167`). It has fade in, fade out, seconds before end, and a fade scaling select (linear/logarithmic). The result is saved with `setConfig`.

**Files:**
- [`src/plugins/crossfade/index.ts`](../../src/plugins/crossfade/index.ts): plugin, menu, backend and renderer logic.
- [`src/plugins/crossfade/fader.ts`](../../src/plugins/crossfade/fader.ts): the `VolumeFader` class.

**IPC / events:**
- IPC `audio-url`: renderer `invoke`, backend `handle`.
- Uses the Navigation API `navigate` event.
- Listens to `<video>` events `seeking`, `pause`, `play` and `timeupdate`.

**DOM anchors:**
- `video`
- `.next-button` (`index.ts:278`)

**New player bar (2026-10):** partially affected.
- `document.querySelector('.next-button')?.click()` at `index.ts:278` uses a dead legacy selector and silently does nothing. The early transition `secondsBeforeEnd` before the end of the track never fires. The song plays to its natural end, and when the navigation happens the fade-out runs on a Howl copy that has also reached its end.
- Manual skips and other navigations still go through `navigate` and still crossfade.
- Fix: use `getPlayerControl('Next')` from [`src/providers/dom-elements.ts`](../../src/providers/dom-elements.ts).

**Gotchas:**
- The source comment says it does not support "repeat 1" mode (`:277`).
- `syncVideoWithTransitionAudio` adds new `seeking`/`pause`/`play`/`timeupdate` listeners to the same `<video>` on every track and never removes them, so they pile up.
- It plays a second network stream of every song (`formats[0]`, the first entry, which is not necessarily audio-only).
- Fades read and write `video.volume`, so exponential-volume's patched getter/setter applies to them.
- `fadeScaling` as a number can only be set by editing config; the menu offers only linear/logarithmic.

---

## Equalizer (`equalizer`)
**What it does:** Applies EQ filters to playback. The only built-in preset is "bass booster". Custom filters can be listed in config.

**Why it exists:** YouTube Music has no EQ.

**How it works:**
- **Process:** renderer.
- **`start`** ([`index.ts:56-82`](../../src/plugins/equalizer/index.ts)) reads config once and registers a **`once: true`** `peard:audio-can-play` listener.
- **The listener:**
  - Concatenates `config.filters` with the enabled presets' `presetConfigs`.
  - Creates one `BiquadFilterNode` per filter (type, frequency, Q, gain).
  - Connects each one as `audioSource -> filter -> destination`, and stores it in module-level `appliedFilters`.
- **`stop`** (`:83-86`) disconnects all applied filters.
- **Presets** ([`presets.ts`](../../src/plugins/equalizer/presets.ts)): `bass-booster` = `lowshelf`, 80 Hz, Q 100, +12 dB.

**Config:** `restartNeeded: false`, `addedVersion: '3.7.X'`.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plugins.equalizer.enabled` | boolean | `false` | on/off |
| `plugins.equalizer.filters` | `{type: BiquadFilterType, frequency, Q, gain}[]` | `[]` | custom filters (config-file only, no UI) |
| `plugins.equalizer.presets` | `{ 'bass-booster': boolean }` | `{ 'bass-booster': false }` | enabled presets |

**Menu:** a "Presets" submenu with one radio item per preset ("Bass booster"). A click toggles that preset's boolean (`:38-53`).

**Files:**
- [`src/plugins/equalizer/index.ts`](../../src/plugins/equalizer/index.ts): plugin.
- [`src/plugins/equalizer/presets.ts`](../../src/plugins/equalizer/presets.ts): preset list and filter values.

**IPC / events:**
- Listens to the DOM event `peard:audio-can-play` (once).
- No IPC.

**DOM anchors:** none.

**New player bar (2026-10):** unaffected. It uses no DOM selectors.

**Gotchas:**
- The filters are connected **in parallel** with the existing `source -> destination` path, not inserted into it. The dry signal still plays, and each filter adds a filtered copy on top.
- There is no `onConfigChange`, and the listener is `once`. Preset changes from the menu only take effect after the plugin is reloaded (disable/enable or restart). Enabling it mid-session applies on the next `canplaythrough`.
- `config.filters` is never validated.

---

## Exponential Volume (`exponential-volume`)
**What it does:** Makes the volume slider exponential, so low volumes are easier to select.

**Why it exists:** With a linear slider, almost all of the usable range is crammed into the bottom few percent.

**How it works:**
- **Process:** renderer.
- **`onPlayerApiReady`** ([`index.ts:14-63`](../../src/plugins/exponential-volume/index.ts)) replaces `HTMLMediaElement.prototype.volume` globally with `Object.defineProperty`, using `EXPONENT = 3` (pulseaudio's value). The approach credits "fix volume ratio 0.4" by Marco Pfeiffer.
  - **Setter:** writes `v^3` to the native volume, and records the requested `v` in a `WeakMap`.
  - **Getter:** returns `native^(1/3)`. If the stored original is within 0.01 of that, it returns the stored original instead, to avoid float drift.
- **`syncVolume`** (`:15-22`) re-applies `setVolume(getVolume())` through the player API so the new curve takes effect. If the player is buffering (state 3), it retries with `setTimeout(0)`.

**Config:** `restartNeeded: true`.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plugins.exponential-volume.enabled` | boolean | `false` | on/off |

**Menu:** none.

**Files:**
- [`src/plugins/exponential-volume/index.ts`](../../src/plugins/exponential-volume/index.ts): plugin.

**IPC / events:** none.

**DOM anchors:** none. It patches `HTMLMediaElement.prototype`.

**New player bar (2026-10):** unaffected. It works at the media-element level, independent of the bar UI.

**Gotchas:**
- There is no `stop()`, so the prototype patch stays until reload. That's why it has `restartNeeded`.
- Every plugin that reads or writes `video.volume` sees the patched curve, including crossfade's `VolumeFader` and skip-silences' `video.volume === 0` check.

---

## Precise Volume (`precise-volume`)
**What it does:** Changes volume in configurable steps with the mouse wheel (over the player bar or the video panel), ArrowUp/ArrowDown, or global shortcuts. It shows a percentage HUD, and saves and restores the volume between sessions.

**Why it exists:** The stock slider moves in coarse steps and doesn't persist exact values.

**How it works:**

*Backend* ([`index.ts:171-185`](../../src/plugins/precise-volume/index.ts)) registers the Electron `globalShortcut` accelerators from config. They send `changeVolume(true|false)` to the renderer.

*Renderer `start`* calls `overrideListener()` ([`override.ts`](../../src/plugins/precise-volume/override.ts)). Until `window` `load`, this monkey-patches `Element.prototype.addEventListener` to drop `mousewheel`/`keydown`/`keyup` listeners on elements with id `volume-slider` or `expand-volume-slider`. That stops YouTube's own handlers from fighting the plugin. It is restored on `load`.

*Renderer `onPlayerApiReady`* ([`renderer.ts:27-284`](../../src/plugins/precise-volume/renderer.ts)):
- **`firstRun`** (`:48-79`):
  - Restores `savedVolume` via `api.setVolume`.
  - Calls `setupPlaybar` and `setupLocalArrowShortcuts`.
  - Injects `#volumeHud`. It goes next to `.center-content.ytmusic-nav-bar` when `#main-panel` is `display:none`, otherwise after `#song-video`.
  - When there is a video panel, adds a wheel handler on `#main-panel`. If video-toggle is disabled, it also repositions the HUD on `peard:src-changed`.
- **`setupPlaybar`** (`:132-152`):
  - Wheel handler on `ytmusic-player-bar`.
  - `on-hover` class tracking.
  - **`setupSliderObserver`** (`:155-183`): a MutationObserver on the `value` attribute of `#volume-slider`. When the slider was changed manually (diff > 4), it saves the value.
- **`setVolume`** (`:185-199`):
  - Calls `api.setVolume`.
  - Saves the value. `writeOptions` is debounced 1 s.
  - Syncs `#volume-slider`/`#expand-volume-slider` values (`:212-223`).
  - Sets tooltips (`:236-250`).
  - Shows the slider (`:225-233`) and the HUD (hidden after 2 s).
- **`changeVolume`** (`:202-210`) steps by `options.steps`, clamped to 0–100.
- **Arrow keys** (`:252-276`) are ignored while `ytmusic-search-box` is `opened`.
- **IPC listeners** (`:278-281`): `changeVolume` and `setVolume`.

*`moveVolumeHud`* (`:14-23`) is exported and debounced. It centers the HUD vertically over the video.

**Config:** `restartNeeded: true`. `stylesheets: [volume-hud.css]`.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plugins.precise-volume.enabled` | boolean | `false` | on/off |
| `plugins.precise-volume.steps` | number | `1` | % per wheel/arrow/shortcut step |
| `plugins.precise-volume.arrowsShortcut` | boolean | `true` | enable local ArrowUp/ArrowDown |
| `plugins.precise-volume.globalShortcuts.volumeUp` | string (accelerator) | `''` | global volume-up shortcut |
| `plugins.precise-volume.globalShortcuts.volumeDown` | string (accelerator) | `''` | global volume-down shortcut |
| `plugins.precise-volume.savedVolume` | number \| undefined | `undefined` | last volume, restored on start |

**Menu** (`index.ts:146-168`):
- "Local Arrow-keys Controls" checkbox.
- "Global Hotkeys" checkbox: opens a keybind prompt.
- "Set Custom Volume Steps": a counter prompt from 0 to 100.

**Files:**
- [`src/plugins/precise-volume/index.ts`](../../src/plugins/precise-volume/index.ts): config, menu, backend global shortcuts.
- [`src/plugins/precise-volume/renderer.ts`](../../src/plugins/precise-volume/renderer.ts): wheel/keys, HUD, slider sync, persistence.
- [`src/plugins/precise-volume/override.ts`](../../src/plugins/precise-volume/override.ts): temporary `addEventListener` patch.
- [`src/plugins/precise-volume/volume-hud.css`](../../src/plugins/precise-volume/volume-hud.css): HUD style. In `MINIPLAYER` player-ui-state the HUD is forced to `top: 0`.

**IPC / events:**
- IPC `changeVolume` (main to renderer; sent by the backend's global shortcuts).
- IPC `setVolume` (main to renderer; sent by [`src/plugins/shortcuts/mpris.ts:318`](../../src/plugins/shortcuts/mpris.ts) when precise-volume is enabled).
- DOM events: `peard:src-changed` on `<video>`; `wheel` on the bar and on `#main-panel`; `keydown` on `window`.

**DOM anchors:**
- `ytmusic-player-bar`
- `#volume-slider`
- `#expand-volume-slider`
- `tp-yt-paper-icon-button.volume`
- `#expand-volume`
- `#main-panel`
- `#song-video`
- `.center-content.ytmusic-nav-bar`
- `ytmusic-player`
- `video`
- `ytmusic-search-box`
- `#volumeHud` (its own)

**New player bar (2026-10):** partially affected.
- `setupPlaybar` returns early at `renderer.ts:134` because `ytmusic-player-bar` is gone. `setupSliderObserver` is only called from inside it (`:151`), so on the new bar it is never attached. As a result:
  - Wheel over the bar no longer changes volume.
  - Dragging the new slider (`.ytMusicMiniPlayerVolumePopup input`) is **not saved** to `savedVolume`. On the next launch, `firstRun` (`:53-55`) restores the stale saved value.
- `updateVolumeSlider`, `setTooltip` and `showVolumeSlider` target dead ids. They are null-guarded, so they silently do nothing.
- Still working, all through `api.setVolume`: arrow keys, global shortcuts, mpris `setVolume`, wheel over `#main-panel`, and the HUD.
- `override.ts`'s ignore list no longer matches any element on the new bar. Whether YouTube's new slider now double-handles keys or wheel is unclear from code.
- Fix candidates: `getPlayerBar()` and `getVolumeSlider()` in [`dom-elements.ts`](../../src/providers/dom-elements.ts). The new slider is a native range input whose `value` is a property, so an attribute MutationObserver won't fire. Use `input` events instead.

**Gotchas:**
- [`src/plugins/video-toggle/index.tsx:9,163-166`](../../src/plugins/video-toggle/index.tsx) imports `moveVolumeHud` and calls it when precise-volume is enabled. That's why precise-volume skips its own HUD repositioning if video-toggle is on.
- Global shortcuts are registered only at backend start (restart needed).
- In the menu, the global-hotkeys `checked` uses `volumeUp ?? volumeDown`. Since `''` is not nullish, only `volumeUp` decides the checkbox state.

---

## Playback Speed (`playback-speed`)
**What it does:** Adds a "Speed" slider item to the song's three-dot menu in the player bar. The range is 0.07x–16x; the slider steps by 0.125 over 0–2, and the mouse wheel steps by 0.01. The chosen rate is enforced on every track.

**Why it exists:** YouTube Music has no playback-rate control.

**How it works:**
- **Process:** renderer.
- **`onPlayerApiReady`** ([`renderer.tsx:32-118`](../../src/plugins/playback-speed/renderer.tsx)):
  - Renders the Solid `PlaybackSpeedSlider` into a detached `div`. The component is a hand-built `tp-yt-paper-slider` menu item ([`components/slider.tsx`](../../src/plugins/playback-speed/components/slider.tsx)).
  - Sets up a MutationObserver on `ytmusic-popup-container` (childList, subtree). It prepends the slider to `getSongMenu()` (`ytmusic-menu-popup-renderer tp-yt-paper-listbox`) when all of these hold:
    - The menu doesn't already contain it.
    - `isMusicOrVideoTrack()` is true.
    - `isPlayerMenu(menu)` is true.
- **Slider input:** `immediate-value-changed` clamps to [0.07, 16] and writes `video.playbackRate`. The wheel adds or subtracts 0.01.
- **Enforcing the rate:** `forcePlaybackRate` (`:18-25`) re-applies the speed on the `<video>` `ratechange` and `peard:src-changed` events.
- **`stop` (`onUnload`, `:120-127`)** removes those listeners and removes the slider from the menu.
- The speed is a module-level Solid signal and **not persisted**. It is 1 after reload.

**Config:** `restartNeeded: false`.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plugins.playback-speed.enabled` | boolean | `false` | on/off |

**Menu:** none (no app menu; the UI is in the in-page song menu).

**Files:**
- [`src/plugins/playback-speed/index.ts`](../../src/plugins/playback-speed/index.ts): plugin definition.
- [`src/plugins/playback-speed/renderer.tsx`](../../src/plugins/playback-speed/renderer.tsx): injection and rate enforcement.
- [`src/plugins/playback-speed/components/slider.tsx`](../../src/plugins/playback-speed/components/slider.tsx): the slider markup.
- Shared helpers:
  - [`src/providers/dom-elements.ts`](../../src/providers/dom-elements.ts) (`getSongMenu`).
  - [`src/plugins/utils/renderer/check.ts`](../../src/plugins/utils/renderer/check.ts) (`isMusicOrVideoTrack`, `isPlayerMenu`).

**IPC / events:**
- DOM events: `ratechange` and `peard:src-changed` on `<video>`; `immediate-value-changed` and `wheel` on the slider.
- No IPC.

**DOM anchors:**
- `ytmusic-popup-container`
- `ytmusic-menu-popup-renderer tp-yt-paper-listbox`
- `tp-yt-paper-listbox #navigation-endpoint` (in `isMusicOrVideoTrack`)
- `ytmusic-menu-renderer.ytmusic-player-bar` (in `isPlayerMenu`, `check.ts:55`)
- `video`

**New player bar (2026-10):** likely broken.
- `isPlayerMenu` ([`check.ts:43-57`](../../src/plugins/utils/renderer/check.ts)) requires the menu's event sink to match `ytmusic-menu-renderer.ytmusic-player-bar`. That class no longer exists, so the slider is never injected and the user cannot change speed.
- Rate enforcement still runs, but the speed stays at 1.
- The slider's own class `volume-slider style-scope ytmusic-player-bar` relies on old player-bar styling. Whether it still renders correctly is unclear from code.

**Gotchas:**
- `onUnload` calls `getSongMenu()?.removeChild(sliderContainer)`. If a menu is open that doesn't contain the slider, this throws `NotFoundError`.
- The fix for the new bar belongs in the shared `isPlayerMenu`, which other plugins also use.

---

## Video Quality Changer (`quality-changer`)
**What it does:** Adds a gear button to the video player's top-row buttons. It opens a native dialog listing the available qualities and applies the one you choose.

**Why it exists:** YouTube Music doesn't expose a video-quality selector.

**How it works:**
- **Renderer `onPlayerApiReady`** ([`index.tsx:47-91`](../../src/plugins/quality-changer/index.tsx)):
  - Renders `QualitySettingButton`, a `yt-icon-button` with a settings SVG ([`templates/quality-setting-button.tsx`](../../src/plugins/quality-changer/templates/quality-setting-button.tsx)), into a container `div`.
  - Prepends that container once to `.top-row-buttons.ytmusic-player`.
- **On click** (`chooseQuality`, `:48-70`):
  - Gets `api.getAvailableQualityLevels()`, the current index of `api.getPlaybackQuality()`, and `api.getAvailableQualityLabels()`.
  - Invokes `peard:quality-changer`.
  - Applies the chosen level with `setPlaybackQualityRange` and `setPlaybackQuality`.
- **Backend** (main, `:20-43`) handles `peard:quality-changer` with `dialog.showMessageBox`: one button per label, `defaultId` = current, `cancelId: -1`.
- **`stop`** removes the button.

**Config:** `restartNeeded: false`.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plugins.quality-changer.enabled` | boolean | `false` | on/off |

**Menu:** none.

**Files:**
- [`src/plugins/quality-changer/index.tsx`](../../src/plugins/quality-changer/index.tsx): backend dialog, renderer injection, quality API calls.
- [`src/plugins/quality-changer/templates/quality-setting-button.tsx`](../../src/plugins/quality-changer/templates/quality-setting-button.tsx): button markup.

**IPC / events:**
- IPC `peard:quality-changer`: renderer `invoke`, backend `handle`.

**DOM anchors:**
- `.top-row-buttons.ytmusic-player`

**New player bar (2026-10):** unaffected. The anchor is inside `ytmusic-player`, which still exists. Whether `.top-row-buttons` itself survived the redesign is not verifiable statically.

**Gotchas:**
- `setup()` runs only once. There's no observer, so if `.top-row-buttons` isn't in the DOM yet at `onPlayerApiReady`, the button never appears.
- `stop()` calls `removeChild` on the anchor, which throws if the button wasn't attached.

---

## Skip Silences (`skip-silences`)
**What it does:** Detects silence in the audio and skips forward through it. It can be limited to only the silence at the start of a track.

**Why it exists:** It removes dead air at the start of songs and between sections.

**How it works:**
- **Process:** renderer.
- **`onRendererLoad`/`start`** ([`renderer.ts:116-124`](../../src/plugins/skip-silences/renderer.ts)) reads config and listens to `peard:audio-can-play`.
- **`audioCanPlayListener`** (`:33-114`):
  - Creates an `AnalyserNode` (fftSize 512, smoothing 0.1) fed from `audioSource`. This is Hark-style detection.
  - Runs a `setTimeout` loop every 2 ms. `getMaxVolume` (`:17-31`) takes the max negative FFT bin from index 4.
  - The silence threshold is -100 dB, with a 10-sample `speakingHistory`.
    - Becoming not-silent needs 2 of the last 3 samples above the threshold.
    - Becoming silent needs all 10 samples below it, and the video must not be paused, seeking, ended, muted or at volume 0. Then it calls `skipSilence`.
- **`skipSilence`** (`:97-105`) does `video.currentTime += 0.2` while silent and playing. With `onlySkipBeginning`, it skips only until audio has started (`hasAudioStarted`).
- **`play`/`seeked`** on `<video>` reset `hasAudioStarted` and try a skip.
- **`stop`** (`:126-134`) removes the document listener and the last `play`/`seeked` handlers.

**Config:** `restartNeeded: true`.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plugins.skip-silences.enabled` | boolean | `false` | on/off |
| `plugins.skip-silences.onlySkipBeginning` | boolean | `false` | only skip silence before the audio first starts |

**Menu:** none. `onlySkipBeginning` can only be set by editing config.

**Files:**
- [`src/plugins/skip-silences/index.ts`](../../src/plugins/skip-silences/index.ts): definition and config.
- [`src/plugins/skip-silences/renderer.ts`](../../src/plugins/skip-silences/renderer.ts): analyser loop.

**IPC / events:**
- DOM events: `peard:audio-can-play`; `play` and `seeked` on `<video>`.
- No IPC.

**DOM anchors:**
- `video`

**New player bar (2026-10):** unaffected. It uses no bar selectors.

**Gotchas:**
- Every `peard:audio-can-play` (once per track) creates a new analyser and a new 2 ms `looper`. The loop has no stop condition, and `stop()` doesn't cancel it, so loops pile up over a session.
- `play`/`seeked` handlers are added per track, but only the last one is removed.
- The `video` reference is captured per event.

---

## Custom Output Device (`custom-output-device`)
**What it does:** Sends the app's audio to a user-chosen output device instead of the system default.

**Why it exists:** You may want music on a different device (headphones or DAC) than the rest of the system's audio.

**How it works:**
- **Process:** renderer ([`renderer.ts`](../../src/plugins/custom-output-device/renderer.ts), built with `createRenderer`).
- **`onPlayerApiReady`** (`:51-66`):
  - Calls `getUserMedia({ audio: true })` so device labels become readable.
  - Sets `navigator.mediaDevices.ondevicechange` to `updateDeviceList`.
  - Registers a `once` `peard:audio-can-play` handler.
  - Calls `updateDeviceList` right away.
- **`updateDeviceList`** (`:7-22`) stores `{deviceId: label}` for every `audiooutput` device into `config.devices`.
- **`audioCanPlayHandler`** (`:46-49`) stores the `audioContext` and calls `updateSinkId`. That calls `audioContext.setSinkId(output)`, guarded by a feature check (`:24-36`).
- **`onConfigChange`** (`:76-79`) re-applies the sink live.
- **`stop`** removes the listener and the `ondevicechange` handler.

**Config:** `restartNeeded: true`.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plugins.custom-output-device.enabled` | boolean | `false` | on/off |
| `plugins.custom-output-device.output` | string (deviceId) | `'default'` | selected sink |
| `plugins.custom-output-device.devices` | `Record<deviceId, label>` | `{}` | cache of available outputs, written by the renderer |

**Menu:** "Select Device" opens a `select` prompt filled from `config.devices` and saves `output` ([`index.ts:23-51`](../../src/plugins/custom-output-device/index.ts)).

**Files:**
- [`src/plugins/custom-output-device/index.ts`](../../src/plugins/custom-output-device/index.ts): config and menu prompt.
- [`src/plugins/custom-output-device/renderer.ts`](../../src/plugins/custom-output-device/renderer.ts): device enumeration and `setSinkId`.

**IPC / events:**
- DOM event: `peard:audio-can-play` (once).
- `navigator.mediaDevices.ondevicechange`.
- No custom IPC; it uses only `getConfig`/`setConfig`.

**DOM anchors:** none.

**New player bar (2026-10):** unaffected.

**Gotchas:**
- The sink is set on the shared `AudioContext` (`AudioContext.setSinkId`), not on the `<video>`. Audio that bypasses that context isn't routed, such as crossfade's Howler `<audio>` copy.
- The device list only appears in the menu after the renderer has run once, because the renderer populates `devices`.

---

## Visualizer (`visualizer`)
**What it does:** Draws an audio-reactive visualization (Butterchurn/MilkDrop, Vudio, or Wave) on a canvas over the player area.

**Why it exists:** It's cosmetic: a visual for audio-only tracks.

**How it works:**
- **Process:** renderer.
- **`onPlayerApiReady`** ([`index.ts:234-244`](../../src/plugins/visualizer/index.ts)) stores `audioContext` and `audioSource` on every `peard:audio-can-play`, then calls `createVisualizer`.
- **`createVisualizer`** (`:163-228`):
  - Destroys the previous instance. It bails if there's no context or source, or the plugin is disabled.
  - Finds `video` and `#player`.
  - Creates or reuses `canvas#visualizer`, prepended into `#player`.
  - Connects `audioSource -> GainNode(1.25)`.
  - Instantiates the chosen class with `(audioContext, audioSource, canvas, gainNode, video.captureStream(), config)`.
  - Sizes the canvas to `#player` with a `ResizeObserver`.
- **Implementations** ([`visualizers/`](../../src/plugins/visualizer/visualizers/)), all extending the abstract `Visualizer` (`resize`, `destroy`):
  - `butterchurn.ts`: `Butterchurn.createVisualizer` with the preset from `butterchurn-presets`, `connectAudio(gainNode)`, and a `requestAnimationFrame` render loop.
  - `vudio.ts`: `new Vudio(stream, canvas, {...config})`, then `.dance()`. It uses the `captureStream` MediaStream.
  - `wave.ts`: `new Wave({context, source}, canvas)` and adds `config.wave.animations`.
- **`onConfigChange`** rebuilds the visualizer. A rebuild with `enabled: false` just destroys it.

**Config:** `restartNeeded: false`. `stylesheets: [empty-player.css]`, which positions `#visualizer` absolutely with a black background.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plugins.visualizer.enabled` | boolean | `false` | on/off |
| `plugins.visualizer.type` | `'butterchurn' \| 'vudio' \| 'wave'` | `'butterchurn'` | which visualizer |
| `plugins.visualizer.butterchurn.preset` | string | `'martin [shadow harlequins shape code] - fata morgana'` | Butterchurn preset name |
| `plugins.visualizer.butterchurn.blendTimeInSeconds` | number | `2.7` | preset blend time |
| `plugins.visualizer.vudio.effect` | string | `'lighting'` | Vudio effect |
| `plugins.visualizer.vudio.accuracy` | number | `128` | Vudio accuracy |
| `plugins.visualizer.vudio.lighting.*` | object | maxHeight 160, maxSize 12, lineWidth 1, color `#49f3f7`, shadowBlur 2, shadowColor `rgba(244,244,244,.5)`, fadeSide true, prettify false, horizontalAlign center, verticalAlign middle, dottify true | Vudio lighting options |
| `plugins.visualizer.wave.animations` | `{type, config}[]` | 2× `Cubes` (bottom count 30 / top count 12) + 1× `Circles` | Wave animations (`index.ts:95-133`) |

**Menu:** a "Visualizer Type" submenu with radio items `butterchurn` / `vudio` / `wave` (`:136-153`).

**Files:**
- [`src/plugins/visualizer/index.ts`](../../src/plugins/visualizer/index.ts): plugin, config, menu, `createVisualizer`.
- [`src/plugins/visualizer/empty-player.css`](../../src/plugins/visualizer/empty-player.css): canvas style.
- [`src/plugins/visualizer/visualizers/visualizer.ts`](../../src/plugins/visualizer/visualizers/visualizer.ts): abstract base class.
- [`src/plugins/visualizer/visualizers/butterchurn.ts`](../../src/plugins/visualizer/visualizers/butterchurn.ts), [`vudio.ts`](../../src/plugins/visualizer/visualizers/vudio.ts), [`wave.ts`](../../src/plugins/visualizer/visualizers/wave.ts): the three implementations.
- [`src/plugins/visualizer/visualizers/index.ts`](../../src/plugins/visualizer/visualizers/index.ts): re-exports.
- [`src/plugins/visualizer/butterchurn.d.ts`](../../src/plugins/visualizer/butterchurn.d.ts), [`vudio.d.ts`](../../src/plugins/visualizer/vudio.d.ts): type declarations for the untyped libraries.

**IPC / events:**
- DOM event: `peard:audio-can-play`.
- No IPC.

**DOM anchors:**
- `#player` (the `ytmusic-player` host)
- `video`
- `canvas#visualizer` (its own)

**New player bar (2026-10):** unaffected. It uses only `#player`/`video`.

**Gotchas:**
- The `GainNode` is connected from the source but never to `destination`, so it only feeds the visualizer and doesn't change what you hear.
- There's no `stop()`. The `peard:audio-can-play` listener is never removed, and the canvas is never removed from the DOM. Disabling relies on `onConfigChange` with `enabled: false`.

---

## Disable Autoplay (`disable-autoplay`)
**What it does:** Each newly loaded track starts paused instead of playing. Optionally this applies only to the first track after launch.

**Why it exists:** It avoids sudden playback on app start or track load.

**How it works:**
- **Process:** renderer.
- **`onPlayerApiReady`** ([`index.ts:73-77`](../../src/plugins/disable-autoplay/index.ts)) stores the API and listens to the document `videodatachange`.
- **`eventListener`** (`:51-64`): on `detail.name === 'dataloaded'`, it calls `api.pauseVideo()`. It also adds a `once` `timeupdate` listener on `<video>` that calls `video.pause()`, as a second safety pause.
- **`applyOnce`:** if set, the document listener removes itself on the first event.
- **`stop`** removes the listener. **`onConfigChange`** updates the config.

**Config:** `restartNeeded: false`.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plugins.disable-autoplay.enabled` | boolean | `false` | on/off |
| `plugins.disable-autoplay.applyOnce` | boolean | `false` | only pause the first loaded track |

**Menu:** an "Applies only on startup" checkbox that toggles `applyOnce` (`:31-47`).

**Files:**
- [`src/plugins/disable-autoplay/index.ts`](../../src/plugins/disable-autoplay/index.ts): the whole plugin.

**IPC / events:**
- DOM event: `videodatachange` on `document` (from `song-info-front.ts:351` and `renderer.ts:375`).
- DOM event: `timeupdate` on `<video>`.
- No IPC.

**DOM anchors:**
- `video`

**New player bar (2026-10):** unaffected. It uses the player API and `<video>` only.

**Gotchas:**
- With `applyOnce`, the listener is removed on the **first `videodatachange` of any name** (`:52-54`), before the `dataloaded` check. If the first event were `dataupdated`, nothing would be paused.
- The menu label text comes from `plugins.disable-autoplay.menu.apply-once` in en.json.
