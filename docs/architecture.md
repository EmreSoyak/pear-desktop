# Architecture (core)

The core of the app, everything outside `src/plugins/`, as read from the code on 2026-10-01. Every claim cites `path:line`, and the links are relative to `docs/`. Plugin internals are covered under [plugins/](plugins/). Custom (non-upstream) features are only pointed to here; see the [custom features](#custom-non-upstream-features-touching-core) list.

Stack: Electron, electron-vite (3 builds: main, preload, renderer), electron-builder, TypeScript, SolidJS (plugin UI), i18next, electron-store, and pnpm. `package.json` name `youtube-music` v3.11.0, `"type": "module"`, main `./dist/main/index.js`.

---

## Process model and boot sequence

| Process | Entry | Built as | Role |
|---|---|---|---|
| Main | [src/index.ts](../src/index.ts) | ES lib → `dist/main` ([electron.vite.config.mts:40-49](../electron.vite.config.mts#L40)) | App lifecycle, window, menu, tray, config store, main-side plugins (`backend`), song-info aggregation |
| Preload | [src/preload.ts](../src/preload.ts) | CJS → `dist/preload/preload.cjs` ([electron.vite.config.mts:67-79](../electron.vite.config.mts#L67)) | Preload plugins, `contextBridge` exposures, injects the renderer bundle |
| Renderer (page) | [src/renderer.ts](../src/renderer.ts) | IIFE → `dist/renderer` ([electron.vite.config.mts:101-111](../electron.vite.config.mts#L101)) | Runs **inside music.youtube.com**: renderer plugins, player-API control, DOM observers ([song-info-front](#song-info-frontts-renderer)) |

There is a single `BrowserWindow`. It uses `contextIsolation: true` and `sandbox: false` (sandbox is on only under tests), and the preload is `../preload/preload.cjs` ([src/index.ts:360-370](../src/index.ts#L360)).

**[src/index.html](../src/index.html) is never loaded as a page.** It exists only so the renderer build has an entry ([index.html:1-14](../src/index.html#L1)). At runtime, main reads `dist/renderer/index.html`, finds the `<script src>`, and returns the script text through the sync IPC `get-renderer-script` ([src/index.ts:714-760](../src/index.ts#L714)). In dev, it instead returns a loader for the Vite dev server (`/@vite/client` plus `/renderer.ts`). The preload executes that text with `webFrame.executeJavaScript[InIsolatedWorld]` and then **busy-waits** (`while (blocked);`) until it has run ([src/preload.ts:87-109](../src/preload.ts#L87)).

### Main boot timeline

| # | When | What | Where |
|---|---|---|---|
| 1 | Module load | `electron-unhandled` (no dialog); `autoUpdater.autoDownload = false` | [index.ts:68-75](../src/index.ts#L68) |
| 2 | Module load | **Single-instance lock**: `app.exit()` if not acquired | [index.ts:77-80](../src/index.ts#L77) |
| 3 | Module load | `http`/`https` registered privileged (bypassCSP, CORS, fetch, stream...) | [index.ts:82-108](../src/index.ts#L82) |
| 4 | Module load | Chromium switches: `ozone-platform-hint=auto`, enable `OverlayScrollbar,SharedArrayBuffer,UseOzonePlatform,WaylandWindowDecorations`, disable `FluentScrollbar`; `disableHardwareAcceleration()` if `options.disableHardwareAcceleration` | [index.ts:111-128](../src/index.ts#L111) |
| 5 | Module load (top-level await) | Linux: WM_CLASS name; disable `MediaSessionService` if `shortcuts` is enabled | [index.ts:130-140](../src/index.ts#L130) |
| 6 | Module load (top-level await) | **Proxy**: if `options.proxy` is set, use `socks5://host:port` from `auth-proxy-adapter` when that plugin is enabled, else `options.proxy` → `--proxy-server` | [index.ts:142-161](../src/index.ts#L142) |
| 7 | Module load | `electron-debug` (no auto DevTools); icon chosen per platform; `peard:get-main-plugin-names` handler | [index.ts:164-183](../src/index.ts#L164) |
| 7a | Import side effects | Config store created with migrations ([store.ts:270-277](../src/config/store.ts#L270)); `menu.ts` top-level await `inAppMenuActive` ([menu.ts:32](../src/menu.ts#L32)) | |
| 8 | `app.whenReady` | Default `options.language` from `app.getLocale()` if a resource exists; `loadI18n` + `setLanguage` | [index.ts:640-651](../src/index.ts#L640) |
| 9 | whenReady | `autoResetAppCache` → clear cache after 20 s | [index.ts:653-666](../src/index.ts#L653) |
| 10 | whenReady (Windows) | AppUserModelId `com.github.th-ch.youtube-music` + Start Menu shortcut create/update (skipped in dev or portable) | [index.ts:669-712](../src/index.ts#L669) |
| 11 | whenReady | Register `get-renderer-script` (sync) | [index.ts:714-760](../src/index.ts#L714) |
| 12 | `createMainWindow()` | Reads `window-size/-maximized/-position`; `in-app-menu` decides frame/titleBar; `new BrowserWindow` (`show:false`, min 325×425) | [index.ts:323-374](../src/index.ts#L323) |
| 12a | ↳ fires synchronously inside `new BrowserWindow` | `app.once('browser-window-created')`: **user-agent override** (`options.overrideUserAgent`, original UA restored for accounts.google.com retries), **`setupSongInfo(win)`**, **`setupAppControls()`**, `did-fail-load` → `log` + `error.html`, `will-prevent-unload` blocked, `customWindowTitle` | [index.ts:527-616](../src/index.ts#L527) |
| 13 | createMainWindow | `initHook(win)`: `peard:get-config` / `peard:set-config` handlers and the `config.watch` that drives runtime plugin enable/disable | [index.ts:185-250](../src/index.ts#L185), [:376](../src/index.ts#L376) |
| 14 | createMainWindow | `initTheme`: inject `music-player.css` and the user CSS files in `options.themes` | [index.ts:294-321](../src/index.ts#L294), [:377](../src/index.ts#L377) |
| 15 | createMainWindow | **`loadAllMainPlugins(win)`**, before menu and tray | [index.ts:379](../src/index.ts#L379) |
| 16 | createMainWindow | Restore position (offscreen check, Windows DPI scale) / maximize / alwaysOnTop | [index.ts:381-425](../src/index.ts#L381) |
| 17 | createMainWindow | **Window-state persistence**: `move`/`resize` → `lateSave` (600 ms debounce) to `window-position`/`window-size`; `window-maximized` saved immediately | [index.ts:432-477](../src/index.ts#L432) |
| 18 | createMainWindow | `render-process-gone` → unresponsive dialog; `ready-to-show` → `show()` if `options.appVisible` | [index.ts:479-487](../src/index.ts#L479) |
| 19 | createMainWindow | **CSP removal** (`removeContentSecurityPolicy`): strips CSP headers on https responses and adds `access-control-allow-origin: https://music.youtube.com` when absent; uses `electron-better-web-request` so plugins (e.g. adblocker) can add more `onHeadersReceived` listeners | [index.ts:489](../src/index.ts#L489), [:933-982](../src/index.ts#L933) |
| 20 | createMainWindow | `dom-ready` (title-bar overlay height × zoom); `will-redirect` `/premium` → Google login workaround | [index.ts:491-516](../src/index.ts#L491) |
| 21 | createMainWindow | **`forceEnglishInterface(session)`** (PREF cookie `hl=en`, errors swallowed), then `loadURL(resumeOnStart ? config.url : default url)` | [index.ts:427-429](../src/index.ts#L427), [:518-522](../src/index.ts#L518) |
| 22 | whenReady | `setApplicationMenu` (runs `loadAllMenuPlugins`) then `refreshMenu` | [index.ts:763-764](../src/index.ts#L763) |
| 23 | whenReady | **`setUpTray(app, mainWindow)`**, after main plugins, so the tray applies their queued handlers | [index.ts:765](../src/index.ts#L765), [tray.ts:191-207](../src/tray.ts#L191) |
| 24 | whenReady | `setupProtocolHandler`; `second-instance` → protocol command (`youtubemusic://cmd args`) or restore/show (virtual-desktop aware) | [index.ts:767-804](../src/index.ts#L767) |
| 25 | whenReady | Login item (`startAtLogin`); **auto-updater** (not dev, `autoUpdates`): check after 2 s, dialog with OK / Download (opens releases page) / Disable | [index.ts:807-860](../src/index.ts#L807) |
| 26 | whenReady | One-time hide-menu warning; macOS dock hide; with tray or on macOS, `close` hides instead of quitting (until `before-quit`) | [index.ts:862-889](../src/index.ts#L862) |

Other app events: `window-all-closed` quits (except macOS) and unregisters global shortcuts ([index.ts:618-625](../src/index.ts#L618)). `activate` re-creates or shows the window ([index.ts:627-635](../src/index.ts#L627)). Re-creating it calls `initHook` again, which re-registers the `peard:get-config`/`set-config` handlers (Electron's `ipcMain.handle` throws on a duplicate).

### Preload ([src/preload.ts](../src/preload.ts))

| Line | Action |
|---|---|
| [19](../src/preload.ts#L19) | Stubs `globalThis.customElements` in the isolated world |
| [21-39](../src/preload.ts#L21) | Removes YouTube's `custom-elements-es5-adapter.js` script once |
| [41-44](../src/preload.ts#L41) | `loadI18n` → `setLanguage` → `loadAllPreloadPlugins()` |
| [46-51](../src/preload.ts#L46) | `plugin:unload` / `plugin:enable` → force (un)load preload plugin |
| [53-85](../src/preload.ts#L53) | `contextBridge`: `window.mainConfig` (the whole `@/config` module, so the page reads config **synchronously**), `window.electronIs`, `window.ipcRenderer` (`on/off/once/send/removeListener/removeAllListeners/invoke/sendSync/sendToHost`), `window.reload()` (→ `peard:reload`), `window.ELECTRON_RENDERER_URL` |
| [87-109](../src/preload.ts#L87) | Fetches and executes the renderer bundle, then busy-waits |

Global typings for these live in [src/reset.d.ts:11-42](../src/reset.d.ts#L11).

### Renderer boot timeline ([src/renderer.ts](../src/renderer.ts))

Entry chain: `initObserver().then(preload).then(main)` ([renderer.ts:586](../src/renderer.ts#L586)).

| # | Step | Where |
|---|---|---|
| R1 | Module top: `setTheme('dark')` (mdui), register the default Trusted Types policy | [renderer.ts:39-46](../src/renderer.ts#L39) |
| R2 | `initObserver`: wait for `DOMContentLoaded`, then a `MutationObserver` on the document waits for **`#movie_player`** (the player API element) | [renderer.ts:542-584](../src/renderer.ts#L542) |
| R3 | `preload()`: i18n + `window.i18n.t`, defines the `<pear-trans key>` element | [renderer.ts:468-495](../src/renderer.ts#L468) |
| R4 | `main()`: `await loadAllRendererPlugins()` (sequential) → `isPluginLoaded = true`; listeners `plugin:unload`, `plugin:enable` (also calls `onPlayerApiReady` if the API already exists), `config-changed` → `renderer.onConfigChange` | [renderer.ts:497-526](../src/renderer.ts#L497) |
| R5 | `main()`: `listenForApiLoad()` (picks up `#movie_player` if it is already there); `window._lact = Date.now()` every 15 min (blocks "Are you still there?"); dev-only `log` listener | [renderer.ts:529-539](../src/renderer.ts#L529) |
| R6 | Observer finds `#movie_player`: **`setupSongInfo(playerApi)`** ([song-info-front](#song-info-frontts-renderer)), records the first `dataloaded`, and calls `onApiLoaded()` if plugins are loaded | [renderer.ts:554-577](../src/renderer.ts#L554) |
| R7 | **`onApiLoaded()`**: `data-os` attribute; registers **all song-control IPC listeners** (`peard:play`, `peard:next-video`, queue, search, ...). Commands sent before this point are dropped | [renderer.ts:59-356](../src/renderer.ts#L59) |
| R8 | Creates one `AudioContext` + `MediaElementSource(video)` → destination | [renderer.ts:358-361](../src/renderer.ts#L358) |
| R9 | Calls **`renderer.onPlayerApiReady(api, ctx)`** for every loaded renderer plugin | [renderer.ts:363-371](../src/renderer.ts#L363) |
| R10 | Re-dispatches a synthetic `videodatachange` `{name:'dataloaded'}` on `document` if data already loaded (so late plugins see it) | [renderer.ts:373-377](../src/renderer.ts#L373) |
| R11 | **`peard:audio-can-play`** CustomEvent on `document` with `{audioContext, audioSource}`: immediately if `readyState === 4`, and on every `loadstart` → first `canplaythrough` | [renderer.ts:379-401](../src/renderer.ts#L379) |
| R12 | `ipcRenderer.send('peard:player-api-loaded')`. Main-side plugins use it to send `peard:setup-*-listener` | [renderer.ts:403](../src/renderer.ts#L403) |
| R13 | `options.startingPage` navigation; CSS for `removeUpgradeButton`, `likeButtons` (`hide`/`force`), `swapLikeButtonsOrder` (selectors cover both old bar and `ytmusic-miniplayer`) | [renderer.ts:405-465](../src/renderer.ts#L405) |

### Player bar layouts (2026-10-01)

YouTube replaced `ytmusic-player-bar` with **`ytmusic-miniplayer`** on 2026-10-01. The same day, `renderer.ts` and `song-info-front.ts` were changed to prefer the new layout through the helpers in [dom-elements.ts](#dom-elementsts), with the old bar as a fallback. Pattern used throughout [renderer.ts:98-226](../src/renderer.ts#L98):

1. If the legacy element (`ytmusic-player-bar`, `#like-button-renderer`) exists, call its Polymer method (`queue.shuffle()`, `onRepeatButtonClick()`, `updateVolume()`, `onVolumeClick()`, `updateLikeStatus()`).
2. Otherwise click the new control (`getPlayerControl`, `getLikeButton`, `getMuteButton`), or drive the volume slider through the native `value` setter plus `input`/`change` events ([renderer.ts:166-178](../src/renderer.ts#L166)).
3. State reads (shuffle, fullscreen) come from the app store (`getAppStore().getState()`) first, then legacy attributes ([renderer.ts:109-119](../src/renderer.ts#L109), [:181-191](../src/renderer.ts#L181)).

Quirks noted in code: the new repeat button ignores a second click in the same task, so `peard:switch-repeat` yields between clicks ([renderer.ts:150-154](../src/renderer.ts#L150)). The new like/dislike buttons are toggles, so they are clicked only when `aria-pressed !== 'true'` ([renderer.ts:135-140](../src/renderer.ts#L135)). Details: [player-bar.md](player-bar.md).

### DOM events (not IPC)

| Event | Target | Detail | Dispatched at | Consumers |
|---|---|---|---|---|
| `videodatachange` | `document` | `{name: 'dataloaded'\|'dataupdated', videoData}` (`VideoDataChanged`) | [song-info-front.ts:345-354](../src/providers/song-info-front.ts#L345) (re-emitted from player API), synthetic at [renderer.ts:373-377](../src/renderer.ts#L373) | many renderer plugins |
| `peard:audio-can-play` | `document` | `{audioContext, audioSource}` | [renderer.ts:379-401](../src/renderer.ts#L379) | audio-compressor, custom-output-device, equalizer, skip-silences, visualizer |
| `peard:src-changed` | `<video>` | none | [song-info-front.ts:29](../src/providers/song-info-front.ts#L29), [:379](../src/providers/song-info-front.ts#L379) on `dataloaded` | captions-selector, playback-speed, precise-volume, video-toggle |

Typed in [src/reset.d.ts:17-20](../src/reset.d.ts#L17) (`peard:src-changed` is not typed there).

---

## Plugin system

### Discovery (build time)

| File | Role |
|---|---|
| [vite-plugins/plugin-importer.mts](../vite-plugins/plugin-importer.mts) | Generates `virtual:plugins` per build. Globs `src/plugins/*/index.{js,ts,jsx,tsx}` and `src/plugins/*.{js,ts,jsx,tsx}`, excluding `src/plugins/utils` ([:25-30](../vite-plugins/plugin-importer.mts#L25)). **Plugin id = folder name** (or file basename) ([:31-43](../vite-plugins/plugin-importer.mts#L31)). Main uses dynamic `import()`; preload/renderer use static imports ([:51-73](../vite-plugins/plugin-importer.mts#L51)). Exports `<mode>Plugins()` (only plugins that have the `backend`/`preload`/`renderer` key, [:95-101](../vite-plugins/plugin-importer.mts#L95)) and `allPlugins()` (stubs) ([:111-129](../vite-plugins/plugin-importer.mts#L111)), cached and filtered by `supportsPlatform` (bit flags, [:138-150](../vite-plugins/plugin-importer.mts#L138)) |
| [vite-plugins/plugin-loader.mts](../vite-plugins/plugin-loader.mts) | Transforms each plugin entry with ts-morph. Finds `export default {…}` or `export default createPlugin({…})` with a **literal object argument** ([:58-113](../vite-plugins/plugin-loader.mts#L58)). Removes the other contexts' keys from this build (backend keeps `menu`) ([:124-132](../vite-plugins/plugin-loader.mts#L124)), then appends `export const pluginStub` = the object without `backend/preload/renderer` (the backend stub keeps `menu`, which is how [loader/menu.ts](../src/loader/menu.ts) gets `plugin.menu` from `allPlugins()`) ([:134-164](../vite-plugins/plugin-loader.mts#L134)). If the default export is not literal, nothing is transformed and no `pluginStub` exists |
| [vite-plugins/i18n-importer.mts](../vite-plugins/i18n-importer.mts) | Generates `virtual:i18n` → `languageResources()` from `src/i18n/resources/*.json` ([:17-41](../vite-plugins/i18n-importer.mts#L17)) |
| [src/virtual-module.d.ts](../src/virtual-module.d.ts) | Types for `virtual:plugins` (`mainPlugins/preloadPlugins/rendererPlugins/allPlugins`) and `virtual:i18n` |

Wired in [electron.vite.config.mts:28-34](../electron.vite.config.mts#L28) (main: `pluginLoader('backend')` + `pluginVirtualModuleGenerator('main')`), [:60-65](../electron.vite.config.mts#L60) (preload) and [:90-98](../electron.vite.config.mts#L90) (renderer, plus Solid).

### Plugin shape (`createPlugin`)

`createPlugin(def)` is an identity function for typing ([src/utils/index.ts:20-36](../src/utils/index.ts#L20)). Helpers `createBackend/createPreload/createRenderer` do the same for split files ([:38-67](../src/utils/index.ts#L38)). The shape is `PluginDef` ([src/types/plugins.ts:48-82](../src/types/plugins.ts#L48)):

| Field | Type | Meaning |
|---|---|---|
| `name` | `() => string` | Display name, normally `t('plugins.<id>.name')` |
| `description?` | `() => string` | Menu tooltip |
| `authors?`, `addedVersion?` | `string[]`, semver range | "New" sublabel when `satisfies(appVersion, addedVersion)` ([menu.ts:81-83](../src/menu.ts#L81)) |
| `config?` | `{enabled: boolean, ...}` | Defaults, deep-merged under the stored `plugins.<id>` |
| `platform?` | `Platform` bit flags (Windows=1, macOS=2, Linux=4, Freebsd=8) | Platform filter ([plugins.ts:41-46](../src/types/plugins.ts#L41)) |
| `restartNeeded?` | boolean | Toggling shows the "restart now / later" dialog ([index.ts:231-233](../src/index.ts#L231), [:252-292](../src/index.ts#L252)) |
| `stylesheets?` | `string[]` | Renderer CSS, added as `document.adoptedStyleSheets` ([loader/renderer.ts:91-103](../src/loader/renderer.ts#L91)) |
| `menu?` | `(MenuContext) => MenuItemConstructorOptions[]` | Plugin submenu items |
| `backend?` / `preload?` / `renderer?` | function **or** object | Lifecycle per process (below) |

Lifecycle ([src/types/plugins.ts:16-39](../src/types/plugins.ts#L16)):

| Form | Hooks |
|---|---|
| Function `(ctx) => void` | Start only. `stopPlugin` returns `false` for it ([utils/index.ts:138](../src/utils/index.ts#L138)), so such plugins can't be unloaded at runtime |
| Object | `start(ctx)`, `stop(ctx)`, `onConfigChange(newConfig)`, plus any custom members (`this` = the object, every function is bound to it by `startPlugin`, [utils/index.ts:91-100](../src/utils/index.ts#L91)) |
| Renderer object, extra | `onPlayerApiReady(playerApi: MusicPlayer, ctx)` ([plugins.ts:25-32](../src/types/plugins.ts#L25)) |

`startPlugin` returns `true` (ran), `null` (no start hook) or `false` (threw) ([utils/index.ts:74-130](../src/utils/index.ts#L74)). `onConfigChange` is called for **backend** ([index.ts:236-244](../src/index.ts#L236)) and **renderer** ([renderer.ts:518-526](../src/renderer.ts#L518)) only. Preload has no `config-changed` listener.

### Context objects (`ctx`), [src/types/contexts.ts](../src/types/contexts.ts)

All contexts share `getConfig()` (deep-merge of stub defaults `?? {enabled:false}` and the stored `plugins.<id>`) and `setConfig(partial)` (`config.setPartial`).

| Context | Built in | Extra members |
|---|---|---|
| `BackendContext` | [loader/main.ts:19-56](../src/loader/main.ts#L19) | `ipc.send(ch, ...args)` → `win.webContents.send`; `ipc.handle(ch, fn)` / `ipc.on(ch, fn)` → `ipcMain` with the **event arg stripped**; `ipc.removeHandler`; `window: BrowserWindow` |
| `PreloadContext` | [loader/preload.ts:17-30](../src/loader/preload.ts#L17) | none (reads the store directly) |
| `RendererContext` | [loader/renderer.ts:18-42](../src/loader/renderer.ts#L18) | `getConfig/setConfig` go through **`peard:get-config` / `peard:set-config` invoke**; `ipc.send`, `ipc.invoke`, `ipc.on` (event stripped), `ipc.removeAllListeners` |
| `MenuContext` | [loader/menu.ts:16-40](../src/loader/menu.ts#L16) | `window`; `refresh()` = `setApplicationMenu` + `refresh-in-app-menu` when in-app-menu is enabled |

### Loaders

| Loader | Load-all | Called from | Notes |
|---|---|---|---|
| [loader/main.ts](../src/loader/main.ts) | `loadAllMainPlugins(win)`, **parallel** `Promise.allSettled` ([:135-150](../src/loader/main.ts#L135)) | [index.ts:379](../src/index.ts#L379) | `forceLoadMainPlugin` / `forceUnloadMainPlugin` ([:58-133](../src/loader/main.ts#L58)); `getAllLoadedMainPlugins` |
| [loader/preload.ts](../src/loader/preload.ts) | `loadAllPreloadPlugins()`, fire-and-forget per plugin ([:85-102](../src/loader/preload.ts#L85)) | [preload.ts:43](../src/preload.ts#L43) | Default fallback is the typo `{ enable: false }` ([:90](../src/loader/preload.ts#L90)) |
| [loader/renderer.ts](../src/loader/renderer.ts) | `loadAllRendererPlugins()`, **sequential** ([:117-131](../src/loader/renderer.ts#L117)) | [renderer.ts:498](../src/renderer.ts#L498) | On unload it removes `style#plugin-<id>` ([:57-59](../src/loader/renderer.ts#L57)), but load added *adopted* stylesheets ([:99-102](../src/loader/renderer.ts#L99)) and `unregisterStyleMap` is never filled, so **plugin CSS stays after a runtime disable** |
| [loader/menu.ts](../src/loader/menu.ts) | `loadAllMenuPlugins(win)`, enabled plugins only ([:72-85](../src/loader/menu.ts#L72)) | every menu rebuild, [menu.ts:72](../src/menu.ts#L72) | Templates kept in `menuTemplateMap` |

### Runtime enable/disable

1. Menu checkbox → `config.plugins.enable/disable(id)` ([menu.ts:47-52](../src/menu.ts#L47)) → `setMenuOptions` → store write, then `restart()` if `options.restartOnConfigChanges` ([config/plugins.ts:49-70](../src/config/plugins.ts#L49)).
2. `config.watch` (set up in `initHook`) diffs `plugins.*` ([index.ts:200-249](../src/index.ts#L200)). When `enabled` flips:
   - `webContents.send('plugin:enable'|'plugin:unload', id)`, which renderer ([renderer.ts:501-516](../src/renderer.ts#L501)) and preload ([preload.ts:46-51](../src/preload.ts#L46)) handle
   - `ipcMain.emit(sameChannel, id)`
   - `forceLoadMainPlugin` / `forceUnloadMainPlugin`
   - `restartNeeded` → `showNeedToRestartDialog`
3. For any changed plugin config: `backend.onConfigChange(config)` if loaded and enabled; always `webContents.send('config-changed', id, config)`.
4. On renderer enable, `onPlayerApiReady` runs immediately if the API is already loaded ([renderer.ts:504-516](../src/renderer.ts#L504)).

### i18n requirements

- [src/i18n/index.ts](../src/i18n/index.ts): `loadI18n()` (i18next, `fallbackLng: 'en'`), `setLanguage`, `t`, `APPLICATION_NAME` = "YouTube Music".
- Resources: `src/i18n/resources/<lang>.json` (62 language files + `@types/`). Top-level keys of `en.json`: `common`, `language`, `main`, `plugins`.
- Each plugin needs **`plugins.<id>.name`** and **`plugins.<id>.description`** in [en.json](../src/i18n/resources/en.json), plus any `plugins.<id>.menu.*` strings it uses (e.g. [disable-autoplay/index.ts:24-25](../src/plugins/disable-autoplay/index.ts#L24)).

---

## Config

The config lives in `electron-store`, in the file **`%APPDATA%\YouTube Music\config.json`** (Options → Advanced → Edit config.json opens it, [menu.ts:615-622](../src/menu.ts#L615)).

| File | Contents |
|---|---|
| [config/defaults.ts](../src/config/defaults.ts) | `DefaultConfig` interface ([:11-43](../src/config/defaults.ts#L11)) + `defaultConfig` ([:45-80](../src/config/defaults.ts#L45)) |
| [config/store.ts](../src/config/store.ts) | `new Store({ defaults, clearInvalidConfig: false, migrations })` ([:270-277](../src/config/store.ts#L270)); loaded via `require` because of a rolldown ESM bug ([:7-14](../src/config/store.ts#L7)) |
| [config/index.ts](../src/config/index.ts) | `get(key)` (typed dot-path, [:83-84](../src/config/index.ts#L83)); `set`; `setPartial(key, value, defaults)` = deepmerge (**arrays replaced, not merged**) of defaults, stored value and new value ([:8-26](../src/config/index.ts#L8)); `setMenuOption` = set + restart if `restartOnConfigChanges` ([:28-33](../src/config/index.ts#L28)); `edit()` opens the file; `watch(cb)` = `onDidAnyChange` |
| [config/plugins.ts](../src/config/plugins.ts) | `getPlugins()`, `isEnabled(id)` (merge with stub defaults), `setOptions`/`setMenuOptions` (exclude `enabled` by default), `getOptions`, `enable`, `disable` |

Plugin config storage: `plugins.<id>` holds only what has been written. The effective config is always `deepmerge(pluginStub.config, store['plugins.<id>'])` (e.g. [loader/main.ts:23-27](../src/loader/main.ts#L23)). Defaults are not written into the store ([store.ts:273](../src/config/store.ts#L273)).

### Top-level keys

| Key | Default | Meaning |
|---|---|---|
| `window-size` | `{width:1100, height:550}` | Saved on resize (600 ms debounce) |
| `window-maximized` | `false` | Saved on resize |
| `window-position` | `{x:-1, y:-1}` | Saved on move; restored with an offscreen check |
| `url` | `https://music.youtube.com` | Last song URL, written by [song-info.ts:102](../src/providers/song-info.ts#L102); loaded when `resumeOnStart` is on |
| `options` | see below | |
| `plugins` | `{}` | Per-plugin config |

### `options.*`

| Key | Default | Meaning / read at |
|---|---|---|
| `language` | *(unset)* | UI language. Set on first run from the OS locale ([index.ts:641-646](../src/index.ts#L641)); Options → Language |
| `tray` | `false` | Create the tray ([tray.ts:74](../src/tray.ts#L74)); close hides instead of quitting ([index.ts:881](../src/index.ts#L881)) |
| `appVisible` | `true` | Show the window on `ready-to-show` ([index.ts:484](../src/index.ts#L484)); macOS dock hide |
| `autoUpdates` | `true` | Update check ([index.ts:811](../src/index.ts#L811)) |
| `alwaysOnTop` | `false` | [index.ts:423](../src/index.ts#L423) |
| `hideMenu` | `false` | `autoHideMenuBar` ([index.ts:343](../src/index.ts#L343)) |
| `hideMenuWarned` | `false` | Whether the hide-menu dialog has been shown |
| `startAtLogin` | `false` | `setLoginItemSettings` ([index.ts:807](../src/index.ts#L807)) |
| `disableHardwareAcceleration` | `false` | [index.ts:122](../src/index.ts#L122) |
| `removeUpgradeButton` | `false` | CSS hide ([renderer.ts:414](../src/renderer.ts#L414)) |
| `restartOnConfigChanges` | `false` | Auto-restart after menu option/plugin toggles |
| `trayClickPlayPause` | `false` | Tray click = play/pause instead of show/hide ([tray.ts:110](../src/tray.ts#L110)) |
| `trayMoveToCurrentDesktop` | `false` | **Custom.** Show on the current virtual desktop ([tray.ts:116](../src/tray.ts#L116), [:147](../src/tray.ts#L147), [index.ts:796](../src/index.ts#L796)). See [custom/virtual-desktop.md](custom/virtual-desktop.md) |
| `autoResetAppCache` | `false` | Clear the HTTP cache 20 s after start |
| `resumeOnStart` | `true` | Load `url` instead of the home page ([index.ts:427](../src/index.ts#L427)) |
| `likeButtons` | `''` | `''` (default), `'force'`, `'hide'` ([renderer.ts:434-452](../src/renderer.ts#L434)) |
| `swapLikeButtonsOrder` | `false` | `row-reverse` CSS ([renderer.ts:455](../src/renderer.ts#L455)) |
| `proxy` | `''` | `--proxy-server` ([index.ts:142](../src/index.ts#L142)) |
| `startingPage` | `''` | Key of `startingPages` ([extracted-data.ts](../src/providers/extracted-data.ts)), navigated at API load |
| `backgroundMaterial?` | *(unset)* | `'none'\|'mica'\|'acrylic'\|'tabbed'`: **typed only; nothing in `src/` reads it** |
| `overrideUserAgent` | `false` | Fixed Chrome 130 UA ([index.ts:528-559](../src/index.ts#L528)) |
| `usePodcastParticipantAsArtist` | `false` | Podcast artist field ([song-info.ts:133](../src/providers/song-info.ts#L133), [:143](../src/providers/song-info.ts#L143)); no menu item |
| `themes` | `[]` | User CSS file paths injected at start ([index.ts:297](../src/index.ts#L297)) |
| `customWindowTitle?` | *(unset)* | Fixed window title ([index.ts:608-615](../src/index.ts#L608)) |

The interface-language pin (`hl=en`) is **not** a config option; it always runs ([custom/interface-language.md](custom/interface-language.md)).

### Migrations ([store.ts:20-268](../src/config/store.ts#L20))

Keyed by version (`>=1.7.0` … `>=3.10.0`). In summary:
- plugins array → object (1.7)
- `resumeOnStart` default (1.11)
- shortcuts array → map (1.12)
- discord `listenAlong` default `true` (1.13)
- precise-volume `globalShortcuts` default `{}`, and hide-video-player → `video-toggle.enabled` (1.14)
- picture-in-picture / video-toggle mode (1.17)
- visualizer / notifications / `ForceShowLikeButtons` → `likeButtons:'force'` (1.20)
- downloader preset (2.1.0)
- discord `listenAlong` rename (2.1.3)
- discord timeout typo fix (3.0)
- lastfm → scrobbler (3.3)
- lyrics-genius → synced-lyrics (3.10)

---

## IPC channel reference

Conventions:
- `M→R` = `webContents.send` → `ipcRenderer.on`; `R→M` = `ipcRenderer.send` → `ipcMain.on`; `invoke` = `ipcRenderer.invoke` → `ipcMain.handle`; `sync` = `sendSync`.
- In the renderer everything goes through `window.ipcRenderer` (from the preload).
- **All song-control `M→R` listeners are registered in `onApiLoaded`**, so they are inert until `#movie_player` exists.

### Infrastructure (plugins, config, boot)

| Channel | Dir | Payload → reply | Sender | Handler | Purpose |
|---|---|---|---|---|---|
| `get-renderer-script` | sync | → `[fileUrl \| null, scriptText]` | [preload.ts:87](../src/preload.ts#L87) | [index.ts:714](../src/index.ts#L714) | Deliver the renderer bundle (or the Vite dev loader) |
| `peard:get-config` | invoke | `id` → merged `PluginConfig` | [loader/renderer.ts:22](../src/loader/renderer.ts#L22) | [index.ts:188](../src/index.ts#L188) | Renderer `ctx.getConfig` |
| `peard:set-config` | invoke | `id, partial` | [loader/renderer.ts:24](../src/loader/renderer.ts#L24) | [index.ts:196](../src/index.ts#L196) | Renderer `ctx.setConfig` (`setPartial`) |
| `peard:get-main-plugin-names` | invoke | → `string[]` | *(no caller in repo)* | [index.ts:181](../src/index.ts#L181) | Ids of plugins with a backend |
| `plugin:enable` | M→R (+ `ipcMain.emit`) | `id` | [index.ts:222-223](../src/index.ts#L222) | [renderer.ts:504](../src/renderer.ts#L504), [preload.ts:49](../src/preload.ts#L49) | Runtime plugin load |
| `plugin:unload` | M→R (+ `ipcMain.emit`) | `id` | [index.ts:226-227](../src/index.ts#L226) | [renderer.ts:501](../src/renderer.ts#L501), [preload.ts:46](../src/preload.ts#L46) | Runtime plugin unload |
| `config-changed` | M→R | `id, PluginConfig` | [index.ts:246](../src/index.ts#L246) | [renderer.ts:518](../src/renderer.ts#L518) | → `renderer.onConfigChange` |
| `log` | M→R | JSON string | [index.ts:598](../src/index.ts#L598) | [renderer.ts:536](../src/renderer.ts#L536) (dev only) | `did-fail-load` details to the DevTools console |
| `refresh-in-app-menu` | M→R | none | [menu.ts:63](../src/menu.ts#L63), [loader/menu.ts:37](../src/loader/menu.ts#L37) | in-app-menu `TitleBar.tsx:277` | Re-fetch the custom title-bar menu |

### App controls ([app-controls.ts](../src/providers/app-controls.ts))

| Channel | Dir | Payload → reply | Sender | Handler | Purpose |
|---|---|---|---|---|---|
| `peard:restart` | R→M | none | *(no caller in repo)* | [app-controls.ts:10](../src/providers/app-controls.ts#L10) | `app.relaunch` + quit (portable-aware) |
| `peard:reload` | R→M | none | `window.reload()` [preload.ts:79-81](../src/preload.ts#L79), used by the "Retry" button in [assets/error.html:47](../assets/error.html#L47) | [app-controls.ts:12](../src/providers/app-controls.ts#L12) | Focused window `loadURL(config.url)` |
| `peard:get-downloads-folder` | invoke | → path | *(no caller in repo)* | [app-controls.ts:11](../src/providers/app-controls.ts#L11) | `app.getPath('downloads')` |
| `peard:get-path` | invoke | `...segments` → `path.join` | *(no caller in repo)* | [app-controls.ts:15](../src/providers/app-controls.ts#L15) | Path join in main |

### Song controls (main → renderer), API in [song-controls.ts](../src/providers/song-controls.ts)

`getSongControls(win)` returns an object of functions ([song-controls.ts:39-150](../src/providers/song-controls.ts#L39)). It is used by the tray, the protocol handler, and plugins (shortcuts, api-server, notifications, taskbar-mediacontrol, touchbar...). Every renderer handler is in `onApiLoaded` ([renderer.ts](../src/renderer.ts)).

| Function | Channel | Payload | Sent at | Renderer handler | Renderer action |
|---|---|---|---|---|---|
| `previous` | `peard:previous-video` | none | [:42](../src/providers/song-controls.ts#L42) | [renderer.ts:80](../src/renderer.ts#L80) | `getPlayerControl('Previous').click()` |
| `next` | `peard:next-video` | none | [:43](../src/providers/song-controls.ts#L43) | [:83](../src/renderer.ts#L83) | click Next |
| `play` / `pause` | `peard:play` / `peard:pause` | none | [:44-45](../src/providers/song-controls.ts#L44) | [:86-91](../src/renderer.ts#L86) | `api.playVideo()` / `pauseVideo()` |
| `playPause` | `peard:toggle-play` | none | [:46](../src/providers/song-controls.ts#L46) | [:92](../src/renderer.ts#L92) | state `2` (paused) → play, else pause |
| `like` / `dislike` | `peard:update-like` | `'LIKE'\|'DISLIKE'` | [:47-48](../src/providers/song-controls.ts#L47) | [:125-142](../src/renderer.ts#L125) | Legacy `updateLikeStatus` or click the new toggle if not pressed |
| `seekTo(s)` | `peard:seek-to` | seconds | [:49-54](../src/providers/song-controls.ts#L49) (also shortcuts/mpris) | [:96](../src/renderer.ts#L96) | `api.seekTo` |
| `goBack(s)` / `goForward(s)` | `peard:seek-by` | ±seconds | [:55-66](../src/providers/song-controls.ts#L55) (also mpris) | [:97](../src/renderer.ts#L97) | `api.seekBy` |
| `shuffle` | `peard:shuffle` | none | [:70](../src/providers/song-controls.ts#L70) | [:98-107](../src/renderer.ts#L98) | Legacy `queue.shuffle()` or click Shuffle |
| `requestShuffleInformation` | `peard:get-shuffle` → **`peard:get-shuffle-response`** (R→M, `boolean`) | none | [:67-69](../src/providers/song-controls.ts#L67) | [:121-123](../src/renderer.ts#L121) | Reply consumed by api-server `routes/control.ts` (`ipcMain.once`) |
| `switchRepeat(n=1)` | `peard:switch-repeat` | count | [:71-76](../src/providers/song-controls.ts#L71) | [:143-157](../src/renderer.ts#L143) | Click repeat n times (yield between clicks) |
| `setVolume(v)` | `peard:update-volume` | 0-100 | [:78-83](../src/providers/song-controls.ts#L78) | [:158-179](../src/renderer.ts#L158) | Legacy `updateVolume`, else drive the slider, else `api.setVolume` |
| `setFullscreen(b)` | `peard:click-fullscreen-button` | boolean | [:84-93](../src/providers/song-controls.ts#L84) (also `win.setFullScreen`) | [:210-215](../src/renderer.ts#L210) | Click (exit-)fullscreen if the state differs |
| `requestFullscreenInformation` | `peard:get-fullscreen` → **`peard:set-fullscreen`** (R→M, `boolean`; the name doesn't match) | none | [:94-96](../src/providers/song-controls.ts#L94) | [:206-208](../src/renderer.ts#L206) | Reply consumed by shortcuts/mpris and api-server |
| `requestQueueInformation` | `peard:get-queue` → **`peard:get-queue-response`** (R→M, `QueueResponse`) | none | [:97-99](../src/providers/song-controls.ts#L97) | [:228-235](../src/renderer.ts#L228) | `{items, autoPlaying, continuation}` from `#queue`; consumed by mpris and api-server |
| `muteUnmute` | `peard:toggle-mute` | none | [:100](../src/providers/song-controls.ts#L100) | [:217-226](../src/renderer.ts#L217) | Legacy `onVolumeClick` or click the mute button |
| `openSearchBox` | *(no IPC)* | none | [:101-106](../src/providers/song-controls.ts#L101) | none | `sendInputEvent` keyDown `/` |
| `addSongToQueue(id, pos)` | `peard:add-to-queue` | `videoId, queueInsertPosition` | [:108-117](../src/providers/song-controls.ts#L108) | [:237-291](../src/renderer.ts#L237) | `networkManager.fetch('/music/get_queue')` → `ADD_ITEMS` (after current if `INSERT_AFTER_CURRENT_VIDEO`, else at the end) |
| `moveSongInQueue(from,to)` | `peard:move-in-queue` | `from, to` | [:118-127](../src/providers/song-controls.ts#L118) | [:292-304](../src/renderer.ts#L292) | `MOVE_ITEM` |
| `removeSongFromQueue(i)` | `peard:remove-from-queue` | index | [:128-133](../src/providers/song-controls.ts#L128) | [:305-311](../src/renderer.ts#L305) | `REMOVE_ITEM` |
| `setQueueIndex(i)` | `peard:set-queue-index` | index | [:134-139](../src/providers/song-controls.ts#L134) | [:312-318](../src/renderer.ts#L312) | `SET_INDEX` |
| `clearQueue` | `peard:clear-queue` | none | [:140](../src/providers/song-controls.ts#L140) | [:319-328](../src/renderer.ts#L319) | Close the player page + `CLEAR` |
| `search(q, params?, cont?)` → Promise | `peard:search` → **`peard:search-results`** (R→M, raw response) | `query, params, continuation` | [:142-148](../src/providers/song-controls.ts#L142) | [:330-356](../src/renderer.ts#L330) | `networkManager.fetch('/search')`. The reply uses `ipcMain.once`, so concurrent searches can receive each other's results |

Argument parsing: the `ArgsType<T> = T | string[] | undefined` parsers ([song-controls.ts:7-37](../src/providers/song-controls.ts#L7)) validate the input. But `seekTo`, `goForward`, `switchRepeat` and `setVolume` send the **raw argument**, not the parsed number ([:52](../src/providers/song-controls.ts#L52), [:64](../src/providers/song-controls.ts#L64), [:74](../src/providers/song-controls.ts#L74), [:81](../src/providers/song-controls.ts#L81)). On the protocol path, `handleProtocol` spreads the args ([protocol-handler.ts:26](../src/providers/protocol-handler.ts#L26)), so each control gets a plain string such as `'30'`. `parseNumberFromArgsType('30')` and `parseBooleanFromArgsType('true')` return `null` for that, which makes `youtubemusic://seekTo 30`, `goBack`/`goForward`, `switchRepeat`, `setVolume`, `setFullscreen` and the queue-index commands silent no-ops. `addSongToQueue` works because `parseStringFromArgsType` accepts a string.

### Song-info pipeline

| Channel | Dir | Payload | Sender | Handler (core) | Also used by |
|---|---|---|---|---|---|
| `peard:video-src-changed` | R→M | `GetPlayerResponse` with `videoDetails.album/elapsedSeconds=0/isPaused=false` added | [song-info-front.ts:455](../src/providers/song-info-front.ts#L455) | [song-info.ts:196](../src/providers/song-info.ts#L196) | downloader, sponsorblock (listen) |
| `peard:update-song-info` | M→R | `SongInfo` | [song-info.ts:167](../src/providers/song-info.ts#L167) | [song-info-front.ts:21-26](../src/providers/song-info-front.ts#L21) (`getSongInfo()`) | synced-lyrics renderer |
| `peard:play-or-paused` | R→M | `{isPaused, elapsedSeconds}` | [song-info-front.ts:333](../src/providers/song-info-front.ts#L333) | [song-info.ts:210](../src/providers/song-info.ts#L210) | none |
| `peard:time-changed` | R→M | seconds (integer) | [song-info-front.ts:41](../src/providers/song-info-front.ts#L41) | [song-info.ts:238](../src/providers/song-info.ts#L238) | none |
| `peard:player-api-loaded` | R→M | none | [renderer.ts:403](../src/renderer.ts#L403) | none in core | api-server, discord, downloader, lumiastream, notifications, shortcuts (mpris), tuna-obs |

**On-demand listeners (`peard:setup-*-changed-listener`).** Main sends a `setup-*` request with no payload (M→R), usually in response to `peard:player-api-loaded`. The renderer handlers in [song-info-front.ts:296-326](../src/providers/song-info-front.ts#L296) call a **`singleton()`-wrapped** setup function ([decorators.ts:1-12](../src/providers/decorators.ts#L1)). That function installs its observer **once per page load**, however many plugins ask, and then streams R→M events:

| Request (M→R) | Setup fn | Emits (R→M) | Payload | Source of truth | Requested by | Consumed by |
|---|---|---|---|---|---|---|
| `peard:setup-time-changed-listener` | [:39-68](../src/providers/song-info-front.ts#L39) | `peard:time-changed` | seconds | Legacy `#progress-bar` `value` attribute; new bar: `<video>` `timeupdate`, once per whole second | api-server, discord, downloader, lumiastream, notifications, mpris, tuna-obs | core song-info |
| `peard:setup-like-changed-listener` | [:140-194](../src/providers/song-info-front.ts#L140) | `peard:like-changed` | `LikeType` | Legacy `#like-button-renderer[like-status]`; new: `aria-pressed` of `like/dislike-button-view-model button` in the bar | api-server | **no listener in repo** |
| `peard:setup-repeat-changed-listener` | [:92-131](../src/providers/song-info-front.ts#L92) | `peard:repeat-changed` | `'NONE'\|'ONE'\|'ALL'` | Store `queue.repeatMode` (new); legacy `#right-controls .repeat[title]` + `__dataHost` | api-server, mpris | api-server, mpris |
| `peard:setup-volume-changed-listener` | [:196-209](../src/providers/song-info-front.ts#L196) | `peard:volume-changed` | `{state, isMuted}` | `<video>` `volumechange` + `api.getVolume/isMuted` | api-server, mpris | api-server, mpris |
| `peard:setup-shuffle-changed-listener` | [:211-241](../src/providers/song-info-front.ts#L211) | `peard:shuffle-changed` / `peard:shuffle-changed-supported` (`false`) | boolean | Store `queue.shuffleEnabled`; legacy `[shuffle-on]` | api-server, mpris | api-server, mpris (`-supported`: **no listener**) |
| `peard:setup-fullscreen-changed-listener` | [:243-275](../src/providers/song-info-front.ts#L243) | `peard:fullscreen-changed` / `peard:fullscreen-changed-supported` (`false`) | boolean | Store `player.fullscreened`; legacy `[player-fullscreened]` | mpris | mpris |
| `peard:setup-autoplay-changed-listener` | [:277-293](../src/providers/song-info-front.ts#L277) | `peard:autoplay-changed` | none | `.autoplay > tp-yt-paper-toggle-button` attributes | mpris | mpris (re-requests the queue) |
| `peard:setup-seeked-listener` | [:31-37](../src/providers/song-info-front.ts#L31) | `peard:seeked` | `currentTime` | `<video>` `seeked` | api-server, mpris | api-server, mpris |

`watchStoreValue` ([song-info-front.ts:74-90](../src/providers/song-info-front.ts#L74)) subscribes to the app store and emits the initial value. It returns `false` (→ legacy path) when the store is missing **or** `ytmusic-player-bar` is present.

### Plugin-internal channels (one line per plugin)

| Plugin | Channels |
|---|---|
| captions-selector | `peard:captions-selector` (invoke: prompt for a caption track) |
| crossfade | `audio-url` (invoke) |
| downloader | `download-song`, `download-playlist-request` (invoke); `downloader-feedback` (M→R) |
| in-app-menu | invoke: `get-menu`, `get-menu-by-id`, `image-path-to-data-url`, `window-is-maximized/-close/-minimize/-maximize/-unmaximize`, `peard:menu-event`; M→R: `close-all-in-app-menu-panel`, `toggle-in-app-menu`, `window-maximize/-unmaximize`; listens to core's `refresh-in-app-menu` |
| music-together | `music-together:prompt` (invoke) |
| picture-in-picture | `plugin:toggle-picture-in-picture` (R→M), `peard:pip-toggle` (M→R) |
| precise-volume | `changeVolume`, `setVolume` (M→R). shortcuts/mpris also sends `setVolume` ([mpris.ts:318](../src/plugins/shortcuts/mpris.ts#L318)) |
| quality-changer | `peard:quality-changer` (invoke: quality dialog) |
| sponsorblock | `sponsorblock-skip` (M→R segments) |
| synced-lyrics | `synced-lyrics:fetch` (invoke: net fetch through main) |
| notifications (hover popup) | No IPC: popup buttons set `document.title = 'act:<cmd>'`, read via `page-title-updated` ([hover-popup.ts:53](../src/plugins/notifications/hover-popup.ts#L53)) |

---

## Providers

### app-controls.ts

[src/providers/app-controls.ts](../src/providers/app-controls.ts), main process.
- `restart()` calls `app.relaunch({execPath: PORTABLE_EXECUTABLE_FILE})` and then `app.quit()` ([:7](../src/providers/app-controls.ts#L7), [:20-24](../src/providers/app-controls.ts#L20)).
- `setupAppControls()` registers `peard:restart`, `peard:reload`, `peard:get-downloads-folder` and `peard:get-path` ([:9-18](../src/providers/app-controls.ts#L9)). It is called in `browser-window-created`.
- `sendToFront(channel, ...args)` broadcasts to all windows ([:26-37](../src/providers/app-controls.ts#L26)). It has no callers in the repo.

### decorators.ts

[src/providers/decorators.ts](../src/providers/decorators.ts) has function wrappers:
- `singleton` (first call only; it backs the `setup-*` listeners)
- `debounce`
- `cache` (last arguments)
- `cacheNoArgs`
- `throttle`, `memoize`, `retry`, which are marked "currently unused" ([:53-55](../src/providers/decorators.ts#L53))

### dom-elements.ts

[src/providers/dom-elements.ts](../src/providers/dom-elements.ts), renderer. These are the DOM accessors for the 2026-10-01 player-bar change. Each one prefers `ytmusic-miniplayer` and falls back to `ytmusic-player-bar` ([:8-10](../src/providers/dom-elements.ts#L8)).

| Helper | New layout | Legacy fallback |
|---|---|---|
| `getSongMenu()` | `ytmusic-menu-popup-renderer tp-yt-paper-listbox` | none |
| `getPlayerControl(c)` (`Shuffle\|Previous\|PlayPause\|Next\|Repeat`) | `.ytmusicPlayerControls<C>Button button` | `.shuffle.ytmusic-player-bar`, `.previous-button…`, `#play-pause-button`, `.next-button…`, `#right-controls .repeat` ([:19-30](../src/providers/dom-elements.ts#L19)) |
| `getPlayerControlWrapper(c)` | `.ytmusicPlayerControls<C>Button` | none |
| `getPlayerBar()` | `ytmusic-miniplayer` | `ytmusic-player-bar` |
| `getProgressBar()` | `input.ytMusicMiniPlayerProgressBar` (`value` is a property only) | `#progress-bar` |
| `isNewPlayerBar()` | true if `input.ytMusicMiniPlayerProgressBar` exists | none |
| `getLikeButton('like'\|'dislike')` | `ytmusic-miniplayer <type>-button-view-model button` | none |
| `getMuteButton()` | `.ytMusicMiniPlayerVolumeWrapper button` | none |
| `getVolumeSlider()` | `.ytMusicMiniPlayerVolumePopup input` | none |
| `getAppStore()` | `document.querySelector('#queue').queue.store` → `{getState(): GetState, subscribe(fn)}` ([:64-72](../src/providers/dom-elements.ts#L64)) | none |

Two app-store paths appear in the code, both as written. `getAppStore()` uses `#queue.queue.store`. [types/queue.ts:17-21](../src/types/queue.ts#L17) and [renderer.ts:244](../src/renderer.ts#L244) / [:321](../src/renderer.ts#L321) use `#queue.queue.store.store` (with `dispatch`). Both are in use. See [player-bar.md](player-bar.md).

### extracted-data.ts

[src/providers/extracted-data.ts](../src/providers/extracted-data.ts) holds `startingPages`, a map from display name to browse id (`Home` → `FEmusic_home`, …, 18 entries). It is used by the Options → Starting page menu and by [renderer.ts:406-411](../src/renderer.ts#L406).

### prompt-options.ts

[src/providers/prompt-options.ts](../src/providers/prompt-options.ts) returns `{customStylesheet: 'dark', icon: tray.png}` for `custom-electron-prompt` dialogs.

### protocol-handler.ts

[src/providers/protocol-handler.ts](../src/providers/protocol-handler.ts), main.
- `APP_PROTOCOL = 'youtubemusic'`.
- `setupProtocolHandler(win)` registers the default protocol client and maps `cmd` to `getSongControls(win)[cmd](...args)` ([:12-29](../src/providers/protocol-handler.ts#L12)).
- `handleProtocol` is called from `second-instance` with a URI like `youtubemusic://<cmd> <args…>` (decoded, split on spaces; [index.ts:769-786](../src/index.ts#L769)).
- `changeProtocolHandler(f)` lets a plugin replace the handler.

### song-controls.ts

[src/providers/song-controls.ts](../src/providers/song-controls.ts) contains `getSongControls(win)`. The full table is in the [IPC reference](#ipc-channel-reference).

### song-info.ts (main)

[src/providers/song-info.ts](../src/providers/song-info.ts)

- **`SongInfo`** ([:29-47](../src/providers/song-info.ts#L29)): `title`, `alternativeTitle?`, `artist`, `artistUrl?`, `views`, `uploadDate?`, `imageSrc?`, `image?` (NativeImage), `isPaused?`, `songDuration`, `elapsedSeconds?`, `url?`, `album?`, `videoId`, `playlistId?`, `mediaType`, `tags?`.
- **`MediaType`** ([:9-27](../src/providers/song-info.ts#L9)): `AUDIO` (ATV), `ORIGINAL_MUSIC_VIDEO` (OMV), `USER_GENERATED_CONTENT` (UGC), `PODCAST_EPISODE`, `OTHER_VIDEO`.
- **`handleData(GetPlayerResponse)`** ([:63-171](../src/providers/song-info.ts#L63)):
  - From `microformat`: `uploadDate`, `url` (cut at `&`), `playlistId` (`list` param), `artistUrl` (channel), `alternativeTitle`, `tags`. It also **writes `config.url`** (resume on start).
  - From `videoDetails`: `title`/`artist` via `cleanupName`, views, duration, videoId, album, mediaType. For podcasts and other videos the artist is the page owner, unless `usePodcastParticipantAsArtist` is set.
  - Thumbnail: the largest one with the query string removed (kept if a HEAD request fails), fetched into a `NativeImage` via `getImage` (with a webp fix).
  - Finally sends `peard:update-song-info`.
- **Events** (`SongInfoEvent`, [:173-177](../src/providers/song-info.ts#L173)): `VideoSrcChanged`, `PlayOrPaused`, `TimeChanged`. The IPC handlers update one shared `songInfo` under an `async-mutex` and call every registered callback ([:191-255](../src/providers/song-info.ts#L191)).
- **`registerCallback(cb(songInfo, event))`** ([:187-189](../src/providers/song-info.ts#L187)) is the main-side subscription API. It is used by the tray and by plugins: amuse, api-server, discord, downloader, lumiastream, notifications, scrobbler, shortcuts/mpris, taskbar-mediacontrol, touchbar, tuna-obs.
- `cleanupName` strips `- Topic`, `VEVO`, `(Official …)`, `(Lyrics)`, `[HD]`, `(Live)`, `[4K]`, and similar ([:257-283](../src/providers/song-info.ts#L257)).
- `setupSongInfo = registerProvider` ([:285](../src/providers/song-info.ts#L285)), called in `browser-window-created`.

### song-info-front.ts (renderer)

[src/providers/song-info-front.ts](../src/providers/song-info-front.ts)

- Keeps a renderer copy of `SongInfo` from `peard:update-song-info`; `getSongInfo()` reads it ([:18-26](../src/providers/song-info-front.ts#L18)).
- `setupSongInfo(api)` is called by the renderer observer as soon as `#movie_player` exists ([renderer.ts:562](../src/renderer.ts#L562)). It does three things:
  1. Registers the 8 `peard:setup-*` handlers ([:296-326](../src/providers/song-info-front.ts#L296)).
  2. Re-emits player `videodatachange` as a DOM event. On `dataloaded` it dispatches `peard:src-changed` on `<video>`, attaches `playing`/`pause` → `peard:play-or-paused` (only when `currentTime > 0`), and waits for `dataupdated`, with a **1500 ms fallback** ([:16](../src/providers/song-info-front.ts#L16), [:368-399](../src/providers/song-info-front.ts#L368)). Then it calls `sendSongInfo`.
  3. If a video is already loaded at setup, it sends song info right away from `api.getVideoData()` + `getWatchNextResponse()` ([:401-431](../src/providers/song-info-front.ts#L401)).
- `sendSongInfo` takes `api.getPlayerResponse()` and adds the album from `playerOverlays…browserMediaSession…album`, `elapsedSeconds=0` and `isPaused=false`. It then sends **`peard:video-src-changed`** ([:433-456](../src/providers/song-info-front.ts#L433)).
- Since 2026-10-01 the listeners use the app store or the `<video>` element when the new bar is present (table in the [IPC reference](#song-info-pipeline)).

### youtube-language.ts

[src/providers/youtube-language.ts](../src/providers/youtube-language.ts), main. `forceEnglishInterface(session)` pins the YouTube interface to English by setting `hl=en` in the `PREF` cookie. It keeps the other PREF keys, uses domain `.youtube.com`, and sets a 2-year expiry ([:13-39](../src/providers/youtube-language.ts#L13)). It also re-applies `hl=en` on every `cookies.changed` for PREF (once per process, [:41-51](../src/providers/youtube-language.ts#L41)). It is called from `createMainWindow` before `loadURL` ([index.ts:519](../src/index.ts#L519)). See [custom/interface-language.md](custom/interface-language.md).

---

## Tray, menu and window utils

### Tray ([src/tray.ts](../src/tray.ts))

- `setUpTray(app, win)` returns early (no tray) unless `options.tray` is set ([:74-77](../src/tray.ts#L74)).
- Icon: 16 px × the primary display scale on Windows. Paused and playing icons (white on macOS) ([:81-98](../src/tray.ts#L81)).
- Default click ([:109-123](../src/tray.ts#L109)):
  - with `trayClickPlayPause` set: play/pause
  - otherwise: toggle hide/show, using `showOnCurrentDesktop` when `trayMoveToCurrentDesktop` is set
- Context menu: Play/Pause, Next, Previous, Show, Restart, Quit ([:125-168](../src/tray.ts#L125)).
- `registerCallback` updates the tooltip ("artist - title") and the paused icon, ignoring `TimeChanged` ([:170-189](../src/tray.ts#L170)).
- **Handler queueing (custom):**
  - `setTrayOnClick`, `setTrayOnDoubleClick` and `setTrayOnMouseMove` ([:39-69](../src/tray.ts#L39)) store the handler in `pending*` when the tray doesn't exist yet.
  - That is normal, because main plugins load before `setUpTray` (boot step 15 vs 23). The queue is applied at the end of `setUpTray` ([:191-207](../src/tray.ts#L191)).
  - Click and double-click replace existing listeners. A queued mouse-move is *added* without `removeAllListeners`.
  - If `options.tray` is off, the queued handlers are never applied.
- `getTrayBounds()` ([:71](../src/tray.ts#L71)).
- Callers: notifications `interactive.ts` (click / double-click) and `hover-popup.ts` (mouse-move, bounds). See [custom/tray-hover-mini-player.md](custom/tray-hover-mini-player.md).

### Application menu ([src/menu.ts](../src/menu.ts))

`setApplicationMenu(win)` builds from `mainMenuTemplate(win)`, prepends the standard app menu on macOS, and calls `Menu.setApplicationMenu` ([:714-741](../src/menu.ts#L714)). `refreshMenu(win)` rebuilds and sends `refresh-in-app-menu` if in-app-menu was active at launch ([:60-65](../src/menu.ts#L60)). Each rebuild re-runs `loadAllMenuPlugins` ([:72](../src/menu.ts#L72)).

Top-level menus:
- **Plugins** ([:122-160](../src/menu.ts#L122)): every plugin, sorted by localized name. A disabled plugin is a checkbox. An enabled plugin that has menu items gets a submenu: "Enabled" checkbox, separator, then the plugin's items.
- **Options** ([:161-626](../src/menu.ts#L161)), tree below.
- **View** ([:627-671](../src/menu.ts#L627)): reload, force reload, zoom, fullscreen.
- **Navigation** ([:672-707](../src/menu.ts#L672)): back, forward, copy URL, restart, quit.
- **About** ([:708-711](../src/menu.ts#L708)).

Options tree:

```
Options
├─ Auto-update ☐                       options.autoUpdates (setMenuOption)
├─ Resume on start ☐                   options.resumeOnStart
├─ Starting page ▸ (unset) + startingPages keys (radio)   options.startingPage (config.set)
├─ Visual tweaks ▸
│  ├─ Remove upgrade button ☐          options.removeUpgradeButton
│  ├─ Custom window title… (prompt)    options.customWindowTitle
│  ├─ Like buttons ▸ Default / Force show / Hide (radio) + Swap order ☐
│  └─ Theme ▸ <each CSS: click → remove dialog> / Import CSS file… (replaces options.themes)
├─ Single instance lock ☐              (hardcoded checked:true; toggles app lock at runtime only)
├─ Always on top ☐                     options.alwaysOnTop (+ win.setAlwaysOnTop)
├─ Hide menu ☐            [Win/Linux]  options.hideMenu
├─ Start at login ☐       [Win/macOS]  options.startAtLogin
├─ Tray ▸ Disabled / Enabled+show app / Enabled+hide app (radio: tray+appVisible)
│         ── Play/Pause on click ☐     options.trayClickPlayPause
│            Move to current desktop ☐ options.trayMoveToCurrentDesktop   (custom)
├─ Language ▸ help-translate link + one checkbox per resource   options.language
└─ Advanced ▸ Set proxy… / Override user agent ☐ / Disable HW accel ☐ /
              Restart on config changes ☐ / Auto reset app cache ☐ / ── /
              Toggle DevTools / Edit config.json
```

Most items use `config.setMenuOption` (restart if `restartOnConfigChanges`). `startingPage`, `likeButtons` and `themes` use plain `config.set`. Several options apply only at startup or page load (e.g. like-button CSS, proxy, UA, theme injection).

### Window utils ([src/window-utils.ts](../src/window-utils.ts))

`showOnCurrentDesktop(win)` = `setVisibleOnAllWorkspaces(true)` → `show()` → `setVisibleOnAllWorkspaces(false)`, which leaves the window on the active virtual desktop ([:8-12](../src/window-utils.ts#L8)). It is custom and used by the tray click, the tray "Show" item and `second-instance`. See [custom/virtual-desktop.md](custom/virtual-desktop.md).

### Custom (non-upstream) features touching core

| Feature | Core files touched | Doc |
|---|---|---|
| Virtual-desktop-aware show | [window-utils.ts](../src/window-utils.ts), [tray.ts](../src/tray.ts), [index.ts:796-803](../src/index.ts#L796), [menu.ts:481-493](../src/menu.ts#L481), `trayMoveToCurrentDesktop` in [defaults.ts](../src/config/defaults.ts) | [custom/virtual-desktop.md](custom/virtual-desktop.md) |
| Tray hover mini-player + handler queueing | [tray.ts:33-71](../src/tray.ts#L33), [tray.ts:191-207](../src/tray.ts#L191) | [custom/tray-hover-mini-player.md](custom/tray-hover-mini-player.md) |
| English interface pin | [youtube-language.ts](../src/providers/youtube-language.ts), [index.ts:518-521](../src/index.ts#L518) | [custom/interface-language.md](custom/interface-language.md) |
| New player bar (`ytmusic-miniplayer`) support | [dom-elements.ts](../src/providers/dom-elements.ts), [renderer.ts](../src/renderer.ts), [song-info-front.ts](../src/providers/song-info-front.ts) | [player-bar.md](player-bar.md) |

---

## Build and packaging

| Item | Details |
|---|---|
| [electron.vite.config.mts](../electron.vite.config.mts) | Three configs. **main**: `src/index.ts`, ES, `dist/main`, `publicDir: assets`, `__dirname` → `import.meta.dirname`. **preload**: `src/preload.ts`, CJS, `dist/preload`. **renderer**: root `src/`, entry `index.html`, IIFE, `dist/renderer`, Solid via `withFilter`, dev-server CORS for music.youtube.com. All three: aliases `@` → `src`, `@assets` → `assets`; `electron` + Node builtins external (main and preload also `custom-electron-prompt`); minify unless development; inline sourcemaps in dev; `vite-plugin-inspect` in dev → `.vite-inspect/` |
| [electron-builder.yml](../electron-builder.yml) | appId `com.github.th-ch.youtube-music`, productName "YouTube Music". Files: `dist`, `assets`, `license` + `custom-electron-prompt`, `@ghostery/adblocker-electron-preload`, `@ffmpeg.wasm/core-mt` from node_modules; `asarUnpack: assets`. Win: `nsis-web` + `portable` (x64/ia32/arm64). Mac: dmg x64/arm64. Linux: AppImage, flatpak, deb, rpm, snap, freebsd, tar.gz. **Output `./pack/`** ([:120-121](../electron-builder.yml#L120)) |
| `pack/` | Currently contains `win-unpacked/` + `builder-debug.yml` |
| Asset imports | `?asset` / `?asset&asarUnpack` (e.g. tray icons, [tray.ts:4-7](../src/tray.ts#L4)); `?inline` CSS ([index.ts:48](../src/index.ts#L48)). Ambient module types in [src/pear-desktop.ts](../src/pear-desktop.ts) |

`package.json` scripts:

| Script | Command |
|---|---|
| `dev` | `electron-vite dev --watch` (NODE_ENV=development, source maps) |
| `dev:renderer` / `dev:debug` | dev without watch / with `ELECTRON_ENABLE_LOGGING=1` |
| `build` | `electron-vite build` |
| `start` / `start:debug` | `electron-vite preview` |
| `clean` | delete `dist`, `pack`, `.vite-inspect` |
| `dist`, `dist:win`, `dist:win:x64`, `dist:mac[:arm64]`, `dist:linux[:deb-arm64\|:rpm-arm64]` | clean + build + `electron-builder … -p never` |
| `release:*` | same with `-p always` |
| `lint` / `typecheck` / `test` | eslint `./src` / `tsc --noEmit` / Playwright |
| `vite:inspect`, `changelog` | inspect build / auto-changelog |

Engines: node ≥ 22, pnpm ≥ 10. `pnpm.overrides` pins vite 8.0.8 among others.

### patches/ (`pnpm.patchedDependencies`)

| Patch | Purpose (from the diff) |
|---|---|
| `electron-is@3.0.0` | Adds `is.freebsd()` (JS + d.ts), used by `supportsPlatform` |
| `mdui@2.1.4` | Rewrites the JSX typings from React to `solid-js` `IntrinsicElements`; adds the `solid-js` peer dep |
| `vudio@2.1.1` | Removes `analyser.connect(audioContext.destination)` so the visualizer doesn't route audio to the output a second time (renderer.ts already connects the source) |
| `kuromoji@0.1.2` | Large (≈259 KB): rebuilt bundle, swaps `zlibjs` → `fflate`, uses `BrowserDictionaryLoader` and newer `async`/lodash internals. Used by synced-lyrics romanization (kuroshiro) |
| `@malept/flatpak-bundler@0.4.0` | Collects stdout/stderr and includes the args and output in the failure error (flatpak build debugging) |

---

## Types

| File | Contents |
|---|---|
| [contexts.ts](../src/types/contexts.ts) | `BaseContext`, `BackendContext`, `MenuContext`, `PreloadContext`, `RendererContext` (plugin `ctx`) |
| [datahost-get-state.ts](../src/types/datahost-get-state.ts) | **App store state** (`GetState`, [:3-17](../src/types/datahost-get-state.ts#L3)): `castStatus, entities, download, likeStatus, multiSelect, navigation, player, playerPage, queue, subscribeStatus, toggleStates, ui, uploads`. Key members: `queue.repeatMode: 'NONE'\|'ONE'\|'ALL'`, `queue.shuffleEnabled`, `queue.items`, `queue.queueContextParams`, `queue.nextQueueItemId`, `player.fullscreened/muted/volume`. Also `LikeType` enum (`LIKE/DISLIKE/INDIFFERENT`), `VolumeState`, `QueueItem` |
| [get-player-response.ts](../src/types/get-player-response.ts) | `GetPlayerResponse` (`api.getPlayerResponse()`: `videoDetails`, `microformat`, captions, …), the input to song-info |
| [icons.ts](../src/types/icons.ts) | Unions of YouTube icon names (`YtIcons`, `YtSysIcons`, …) |
| [media-icons.ts](../src/types/media-icons.ts) | Unicode play/pause/next/previous glyphs |
| [music-player.ts](../src/types/music-player.ts) | **`MusicPlayer`** = the `#movie_player` API (~180 members): `playVideo/pauseVideo/getPlayerState/seekTo/seekBy/setVolume/getVolume/isMuted/getVideoData/getPlayerResponse/getWatchNextResponse/addEventListener('videodatachange'\|'onStateChange')`, … |
| [music-player-app-element.ts](../src/types/music-player-app-element.ts) | `ytmusic-app`: `navigate(page)`, `networkManager.fetch(url, data)` |
| [music-player-desktop-internal.ts](../src/types/music-player-desktop-internal.ts) | `QueueResponse {items, autoPlaying, continuation}`, `WatchNextResponse {playerOverlays}` |
| [player-api-events.ts](../src/types/player-api-events.ts) | `PlayerAPIEvents` (`videodatachange` `dataloaded\|dataupdated`, `onStateChange`), `VideoDataChangeValue`, `PlayerOverlays`, `AlbumDetails` |
| [plugins.ts](../src/types/plugins.ts) | `PluginDef`, `PluginConfig`, lifecycle types, `Platform` flags |
| [queue.ts](../src/types/queue.ts) | `QueueElement` (`#queue`: `dispatch`, `queue.getItems()`, `queue.store.store`), `Store` (redux: `dispatch/getState/subscribe`), `ToastService`, `AppElement` |
| [search-box-element.ts](../src/types/search-box-element.ts) | `ytmusic-search-box.getSearchboxStats()` |
| [video-data-changed.ts](../src/types/video-data-changed.ts) | `VideoDataChanged {name, videoData?}` (DOM `videodatachange` detail) |
| [video-details.ts](../src/types/video-details.ts) | `VideoDetails` (`api.getVideoData()`) |

Other typing and utility files:
- [src/reset.d.ts](../src/reset.d.ts): `window.*` globals and DOM events.
- [src/virtual-module.d.ts](../src/virtual-module.d.ts): the virtual modules.
- [src/pear-desktop.ts](../src/pear-desktop.ts): asset module declarations.
- [src/solit.tsx](../src/solit.tsx): `LitElementWrapper` (Solid wrapper for a Lit element).
- `src/utils/`: `createPlugin` and start/stop ([index.ts](../src/utils/index.ts)), `waitForElement` (polling, [wait-for-element.ts](../src/utils/wait-for-element.ts)), the default Trusted Types policy ([trusted-types.ts](../src/utils/trusted-types.ts)), `anonymousCustomElement` (`pear-<uuid>`, [custom-element.ts](../src/utils/custom-element.ts)), and `isTesting`.
