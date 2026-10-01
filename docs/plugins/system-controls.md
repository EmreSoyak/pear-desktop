# System controls plugins

Plugins that expose playback control outside the web page: OS media keys and global hotkeys, Linux MPRIS, the macOS Touch Bar, the Windows taskbar thumbnail toolbar, and desktop notifications. All of them run in the **main process** (`backend`), drive playback through `getSongControls()` ([src/providers/song-controls.ts](../../src/providers/song-controls.ts), main -> renderer IPC handled in [src/renderer.ts](../../src/renderer.ts)) and read state through `registerCallback()` ([src/providers/song-info.ts](../../src/providers/song-info.ts)). None of them touch the YouTube DOM directly, so the 2026-10 player-bar redesign does not affect them. The shared helper folder `src/plugins/utils` is documented at the end; one of its helpers (`isPlayerMenu`) is broken by the redesign.

Platform-restricted plugins (`platform:` field) are filtered out at runtime by `supportsPlatform()` in [vite-plugins/plugin-importer.mts:138](../../vite-plugins/plugin-importer.mts) (generated into `mainPlugins()`/`allPlugins()`), so they neither load nor appear in the menu on other OSes.

| Plugin | Summary | Default enabled | New bar (2026-10) |
|---|---|---|---|
| [Shortcuts](#shortcuts-shortcuts) (`shortcuts`) | Global/local hotkeys for prev/play-pause/next, optional media-key override, MPRIS on Linux | no | unaffected |
| [TouchBar](#touchbar-touchbar) (`touchbar`) | macOS Touch Bar with cover, title, prev/play/next/dislike/like | no | unaffected |
| [Taskbar Media Control](#taskbar-media-control-taskbar-mediacontrol) (`taskbar-mediacontrol`) | Windows thumbnail toolbar prev/play-pause/next buttons | no | unaffected |
| [Notifications](#notifications-notifications) (`notifications`) | Song-change notifications; Windows interactive toasts with buttons; tray hover mini-player (fork addition) | no | unaffected |
| [Plugin utilities](#plugin-utilities-utils) (`utils`) | Shared helpers (CSS injection, net fetch, menu checks, HTML parsing) - not a plugin | n/a | partially affected: `isPlayerMenu` |

---

## Shortcuts (`shortcuts`)
**What it does:** Lets the user bind global (system-wide) hotkeys for Previous / Play-Pause / Next, optionally grabs the hardware media keys (MediaPlayPause/MediaNextTrack/MediaPreviousTrack), and on Linux always exposes the player over MPRIS (D-Bus) so desktop media widgets and media keys can control it. i18n name: "Shortcuts (& MPRIS)".
**Why it exists:** YouTube Music only reacts to keys while the window is focused; this gives OS-level control and Linux desktop integration.
**How it works:**
- Main process only (`backend: onMainLoad`, [index.ts:38](../../src/plugins/shortcuts/index.ts)).
- [main.ts:32-94](../../src/plugins/shortcuts/main.ts): reads config, gets `playPause/next/previous` from `getSongControls(window)`.
  - `overrideMediaKeys` -> `globalShortcut.register('MediaPlayPause' | 'MediaNextTrack' | 'MediaPreviousTrack', ...)` ([main.ts:41-45](../../src/plugins/shortcuts/main.ts)).
  - `is.linux()` -> `registerMPRIS(window)` ([main.ts:47-49](../../src/plugins/shortcuts/main.ts)), independent of `overrideMediaKeys`.
  - Iterates `global` and `local` maps; each non-empty accelerator is bound to `songControls[action]` (`previous`, `playPause`, `next`). `global` -> Electron `globalShortcut.register` ([main.ts:12-20](../../src/plugins/shortcuts/main.ts)); `local` -> `electron-localshortcut` `register(win, ...)` (only while the window is focused, [main.ts:22-30](../../src/plugins/shortcuts/main.ts)).
- MPRIS ([mpris.ts](../../src/plugins/shortcuts/mpris.ts)), using `@jellybrick/mpris-service` (+ `@jellybrick/dbus-next`):
  - `YTPlayer extends MprisPlayer` keeps its own position (microseconds) and exposes setters ([mpris.ts:26-66](../../src/plugins/shortcuts/mpris.ts)). `setupMPRIS()` creates it with bus name `YoutubeMusic` (unicode-escaped), identity `APPLICATION_NAME`, desktopEntry `youtube-music`, `canRaise=true`, `canQuit=false`, URI schemes http/https ([mpris.ts:68-83](../../src/plugins/shortcuts/mpris.ts)).
  - On `peard:player-api-loaded` it asks the renderer to start the seeked/time/repeat/volume/shuffle/fullscreen/autoplay state feeds (`peard:setup-*-listener`) and requests shuffle/fullscreen/queue info ([mpris.ts:124-135](../../src/plugins/shortcuts/mpris.ts)).
  - Renderer -> MPRIS state: `peard:seeked` (Seeked signal), `peard:repeat-changed` (NONE/ONE/ALL -> LoopStatus None/Track/Playlist), `peard:shuffle-changed`, `peard:fullscreen-changed`, `peard:set-fullscreen`, `peard:fullscreen-changed-supported` (sets `canUsePlayerControls`), `peard:autoplay-changed`, `peard:get-queue-response` (computes `canGoPrevious`/`canGoNext` from the selected queue item), `peard:volume-changed` (muted -> 0) ([mpris.ts:137-224, 309-313](../../src/plugins/shortcuts/mpris.ts)).
  - MPRIS -> app: `play`/`pause`/`playpause` -> `playPause()` (guarded by current status), `next`, `previous`, `seek` -> `peard:seek-by`, `position` -> `peard:seek-to` (only if trackId matches current video), `loopStatus` -> `switchRepeat(delta)` cycling None->Playlist->Track, `shuffle` -> `shuffle()` (only when enabling), `fullscreen` -> `setFullscreen`, `raise` -> `win.setSkipTaskbar(false); win.show()`, `open` -> `win.loadURL(uri)`, `volume` -> `setVolume(v*100)` or, if `precise-volume` is enabled, sends `setVolume` to the renderer ([mpris.ts:226-322](../../src/plugins/shortcuts/mpris.ts)).
  - Song metadata via `registerCallback`: TimeChanged only updates position; other events publish `mpris:length`, `mpris:artUrl`, `xesam:title/url/artist/album`, `mpris:trackid` (`Track/<videoId with - -> _MINUS_>`), position + Seeked, PlaybackStatus, then re-request the queue ([mpris.ts:324-362](../../src/plugins/shortcuts/mpris.ts)).
**Config:**

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plugins.shortcuts.enabled` | boolean | `false` | Plugin on/off. `restartNeeded: true`. |
| `plugins.shortcuts.overrideMediaKeys` | boolean | `false` | Register hardware media keys as global shortcuts. |
| `plugins.shortcuts.global.previous` | string (Electron accelerator) | `''` | Global hotkey for previous; empty = not registered. |
| `plugins.shortcuts.global.playPause` | string | `''` | Global hotkey for play/pause. |
| `plugins.shortcuts.global.next` | string | `''` | Global hotkey for next. |
| `plugins.shortcuts.local.previous` | string | `''` | Window-focused hotkey (electron-localshortcut). |
| `plugins.shortcuts.local.playPause` | string | `''` | Window-focused hotkey. |
| `plugins.shortcuts.local.next` | string | `''` | Window-focused hotkey. |

**Menu:** ([menu.ts](../../src/plugins/shortcuts/menu.ts)) "Set Global Song Controls" opens a `custom-electron-prompt` `keybind` dialog for previous / play-pause / next prefilled from `config.global` and saves the accelerators into `global` ([menu.ts:28-72](../../src/plugins/shortcuts/menu.ts)); "Override Media Keys" checkbox. `local` keys have no UI (config file only).
**Files:**
- [src/plugins/shortcuts/index.ts](../../src/plugins/shortcuts/index.ts) - plugin definition, config types/defaults.
- [src/plugins/shortcuts/main.ts](../../src/plugins/shortcuts/main.ts) - globalShortcut / localshortcut registration, starts MPRIS on Linux.
- [src/plugins/shortcuts/menu.ts](../../src/plugins/shortcuts/menu.ts) - keybind prompt + override checkbox.
- [src/plugins/shortcuts/mpris.ts](../../src/plugins/shortcuts/mpris.ts) - MPRIS player bridge.
- [src/plugins/shortcuts/mpris-service.d.ts](../../src/plugins/shortcuts/mpris-service.d.ts) - type declarations for `@jellybrick/mpris-service`.

**IPC / events:**
- Sent (main -> renderer, via song-controls): `peard:toggle-play`, `peard:next-video`, `peard:previous-video`; MPRIS additionally `peard:switch-repeat`, `peard:shuffle`, `peard:update-volume`, `peard:click-fullscreen-button` (+ `win.setFullScreen`), `peard:get-shuffle`, `peard:get-fullscreen`, `peard:get-queue`, `peard:seek-to`, `peard:seek-by`, `setVolume` (precise-volume), `peard:setup-{seeked,time-changed,repeat-changed,volume-changed,shuffle-changed,fullscreen-changed,autoplay-changed}-listener`.
- Received (ipcMain, MPRIS only): `peard:player-api-loaded`, `peard:seeked`, `peard:repeat-changed`, `peard:shuffle-changed`, `peard:fullscreen-changed`, `peard:set-fullscreen`, `peard:fullscreen-changed-supported`, `peard:autoplay-changed`, `peard:get-queue-response`, `peard:volume-changed`; song-info callbacks.

**DOM anchors:** none (plugin code). Indirectly relies on renderer handlers in [src/renderer.ts](../../src/renderer.ts) / [src/providers/song-info-front.ts](../../src/providers/song-info-front.ts).
**New player bar (2026-10):** unaffected - every action goes through song-controls IPC and every state feed through song-info / song-info-front, all of which were fixed for `ytmusic-miniplayer` (repeat/shuffle/fullscreen now read from the app store via `watchStoreValue`). Queue info (`#queue`) and fullscreen clicks (`.fullscreen-button` / `.exit-fullscreen-button` in renderer.ts) are not on the dead-selector list.
**Gotchas:**
- MPRIS is Linux-only and always on when the plugin is enabled on Linux; `overrideMediaKeys` is unrelated to it.
- `globalShortcut` registrations are never unregistered by the plugin (no `stop`); changes need a restart (`restartNeeded`).
- MPRIS `shuffle` only acts when set to true (calls `shuffle()`); setting false only updates the MPRIS property ([mpris.ts:286-297](../../src/plugins/shortcuts/mpris.ts)).
- `requestShuffleInformation()` sends `peard:get-shuffle`, whose reply is `peard:get-shuffle-response`, which MPRIS does not listen for; the initial shuffle state instead arrives from the store watcher's initial `peard:shuffle-changed`.
- `canGoNext` expression `currentPosition - (queue?.items?.length ?? 0 - 1)` parses as `?? (0 - 1)`, so it is truthy for practically any position (canGoNext almost always true) ([mpris.ts:220](../../src/plugins/shortcuts/mpris.ts)).
- Keybind prompt calls `setConfig(config)` with the original object; it still saves because `newConfig` is a shallow copy sharing the same `global` object ([menu.ts:61-70](../../src/plugins/shortcuts/menu.ts)).
- The i18n description mentions "Ctrl/CMD + F to search"; no such code exists in this plugin.

---

## TouchBar (`touchbar`)
**What it does:** On macOS Touch Bar Macs, shows a scrubber with the album art and song title plus a segmented control: previous, play/pause, next, dislike, like.
**Why it exists:** Native Touch Bar media controls for the app.
**How it works:** Main process `backend` ([index.ts:19-106](../../src/plugins/touchbar/index.ts)), `platform: Platform.macOS`.
- Builds an Electron `TouchBar` with `TouchBarScrubber` (items: image + `TouchBarLabel` title), a flexible `TouchBarSpacer`, and a `TouchBarSegmentedControl` (`mode: 'buttons'`) of `⏮`, play/pause, `⏭`, `👎`, `👍`; `change: (i) => controls[i]()` ([index.ts:29-76](../../src/plugins/touchbar/index.ts)).
- On `window.once('ready-to-show')`, sets `controls = [previous, playPause, next, dislike, like]` from `getSongControls` and registers a song-info callback that (ignoring TimeChanged) updates the title, the play/pause label (`▶️` when paused, `⏸` otherwise), the icon (`songInfo.image` or the app icon, resized to height 23), then `window.setTouchBar(touchBar)` ([index.ts:82-105](../../src/plugins/touchbar/index.ts)).

**Config:**

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plugins.touchbar.enabled` | boolean | `false` | Plugin on/off. `restartNeeded: true`. |

**Menu:** none.
**Files:** [src/plugins/touchbar/index.ts](../../src/plugins/touchbar/index.ts) - whole plugin.
**IPC / events:** sent via song-controls: `peard:previous-video`, `peard:toggle-play`, `peard:next-video`, `peard:update-like` (`LIKE` / `DISLIKE`). Receives song-info callbacks (VideoSrcChanged, PlayOrPaused).
**DOM anchors:** none.
**New player bar (2026-10):** unaffected - prev/next/play-pause/like/dislike all go through song-controls IPC (like path fixed in renderer.ts for the new bar).
**Gotchas:** macOS only (filtered elsewhere). The Touch Bar is only attached after the first song-info event; the callback is registered only after the window's first `ready-to-show`. Labels are emoji, not i18n.

---

## Taskbar Media Control (`taskbar-mediacontrol`)
**What it does:** Adds Previous / Play-Pause / Next buttons to the Windows taskbar thumbnail preview (hover the taskbar icon). The middle icon flips between play and pause with the playback state; icons follow the OS light/dark theme.
**Why it exists:** Control playback from the taskbar without opening the window.
**How it works:** Main process `backend` ([index.ts:32-108](../../src/plugins/taskbar-mediacontrol/index.ts)), `platform: Platform.Windows`.
- `getImages()` picks white icons when `nativeTheme.shouldUseDarkColors` else black (`assets/media-icons-{white,black}/{play,pause,next,previous}.png`, `?asset&asarUnpack`) ([index.ts:37-57](../../src/plugins/taskbar-mediacontrol/index.ts)); `nativeTheme.on('updated')` reloads icons and re-applies.
- `setThumbar(songInfo)` returns early until `songInfo.title` exists, then calls `window.setThumbarButtons([...])` with all three buttons each time ("Win32 require full rewrite"); play/pause icon = `play` when `isPaused` else `pause`; clicks call `previous()` / `playPause()` / `next()` ([index.ts:64-95](../../src/plugins/taskbar-mediacontrol/index.ts)).
- Re-applied on every non-TimeChanged song-info event and on `window.on('show')` (thumbar buttons are lost when the window is hidden) ([index.ts:97-107](../../src/plugins/taskbar-mediacontrol/index.ts)).

**Config:**

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plugins.taskbar-mediacontrol.enabled` | boolean | `false` | Plugin on/off. `restartNeeded: true`. |

**Menu:** none.
**Files:** [src/plugins/taskbar-mediacontrol/index.ts](../../src/plugins/taskbar-mediacontrol/index.ts) - whole plugin; icons in [assets/media-icons-black](../../assets/media-icons-black) / [assets/media-icons-white](../../assets/media-icons-white).
**IPC / events:** sent via song-controls: `peard:previous-video`, `peard:toggle-play`, `peard:next-video`. Listens to song-info callbacks, `nativeTheme` `updated`, `BrowserWindow` `show`.
**DOM anchors:** none.
**New player bar (2026-10):** unaffected - play/pause uses the player API (`peard:toggle-play`), prev/next use the fixed `getPlayerControl` path in renderer.ts; state comes from song-info (video/play-pause events, not player-bar DOM).
**Gotchas:** Windows only. Tooltips are hard-coded English (`'Previous'`, `'Play/Pause'`, `'Next'`), not i18n. No buttons appear until the first song with a title is reported. No `stop` hook: disabling needs a restart.

---

## Notifications (`notifications`)
**What it does:** Shows a desktop notification (title, artist, cover) whenever a new song starts (and optionally on every unpause). On Windows with "Interactive Notifications" (default on) it shows a custom toast with Previous / Play-Pause / Next buttons in one of 7 layouts, and a single tray click toggles that toast. This fork also adds a tray hover mini-player (see below).
**Why it exists:** Song-change awareness and quick control without switching to the window.
**How it works:** Main process `backend: { start: onMainLoad, onConfigChange }` ([index.ts:46-49](../../src/plugins/notifications/index.ts)). `onConfigChange` replaces the module-level `config`, so options read through it (urgency, toastStyle, unpauseNotification, refreshOnPlayPause) apply live; `interactive`, `trayControls`, `hoverControls` are only read at start.
- **Path selection** ([main.ts:55-68](../../src/plugins/notifications/main.ts)): `is.windows() && config.interactive` -> `interactive(window, () => config, context)`; otherwise `setup()`. Independently, `config.hoverControls` -> `setupHoverPopup(window)`.
- **Plain notifications** (`setup()`, [main.ts:20-53](../../src/plugins/notifications/main.ts); Linux, macOS, or Windows with interactive off): on each non-TimeChanged song-info event where `!isPaused` and (`url` changed or `unpauseNotification`), closes the previous notification and after a 10 ms `setTimeout` (workaround for the notification being updated instead of re-shown) shows `new Notification({ title: title || 'Playing', body: artist, icon, silent: true, urgency })`.
- **Icon** (`notificationImage`, [utils.ts:44-66](../../src/plugins/notifications/utils.ts)): no `songInfo.image` -> app icon path. `interactive` false -> cover resized to height 256 and center-cropped to 256x256 (`NativeImage`). `interactive` true -> toastStyle `logo`/`legacy`: cropped square saved to `<userData>/tempIcon.png`; any other style: full cover saved to `<userData>/tempBanner.png` (path returned; falls back to app icon on write error). Note the `interactive` flag decides this even on Linux/macOS (default `true` -> file path).
- **Interactive toasts** ([interactive.ts](../../src/plugins/notifications/interactive.ts)):
  - `sendNotification()` closes the previous toast, builds `new Notification({ ..., silent: true, toastXml })` and force-closes it after 5 s ([interactive.ts:37-69](../../src/plugins/notifications/interactive.ts)). `NativeImage` icons are converted with `toDataURL()` for the XML.
  - Toast XML: `<toast><audio silent="true"/><visual><binding template="ToastGeneric">...</binding></visual><actions>...</actions></toast>` ([interactive.ts:144-154](../../src/plugins/notifications/interactive.ts)). Buttons: previous, play-or-pause (by `isPaused`), next, each `<action activationType="protocol" arguments="youtubemusic://<kind>">` ([interactive.ts:131-142](../../src/plugins/notifications/interactive.ts)). `legacy` style uses unicode glyph labels from [src/types/media-icons.ts](../../src/types/media-icons.ts) (`ᐸ ‖ ᐅ ᐳ`); other styles use empty `content` plus `imageUri="file:///<assets/media-icons-black/*.png>"` ([interactive.ts:116-129](../../src/plugins/notifications/interactive.ts)).
  - Templates (`getXml`, [interactive.ts:71-99](../../src/plugins/notifications/interactive.ts)), `ToastStyles` in [utils.ts:16-24](../../src/plugins/notifications/utils.ts): 1 `logo` and 7 `legacy` (image `placement="appLogoOverride"` + title/artist text), 2 `banner_centered_top` (image on top, centered title/artist), 3 `hero` (`placement="hero"`), 4 `banner_top_custom` (image, title/artist, right-aligned album and `elapsed / duration` via `secondsToMinutes`), 5 `banner_centered_bottom` (centered text, image below), 6 `banner_bottom` (inline image, no placement). Centered styles pick title font size by length (`Header` <=13, `Subheader` <=22, `Title` <=26, else `Subtitle`, [interactive.ts:248-262](../../src/plugins/notifications/interactive.ts)). Unknown values fall back to `logo`.
  - On `peard:player-api-loaded` sends `peard:setup-time-changed-listener` to track elapsed seconds ([interactive.ts:266-269](../../src/plugins/notifications/interactive.ts)).
  - Song-info callback ([interactive.ts:275-294](../../src/plugins/notifications/interactive.ts)): stores elapsed seconds on TimeChanged; requires title or artist; saves `savedSongInfo`; shows a toast when `!isPaused` and (`url` changed or `unpauseNotification`) - unless the hover mini-player is visible (`isHoverPopupVisible()`, fork addition).
  - `trayControls` ([interactive.ts:296-316](../../src/plugins/notifications/interactive.ts)): `setTrayOnClick` -> close the open toast, or re-show the last song's toast with current elapsed time; `setTrayOnDoubleClick` -> hide/show the main window. These replace the default tray click handler in [src/tray.ts](../../src/tray.ts) (`removeAllListeners('click')`, queued via `pendingClick` if the tray does not exist yet).
  - `app.once('before-quit')` closes the toast. `changeProtocolHandler(...)` installs a handler that runs `songControls[cmd](...args)` and, with `refreshOnPlayPause`, re-sends the toast after `pause` / `play` ([interactive.ts:322-339](../../src/plugins/notifications/interactive.ts)).
  - Button clicks reach the app as `youtubemusic://<cmd>` protocol launches -> `app.on('second-instance')` -> `handleProtocol(cmd)` ([src/index.ts:769-785](../../src/index.ts), [src/providers/protocol-handler.ts](../../src/providers/protocol-handler.ts)) -> `peard:previous-video` / `peard:play` / `peard:pause` / `peard:next-video`.
- **Urgency** (Linux): `urgency` passed to `Notification`; menu values Low=`low`, Normal=`normal`, High=`critical` ([utils.ts:26-30](../../src/plugins/notifications/utils.ts)).

**Tray hover mini-player (fork addition):** When `hoverControls` is on (default `true`), hovering the tray icon opens a small frameless, transparent, always-on-top window (380x85 + shadow padding) next to the tray with cover, title, artist and Previous / Play-Pause / Next buttons; it hides when the cursor leaves both the popup and the tray icon (polled every 150 ms). It is implemented in [hover-popup.ts](../../src/plugins/notifications/hover-popup.ts) + [assets/hover-popup.html](../../assets/hover-popup.html), uses `setTrayOnMouseMove` / `getTrayBounds` from [src/tray.ts](../../src/tray.ts) (tray `mouse-move` is macOS/Windows only), sends commands via song-controls, and suppresses interactive toasts while visible. It is started from `main.ts` regardless of the interactive setting. Full details: [../custom/tray-hover-mini-player.md](../custom/tray-hover-mini-player.md).

**Config:**

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plugins.notifications.enabled` | boolean | `false` | Plugin on/off. `restartNeeded: true`. |
| `plugins.notifications.unpauseNotification` | boolean | `false` | Also notify when playback resumes (not just on song change). |
| `plugins.notifications.urgency` | `'low' \| 'normal' \| 'critical'` | `'normal'` | Notification urgency; only effective on Linux. |
| `plugins.notifications.interactive` | boolean | `true` | Windows: use custom toast XML with buttons. Read at start only. Also selects icon handling on all OSes (see utils). |
| `plugins.notifications.toastStyle` | number 1-7 | `1` (`logo`) | Interactive toast layout (`ToastStyles`). |
| `plugins.notifications.refreshOnPlayPause` | boolean | `false` | Re-show the toast after toast play/pause buttons (see Gotchas). |
| `plugins.notifications.trayControls` | boolean | `true` | Windows interactive only: tray click toggles toast, double-click toggles window. Read at start. |
| `plugins.notifications.hideButtonText` | boolean | `false` | Menu option only; not read anywhere in code (see Gotchas). |
| `plugins.notifications.hoverControls` | boolean | `true` | Fork addition: enable tray hover mini-player. Read at start. |

**Menu:** ([menu.ts](../../src/plugins/notifications/menu.ts)) Linux: "Notification Priority" radio submenu (Low/Normal/High). Windows: "Interactive Notifications" checkbox (takes effect after restart); "Interactive Settings" submenu with "Open/Close on tray click" (`trayControls`), "Hide button text" (`hideButtonText`), "Refresh on Play/Pause" (`refreshOnPlayPause`), "Show mini-player on tray hover" (`hoverControls`, fork addition); "Toast style" radio submenu (labels from `snakeToCamel` of `ToastStyles` keys, e.g. "Banner Centered Top"). macOS: no OS-specific items. All OSes: "Show notification on unpause" checkbox. Note the hover-controls item is only reachable on Windows.
**Files:**
- [src/plugins/notifications/index.ts](../../src/plugins/notifications/index.ts) - plugin definition, config type/defaults (`hoverControls` added by fork).
- [src/plugins/notifications/main.ts](../../src/plugins/notifications/main.ts) - start, plain-notification path, `onConfigChange`, starts hover popup (fork edit).
- [src/plugins/notifications/interactive.ts](../../src/plugins/notifications/interactive.ts) - Windows toast XML, buttons, tray click, protocol handler (fork edit: hover-visibility check).
- [src/plugins/notifications/menu.ts](../../src/plugins/notifications/menu.ts) - per-OS menu (fork edit: hover item).
- [src/plugins/notifications/utils.ts](../../src/plugins/notifications/utils.ts) - `ToastStyles`, `urgencyLevels`, `notificationImage`, `saveImage`, `snakeToCamel`, `secondsToMinutes`.
- [src/plugins/notifications/hover-popup.ts](../../src/plugins/notifications/hover-popup.ts) - fork: tray hover mini-player window.
- [assets/hover-popup.html](../../assets/hover-popup.html) - fork: mini-player UI.

**IPC / events:**
- Sent: `peard:setup-time-changed-listener` (interactive). Commands via song-controls: `peard:previous-video`, `peard:next-video`, `peard:play`, `peard:pause` (toast buttons through protocol handler), `peard:toggle-play` (hover popup).
- Received: `peard:player-api-loaded` (interactive, via `ctx.ipc.on`); song-info callbacks (VideoSrcChanged, PlayOrPaused, TimeChanged).
- Other: `youtubemusic://<cmd>` protocol activations; tray `click` / `double-click` / `mouse-move`; hover popup buttons signal via `page-title-updated` with titles `act:<cmd>:<n>` (no IPC).

**DOM anchors:** none in the YouTube page. (Hover popup has its own HTML: `#popup`, `#prev`, `#pp`, `#next`, `#title`, `#artist`, `#albumArt`.)
**New player bar (2026-10):** unaffected - only uses song-info (video-src / play-or-paused / time-changed feeds, fixed) and song-controls (`peard:play`/`pause`/`toggle-play` use the player API; prev/next use the fixed renderer path). Hover mini-player likewise only uses song-controls.
**Gotchas:**
- `refreshOnPlayPause` appears ineffective: `interactive()` calls `changeProtocolHandler()` during `loadAllMainPlugins` ([src/index.ts:379](../../src/index.ts), inside `createMainWindow`), but `setupProtocolHandler(mainWindow)` runs later at [src/index.ts:767](../../src/index.ts) and overwrites `protocolHandler` with the default one. Toast buttons still work (default handler calls the same song-controls), but the refresh branch never runs. (Static reading of load order.)
- `hideButtonText` is never read. In `display()` button text is `''` whenever `toastStyle` is truthy (always, values 1-7); `legacy` uses glyphs ([interactive.ts:116-129](../../src/plugins/notifications/interactive.ts)).
- Interactive callback does not skip `TimeChanged` events: with `unpauseNotification` on, the condition `!isPaused && (url changed || unpauseNotification)` is true on every time tick, so a toast would be re-sent about every second while playing (from code reading, [interactive.ts:284-293](../../src/plugins/notifications/interactive.ts)). The plain path (`main.ts`) does skip TimeChanged.
- Interactive toasts are closed after 5 s by a timer ("To fix the notification not closing").
- With `trayControls` (default on, Windows interactive), the tray single-click no longer shows/hides the window and ignores `options.trayClickPlayPause`; double-click toggles the window instead.
- Cover images are written to `<userData>/tempIcon.png` / `tempBanner.png` on every notification when `interactive` is true (even on Linux/macOS).
- Toast XML interpolates title/artist/album without XML escaping (unclear from code how `&`/`<` in titles render).

---

## Plugin utilities (`utils`)
**What it does:** Not a plugin (no `index.ts`, not auto-discovered). Shared helpers imported by core code and several plugins.
**Why it exists:** Avoid duplicating CSS injection, `net.fetch` adapters, song-menu checks and HTML-string parsing.
**How it works:** Helper inventory and users (grep of `src/`):

| Helper | File | What it does | Used by |
|---|---|---|---|
| `injectCSS(webContents, css)` | [main/css.ts:15](../../src/plugins/utils/main/css.ts) | `insertCSS` now if page loaded, else queue until `did-finish-load`; resolves to an unregister fn | [src/index.ts:295](../../src/index.ts) (core music-player CSS) |
| `injectCSSAsFile(webContents, path)` | [main/css.ts:32](../../src/plugins/utils/main/css.ts) | Same, reading the CSS file from disk | [src/index.ts:303](../../src/index.ts) (user custom CSS files) |
| `fileExists(path, onExists, onError?)` | [main/fs.ts:3](../../src/plugins/utils/main/fs.ts) | `fs.access` F_OK callback wrapper | [src/index.ts:300](../../src/index.ts) |
| `getNetFetchAsFetch()` | [main/fetch.ts:3](../../src/plugins/utils/main/fetch.ts) | `fetch`-compatible wrapper around Electron `net.fetch` (defaults method to POST when a body is given) | `crossfade` ([index.ts:171](../../src/plugins/crossfade/index.ts)), `downloader` ([main/index.ts:153,181](../../src/plugins/downloader/main/index.ts)) |
| `defineMainPlugin` / `definePreloadPlugin` / `defineMenuPlugin` | [main/types.ts](../../src/plugins/utils/main/types.ts) | Identity typing helpers (legacy plugin API) | none |
| `Config`, `Plugin`, `RendererPlugin`, `MainPlugin`, `PreloadPlugin`, `MenuPlugin` types; `definePluginConfig` | [common/types.ts](../../src/plugins/utils/common/types.ts) | Legacy plugin types; `definePluginConfig` stores defaults in an unexported map | only `main/types.ts` |
| `ElementFromHtml(html)` | [renderer/html.ts:8](../../src/plugins/utils/renderer/html.ts) | `DOMParser` -> first body element | `music-together` (element.ts, ui/guest.ts, ui/host.ts, ui/setting.ts, ui/status.ts) |
| `ImageElementFromSrc(src)` | [renderer/html.ts:18](../../src/plugins/utils/renderer/html.ts) | Creates `<img src>` | none |
| `isMusicOrVideoTrack()` | [renderer/check.ts:1](../../src/plugins/utils/renderer/check.ts) | True if any `tp-yt-paper-listbox #navigation-endpoint` has `data.addToPlaylistEndpoint.videoId` or `data.watchEndpoint.videoId` (open popup menu is for a track) | `downloader`, `picture-in-picture`, `playback-speed` renderers |
| `isAlbumOrPlaylist()` | [renderer/check.ts:25](../../src/plugins/utils/renderer/check.ts) | True if a menu item has `addToPlaylistEndpoint.playlistId` | `downloader` renderer |
| `isPlayerMenu(menu)` | [renderer/check.ts:43](../../src/plugins/utils/renderer/check.ts) | `menu.parentElement.ytEventForwardingBehavior.forwarder_.eventSink.matches('ytmusic-menu-renderer.ytmusic-player-bar')` - menu was opened from the player bar's "..." button | `picture-in-picture` ([renderer.tsx:161](../../src/plugins/picture-in-picture/renderer.tsx)), `playback-speed` ([renderer.tsx:93](../../src/plugins/playback-speed/renderer.tsx)) |

Barrels: `main/index.ts` re-exports css, fs, types, fetch; `renderer/index.ts` re-exports only `html` (check.ts is imported by path `@/plugins/utils/renderer/check`); `common/index.ts` re-exports types.
**Config:** none.
**Menu:** none.
**Files:** [src/plugins/utils/common/](../../src/plugins/utils/common) (legacy types), [src/plugins/utils/main/](../../src/plugins/utils/main) (css, fetch, fs, types), [src/plugins/utils/renderer/](../../src/plugins/utils/renderer) (check, html).
**IPC / events:** none (`setupCssInjection` listens to `webContents` `did-finish-load`).
**DOM anchors:** `tp-yt-paper-listbox #navigation-endpoint` (check.ts:14,35), `ytmusic-menu-renderer.ytmusic-player-bar` (check.ts:55).
**New player bar (2026-10):** partially affected - `isPlayerMenu` matches the dead selector `ytmusic-menu-renderer.ytmusic-player-bar`, so it now returns false/undefined for every menu; callers `picture-in-picture` and `playback-speed` therefore never inject their items into the player-bar song menu. `isMusicOrVideoTrack` / `isAlbumOrPlaylist` use popup-menu selectors not on the dead list (unclear from code whether the new bar's menu still produces them). All main-process helpers and `ElementFromHtml` are unaffected.
