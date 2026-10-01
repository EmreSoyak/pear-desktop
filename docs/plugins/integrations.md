# Integrations plugins

Plugins that bridge the player to **external programs and services**: remote control (HTTP/WebSocket API), presence and scrobbling (Discord, Last.fm, ListenBrainz), streaming overlays (Lumia Stream, Tuna OBS, Amuse), peer-to-peer shared listening (Music Together), and a network helper (Auth Proxy Adapter).

Almost all of them live entirely in the **main process** (`backend`). They read song state from `registerCallback` in [song-info.ts](../../src/providers/song-info.ts) (events `peard:video-src-changed`, `peard:play-or-paused`, `peard:time-changed`, see `SongInfoEvent` at `src/providers/song-info.ts:173-177`) and send controls through [song-controls.ts](../../src/providers/song-controls.ts). Neither path touches the DOM from the plugin, so they keep working on the new player bar. Only two plugins in this domain query YouTube's DOM directly: `api-server` (one endpoint) and `music-together` (renderer).

`registerCallback` only gets `TimeChanged` events once some plugin has sent `peard:setup-time-changed-listener` to the renderer. The renderer then emits `peard:time-changed` once per whole second, driven by `video` `timeupdate` on the new bar (`src/providers/song-info-front.ts:39-70`).

