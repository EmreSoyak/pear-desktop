# Appearance & UI plugins

Plugins that restyle the YouTube Music page or the Electron window, or add small UI elements (clock, arrows, title bar, video/song switch, PiP). Almost all of them work by injecting CSS (`stylesheets: [...]` in `createPlugin`, adopted as `CSSStyleSheet`s by [src/loader/renderer.ts:91](../../src/loader/renderer.ts)) and by querying YouTube DOM nodes from the renderer. That makes them sensitive to YouTube DOM changes such as the 2026-10-01 player-bar redesign (`ytmusic-player-bar` became `ytmusic-miniplayer`; see [src/providers/dom-elements.ts](../../src/providers/dom-elements.ts)).

All statuses below come from reading the code. Nothing was run. "Unverified" means the selector is in neither the known-dead list nor the known-alive list.

| Plugin | Summary | Default enabled | New player bar (2026-10) |
|---|---|---|---|
| [`album-color-theme`](#album-color-theme-album-color-theme) | Tints YTM's colour variables with the current thumbnail's average colour | false | partially affected |
| [`ambient-mode`](#ambient-mode-ambient-mode) | Blurred glow of the video/cover behind the player | false | unaffected |
| [`blur-nav-bar`](#blur-navigation-bar-blur-nav-bar) | Translucent, blurred top nav bar | false (no config block) | unaffected |
| [`compact-sidebar`](#compact-sidebar-compact-sidebar) | Forces the left guide into its compact (mini) form | false | unaffected |
| [`clock`](#clock-clock) | Clock in the centre of the nav bar | false | unaffected |
| [`transparent-player`](#transparent-player-transparent-player) | Windows Mica/Acrylic window material plus transparent page backgrounds | false | partially affected |
| [`unobtrusive-player`](#unobtrusive-player-unobtrusive-player) | Stops the player page from popping open when you start a song | false | likely broken |
| [`picture-in-picture`](#picture-in-picture-picture-in-picture) | Native video PiP, or shrinks the window into an always-on-top mini player | false | likely broken (partly) |
| [`video-toggle`](#video-toggle-video-toggle) | Song/Video switch over the player, or hides the video panel | false | unaffected (verified live) |
| [`in-app-menu`](#in-app-menu-in-app-menu) | Custom HTML title bar and menu instead of the native frame | true on Windows, false on macOS/Linux | unaffected (CSS-var caveat) |
| [`navigation`](#navigation-navigation) | Back/forward arrows in the nav bar | true | unaffected |

**Loader gotcha (affects every plugin here that has `stylesheets`):** `forceUnloadRendererPlugin` ([src/loader/renderer.ts:44-58](../../src/loader/renderer.ts)) calls `unregisterStyleMap[id]`, but nothing ever fills that map. It then removes `style#plugin-${id}`, which is not how the sheets were added (they go into `document.adoptedStyleSheets`, lines 91-102). From reading the code, a plugin's stylesheet appears to stay active after the plugin is disabled at runtime, until the page reloads.

---

## Album Color Theme (`album-color-theme`)
**What it does:** On every track change it takes the average colour of the track thumbnail and mixes it into YouTube Music's dark-theme CSS variables. Backgrounds, menus and the progress colour all take on the album's tint. The menu sets how strongly the colour is mixed in and whether the seek bar is themed.
**Why it exists:** It gives the UI a dynamic, album-based colour theme instead of YTM's fixed black/grey palette.
**How it works:** This plugin is renderer-only.
- `start()` caches a few elements: `#player-page`, `#nav-bar-background`, `ytmusic-player-bar`, `#player-bar-background`, `#guide-wrapper`, `#mini-guide-background` and `#layout` ([index.ts:83-98](../../src/plugins/album-color-theme/index.ts)). These cached fields are assigned but never read again.
- `onPlayerApiReady` applies the config, then listens on `document` for `videodatachange` with `detail.name === 'dataloaded'` (lines 99-155).
  - It takes the first thumbnail URL from `playerApi.getPlayerResponse().videoDetails.thumbnail.thumbnails` and runs `FastAverageColor.getColorAsync()` on it.
  - It darkens the colour by 0.15 (and by 0.3 for the dark variant), then keeps darkening in 0.05 steps until luminosity is ≤ 0.5.
  - It writes `r, g, b` triplets to `--ytmusic-album-color` and `--ytmusic-album-color-dark` on `<html>`.
- `updateColor(alpha)` (lines 180-248) overrides about 40 YTM/paper CSS variables on `<html>` with `!important`. Each value is `color-mix(in srgb, <original> <100-ratio>%, rgba(var(--ytmusic-album-color), alpha) <ratio>%)`.
  - `background` and `--ytmusic-background` use the dark colour.
  - The progress colours and `--yt-spec-inverted-background` use 1.75× the ratio.
- Alpha is `plugins.transparent-player.opacity` when transparent-player is enabled. Otherwise it is 1 (lines 144-153).
- `onConfigChange` sets `--ytmusic-album-color-ratio` and toggles `body.seekbar-theme` (lines 156-163).
- [style.css](../../src/plugins/album-color-theme/style.css) does the following:
  - adds transitions on the nav, guide and player page
  - sets a `padding-top: 90px` / `margin-top` hack on `[slot="player-page"]` to fix the blurred nav bar; it uses `--menu-bar-height` from in-app-menu (lines 33-36)
  - greys out icons and text, including several player-bar rules (lines 51-65)
  - masks the fullbleed thumbnail
  - applies a seek-bar gradient under `.seekbar-theme #progress-bar.ytmusic-player-bar` (lines 89-93)

**Config:**

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plugins.album-color-theme.enabled` | boolean | `false` | |
| `plugins.album-color-theme.ratio` | number 0–1 | `0.5` | Share of album colour in the mix (`--ytmusic-album-color-ratio`) |
| `plugins.album-color-theme.enableSeekbar` | boolean | `true` | Adds `body.seekbar-theme` (gradient seek bar) |

`restartNeeded: false`.
**Menu:**
- "Color mix ratio": a radio list from 0% to 100% in steps of 10.
- "Enable seekbar": a checkbox.

**Files:**
- [index.ts](../../src/plugins/album-color-theme/index.ts): the plugin, colour extraction and variable overrides.
- [style.css](../../src/plugins/album-color-theme/style.css): transitions, colour fixes, seek-bar theme.

**IPC / events:**
- No IPC.
- Listens to the DOM `videodatachange` event on `document` (dispatched by [src/providers/song-info-front.ts:351](../../src/providers/song-info-front.ts) and [src/renderer.ts:375](../../src/renderer.ts)).
- Reads `window.mainConfig.plugins.isEnabled('transparent-player')` and `window.mainConfig.get('plugins.transparent-player.opacity')`.

**DOM anchors:**
- JS: `<html>` style, `body` class, plus the cached-but-unused nodes listed under How it works.
- CSS:
  - `yt-page-navigation-progress`, `#player-page`, `#nav-bar-background`, `#mini-guide-background`, `#guide-wrapper`, `#items`
  - `ytmusic-app-layout > [slot="player-page"]`
  - `.duration/.byline.ytmusic-player-queue-item`, `.icon.ytmusic-menu-navigation-item-renderer`
  - `.menu.ytmusic-player-bar`, `ytmusic-player-bar`, `.time-info.ytmusic-player-bar`, `.volume-slider.ytmusic-player-bar`, `.expand-volume-slider.ytmusic-player-bar`
  - `ytmusic-fullbleed-thumbnail-renderer img`, `.background-gradient`, `ytmusic-browse-response`, `ytmusic-search-box`
  - `#progress-bar.ytmusic-player-bar`

**New player bar (2026-10):** Partially affected.
- The main feature (CSS variable overrides on `<html>`) does not depend on the bar, so it is unaffected. Whether `ytmusic-miniplayer` reads those same variables is unverified.
- Dead:
  - The `enableSeekbar` gradient (`.seekbar-theme #progress-bar.ytmusic-player-bar`, style.css:89). The new seek bar is `input.ytMusicMiniPlayerProgressBar`, so this option probably does nothing now.
  - The player-bar text/icon/volume colour fixes (style.css:51-65).
  - `document.querySelector('ytmusic-player-bar')` in `start()`. It is harmless because the result is unused.

**Gotchas:**
- There is no `stop()`. Disabling the plugin at runtime leaves the `!important` variable overrides and the `videodatachange` listener in place until reload.
- It works together with transparent-player in both directions. This plugin reads that plugin's opacity, and transparent-player skips its `body.transparent-player` class when this plugin is enabled.

## Ambient Mode (`ambient-mode`)
**What it does:** Draws a large, blurred copy of the current video or album art behind the player on the player page, like YouTube's ambient mode. Smoothness, quality, size, frame buffer, opacity, blur and full-screen spread are all configurable.
**Why it exists:** It is a cosmetic "glow" effect that matches the colour of the content.
**How it works:** This plugin is renderer-only ([index.ts](../../src/plugins/ambient-mode/index.ts)).
- `start()` finds `#song-image`, `#song-video`, `#song-image yt-img-shadow > img` and `#song-video > .player-wrapper`. It also awaits `waitForElement('.html5-video-container > video')` (lines 54-65).
- Image mode, `injectBlurImage` (lines 67-94): prepends an `<img class="html5-blur-image">` copy of the cover into `#song-image`.
- Video mode, `injectBlurVideo` (lines 96-199): prepends a `<canvas class="html5-blur-canvas">` into `.player-wrapper`.
  - Every `1000/buffer` ms it `drawImage`s the video at `quality` px wide.
  - It cross-fades with the previous frame through `globalAlpha`, which gives the interpolation.
  - The timer pauses and resumes on `#song-video` `pause`/`play`.
- `injectBlurElement` (lines 216-239) only injects when `#layout` has the `player-page-open` attribute.
  - It picks video or image mode from `getComputedStyle(#song-video).display`.
  - It skips the work if the source has not changed.
- A `MutationObserver` on `#player-page` attributes, plus a 1 s fallback `setInterval`, re-runs the injection (lines 242-256).
- `onConfigChange` updates the fields and calls `update()`, which sets the CSS custom properties `--width/--height/--blur/--opacity` and the `.fullscreen` class.
- [style.css](../../src/plugins/ambient-mode/style.css) applies the blur filter, centres the element absolutely (or makes it `position: fixed` full-viewport when `.fullscreen`), widens `#player`, and sets z-index fixes for `ytmusic-av-toggle` buttons and `#side-panel` (issue #2520).

**Config:**

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plugins.ambient-mode.enabled` | boolean | `false` | |
| `plugins.ambient-mode.quality` | number (px) | `50` | Canvas width in pixels |
| `plugins.ambient-mode.buffer` | number | `30` | Frames per second sampled (interval = 1000/buffer ms) |
| `plugins.ambient-mode.interpolationTime` | number (ms) | `1500` | Cross-fade smoothness |
| `plugins.ambient-mode.blur` | number (px) | `100` | CSS blur radius |
| `plugins.ambient-mode.size` | number (%) | `100` | Width/height of the glow |
| `plugins.ambient-mode.opacity` | number 0–1 | `1` | Glow opacity |
| `plugins.ambient-mode.fullscreen` | boolean | `false` | Canvas covers the whole viewport (`position: fixed`) |

`restartNeeded: false`.
**Menu:** Radio submenus for each setting ([menu.ts](../../src/plugins/ambient-mode/menu.ts)):

| Setting | Options |
|---|---|
| Smoothness transition | 0, 0.5, 1, 1.5, 2, 3, 4, 5 s |
| Quality | 10, 25, 50, 100, 200, 500, 1000 px |
| Size | 100–300% |
| Buffer | 1, 5, 10, 20, 30 |
| Opacity | 10–100% |
| Blur amount | 0–500 px |

There is also a "Use fullscreen" checkbox.
**Files:**
- [index.ts](../../src/plugins/ambient-mode/index.ts): logic.
- [menu.ts](../../src/plugins/ambient-mode/menu.ts): menu.
- [style.css](../../src/plugins/ambient-mode/style.css): blur and positioning.
- [types.ts](../../src/plugins/ambient-mode/types.ts): config type.

**IPC / events:** No IPC. Listens to DOM `pause`/`play` on `#song-video`.
**DOM anchors:**
- JS: `#song-image`, `#song-image yt-img-shadow > img`, `#song-video`, `#song-video > .player-wrapper`, `.html5-video-container > video`, `#player-page` (attributes), `#layout[player-page-open]`.
- CSS: `#player`, `.song-button.ytmusic-av-toggle`, `.video-button.ytmusic-av-toggle`, `#side-panel.side-panel.ytmusic-player-page`.

**New player bar (2026-10):** Unaffected. It only touches the player page and video/cover elements, which still exist.
**Gotchas:**
- `stop()` clears the 1 s interval and unregisters the current blur element. It does **not** disconnect the `MutationObserver` (a local in `start()`, line 242). A later attribute change on `#player-page` would call `injectBlurElement(true)` again after the plugin is disabled.
- Video mode reads frames with `getImageData` every tick (`willReadFrequently: true`), so it costs CPU in proportion to `buffer × quality`.

## Blur Navigation Bar (`blur-nav-bar`)
**What it does:** Makes the top navigation bar and sticky tab headers translucent black with an 8 px backdrop blur, and hides the nav-bar divider line.
**Why it exists:** Cosmetic. Content scrolls visibly behind a frosted nav bar.
**How it works:** This plugin is renderer-only.
- `start()` builds a `CSSStyleSheet` from [style.css](../../src/plugins/blur-nav-bar/style.css) and appends it to `document.adoptedStyleSheets` ([index.ts:14-22](../../src/plugins/blur-nav-bar/index.ts)). It does not use the `stylesheets` field.
- `stop()` empties that sheet with `replace('')` (line 24).

**Config:**

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plugins.blur-nav-bar.enabled` | boolean | `false` | The plugin has no `config` block. The loaders fall back to `{ enabled: false }` ([src/config/plugins.ts:16](../../src/config/plugins.ts), [src/loader/main.ts:25](../../src/loader/main.ts)). |

`restartNeeded: false`.
**Menu:** None.
**Files:**
- [index.ts](../../src/plugins/blur-nav-bar/index.ts): adopts or clears the sheet.
- [style.css](../../src/plugins/blur-nav-bar/style.css): the rules.

**IPC / events:** None.
**DOM anchors:** `#nav-bar-background`, `#header.ytmusic-item-section-renderer`, `ytmusic-tabs`, `ytmusic-tabs.stuck`, `#nav-bar-divider`.
**New player bar (2026-10):** Unaffected. It only touches the nav bar.
**Gotchas:** Because it manages its own sheet, it is one of the few plugins here whose CSS really goes away on runtime disable (see the loader gotcha above).

## Compact Sidebar (`compact-sidebar`)
**What it does:** Keeps YTM's left guide in its compact (icon-only) form.
**Why it exists:** It saves horizontal space by making the compact sidebar the permanent default.
**How it works:** This plugin is renderer-only ([index.ts](../../src/plugins/compact-sidebar/index.ts)).
- `isCompactSidebarDisabled()` is true when `#mini-guide` is missing or has computed `display: none` (lines 20-26).
- `start()`, `stop()` and `onConfigChange()` each click `document.querySelector('#button')` (the guide hamburger is the assumed target) when the compact sidebar is not showing (lines 27-41).

**Config:**

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plugins.compact-sidebar.enabled` | boolean | `false` | |

`restartNeeded: false`.
**Menu:** None.
**Files:** [index.ts](../../src/plugins/compact-sidebar/index.ts): the whole plugin.
**IPC / events:** None.
**DOM anchors:** `#mini-guide`, `#button` (first element in the document with that id).
**New player bar (2026-10):** Unaffected. It only touches the guide and hamburger.
**Gotchas:**
- `#button` is a generic id. The plugin clicks whichever element with that id comes first in the document.
- `stop()` uses the same condition as `start()`: it clicks only if the sidebar is **not** compact. Disabling the plugin therefore does not expand the sidebar back.
- It only checks once on start. It does not observe later layout changes.

## Clock (`clock`)
**What it does:** Shows the current time, centred in the top navigation bar. It can include seconds and switch between 12-hour and 24-hour format.
**Why it exists:** It shows the time when the app is fullscreen or covers the OS clock.
**How it works:** This plugin is renderer-only ([index.tsx](../../src/plugins/clock/index.tsx)).
- `start()` renders a Solid `<h1 class="clock">` into a `div` and appends it to `.center-content` (lines 85-94).
- `updateTime` formats `new Date().toLocaleTimeString('en', { hour12, hour, minute, second? })` (lines 69-78).
- A 1 s `setInterval` started inside `onMount` drives the updates (lines 81-83).
- `onConfigChange` updates the format flags and redraws immediately.
- `stop()` removes the container, clears its children and clears the interval.
- [style.css](../../src/plugins/clock/style.css) positions `.clock` absolutely at `left: 50%` with `translateX(-50%)`.

**Config:**

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plugins.clock.enabled` | boolean | `false` | |
| `plugins.clock.displaySeconds` | boolean | `false` | Show seconds |
| `plugins.clock.hour12` | boolean | `false` | 12-hour format. The menu shows the inverse, "24 hour format". |

`restartNeeded: false`.
**Menu:** A "Format" submenu with two checkboxes, "Display seconds" and "24 hour format".
**Files:**
- [index.tsx](../../src/plugins/clock/index.tsx): plugin and render.
- [style.css](../../src/plugins/clock/style.css): centring.
- [types.ts](../../src/plugins/clock/types.ts): config type.

**IPC / events:** None.
**DOM anchors:** `.center-content`. Core code addresses the same node as `.center-content.ytmusic-nav-bar` ([src/plugins/precise-volume/renderer.ts:86](../../src/plugins/precise-volume/renderer.ts)).
**New player bar (2026-10):** Unaffected. The clock lives in the nav bar.
**Gotchas:**
- The locale is hard-coded to `'en'`.
- `updateTime` is not called on start, so the clock is blank for the first second.
- The interval is created through `onMount`, which runs outside any Solid component or root. Whether it fires reliably in every build is unclear from the code.

## Transparent Player (`transparent-player`)
**What it does:** On Windows it gives the app window a Mica, Acrylic or Tabbed backdrop material and makes the page backgrounds semi-transparent or blurred, so the desktop shows through.
**Why it exists:** It produces a native Windows 11 translucent look.
**How it works:**
- `platform: Platform.Windows`, `restartNeeded: true` ([index.ts:24-25](../../src/plugins/transparent-player/index.ts)).
- **Backend (main):**
  - `start()` calls `window.setBackgroundMaterial(config.type)` and `setBackgroundColor('rgba(0, 0, 0, opacity)')` (lines 59-65).
  - `onConfigChange` only re-applies the material.
  - `stop()` sets the material to `'none'`.
- **Renderer:**
  - `start()` adds `body.transparent-background-color` and `body.transparent-player-backdrop-filter`.
  - It adds `body.transparent-player` too, but **only if album-color-theme is not enabled** (lines 79-91).
  - It sets `--ytmd-transparent-player-opacity` on `<html>`.
  - `stop()` removes the classes and the variable.
- **[style.css](../../src/plugins/transparent-player/style.css):**
  - `#111` at the configured opacity becomes the `body` background.
  - Backdrop blur is applied to `#nav-bar-background`, `#player-bar-background`, sticky search tabs, `ytmusic-menu-popup-renderer` and the in-app-menu title bar `#ytmd-title-bar-main-panel`.
  - Under `body.transparent-player`, the backgrounds of the following are cleared or dimmed: the nav and player-bar backgrounds (they go to opacity 0 when the player page is open), the guide, `ytmusic-player-bar`, `#player-page`, the browse page background/gradient, `nav[data-ytmd-main-panel]` and `.av-toggle.ytmusic-av-toggle`.

**Config:**

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plugins.transparent-player.enabled` | boolean | `false` | |
| `plugins.transparent-player.opacity` | number 0.1–1 | `0.5` | Page background alpha (`--ytmd-transparent-player-opacity`) and window background colour alpha |
| `plugins.transparent-player.type` | `'mica' \| 'acrylic' \| 'tabbed' \| 'none'` | `'acrylic'` | `BrowserWindow.setBackgroundMaterial` value ([types.ts](../../src/plugins/transparent-player/types.ts)) |

`restartNeeded: true`. Windows only.
**Menu:**
- "Opacity": a radio list from 10% to 100%.
- "Type": radio items mica, acrylic, tabbed and none.

**Files:**
- [index.ts](../../src/plugins/transparent-player/index.ts): backend and renderer.
- [style.css](../../src/plugins/transparent-player/style.css): transparency rules.
- [types.ts](../../src/plugins/transparent-player/types.ts): `MaterialType` enum and config type.

**IPC / events:** None of its own. It uses BrowserWindow APIs directly in main.
**DOM anchors:**
- `body`
- `#layout #nav-bar-background`, `#layout #player-bar-background`
- `#search-page #tabs.stuck`, `ytmusic-menu-popup-renderer`
- `#ytmd-title-bar-main-panel`, `nav[data-ytmd-main-panel]`
- `ytmusic-app-layout[player-page-open]`
- `#mini-guide-background`, `#guide #guide-wrapper`
- `ytmusic-player-bar`, `#player-page`
- `#browse-page #background`, `#browse-page .background-gradient`
- `.av-toggle.ytmusic-av-toggle`

**New player bar (2026-10):** Partially affected.
- Dead: `#layout ytmusic-player-bar { background: none }` (style.css:69). The new `ytmusic-miniplayer` keeps whatever background YouTube gives it, so the bottom bar may now show up opaque.
- Unverified: whether `#player-bar-background` still exists (style.css:20, 46, 53).
- Unaffected: the window material, the body background and the nav/guide/page rules.

**Gotchas:**
- Changing opacity at runtime updates the page variable but not the window `setBackgroundColor`. That only happens in backend `start`.
- `stop()` in main resets the material but not the background colour.
- The renderer checks `config.enabled` inside `start()`, so it is always true there.

## Unobtrusive Player (`unobtrusive-player`)
**What it does:** When you start a song from a list, by its play button or by "Shuffle play", the full player page is suppressed and you stay where you were. Clicking the player bar brings normal behaviour back.
**Why it exists:** YTM pops the player page open on every play, which interrupts browsing.
**How it works:** This plugin is renderer-only ([index.ts](../../src/plugins/unobtrusive-player/index.ts)).
- `start()` adds `body.unobtrusive-player` and a document `click` listener, `handlePlay` (lines 6-43). The listener does the following:
  - A click inside `ytmusic-player-bar`, while not auto-closing, removes `unobtrusive-player--did-play`.
  - A click on `ytmusic-play-button-renderer` outside `ytmusic-player-page` adds `--did-play`.
  - A click on a `ytmusic-menu-navigation-item-renderer` whose icon path starts with the first 15 characters of `iron-iconset-svg[name="yt-sys-icons"] #shuffle`'s `d` also adds `--did-play`.
- `onPlayerApiReady` listens to `videodatachange`. When `--did-play` is set and `ytmusic-app-layout[player-ui-state="PLAYER_PAGE_OPEN"]`, it adds `--auto-closing`, clicks `.toggle-player-page-button` to close the page, and removes `--auto-closing` after 500 ms (lines 45-67).
- [style.css](../../src/plugins/unobtrusive-player/style.css): while `--did-play` is set, it makes `ytmusic-player-page` and its descendants `visibility: hidden`, keeps `#content` visible, hides the nav/divider/mini-guide backgrounds when not scrolled, and rotates `.toggle-player-page-button` 180°.

**Config:**

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plugins.unobtrusive-player.enabled` | boolean | `false` | |

`restartNeeded: false`.
**Menu:** None.
**Files:**
- [index.ts](../../src/plugins/unobtrusive-player/index.ts): click and video-change handlers.
- [style.css](../../src/plugins/unobtrusive-player/style.css): hiding rules.

**IPC / events:** No IPC. It uses the DOM `click` (document) and `videodatachange` (document) events.
**DOM anchors:**
- JS: `ytmusic-player-bar` (via `closest`), `ytmusic-play-button-renderer`, `ytmusic-player-page`, `iron-iconset-svg[name="yt-sys-icons"] #shuffle`, `ytmusic-menu-navigation-item-renderer`, `ytmusic-app-layout[player-ui-state]`, `.toggle-player-page-button`.
- CSS: `ytmusic-player-page`, `#content`, `ytmusic-app-layout:not(.content-scrolled)`, `#nav-bar-background`, `#nav-bar-divider`, `#mini-guide-background`, `.toggle-player-page-button`.

**New player bar (2026-10):** Likely broken.
- `e.target.closest('ytmusic-player-bar')` (index.ts:11) no longer matches, so clicking the bar never clears `unobtrusive-player--did-play`. Once a song is started from a list, the player page stays `visibility: hidden` even when the user opens it on purpose. It also keeps being auto-closed on every track change.
- Unverified: whether `.toggle-player-page-button` (auto-close click and CSS rotation) still exists.
- Unaffected: the play-button and shuffle-menu triggers.

**Gotchas:**
- The class `content-scrolled` used in the CSS is set by in-app-menu ([TitleBar.tsx:305-313](../../src/plugins/in-app-menu/renderer/TitleBar.tsx)), not by YouTube. Without in-app-menu that part of the CSS may never apply.
- Shuffle detection depends on the SVG path data of YTM's icon set.

## Picture-in-picture (`picture-in-picture`)
**What it does:** It toggles PiP from a hotkey (default `P`), from a "Picture in picture" entry in the player song menu, or from the player page's minimize button. There are two modes:
- **Native** (default): Chromium's video PiP.
- **Window**: the main window shrinks to a small, always-on-top, all-workspaces window showing the player in fullscreen layout.

**Why it exists:** Keeps the video visible while you use other apps.
**How it works:**
- **Renderer** ([renderer.tsx](../../src/plugins/picture-in-picture/renderer.tsx), `onPlayerApiReady` only):
  - `togglePictureInPicture` (lines 25-43):
    - If `useNativePiP`, it calls `document.querySelector('video').requestPictureInPicture()` or `document.exitPictureInPicture()`. On success it clicks `#icon` to close the open menu.
    - On failure, or when native mode is off, it sends IPC `plugin:toggle-picture-in-picture`.
  - The hotkey is a `window` `keydown` listener that compares against `toKeyEvent(config.hotkey)`. It is ignored while `ytmusic-search-box.opened` is true (lines 45-57).
  - On `peard:pip-toggle(true)` (lines 92-111):
    - It rebinds `.exit-fullscreen-button` to toggle PiP and disables `#player.onDoubleClick_`.
    - It makes `mouseleave` on `#expanding-menu` click `.middle-controls`.
    - It opens the player page with `.toggle-player-page-button` if `ytmusic-player-page.playerPageOpen_` is false, then clicks `.fullscreen-button`.
    - It adds `ytmusic-app-layout.pip` and hides `nav[data-ytmd-main-panel]`.
  - `peard:pip-toggle(false)` reverses these steps (lines 112-128).
  - `.player-minimize-button` click → toggle PiP (line 132).
  - Menu entry (lines 134-172):
    - A `MutationObserver` on `ytmusic-popup-container` prepends a Solid-rendered item ([templates/picture-in-picture-button.tsx](../../src/plugins/picture-in-picture/templates/picture-in-picture-button.tsx)) into `getSongMenu()` (`ytmusic-menu-popup-renderer tp-yt-paper-listbox`).
    - It only does so when `isMusicOrVideoTrack()` and `isPlayerMenu(menu)` are true ([src/plugins/utils/renderer/check.ts](../../src/plugins/utils/renderer/check.ts)).
- **Backend** ([main.ts](../../src/plugins/picture-in-picture/main.ts)):
  - `onMainLoad` resets `isInPiP=false` and listens for `plugin:toggle-picture-in-picture`.
  - `togglePiP` (lines 25-86) does the following:
    - exits fullscreen or maximize and saves the original position and size
    - blocks `f` and turns `Escape` into "exit PiP" through `before-input-event`
    - disables maximizable/fullscreenable
    - sends `peard:pip-toggle`
    - calls `setVisibleOnAllWorkspaces(true)` and, if `alwaysOnTop`, `setAlwaysOnTop(true, 'screen-saver', 1)`
    - moves and resizes to `pip-position`/`pip-size` (or `[10,10]`/`[450,275]` when the save options are off)
    - on exit, restores everything
  - `move`/`resize` handlers persist `pip-position`/`pip-size` while in window-PiP (`isInPiP && !useNativePiP`).
- **[style.css](../../src/plugins/picture-in-picture/style.css)** applies under `ytmusic-app-layout.pip`:
  - drop-shadowed white text and icons on the player bar
  - a styled expanding menu
  - `#volumeHud` offset and drag regions under `.cet-container`
  - info, thumbnail and menu removed from the player bar
  - `.video-switch-button` hidden

**Config:**

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plugins.picture-in-picture.enabled` | boolean | `false` | |
| `plugins.picture-in-picture.alwaysOnTop` | boolean | `true` | Window-PiP is always on top |
| `plugins.picture-in-picture.savePosition` | boolean | `true` | Use the saved `pip-position` |
| `plugins.picture-in-picture.saveSize` | boolean | `false` | Use the saved `pip-size` |
| `plugins.picture-in-picture.hotkey` | Electron accelerator string | `'P'` | Toggle hotkey (empty disables it) |
| `plugins.picture-in-picture.pip-position` | `[x, y]` | `[10, 10]` | Saved window-PiP position |
| `plugins.picture-in-picture.pip-size` | `[w, h]` | `[450, 275]` | Saved window-PiP size |
| `plugins.picture-in-picture.isInPiP` | boolean | `false` | Runtime state, reset to false on main start |
| `plugins.picture-in-picture.useNativePiP` | boolean | `true` | Try Chromium video PiP first |

`restartNeeded: true`.
**Menu:** ([menu.ts](../../src/plugins/picture-in-picture/menu.ts)):
- "Always on top", "Save window position", "Save window size": checkboxes.
- "Hotkey": a checkbox that opens a `custom-electron-prompt` keybind dialog.
- "Use native PiP": a checkbox.

**Files:**
- [index.ts](../../src/plugins/picture-in-picture/index.ts): definition and config type.
- [main.ts](../../src/plugins/picture-in-picture/main.ts): window-PiP and IPC.
- [renderer.tsx](../../src/plugins/picture-in-picture/renderer.tsx): hotkey, DOM wiring, menu injection.
- [menu.ts](../../src/plugins/picture-in-picture/menu.ts): menu.
- [style.css](../../src/plugins/picture-in-picture/style.css): PiP-mode styling.
- [templates/picture-in-picture-button.tsx](../../src/plugins/picture-in-picture/templates/picture-in-picture-button.tsx): the menu item markup.
- `*.d.ts`: typings for `keyboardevent-from-electron-accelerator` and `keyboardevents-areequal`.
- [src/plugins/utils/renderer/check.ts](../../src/plugins/utils/renderer/check.ts): shared `isPlayerMenu` and `isMusicOrVideoTrack`.

**IPC / events:**
- Renderer to main: `plugin:toggle-picture-in-picture`.
- Main to renderer: `peard:pip-toggle` (boolean).
- DOM: `keydown` (window); `click` on the exit-fullscreen and minimize buttons; `mouseleave` on `#expanding-menu`.

**DOM anchors:**
- `video`, `#icon`, `ytmusic-search-box`
- `.exit-fullscreen-button`, `.player-minimize-button`, `ytmusic-app-layout`
- `#expanding-menu`, `.middle-controls`, `ytmusic-player-page`
- `.toggle-player-page-button`, `.fullscreen-button`, `#player`
- `nav[data-ytmd-main-panel]`, `ytmusic-popup-container`
- `ytmusic-menu-popup-renderer tp-yt-paper-listbox`, `tp-yt-paper-listbox #navigation-endpoint`
- `ytmusic-menu-renderer.ytmusic-player-bar` (in check.ts)
- CSS: `ytmusic-player-bar …`, `ytmusic-player-expanding-menu`, `#volumeHud`, `.cet-container`, `.video-switch-button`

**New player bar (2026-10):** Likely broken in part.
- Dead:
  - The "Picture in picture" song-menu entry is never injected. `isPlayerMenu` ([check.ts:54-56](../../src/plugins/utils/renderer/check.ts)) requires the menu's event sink to match `ytmusic-menu-renderer.ytmusic-player-bar`.
  - `.middle-controls` (renderer.tsx:67, the expanding-menu `mouseleave` helper).
  - All `ytmusic-player-bar` rules in style.css (lines 2-9, 24-26, 34-38). In window-PiP the new bar no longer gets the white/drop-shadow text, the no-drag region, or the hidden info/thumbnail/menu.
- Unverified: `.fullscreen-button`, `#expanding-menu`, `.toggle-player-page-button`, `.exit-fullscreen-button` and `.player-minimize-button`. Core [src/renderer.ts:200-202](../../src/renderer.ts) also still uses the fullscreen buttons. If `.fullscreen-button` is gone, window-PiP shrinks the window without switching the player to fullscreen layout.
- Unaffected: the hotkey and native PiP (the default), which use only `video`.

**Gotchas:**
- The DOM references are captured **once** in `onPlayerApiReady`. If `.exit-fullscreen-button` or `#player` is null at that moment, the whole `peard:pip-toggle` handler is a no-op.
- The menu's "Always on top" click calls `window.setAlwaysOnTop()` immediately, even when the app is not in PiP.
- `#icon` is a generic id; the code clicks whichever element with that id comes first in the document.
- `.cet-container` (style.css:19-31) is a custom-electron-titlebar class. The current in-app-menu renders `nav[data-ytmd-main-panel]` instead, so those rules are probably inert.
- `observer.observe(document.querySelector('ytmusic-popup-container')!)` throws if that element is missing.

## Video Toggle (`video-toggle`)
**What it does:** Has three modes:
- **custom** (default): adds a pill-shaped "Song / Video" switch over the player.
- **native**: forces YTM's own AV toggle on.
- **disabled**: removes the AV toggle.

"Force hide" removes the whole video/player panel so the side panel fills the page. On tracks without a video (ATV) the custom switch is hidden and song mode is forced.
**Why it exists:** It gives an easy way to choose cover art or the music video, or to hide the video entirely. It also replaces the legacy `hide-video-player` plugin ([src/config/store.ts:183-185](../../src/config/store.ts) migrates it).
**How it works:** This plugin is renderer-only ([index.tsx](../../src/plugins/video-toggle/index.tsx)).
- `applyStyleClass` adds `body.video-toggle-force-hide` or `body.video-toggle-custom-mode` (lines 111-119).
- `start()` returns early when forceHide is set. In **native** mode it sets the `has-av-switcher` attribute on `ytmusic-player-page`/`ytmusic-player` and removes `toggle-disabled` from `ytmusic-av-toggle`. **Disabled** mode does the reverse (lines 120-155).
- `onPlayerApiReady` (custom mode) renders `VideoSwitchButton` ([templates/video-switch-button.tsx](../../src/plugins/video-toggle/templates/video-switch-button.tsx)) into `#ytmd-video-toggle-switch-button-container`. In a `setTimeout(0)` it then (lines 316-348):
  - prepends the container to `#player`
  - applies `setVideoState(!hideVideo)`
  - starts `forcePlaybackMode()`
  - sets `video.style.height='auto'`
  - listens to `peard:src-changed` on `video`
  - observes `#song-image #img` `src`
  - aligns the container by `align`
- `setVideoState(show)` (lines 203-235) does the following:
  - persists `hideVideo` through `window.mainConfig.plugins.setOptions`
  - syncs the checkbox
  - sets `ytmusic-player[playback-mode]` to `OMV_PREFERRED` or `ATV_PREFERRED`
  - toggles `#song-video.ytmusic-player` and `#song-image` display, and centres `video.style.top`
  - calls precise-volume's `moveVolumeHud` ([src/plugins/precise-volume/renderer.ts:14](../../src/plugins/precise-volume/renderer.ts)) if that plugin is enabled
- `videoStarted` (lines 237-268):
  - For `MUSIC_VIDEO_TYPE_ATV` it forces song mode and hides the button.
  - Otherwise it swaps `#song-image` to the highest-resolution thumbnail (`forceThumbnail`, query string stripped), shows the button, and re-shows the video if it is hidden while `hideVideo` is false.
- `forcePlaybackMode` re-forces `ATV_PREFERRED` once after YTM overrides it, then disconnects (lines 274-291).
- `observeThumbnail` replaces `data:` placeholder thumbnails while `player.videoMode_` is set (lines 293-314).
- CSS:
  - [button-switcher.css](../../src/plugins/video-toggle/button-switcher.css): switch styling, and hides the native `#av-id` in custom mode.
  - [force-hide.css](../../src/plugins/video-toggle/force-hide.css): hides `#main-panel` and makes `.side-panel.ytmusic-player-page` full width.

**Config:**

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plugins.video-toggle.enabled` | boolean | `false` | |
| `plugins.video-toggle.hideVideo` | boolean | `false` | Persisted switch state (true = song/cover mode) |
| `plugins.video-toggle.mode` | `'custom' \| 'native' \| 'disabled'` | `'custom'` | Which toggle to use |
| `plugins.video-toggle.forceHide` | boolean | `false` | Hide the whole player panel |
| `plugins.video-toggle.align` | `'left' \| 'middle' \| 'right'` | `'left'` | Custom switch alignment |

`restartNeeded: true`.
**Menu:**
- "Mode": radio items custom, native and disabled.
- "Alignment": radio items left, middle and right.
- "Force hide": a checkbox.

**Files:**
- [index.tsx](../../src/plugins/video-toggle/index.tsx): logic and menu.
- [templates/video-switch-button.tsx](../../src/plugins/video-toggle/templates/video-switch-button.tsx): the switch markup.
- [button-switcher.css](../../src/plugins/video-toggle/button-switcher.css): custom-mode styles.
- [force-hide.css](../../src/plugins/video-toggle/force-hide.css): force-hide styles.

**IPC / events:**
- No IPC channels.
- Listens to the DOM `peard:src-changed` event on `video` (dispatched by [src/providers/song-info-front.ts:29](../../src/providers/song-info-front.ts) on `dataloaded`).
- Writes config through `window.mainConfig.plugins.setOptions('video-toggle', …)`.

**DOM anchors:**
- `ytmusic-player-page`, `ytmusic-player` (`videoMode_`, `playback-mode`), `ytmusic-av-toggle`
- `video`, `#player`
- `#song-video.ytmusic-player`, `#song-image`, `#song-image #img.style-scope.yt-img-shadow`
- `.video-switch-button-checkbox`
- CSS: `#main-panel`, `#main-panel.ytmusic-player-page`, `.side-panel.ytmusic-player-page`, `#av-id`

**New player bar (2026-10):** Unaffected. There are no player-bar selectors, and its anchors were verified live as still present.
**Gotchas:**
- `onConfigChange` only re-applies the body class. Mode and alignment changes need a restart.
- `applyStyleClass` never removes `video-toggle-custom-mode` when switching to native or disabled. The class only changes on reload.
- `setVideoState` uses non-null assertions on `#song-video.ytmusic-player` and `#song-image`, and `observeThumbnail` does the same on `#song-image #img…`. Each throws if the node is missing.
- picture-in-picture hides `.video-switch-button` while in PiP.

## In-App Menu (`in-app-menu`)
**What it does:** Replaces the native window frame and menu with an HTML title bar at the top of the page. The bar has a hamburger button that collapses or expands the menu, the app's full menu tree rendered as dropdown panels, and (on Linux) its own minimize/maximize/close buttons. The backtick key toggles the menu.
**Why it exists:** It gives a dark title bar that matches the theme (album-color-theme tints it through `--ytmusic-color-black3`), instead of the OS frame.
**How it works:**
- **Window creation** ([src/index.ts:327-340](../../src/index.ts)): when the plugin is enabled, the main window is created with `frame: false` (non-macOS) and `titleBarStyle: 'hidden'`. That is why `restartNeeded: true`.
- **Backend** ([main.ts](../../src/plugins/in-app-menu/main.ts), `backend: onMainLoad`):
  - On window `close` it sends `close-all-in-app-menu-panel`.
  - On `ready-to-show` it registers the local shortcut `` ` `` (via `electron-localshortcut`), which sends `toggle-in-app-menu`.
  - It handles `get-menu`, which serialises `Menu.getApplicationMenu()` without `commandsMap`/`menu`.
  - It handles `get-menu-by-id` (breadth-first search by `commandId`).
  - It registers `ipcMain.handle('peard:menu-event')` directly, not through the ctx. This calls the matched `MenuItem.click`.
  - It handles `window-is-maximized`, `window-close`, `window-minimize`, `window-maximize`, `window-unmaximize` and `image-path-to-data-url`.
  - It forwards `maximize`/`unmaximize` window events as `window-maximize`/`window-unmaximize`.
- **Renderer** ([renderer.tsx](../../src/plugins/in-app-menu/renderer.tsx)):
  - `start` (`onRendererLoad`) sets `document.title = APPLICATION_NAME` and adopts a small scrollbar sheet.
  - It renders `<TitleBar>` into `document.body`. `enableController` is set only on non-Windows, non-macOS systems without `hideDOMWindowControls`. `initialCollapsed` comes from `options.hideMenu`.
  - `onPlayerApiReady` is a no-op; its body is commented out with "NOT WORKING AFTER YTM UPDATE".
- **[TitleBar.tsx](../../src/plugins/in-app-menu/renderer/TitleBar.tsx)**:
  - It renders `nav#ytmd-title-bar-main-panel[data-ytmd-main-panel]`. The nav is fixed at the top with height `--menu-bar-height` and is draggable.
  - It fetches the menu and listens to `close-all-in-app-menu-panel`, `refresh-in-app-menu` and `toggle-in-app-menu`.
  - Clicking an item invokes `peard:menu-event`. The item, or its whole radio group, is then re-fetched with `get-menu-by-id` (lines 217-263).
  - A click outside the nav or `ul[data-ytmd-sub-panel]` closes the open panel.
  - It tracks the mouse Y position. In YTM fullscreen the bar slides away unless the mouse is in the top 32 px (lines 60-63, 330).
  - It adds or removes `content-scrolled` on `#layout` when scrolled more than 20 px (lines 305-313).
  - Panels use `@floating-ui` ([Panel.tsx](../../src/plugins/in-app-menu/renderer/Panel.tsx)). Items render checkbox, radio, submenu and tooltip types ([PanelItem.tsx](../../src/plugins/in-app-menu/renderer/PanelItem.tsx)).
- **[titlebar.css](../../src/plugins/in-app-menu/titlebar.css)**:
  - Defines `--menu-bar-height: 32px` and `--titlebar-background-color`.
  - Pushes the layout, nav bar, guide spacers and player page down by the menu-bar height.
  - Sets the player page height to `calc(100vh - --menu-bar-height - --ytmusic-nav-bar-height - --ytmusic-player-bar-height)` (lines 57-63).
  - Includes a mini-player side-panel transform fix and a fullscreen negative margin.

**Config:**

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plugins.in-app-menu.enabled` | boolean | `true` on Windows; `false` on macOS and Linux | Computed in [constants.ts:6-13](../../src/plugins/in-app-menu/constants.ts) from the user agent or `process.platform` |
| `plugins.in-app-menu.hideDOMWindowControls` | boolean | `false` | Hide the HTML min/max/close buttons (only relevant on Linux) |

`restartNeeded: true`. The core also reads `options.hideMenu` for the initial collapsed state.
**Menu:**
- On Linux: a "Hide DOM window controls" checkbox.
- Elsewhere: no items ([menu.ts](../../src/plugins/in-app-menu/menu.ts)).

**Files:**
- [index.ts](../../src/plugins/in-app-menu/index.ts): definition.
- [constants.ts](../../src/plugins/in-app-menu/constants.ts): config type and platform default.
- [main.ts](../../src/plugins/in-app-menu/main.ts): IPC handlers and shortcut.
- [menu.ts](../../src/plugins/in-app-menu/menu.ts): Linux option.
- [renderer.tsx](../../src/plugins/in-app-menu/renderer.tsx): mounts the TitleBar.
- [renderer/TitleBar.tsx](../../src/plugins/in-app-menu/renderer/TitleBar.tsx): the bar.
- [renderer/Panel.tsx](../../src/plugins/in-app-menu/renderer/Panel.tsx): floating dropdown.
- [renderer/PanelItem.tsx](../../src/plugins/in-app-menu/renderer/PanelItem.tsx): menu rows.
- [renderer/MenuButton.tsx](../../src/plugins/in-app-menu/renderer/MenuButton.tsx): top-level item.
- [renderer/IconButton.tsx](../../src/plugins/in-app-menu/renderer/IconButton.tsx): icon button.
- [renderer/WindowController.tsx](../../src/plugins/in-app-menu/renderer/WindowController.tsx): min/max/close.
- [titlebar.css](../../src/plugins/in-app-menu/titlebar.css): layout offsets.

**IPC / events:**
- Renderer to main (invoke): `get-menu`, `get-menu-by-id`, `peard:menu-event`, `window-is-maximized`, `window-close`, `window-minimize`, `window-maximize`, `window-unmaximize`. `image-path-to-data-url` is handled in main, but no caller exists in this plugin's renderer files, so its use is unclear from the code.
- Main to renderer:
  - `close-all-in-app-menu-panel`, `toggle-in-app-menu`, `window-maximize`, `window-unmaximize`
  - `refresh-in-app-menu`, which is sent by core [src/menu.ts:63](../../src/menu.ts) and [src/loader/menu.ts:37](../../src/loader/menu.ts)
- DOM: `click` on `body`, `mousemove` on `window`, `scroll` on `#layout`.

**DOM anchors:**
- JS: `document.body`, `#layout`, `nav[data-ytmd-main-panel]`, `ul[data-ytmd-sub-panel]`.
- CSS:
  - `ytmusic-app-layout`, `ytmusic-app-layout#layout`, `ytmusic-app-layout > #content`
  - `[slot='nav-bar']`, `[slot='player-page']`
  - `#nav-bar-background`, `#nav-bar-divider`
  - `#guide-spacer`, `#mini-guide-spacer`, `ytmusic-guide-renderer`
  - `ytmusic-player-page[is-mweb-modernization-enabled] .side-panel`
  - `ytmusic-browse-response .ytmusic-responsive-list-item-renderer`
  - `ytmusic-player[player-ui-state='FULLSCREEN']`
  - `ytmusic-app:has(ytmusic-player[player-ui-state='FULLSCREEN'])`

**New player bar (2026-10):** Unaffected by selectors. There is one caveat: titlebar.css:61 uses `var(--ytmusic-player-bar-height)` and line 73 uses `var(--ytmusic-player-page-player-bar-height)`, both unverified. If YouTube dropped either variable, the enclosing `calc()` becomes invalid and that declaration (player-page height, mini-player side-panel transform) stops applying.
**Gotchas:**
- Other plugins depend on it:
  - `--menu-bar-height` (album-color-theme)
  - `#ytmd-title-bar-main-panel` and `nav[data-ytmd-main-panel]` (transparent-player, picture-in-picture)
  - the `content-scrolled` class (unobtrusive-player)
- The adopted `scrollStyle` sets `html::-webkit-scrollbar { background-color: red }` (renderer.tsx:11-15).
- `peard:menu-event` is registered on the raw `ipcMain`, so it is not removed via the plugin context.

## Navigation (`navigation`)
**What it does:** Adds browser-style back and forward arrow buttons, with tooltips, at the start of the nav bar's right-hand area.
**Why it exists:** The Electron app has no browser chrome, so there is no other way to go back or forward.
**How it works:** This plugin is renderer-only ([index.tsx](../../src/plugins/navigation/index.tsx)).
- `start()` uses Solid to render two `mdui-tooltip > mdui-button-icon` buttons with `@mdui/icons` chevrons (via `LitElementWrapper`) into a `div`. The buttons call `history.back()` and `history.forward()` (lines 25-51).
- It then prepends the div to `#right-content` (lines 52-53).
- `stop()` removes the container.

**Config:**

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plugins.navigation.enabled` | boolean | `true` | |

`restartNeeded: false`.
**Menu:** None.
**Files:** [index.tsx](../../src/plugins/navigation/index.tsx): the whole plugin.
**IPC / events:** None.
**DOM anchors:** `#right-content`.
**New player bar (2026-10):** Unaffected. The buttons live in the nav bar.
**Gotchas:** `stop()` only detaches the container. It neither disposes the Solid render nor clears the children. A later `start()` renders into the same container again, which may duplicate the arrows (unverified).