| Plugin | Summary | Default enabled | New player bar (2026-10) |
|---|---|---|---|
| [API Server](#api-server-beta-api-server) | Local HTTP REST + WebSocket API (Hono, JWT) to control and observe the player | false | partially affected: `GET /api/v1/like-state` reads `#like-button-renderer` |
| [Discord Rich Presence](#discord-rich-presence-discord) | Shows the current song as a Discord "Listening" activity over local RPC | false | unaffected |
| [Scrobbler](#scrobbler-scrobbler) | Sends now-playing and scrobbles to Last.fm and/or ListenBrainz | false | unaffected |
| [Lumia Stream](#lumia-stream-beta-lumiastream) | POSTs song state to the local Lumia Stream app (port 39231) | false | unaffected |
| [Tuna OBS](#tuna-obs-tuna-obs) | POSTs song state to the OBS Tuna plugin web server (port 1608) | false | unaffected |
| [Music Together](#music-together-beta-music-together) | Peer-to-peer shared queue and playback (PeerJS/WebRTC), with host and guests | false | partially affected: guest seek broadcast hooks `tp-yt-paper-progress` |
| [Amuse](#amuse-amuse) | Serves song state as JSON on port 9863 for the Amuse now-playing widget | false | unaffected |
| [Auth Proxy Adapter](#auth-proxy-adapter-auth-proxy-adapter) | Local no-auth SOCKS5 server that relays to an authenticated upstream SOCKS proxy | false | unaffected |

---

## API Server [Beta] (`api-server`)
**What it does:** Runs an HTTP(S) server, by default on `0.0.0.0:26538`, with a REST API under `/api/v1/*` and a WebSocket at `/api/v1/ws`. External apps and scripts can use it to control playback, volume, repeat, shuffle, fullscreen, the queue and search, and to read song, queue and player state. It also serves OpenAPI docs at `/doc` and Swagger UI at `/swagger`.

**Why it exists:** It gives third-party tools a stable, documented control and observation surface without scraping the window.

**How it works:**
- **Process.** Main process only (`backend`), [backend/main.ts](../../src/plugins/api-server/backend/main.ts). It is built with `@hono/zod-openapi` (`OpenAPIHono`), `@hono/node-server` `serve()`, and `@hono/node-ws` for the WebSocket.
- **`start`** (`backend/main.ts:33-61`):
  - calls `init()`;
  - caches `songInfo` via `registerCallback`;
  - on `peard:player-api-loaded`, asks the renderer to set up the seeked, time, repeat, like, volume and shuffle listeners;
  - caches `peard:repeat-changed` and `peard:volume-changed`;
  - calls `run(config)`.
- **`init`** (`backend/main.ts:84-170`):
  - global `cors()`;
  - an `Access-Control-Request-Private-Network: true` header for web remotes (`:94-97`);
  - two middlewares on `/api/*`. The first, `jwtGuard`, checks an HS256 JWT signed with `config.secret` unless `authStrategy === NONE` (`:100-111`). The second rejects with 401 unless the JWT payload `id` is in `authorizedClients`, again unless `authStrategy` is `NONE` (`:112-125`);
  - then registers the routes and Swagger.
- **`run`** (`:171-202`) uses `node:https` with `readFileSync(keyPath/certPath)` when `useHttps` is set and both paths are present; otherwise `node:http`. It then injects the WebSocket.
- **`onConfigChange`** (`:65-81`) restarts the server only if hostname, port, useHttps, certPath or keyPath changed.
- **Auth flow** (`backend/routes/auth.ts:49-96`):
  1. The client calls `POST /auth/{id}` with an arbitrary client id. This route is not under `/api`, so it has no guard.
  2. If the id is already in `authorizedClients`, the dialog is skipped. Under `AUTH_AT_FIRST`, an Electron `dialog.showMessageBox` asks the user to Allow or Deny and shows the remote IP. Deny returns 403.
  3. The id is appended to `authorizedClients`.
  4. The route returns `{accessToken}`, a JWT `{id, iat}` signed with `secret`. There is no `exp`.
  5. The client then sends `Authorization: Bearer <token>`.
- **Controls** go through `getSongControls(window)`, which sends IPC to the renderer handled in `src/renderer.ts:80-354`.
- **Request/response reads** (shuffle, fullscreen, queue, search) use `ipcMain.once(<response channel>)` followed by sending the request (`backend/routes/control.ts:650-666, 713-729, 749-767, 771-826`; search in `src/providers/song-controls.ts:142-148`).

Endpoints. Paths are relative to the server root; everything under `/api/v1` needs the bearer token unless `authStrategy=NONE`. Route definitions are in `backend/routes/control.ts:35-568` and handlers in `:582-869`.

| Method | Path | What it does |
|---|---|---|
| POST | `/auth/{id}` | Request a token for client `{id}` (dialog under AUTH_AT_FIRST). 200 `{accessToken}` / 403 |
| GET | `/doc` | OpenAPI 3.1 JSON |
| GET | `/swagger` | Swagger UI |
| POST | `/api/v1/previous` | `peard:previous-video` → 204 |
| POST | `/api/v1/next` | `peard:next-video` → 204 |
| POST | `/api/v1/play` | `peard:play` (`api.playVideo()`) |
| POST | `/api/v1/pause` | `peard:pause` (`api.pauseVideo()`) |
| POST | `/api/v1/toggle-play` | `peard:toggle-play` |
| GET | `/api/v1/like-state` | `{state: LIKE/DISLIKE/INDIFFERENT/null}` read via `executeJavaScript('document.querySelector("#like-button-renderer")?.likeStatus')` (`backend/main.ts:133-136`). **Broken on the new bar.** |
| POST | `/api/v1/like` | `peard:update-like` `LIKE` |
| POST | `/api/v1/dislike` | `peard:update-like` `DISLIKE` |
| POST | `/api/v1/seek-to` | body `{seconds}` → `peard:seek-to` |
| POST | `/api/v1/go-back` | body `{seconds}` → `peard:seek-by` `-seconds` |
| POST | `/api/v1/go-forward` | body `{seconds}` → `peard:seek-by` `seconds` |
| GET | `/api/v1/shuffle` | `peard:get-shuffle` → waits for `peard:get-shuffle-response` → `{state: boolean}` (store-backed, `src/renderer.ts:109-123`) |
| POST | `/api/v1/shuffle` | `peard:shuffle` |
| GET | `/api/v1/repeat-mode` | `{mode: ONE/NONE/ALL/null}` from the cached `peard:repeat-changed` |
| POST | `/api/v1/switch-repeat` | body `{iteration}` → `peard:switch-repeat` (clicks the repeat button `iteration` times) |
| POST | `/api/v1/volume` | body `{volume}` → `peard:update-volume` |
| GET | `/api/v1/volume` | `{state, isMuted}` from the cached `peard:volume-changed`; `{state:0,isMuted:false}` if none yet |
| POST | `/api/v1/fullscreen` | body `{state}` → `win.setFullScreen(state)` + `peard:click-fullscreen-button` |
| GET | `/api/v1/fullscreen` | `peard:get-fullscreen` → waits for `peard:set-fullscreen` → `{state}` |
| POST | `/api/v1/toggle-mute` | `peard:toggle-mute` |
| GET | `/api/v1/song` | cached `SongInfo` without `image`; 204 if none |
| GET | `/api/v1/song-info` | deprecated alias of `/song` |
| GET | `/api/v1/queue` | `peard:get-queue` → waits for `peard:get-queue-response` → `{items, autoPlaying, continuation}` from `#queue` (`src/renderer.ts:228-235`); 204 if empty |
| GET | `/api/v1/queue-info` | deprecated alias of `GET /queue` |
| GET | `/api/v1/queue/next` | Same request; finds the `selected` item and returns the next one as `{title, videoId, thumbnail, lengthText, shortBylineText}`; 204 at the end of the queue |
| POST | `/api/v1/queue` | body `{videoId, insertPosition?: INSERT_AT_END\|INSERT_AFTER_CURRENT_VIDEO}` → `peard:add-to-queue` |
| PATCH | `/api/v1/queue/{index}` | body `{toIndex}` → `peard:move-in-queue` |
| DELETE | `/api/v1/queue/{index}` | `peard:remove-from-queue` |
| PATCH | `/api/v1/queue` | body `{index}` → `peard:set-queue-index` |
| DELETE | `/api/v1/queue` | `peard:clear-queue` |
| POST | `/api/v1/search` | body `{query, params?, continuation?}` → `peard:search` → waits for `peard:search-results` → raw YouTube search response |
| GET | `/api/v1/ws` | WebSocket upgrade (behind the same JWT guard) |

WebSocket ([backend/routes/websocket.ts](../../src/plugins/api-server/backend/routes/websocket.ts)). The server only pushes; client messages are ignored because there is no `onMessage`. Each message is `JSON {type, ...fields}`:

| `type` | Fields | Trigger |
|---|---|---|
| `PLAYER_INFO` | `song, isPlaying, muted, position, volume, repeat, shuffle` | on connect (`:133-147`) |
| `VIDEO_CHANGED` | `song, position: 0` | `SongInfoEvent.VideoSrcChanged` |
| `PLAYER_STATE_CHANGED` | `isPlaying, position` | `SongInfoEvent.PlayOrPaused` |
| `POSITION_CHANGED` | `position` | `SongInfoEvent.TimeChanged` and `peard:seeked` |
| `VOLUME_CHANGED` | `volume, muted` | `peard:volume-changed` |
| `REPEAT_CHANGED` | `repeat` | `peard:repeat-changed` |
| `SHUFFLE_CHANGED` | `shuffle` | `peard:shuffle-changed` |

**Config:**

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plugins.api-server.enabled` | boolean | `false` | |
| `plugins.api-server.hostname` | string | `'0.0.0.0'` | Bind address. All interfaces by default. |
| `plugins.api-server.port` | number | `26538` | |
| `plugins.api-server.authStrategy` | `'AUTH_AT_FIRST'` \| `'NONE'` | `'AUTH_AT_FIRST'` | `NONE` disables JWT and client checks entirely |
| `plugins.api-server.secret` | string | `Date.now().toString(36)` (computed at import) | **Secret.** HS256 JWT signing key, stored in plain text. It is regenerated each launch until the first `setConfig` persists it (`config.setPartial` merges defaults into the store, `src/config/index.ts:19-26`). |
| `plugins.api-server.authorizedClients` | string[] | `[]` | Client ids that have been allowed. Effectively a credential list. |
| `plugins.api-server.useHttps` | boolean | `false` | Uses HTTPS only if `certPath` and `keyPath` are also set |
| `plugins.api-server.certPath` | string | `''` | Path to a .crt/.pem file |
| `plugins.api-server.keyPath` | string | `''` | Path to a .key/.pem file |

`restartNeeded: false`; the server restarts itself on hostname, port or TLS changes.

**Menu:**
- Hostname prompt.
- Port prompt (counter 0..65565).
- Auth strategy radio (AUTH_AT_FIRST / NONE).
- HTTPS submenu: enable checkbox, a certificate file picker and a private key file picker ([menu.ts](../../src/plugins/api-server/menu.ts)).

There is no menu item to view or revoke `authorizedClients` or to rotate `secret`.

**Files:**
- [index.ts](../../src/plugins/api-server/index.ts): plugin definition.
- [config.ts](../../src/plugins/api-server/config.ts): config type, defaults, `AuthStrategy`.
- [menu.ts](../../src/plugins/api-server/menu.ts): menu.
- [backend/main.ts](../../src/plugins/api-server/backend/main.ts): server lifecycle, middlewares, Swagger, like-state getter.
- [backend/routes/control.ts](../../src/plugins/api-server/backend/routes/control.ts): all `/api/v1` REST routes.
- [backend/routes/auth.ts](../../src/plugins/api-server/backend/routes/auth.ts): `/auth/{id}`.
- [backend/routes/websocket.ts](../../src/plugins/api-server/backend/routes/websocket.ts): `/api/v1/ws`.
- [backend/scheme/*.ts](../../src/plugins/api-server/backend/scheme/index.ts): zod request/response schemas.
- [backend/types.ts](../../src/plugins/api-server/backend/types.ts): backend state type.
- [backend/api-version.ts](../../src/plugins/api-server/backend/api-version.ts): `API_VERSION = 'v1'`.

**IPC / events:**
- **Listens (main):**
  - `peard:player-api-loaded`, `peard:repeat-changed`, `peard:volume-changed`, `peard:seeked`, `peard:shuffle-changed`.
  - Response channels: `peard:get-shuffle-response`, `peard:set-fullscreen`, `peard:get-queue-response`, `peard:search-results`.
- **Sends to the renderer:**
  - `peard:setup-{seeked,time-changed,repeat-changed,like-changed,volume-changed,shuffle-changed}-listener`.
  - Via song-controls: `peard:previous-video`, `peard:next-video`, `peard:play`, `peard:pause`, `peard:toggle-play`, `peard:update-like`, `peard:seek-to`, `peard:seek-by`, `peard:get-shuffle`, `peard:shuffle`, `peard:switch-repeat`, `peard:update-volume`, `peard:click-fullscreen-button`, `peard:get-fullscreen`, `peard:toggle-mute`, `peard:get-queue`, `peard:add-to-queue`, `peard:move-in-queue`, `peard:remove-from-queue`, `peard:set-queue-index`, `peard:clear-queue`, `peard:search`.
- **Indirect, via `registerCallback`:** `peard:video-src-changed`, `peard:play-or-paused`, `peard:time-changed`.

**DOM anchors:** `#like-button-renderer` (`.likeStatus`), read via `webContents.executeJavaScript` in `backend/main.ts:134-136`. Everything else goes through the renderer handlers in `src/renderer.ts`.

**New player bar (2026-10):** partially affected. `GET /api/v1/like-state` queries the dead `#like-button-renderer`, so it now always returns `{state: null}`.
- Every other endpoint and every WebSocket message uses the IPC paths that were fixed on 2026-10-01, so they work.
- The fullscreen button click in `src/renderer.ts:199-203` uses `.exit-fullscreen-button` / `.fullscreen-button`. Whether those still exist on the new bar is unclear from code.
- Fix hint: the plugin already asks for `peard:setup-like-changed-listener` but never listens to `peard:like-changed`. Caching that event in `start` and returning it from the like getter would remove the DOM read.

**Gotchas:**
- The default bind is `0.0.0.0`, so the API is reachable from the LAN. `authStrategy=NONE` means anyone on the network can control the player.
- Tokens never expire, since there is no `exp` claim. Revoking a client means editing `authorizedClients` (or `secret`) in the config file by hand.
- `ipcMain.once` request/response is not correlated. Concurrent `GET /queue`, `/queue/next`, `/shuffle`, `/fullscreen` or `/search` calls can receive each other's answers, and a request hangs if the renderer never answers (for example, before the player API is loaded).
- `peard:set-fullscreen` is reused as the *response* channel for `GET /fullscreen`.
- `registerCallback` and `ctx.ipc.on` listeners are never removed in `stop()`. Toggling the plugin off and on stacks duplicates; the WebSocket module also registers its own copies in `init()`.
- The port prompt allows values up to 65565, which is above the real TCP maximum of 65535.

---

## Discord Rich Presence (`discord`)
**What it does:** Shows the current song in your Discord profile as a "Listening" activity:
- song title, with artist as state and album as image text;
- the cover as the large image;
- elapsed/remaining timestamps;
- optional "Play on …" and "View App On GitHub" buttons.

Paused songs show `⏸︎` as the large image text. After a configurable pause timeout the activity is cleared.

**Why it exists:** It is the standard "now playing" presence for Discord users.

**How it works:**
- **Process.** Main process only. [main.ts](../../src/plugins/discord/main.ts) creates a `DiscordService` ([discord-service.ts](../../src/plugins/discord/discord-service.ts)) wrapping `@xhayper/discord-rpc` `Client` with the hardcoded application id `1177081335727267940` ([constants.ts:4](../../src/plugins/discord/constants.ts)). This is a local IPC connection to the Discord desktop client, with no auth or token.
- **`start`** (`main.ts:22-55`): if `enabled`, on `window.once('ready-to-show')` it calls `connect(!autoReconnect)` and registers a song callback. Non-time events update immediately. `TimeChanged` events are debounced to one every 5 s (`TIME_UPDATE_DEBOUNCE_MS`, `main.ts:31-44`). It also requests `peard:setup-time-changed-listener` on `peard:player-api-loaded`.
- **`updateActivity`** (`discord-service.ts:289-376`):
  - It sends immediately when the song, the paused state, or a seek (more than 2 s jump, `utils.ts:97-101`) changes.
  - Otherwise it throttles to once per 15 s (`PROGRESS_THROTTLE_MS`) and schedules a deferred update.
  - `buildActivityInfo` (`:108-146`) builds the payload: `details` = `alternativeTitle ?? title`, `state` = `tags[0] ?? artist`, `largeImageKey` = `imageSrc`, timestamps from `elapsedSeconds`/`songDuration` unless `hideDurationLeft`, and buttons from `utils.ts:52-75`.
  - Strings are trimmed and truncated to 128 characters, and 1-character Hangul fields are padded (`utils.ts:28-89`).
- **Reconnect:** when `autoReconnect` is on, the service retries every 5 s and recreates the RPC client after each failure (`discord-service.ts:188-230, 253-264`).
- **Pause timeout:** `setActivityTimeout` clears the activity after `activityTimeoutTime` ms paused (`:152-169`).
- **`onConfigChange`** (`main.ts:61-70`) connects or disconnects on `enabled` changes and re-applies the activity.

**Config:**

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plugins.discord.enabled` | boolean | `false` | |
| `plugins.discord.autoReconnect` | boolean | `true` | Retry the connection every 5 s |
| `plugins.discord.activityTimeoutEnabled` | boolean | `true` | Clear the activity after a pause |
| `plugins.discord.activityTimeoutTime` | number (ms) | `600000` (10 min) | Pause timeout |
| `plugins.discord.playOnYouTubeMusic` | boolean | `true` | Add the "Play on <app>" button linking to `songInfo.url`. The key is written with `\u` escapes in source (`index.ts:29,53`). |
| `plugins.discord.hideGitHubButton` | boolean | `false` | Hide the "View App On GitHub" button (links to `github.com/pear-devs/pear-desktop`) |
| `plugins.discord.hideDurationLeft` | boolean | `false` | Omit start/end timestamps |
| `plugins.discord.statusDisplayType` | `StatusDisplayType` (discord-api-types) | `StatusDisplayType.Details` | Which field Discord shows in the status line: Name (app), State (artist) or Details (title) |

`restartNeeded: false`. No secrets.

**Menu** ([menu.ts](../../src/plugins/discord/menu.ts)):
- Connection status item. It is clickable to connect while disconnected, and the menu refreshes through `registerRefreshCallback`.
- Auto reconnect checkbox.
- Clear activity.
- Clear activity after timeout checkbox.
- "Play on …" button checkbox.
- Hide GitHub button checkbox.
- Hide duration left checkbox.
- Set inactivity timeout: a prompt in seconds, saved via `setMenuOptions('discord', …)`.
- Status display type radio submenu.

**Files:**
- [index.ts](../../src/plugins/discord/index.ts): config type, defaults, plugin definition.
- [main.ts](../../src/plugins/discord/main.ts): backend lifecycle and song callback.
- [discord-service.ts](../../src/plugins/discord/discord-service.ts): RPC client, activity building, throttling, reconnect.
- [menu.ts](../../src/plugins/discord/menu.ts): menu.
- [constants.ts](../../src/plugins/discord/constants.ts): client id, throttle constants, timer keys.
- [timer-manager.ts](../../src/plugins/discord/timer-manager.ts): keyed `setTimeout` manager.
- [utils.ts](../../src/plugins/discord/utils.ts): truncation, buttons, Hangul padding, seek detection.

**IPC / events:**
- Listens: `peard:player-api-loaded`.
- Sends: `peard:setup-time-changed-listener`.
- Indirect via `registerCallback`: `peard:video-src-changed`, `peard:play-or-paused`, `peard:time-changed`.

**DOM anchors:** none.

**New player bar (2026-10):** unaffected. It uses only `registerCallback` song info; the time feed works on the new bar.

**Gotchas:**
- The connect and the `registerCallback` only happen inside `window.once('ready-to-show')`, and only if `enabled` at `start` (`main.ts:27-45`). If the plugin is turned on after the window is already shown, that event won't fire again. `onConfigChange` may still connect, but no song callback gets registered, so presence likely doesn't update until restart. Whether the loader compensates is unclear from code.
- The `showErrorDialog` branch in `connect()` is empty (`discord-service.ts:261-263`), so a failed manual connect with auto-reconnect off is silent.
- `electronIs` used in `discord-service.ts` is a global set by the generated plugin importer (`vite-plugins/plugin-importer.mts:79`), not an import. The file imports `is` too.

---

## Scrobbler (`scrobbler`)
**What it does:**
- Sends "now playing" updates and scrobbles to **Last.fm** and/or **ListenBrainz**.
- A track is scrobbled once playback passes half its duration or 4 minutes, whichever is first.
- It can skip non-music media, and can use alternative (original-script) titles and the first tag as the artist.

**Why it exists:** It brings listening-history tracking to these services from the desktop app.

**How it works:**
- **Process.** Main process only ([main.ts](../../src/plugins/scrobbler/main.ts)).
- **`start`** (`main.ts:65-116`): `toggleScrobblers` instantiates a `LastFmScrobbler` / `ListenbrainzScrobbler` per enabled service, then `createSessions` runs.
- **Song callback.** `TimeChanged` events are ignored. On any other event the pending timer is cleared. If the track is not paused, the callback checks `scrobbleOtherMedia` against `MediaType.Audio` / `OriginalMusicVideo`. It schedules `addScrobble` at `min(ceil(duration/2), 240) - elapsedSeconds` seconds and calls `setNowPlaying` on every scrobbler.
- **`onConfigChange`** (`:118-141`) rebuilds the scrobbler map and creates a session for any service that was just enabled.
- **Last.fm** ([services/lastfm.ts](../../src/plugins/scrobbler/services/lastfm.ts)): signed API calls, where `api_sig` = md5 of the sorted `key+value` pairs (excluding `format`) plus `secret` (`:214-230`).
  - Session (`createSession`, `:44-82`): calls `auth.getsession` with the stored token. On error it gets a new token via `auth.gettoken` (`:232-253`).
  - It then opens a modal `BrowserWindow` at `https://www.last.fm/api/auth/?api_key=…&token=…` (`authenticate`, `:258-323`). That function watches `did-navigate` and treats `/api/auth` without a `confirm` element as success and `/api/None` as failure.
  - It then retries `auth.getsession` and stores `sessionKey`.
  - Now playing uses `track.updateNowPlaying`; scrobbles use `track.scrobble`. Both are form POSTs to `https://ws.audioscrobbler.com/2.0/` (`:119-183`).
- **ListenBrainz** ([services/listenbrainz.ts](../../src/plugins/scrobbler/services/listenbrainz.ts)): `POST {apiRoot}submit-listens` with the header `Authorization: Token <token>`. The body is `listen_type` `playing_now` or `single`, with `track_metadata` (artist, track, release, `additional_info`) and `listened_at` = now for scrobbles (`:76-127`). There is no session step.

**Config:**

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plugins.scrobbler.enabled` | boolean | `false` | |
| `plugins.scrobbler.scrobbleOtherMedia` | boolean | `true` | Also scrobble UGC, podcasts and other videos |
| `plugins.scrobbler.alternativeTitles` | boolean | `true` | Use `songInfo.alternativeTitle` when present |
| `plugins.scrobbler.alternativeArtist` | boolean | `true` | Use `songInfo.tags[0]` as the artist when present |
| `plugins.scrobbler.scrobblers.lastfm.enabled` | boolean | `false` | |
| `plugins.scrobbler.scrobblers.lastfm.token` | string? | `undefined` | **Secret-ish.** Last.fm auth token |
| `plugins.scrobbler.scrobblers.lastfm.sessionKey` | string? | `undefined` | **Secret.** Last.fm session key (permanent) |
| `plugins.scrobbler.scrobblers.lastfm.apiRoot` | string | `'https://ws.audioscrobbler.com/2.0/'` | Used for token and session calls only |
| `plugins.scrobbler.scrobblers.lastfm.apiKey` | string | `'04d76faaac8726e60988e14c105d421a'` | Last.fm API key, hardcoded default |
| `plugins.scrobbler.scrobblers.lastfm.secret` | string | `'a5d2a36fdf64819290f6982481eaffa2'` | **Secret.** Last.fm API secret, hardcoded default |
| `plugins.scrobbler.scrobblers.listenbrainz.enabled` | boolean | `false` | |
| `plugins.scrobbler.scrobblers.listenbrainz.token` | string? | `undefined` | **Secret.** ListenBrainz user token |
| `plugins.scrobbler.scrobblers.listenbrainz.apiRoot` | string | `'https://api.listenbrainz.org/1/'` | |

`restartNeeded: true`. All secrets are stored in plain text in the config store.

**Menu** ([menu.ts](../../src/plugins/scrobbler/menu.ts)):
- Scrobble other media checkbox.
- Use alternative title checkbox.
- Use alternative artist checkbox.
- **Last.fm** submenu: Enabled checkbox; API settings (multi-input prompt for API key and secret).
- **ListenBrainz** submenu: Enabled checkbox; Token prompt.

**Files:**
- [index.ts](../../src/plugins/scrobbler/index.ts): config type, defaults, plugin definition.
- [main.ts](../../src/plugins/scrobbler/main.ts): backend, scrobble timing.
- [menu.ts](../../src/plugins/scrobbler/menu.ts): menu and prompts.
- [services/base.ts](../../src/plugins/scrobbler/services/base.ts): abstract `ScrobblerBase`.
- [services/lastfm.ts](../../src/plugins/scrobbler/services/lastfm.ts): Last.fm auth, signing, API calls.
- [services/listenbrainz.ts](../../src/plugins/scrobbler/services/listenbrainz.ts): ListenBrainz submission.

**IPC / events:** none directly. Indirect via `registerCallback`: `peard:video-src-changed`, `peard:play-or-paused` (it ignores `peard:time-changed`).

**DOM anchors:** none. The Last.fm auth window checks `document.getElementsByName('confirm')` on last.fm, not on YouTube.

**New player bar (2026-10):** unaffected. It only uses `registerCallback` song info.

**Gotchas:**
- The Last.fm scrobble `timestamp` is `trunc((Date.now() - elapsedSeconds) / 1000)` (`lastfm.ts:112-114`). It subtracts seconds from milliseconds, so the timestamp is effectively "now", not the track start.
- Scrobble and now-playing POSTs use a hardcoded `https://ws.audioscrobbler.com/2.0/` and ignore `apiRoot` (`lastfm.ts:154`).
- The "error 9 → re-auth" path in `postSongDataToAPI` (`lastfm.ts:158-181`) runs in `.catch()` on `net.fetch`. It only fires if fetch *rejects* with `error.response.data.error === 9`, so API-level errors returned with a 200/4xx body are not handled there.
- `authenticate()`'s second-caller path is a busy loop `while (authWindowOpened) {}` (`lastfm.ts:315-320`). If it is ever reached, it would block the main process.
- Pausing cancels the pending scrobble timer. Resuming reschedules it from the current `elapsedSeconds`.
- The menu "Enabled" click calls `backend.toggleScrobblers(config, window)` *before* flipping the flag (`menu.ts:125-127`). `onConfigChange` rebuilds the map afterwards anyway.

---

## Lumia Stream [Beta] (`lumiastream`)
**What it does:** Pushes the current song (title, artist, album, cover, progress, duration, play/pause status, URL, ids, views) to the local **Lumia Stream** app, so streamers can drive lights and overlays from it.

**Why it exists:** It integrates with Lumia Stream's media API.

**How it works:** Main process only; the whole plugin is in [index.ts](../../src/plugins/lumiastream/index.ts).
- On `peard:player-api-loaded` it requests `peard:setup-time-changed-listener` (`:69-71`).
- Every `registerCallback` event with a title or artist builds `LumiaData` and calls `post()` (`:73-99`). Times are in ms, and `origin` is the escaped string `youtubemusic`.
- `post()` (`:44-67`) sends `net.fetch POST http://127.0.0.1:39231/api/media` with body `{token: 'lsmedia_ytmsI7812', data}`. Errors are only logged to the console.

**Config:**

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plugins.lumiastream.enabled` | boolean | `false` | |

`restartNeeded: true`. The fixed token `lsmedia_ytmsI7812` is hardcoded in source (`:57`), not in config. The port `39231` is hardcoded.

**Menu:** none.

**Files:** [index.ts](../../src/plugins/lumiastream/index.ts) (everything).

**IPC / events:**
- Listens: `peard:player-api-loaded`.
- Sends: `peard:setup-time-changed-listener`.
- Indirect via `registerCallback`: `peard:video-src-changed`, `peard:play-or-paused`, `peard:time-changed`.

**DOM anchors:** none.

**New player bar (2026-10):** unaffected. It only uses `registerCallback` song info.

**Gotchas:**
- `previousStatePaused` is declared `const … = null` and never updated (`:36, 78-82`), so `eventType` is always `'switchSong'` and `'playPause'` is never sent.
- It posts on every `TimeChanged` (about once per second while playing), whether or not Lumia is running.

---

## Tuna OBS (`tuna-obs`)
**What it does:** Pushes the current song (title, alternative title, artists, album, cover, duration/progress in ms, playing/stopped, URL, tags) to the **Tuna** OBS plugin's local web server, so OBS overlays can show "now playing".

**Why it exists:** It integrates with OBS via Tuna's HTTP input.

**How it works:** Main process only, in [index.ts](../../src/plugins/tuna-obs/index.ts).
- It requests `peard:setup-time-changed-listener` on `peard:player-api-loaded` (`:75-77`).
- On each `registerCallback` event with a title or artist, it calls `post()` (`:79-98`).
- `post()` (`:36-73`) sends `net.fetch` to `http://127.0.0.1:1608/` with body `{data}`, `keepalive: true` and CORS-ish headers.
- **Lite mode:** on the first failure it sets `this.liteMode = true`. From then on it sends bodiless `OPTIONS` probes. When a probe succeeds it turns lite mode off and immediately re-POSTs the data. Errors are logged only in dev.

**Config:**

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plugins.tuna-obs.enabled` | boolean | `false` | |

`restartNeeded: true`. The port `1608` is hardcoded. No secrets.

**Menu:** none.

**Files:** [index.ts](../../src/plugins/tuna-obs/index.ts) (everything; backend is an object with a `liteMode` field and `start`).

**IPC / events:**
- Listens: `peard:player-api-loaded`.
- Sends: `peard:setup-time-changed-listener`.
- Indirect via `registerCallback`: `peard:video-src-changed`, `peard:play-or-paused`, `peard:time-changed`.

**DOM anchors:** none.

**New player bar (2026-10):** unaffected. It only uses `registerCallback` song info.

**Gotchas:** It posts (or probes) on every time tick, about once per second while playing. There is no `stop()`, so the callback stays registered until restart (`restartNeeded: true`).

---

## Music Together [Beta] (`music-together`)
**What it does:** Adds a button to the top nav bar for **hosting** or **joining** a shared listening session.
- The host's peer id is the room code; it is copied to the clipboard.
- Guests paste it into a prompt.
- Everyone's queue is kept in sync, with an owner avatar and name shown on each queue item.
- The host's playback position, play/pause state and current index are pushed to guests every second.
- The host sets the guest permission: `host-only`, `playlist` (guests can edit the queue and change the track) or `all` (guests can also seek and play/pause).

**Why it exists:** It provides "listen together" without any server of its own, peer-to-peer over WebRTC.

**How it works:**
- **Backend** (`index.ts:92-101`) only registers `ipc.handle('music-together:prompt')`, which shows a `custom-electron-prompt` input. The renderer uses it to ask for the host id (`index.ts:736-737, 396-399`).
- **Renderer `start`** (`index.ts:734-906`):
  - It injects [templates/setting.html](../../src/plugins/music-together/templates/setting.html) before `#right-content > ytmusic-settings-button`.
  - It creates three popups: setting (Host / Join), host (copy id, cycle permission, close) and guest (disconnect). They are built with [element.ts](../../src/plugins/music-together/element.ts) and [ui/*](../../src/plugins/music-together/ui/status.ts).
  - It starts a 1 s interval that, in host mode, broadcasts `SYNC_PROGRESS {progress, state, index}` (`:765-774`).
  - It calls `initMyProfile()`, which clicks the account button, scrapes `ytd-active-account-header-renderer.data` for name, handle and photo, then clicks again to close the menu (`:693-731`).
- **`onPlayerApiReady`** (`:907-922`): creates the `Queue` wrapper and subscribes to the player API `onStateChange` and `document` `videodatachange`.
- **Transport** ([connection.ts](../../src/plugins/music-together/connection.ts)):
  - `new Peer({debug: 0, config: {iceServers}})` from `peerjs`. No `host` option is passed, so PeerJS's default signalling server is used.
  - ICE servers: Google STUN, `eu-0`/`us-0.turn.peerjs.com:3478` (user `peerjs` / `peerjsp`), and `freestun.net` STUN/TURN (`free`/`free`) (`:49-73`).
  - The host waits for `open`, which gives its id. A guest calls `peer.connect(id, {reliable: true})`.
  - A network error triggers `peer.reconnect()` after 10 s.
  - Incoming data must be an object with `type` and `payload`, or it is dropped (`:202-217`).
  - `broadcast()` sends to every open connection, so a guest's only connection is the host (`:165-175`).
- **Queue bridge** ([queue/queue.ts](../../src/plugins/music-together/queue/queue.ts)):
  - It wraps `#queue` and its Redux-like store `queue.queue.store.store`.
  - `injection()` (`:301-488`) monkey-patches `store.dispatch`. User-originated (non-internal) `CLEAR`, `ADD_ITEMS`, `MOVE_ITEM`, `REMOVE_ITEM` and `SET_INDEX` actions are **swallowed** and turned into protocol events for the plugin's listener: `CLEAR_QUEUE`, `ADD_SONGS` (+ `after: SET_INDEX` when a new list is played), `MOVE_SONG`, `REMOVE_SONG`, and `SYNC_PROGRESS {index}` respectively.
  - It also rewrites `SET_HEADER` to a "Music Together" header, turns `ADD_STEERING_CHIPS` into `CLEAR_STEERING_CHIPS`, blocks `SET_PLAYER_UI_STATE: INACTIVE` while the list is non-empty, and drops `HAS_SHOWN_AUTOPLAY` and `ADD_AUTOMIX_ITEMS`.
  - To apply events, it dispatches with `internalDispatch = true`.
  - To materialise remote video ids, it calls `ytmusic-app.networkManager.fetch('/music/get_queue', {queueContextParams, videoIds})` ([queue/song.ts](../../src/plugins/music-together/queue/song.ts)), then dispatches `ADD_ITEMS` / `UPDATE_ITEMS`. Only `{videoId, ownerId}` pairs travel over the wire.
  - `syncQueueOwner()` appends `img.music-together-owner` and `div.music-together-name` to each `ytmusic-player-queue-item` (`:537-586`).

Protocol. The message envelope is `{type, payload, after?: Event[]}`. `after` is a chain of follow-up events that the receiver processes in order (`index.ts:372-378`). Event types are listed in `connection.ts:5-19`:

| Event | Payload | Host handling (`index.ts:211-379`) | Guest handling (`index.ts:463-584`) |
|---|---|---|---|
| `CLEAR_QUEUE` | `null` | From a guest under `host-only`, it replies with `SYNC_QUEUE` instead. Otherwise it clears and rebroadcasts. | Clear the local queue |
| `ADD_SONGS` | `{videoList, index?}` | Same `host-only` guard. Otherwise it fills `ownerId` (sender's peer id), adds, rebroadcasts with `after`, and applies a trailing `SET_INDEX`. | Add the videos; apply a trailing `SET_INDEX` |
| `REMOVE_SONG` | `{index}` | `host-only` guard; otherwise remove and rebroadcast | Remove |
| `MOVE_SONG` | `{fromIndex, toIndex}` | `host-only` guard; otherwise move and rebroadcast | Move |
| `SET_INDEX` | `{index}` | Set and rebroadcast (no permission check) | Set the index |
| `IDENTIFY` | `{profile}` | Store the sender's profile and show a toast | Warn and ignore |
| `SYNC_PROFILE` | `{profiles}` / `undefined` | Broadcast all profiles (request) | Merge profiles |
| `SYNC_QUEUE` | `{videoList}` / `undefined` | Broadcast the host's `videoList` (request) | `setVideoList` → `syncVideo()` (`/music/get_queue` + `UPDATE_ITEMS`) |
| `SYNC_PROGRESS` | `{progress?, state?, index?}` | Permission level: `all`=2, `playlist`=1, `host-only`=0, local=3. At ≥2 it seeks if the difference is over 3 s and applies play (1) / pause (2). At ≥1 it applies the index. | Seek if the difference is over 3 s, apply play/pause and the index |
| `PERMISSION` | `Permission` / `undefined` | Broadcast the host's permission (a guest's payload is ignored) | Store it, update the popups, show a toast |
| `CONNECTION_CLOSED` | `null` | Local only: detach the queue listener | Local only: detach the queue listener |

- **Join sequence** (guest, `index.ts:389-647`):
  1. Connect and inject the queue.
  2. Patch `_update` on every `tp-yt-paper-progress`. A user seek (more than 3 s away) under `all` broadcasts `SYNC_PROGRESS`.
  3. Send `IDENTIFY {profile}`, then `SYNC_PROFILE`, then `PERMISSION`.
  4. Clear and init the local queue.
  5. Send `SYNC_QUEUE` (a request).
- **Guest local changes:** local queue edits go to the host via `queueListener` (`:414-462`). Under `host-only`, a local `SYNC_PROGRESS` becomes a `SYNC_QUEUE` request instead. Guest player state changes are sent as `SYNC_PROGRESS {state}` only under `all` (`:146-159`).
- **Host `videodatachange` (`dataloaded`):** rebuilds `videoList` from the store and broadcasts `SYNC_QUEUE` (`:121-144`).
- **Permission cycle** in the host popup (`index.ts:804-827`): `playlist` → `all` → `host-only` → `playlist`. The default is `playlist` (`:105`).

**Config:**

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plugins.music-together.enabled` | boolean | `false` | |

`restartNeeded: false`. The permission and profiles are in-memory only. The TURN credentials are hardcoded in `connection.ts` (public `peerjs` / `free` accounts).

**Menu:** none in the app menu. The UI is the injected nav-bar button and popups. It also ships `stylesheets: [style.css]`.

**Files:**
- [index.ts](../../src/plugins/music-together/index.ts): plugin definition, backend prompt handler, host/guest logic, UI wiring.
- [connection.ts](../../src/plugins/music-together/connection.ts): PeerJS wrapper and event types.
- [types.ts](../../src/plugins/music-together/types.ts): `Profile`, `VideoData`, `Permission`, `getDefaultProfile` (avatar from `ui-avatars.com`).
- [queue/queue.ts](../../src/plugins/music-together/queue/queue.ts): store dispatch injection, queue ops, owner badges.
- [queue/song.ts](../../src/plugins/music-together/queue/song.ts): `/music/get_queue` fetch.
- [queue/utils.ts](../../src/plugins/music-together/queue/utils.ts): `mapQueueItem`, which unwraps `playlistPanelVideoWrapperRenderer`.
- [queue/client.ts](../../src/plugins/music-together/queue/client.ts): SAPISIDHASH and InnerTube client helpers. **Unused**; nothing imports it.
- [queue/sha1hash.ts](../../src/plugins/music-together/queue/sha1hash.ts): SHA-1 via `crypto.subtle`.
- [element.ts](../../src/plugins/music-together/element.ts): `Popup` and `ItemRenderer`.
- [ui/host.ts](../../src/plugins/music-together/ui/host.ts), [ui/guest.ts](../../src/plugins/music-together/ui/guest.ts), [ui/setting.ts](../../src/plugins/music-together/ui/setting.ts): the three popups.
- [ui/status.ts](../../src/plugins/music-together/ui/status.ts): status, permission and user-list block.
- [templates/*.html](../../src/plugins/music-together/templates/setting.html): button, popup, item and status markup.
- [style.css](../../src/plugins/music-together/style.css): styles.
- `icons/*.svg`: icons.

**IPC / events:**
- `music-together:prompt` (renderer `invoke` → backend `handle`).
- DOM/player events: `document` `videodatachange`, and player API `onStateChange`.
- It does not use `registerCallback` or the `peard:*` channels.

**DOM anchors:**
- `#right-content > ytmusic-settings-button`: nav bar; the injection point (`index.ts:741-743`).
- `#right-content > ytmusic-settings-button *:where(tp-yt-paper-icon-button,yt-icon-button,.ytmusic-settings-button)`: the account button (`:694-695`).
- `ytd-active-account-header-renderer` (`.data`) (`:703-704`).
- `ytmusic-settings-button > tp-yt-paper-icon-button > tp-yt-iron-icon#icon img`: avatar (`ui/status.ts:10-12`).
- `tp-yt-paper-progress` (`._update`): guest seek hook (`index.ts:596-602`).
- `#queue` (`.queue.store.store` getState/dispatch, `.dispatch`) (`queue/queue.ts:131,147,189-203,307`).
- `ytmusic-app` (`.toastService`, `.networkManager`) (`index.ts:738`, `queue/song.ts:16`).
- `#contents > ytmusic-player-queue-item` and the wrapper-renderer variant (`queue/queue.ts:543`).
- `ytmusic-player-queue-item` (`:593`).

**New player bar (2026-10):** partially affected.
- The guest seek broadcast patches `_update` on `tp-yt-paper-progress`, which is the internals of the old `#progress-bar` slider. The new bar's seek bar is a native `input.ytMusicMiniPlayerProgressBar` (see [../player-bar.md](../player-bar.md)). The query probably returns nothing now, so guest-initiated seeks under permission `all` likely stop being sent. This fails silently, because the empty list is not checked.
- Host→guest sync is unaffected: it comes from the 1 s interval and the player API. So are queue sync (`#queue` store and `ytmusic-app.networkManager`, both still present) and guest play/pause (`onStateChange`).
- The nav-bar and account anchors are not part of the player bar and are not on the dead list. They are unverified.

**Gotchas:**
- There is no auth: anyone with the host's peer id can join. Signalling goes through PeerJS's default public server, and TURN uses public shared credentials.
- `store.dispatch` monkey-patching swallows the user's own queue actions and re-applies them through the host round-trip. If the session state breaks, queue edits can appear to "do nothing". `onStop` restores the original dispatch via `rollbackInjection()`.
- The popups are appended to `document.body` (`element.ts:61`) and are never removed in `stop()`. Only the nav button and dividers are removed.
- `initMyProfile` visibly opens and closes the account menu at startup.
- `getDefaultProfile` loads avatars from `ui-avatars.com`, sending the guest name to a third party.

---

## Amuse (`amuse`)
**What it does:** Serves the current song as JSON on `http://<host>:9863/query` (and `/api`) for the **Amuse** now-playing widget by 6K Labs. `GET /` returns a short text message.

**Why it exists:** Amuse polls a local endpoint in a fixed format; this plugin speaks that format.

**How it works:** Main process only ([backend.ts](../../src/plugins/amuse/backend.ts)).
- `start` (`:38-64`) caches the latest `SongInfo` via `registerCallback` and creates a `hono` app with `cors()`.
- Routes: `GET /` → `t('plugins.amuse.response.query')`; `GET /query` and `GET /api` → `formatSongInfo()`.
- It serves with `@hono/node-server` on port `9863`. No hostname is passed, so the binding is the library default (unclear from code).
- Response shape ([types.ts](../../src/plugins/amuse/types.ts)): `{player: {hasSong, isPaused, seekbarCurrentPosition}, track: {duration, title, author, cover, url, id, isAdvertisement: false}}` (`backend.ts:14-32`).
- `stop` closes the server.

**Config:**

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plugins.amuse.enabled` | boolean | `false` | |

`restartNeeded: true`. The port is hardcoded. No auth and no secrets.

**Menu:** none.

**Files:**
- [index.ts](../../src/plugins/amuse/index.ts): plugin definition.
- [backend.ts](../../src/plugins/amuse/backend.ts): HTTP server.
- [types.ts](../../src/plugins/amuse/types.ts): response types.

**IPC / events:** none directly. Indirect via `registerCallback`: `peard:video-src-changed`, `peard:play-or-paused`, `peard:time-changed`.

**DOM anchors:** none.

**New player bar (2026-10):** unaffected. It only uses `registerCallback` song info.

**Gotchas:**
- It never requests `peard:setup-time-changed-listener`. `seekbarCurrentPosition` therefore only updates on song change and play/pause, unless another enabled plugin (discord, api-server, lumiastream, tuna-obs, …) has requested the time listener.
- It imports `t` from `i18next` directly rather than `@/i18n`.
- `registerCallback` is not unregistered on `stop`.

---

## Auth Proxy Adapter (`auth-proxy-adapter`)
**What it does:** Runs a local **SOCKS5** server, by default `127.0.0.1:4545`, with no authentication. It relays every CONNECT through the upstream proxy configured in the app's global `options.proxy` (for example `socks5://user:pass@host:port`), including that proxy's username and password. When the plugin is enabled, the app routes its traffic through this local adapter.

**Why it exists:** It lets the app use proxy services that require authentication. The app's `--proxy-server` switch is pointed at a credential-free local endpoint, and the adapter adds the credentials upstream. That Chromium can't carry SOCKS credentials itself is the implied reason, but it is not stated in code.

**How it works:**
- **Wiring is in the app entry, not the plugin.** At startup, `src/index.ts:142-161` checks `options.proxy`. If it is set **and** the plugin is enabled, it calls `app.commandLine.appendSwitch('proxy-server', 'socks5://<hostname>:<port>')` using the plugin config. Otherwise it uses `options.proxy` directly.
- **Backend** ([backend/index.ts](../../src/plugins/auth-proxy-adapter/backend/index.ts)):
  - `startServer` (`:53-97`) runs `net.createServer`. It reads `config.get('options.proxy')` once, accepts only the SOCKS5 greeting (`0x05`) and closes anything else.
  - `handleSocks5` (`:100-124`) accepts only the "no auth" method (`0x00`); otherwise it replies `0x05 0xff`.
  - `processSocks5Request` (`:127-236`) supports only CMD `0x01` CONNECT (otherwise replies `0x07`). It parses an IPv4, domain or IPv6 target.
  - `parseSocksUrl` (`:16-27`) uses `new URL`; the type is 5 if the protocol is `socks5:`, else 4.
  - It then calls `SocksClient.createConnection` (`socks` package) with the upstream `userId`/`password`, replies success, and pipes the sockets both ways. On failure it replies `0x05 0x05`.
- `onConfigChange` (`:37-49`) restarts the server on hostname or port changes.

**Config:**

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plugins.auth-proxy-adapter.enabled` | boolean | `false` | |
| `plugins.auth-proxy-adapter.hostname` | string | `'127.0.0.1'` | Local SOCKS5 bind address, also used in `--proxy-server` |
| `plugins.auth-proxy-adapter.port` | number | `4545` | Local SOCKS5 port |

`restartNeeded: true`, because the Chromium proxy switch is only applied at startup. The upstream credentials are **not** in plugin config; they live in plain text inside `options.proxy`.

**Menu:** Hostname prompt and Port prompt (counter 0..65535) ([menu.ts](../../src/plugins/auth-proxy-adapter/menu.ts)).

**Files:**
- [index.ts](../../src/plugins/auth-proxy-adapter/index.ts): plugin definition.
- [config.ts](../../src/plugins/auth-proxy-adapter/config.ts): config and defaults.
- [menu.ts](../../src/plugins/auth-proxy-adapter/menu.ts): menu.
- [backend/index.ts](../../src/plugins/auth-proxy-adapter/backend/index.ts): SOCKS5 server and relay.
- [backend/types.ts](../../src/plugins/auth-proxy-adapter/backend/types.ts): backend state type.
- Wiring: `src/index.ts:142-161`.

**IPC / events:** none.

**DOM anchors:** none.

**New player bar (2026-10):** unaffected. It is a pure network layer in the main process.

**Gotchas:**
- The plugin does nothing unless `options.proxy` is set; `src/index.ts` only enters the proxy block when it is.
- The `if (!socksProxy)` check (`:172`) is dead code. `parseSocksUrl` throws on an empty or invalid URL instead of returning a falsy value, and the throw is not caught inside the `data` handler.
- If the target address type is unrecognised, the destination falls back to the adapter's own default `127.0.0.1:4545` (`:190-193`).
- Any upstream scheme other than `socks5:` (including `http:`) is treated as SOCKS4.
- Changing hostname or port at runtime restarts the local server, but Chromium keeps using the old `--proxy-server` until the app restarts.
- `options.proxy` is read once per `startServer`, so changing it needs a plugin or app restart.
