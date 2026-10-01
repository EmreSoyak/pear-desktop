# Content & library plugins

Plugins that fetch, filter or save the *content* being played: downloading audio, lyrics, captions, skipping segments/disliked songs, bulk like/dislike on album/playlist pages, and a renderer performance patch. All seven are upstream (pear-desktop) code, untouched by this fork. Written from a static read of the code on 2026-10-01. The new-bar column checks each plugin against the 2026-10-01 YouTube Music redesign, which replaced `ytmusic-player-bar` with `ytmusic-miniplayer`.

| Plugin | Summary | Default enabled | New player bar (2026-10) |
|---|---|---|---|
| [Downloader](#downloader-downloader) | Download the current/selected song or a whole playlist via youtubei.js + ffmpeg.wasm (mp3 / source / custom preset). | no | partially affected |
| [Synced Lyrics](#synced-lyrics-synced-lyrics) | Replaces the Lyrics tab with time-synced lyrics from YTMusic / LRCLib / MusixMatch / Genius, with romanization. | no (user has it **enabled**) | unaffected |
| [Captions Selector](#captions-selector-captions-selector) | Player-bar button to pick a caption track, and can autoload or disable captions. | no | likely broken |
| [SponsorBlock](#sponsorblock-sponsorblock) | Skips SponsorBlock segments (intro, outro, sponsor, non-music…) by seeking the `<video>`. | no | unaffected |
| [Skip Disliked Songs](#skip-disliked-songs-skip-disliked-songs) | Presses Next when the current song becomes disliked. | no | likely broken |
| [Album Actions](#album-actions-album-actions) | Adds Undislike / Dislike / Like / Unlike-all buttons to album/playlist headers. | no | unaffected |
| [Performance improvement [Beta]](#performance-improvement-beta-performance-improvement) | Injects two third-party userscripts (rm3 element recycling, CPU tamer timer throttling). | **yes** | unaffected |

Shared context:
- Default-enabled values come from each plugin's `config.enabled`. A plugin with no `config` (only `skip-disliked-songs` here) defaults to `{ enabled: false }` ([config/plugins.ts:16](../../src/config/plugins.ts)).
- `restartNeeded` is read in [src/index.ts:231](../../src/index.ts).
- `peard:video-src-changed` (renderer → main, a `GetPlayerResponse`) and the `peard:src-changed` CustomEvent on `<video>` both come from [providers/song-info-front.ts](../../src/providers/song-info-front.ts), driven by the player API's `videodatachange` (lines ~370-455). They do not depend on the player bar.
- `peard:update-song-info` (main → renderer, a `SongInfo`) is sent from [providers/song-info.ts:167](../../src/providers/song-info.ts).

---

## Downloader (`downloader`)
**What it does:**
- Adds a "Download" entry to YouTube Music's popup (⋮) menus for songs, videos, albums and playlists. Clicking it downloads the track, or every track of the album/playlist, to disk.
- The app menu offers "Download playlist", a download folder, an ffmpeg preset, "skip existing", and "download on finish". Download on finish auto-saves a song you listened to past a threshold.
- Progress is shown in the menu entry text, on the taskbar progress bar, and, during playlist downloads, as a remaining-count badge on Linux/macOS.

**Why it exists:** YouTube Music has no offline file export. This saves audio files, with ID3 tags and cover art for mp3.

**How it works:**
- *Renderer* ([renderer.tsx](../../src/plugins/downloader/renderer.tsx)):
  - `onPlayerApiReady` (l.90) builds a `div.menu-item.ytmusic-menu-popup-renderer` containing the `DownloadButton` template, an `<a id="navigation-endpoint">` styled as a native menu item.
  - A `MutationObserver` on `ytmusic-popup-container` (l.109, non-null asserted) prepends that div into `getSongMenu()`. `getSongMenu()` is `ytmusic-menu-popup-renderer tp-yt-paper-listbox`, from [providers/dom-elements.ts:3](../../src/providers/dom-elements.ts). The div is only added when [utils/renderer/check.ts](../../src/plugins/utils/renderer/check.ts) `isMusicOrVideoTrack()` or `isAlbumOrPlaylist()` finds an `addToPlaylistEndpoint`/`watchEndpoint` in the menu's `#navigation-endpoint` items. `isPlayerMenu` is **not** used.
  - On click, `download()` (l.43) takes the href of `ytmusic-menu-navigation-item-renderer[tabindex="0"] #navigation-endpoint`. It falls back to a `podcast/` link in a `[tabindex="-1"]` item, then to `getSongInfo().url || location.href`.
  - It normalises `watch?…` and `podcast/…` hrefs to `https://music.youtube.com/watch?v=…`.
  - A `?playlist=` URL goes to `ipc.invoke('download-playlist-request')`. Anything else goes to `ipc.invoke('download-song')`.
  - `downloader-feedback` messages set the button text. An empty message resets it to the default label.
- *Backend* ([main/index.ts](../../src/plugins/downloader/main/index.ts)):
  - `onMainLoad` (l.141) creates an `Innertube` client (youtubei.js) with the window's music.youtube.com cookies (`getCookieFromWindow`, l.129) and Electron `net` fetch.
  - It then tries to mint a PO token with `bgutils-js` BotGuard: `happy-dom` provides a fake `window`/`document`, and the interpreter JS runs via `new Function` (l.156-213). Failures are swallowed.
  - It overrides `Platform.shim.eval` (l.57) so youtubei.js can evaluate the n/sig deobfuscation code.
- *Single song* (`downloadSongUnsafe`, l.327):
  1. Get the video id from `?v=` and call `yt.music.getInfo(id)`.
  2. `LOGIN_REQUIRED` triggers an age-gate bypass, `yt.getBasicInfo(id, {client:'TV_EMBEDDED'})` (l.870). `UNPLAYABLE` throws.
  3. Choose the preset: `Custom` uses `config.customPresetSetting`, `Source` uses the `Source` preset, and anything else uses `mp3 (256kbps)` (l.403-411).
  4. Choose the format with `chooseFormat({type: isPremium() ? 'audio' : 'video+audio', quality:'best', format:'any'})`. `isPremium` (l.81) runs `executeJavaScript`: it reads `yt.config_.LOGGED_IN`, then checks whether a "YouTube Music" upgrade entry exists in `ytmusic-guide-entry-renderer`.
  5. Pick the file extension: `preset.extension`, or if that is falsy, the container from `VideoFormatList` for that itag ([types.ts](../../src/plugins/downloader/types.ts)), or `mp3`.
  6. Build the file name: `filenamify("Artist - Title.ext")`, NFC-normalised except on macOS. With `skipExisting`, an existing file means skip.
  7. Download the stream in chunks, then run it through `@ffmpeg.wasm/main` (lazy-loaded, one job at a time behind `ffmpegMutex`) with `-i in <preset ffmpegArgs> -metadata title/artist/album/track out.ext` (l.515-586).
  8. For mp3, write ID3 tags with `node-id3`: title, artist, album, track number, and a PNG cover via `getImage`, with 1280×720 thumbnails cropped to the centre 720×720 ([main/utils.ts:11](../../src/plugins/downloader/main/utils.ts)).
  9. `writeFileSync` the result. Errors open an info dialog (`sendError`, l.104).
- *Playlist* (`downloadPlaylist`, l.633):
  1. Get the playlist id from `list`/`playlist` in the given URL, the window URL, or the last `playingUrl`. An `RDAMPL` prefix is stripped (l.839).
  2. Load `yt.music.getPlaylist` and every continuation, keeping only `MusicResponsiveListItem` entries.
  3. If there is one item, download it as a single song. Otherwise create `<downloadFolder>/<playlist title>/`. If the folder exists, abort unless `skipExisting` is on.
  4. Download the tracks one after another. An album (a header with no title) gets track numbers.
- *Download on finish* (`downloadSongOnFinishSetup`, l.272):
  - `registerCallback` on main-side song info tracks the highest `elapsedSeconds` from `SongInfoEvent.TimeChanged`, which maps to `peard:time-changed` ([providers/song-info.ts:238](../../src/providers/song-info.ts)).
  - When a new, non-paused URL arrives, the **previous** song is downloaded if it met the threshold: `seconds` mode means `duration - time <= seconds`, and `percent` mode means `time >= duration*percent/100`. The target folder is `downloadOnFinish.folder ?? downloadFolder ?? Downloads`.
  - On `peard:player-api-loaded` it sends `peard:setup-time-changed-listener` so the renderer starts emitting time.

**Config:** (`restartNeeded: true`)

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plugins.downloader.enabled` | boolean | `false` | |
| `plugins.downloader.downloadFolder` | string? | `undefined` (= OS Downloads) | Target folder |
| `plugins.downloader.downloadOnFinish.enabled` | boolean | `false` | Auto-download a song after it has been listened to |
| `plugins.downloader.downloadOnFinish.mode` | `'seconds'`\|`'percent'` | `'seconds'` | Threshold type |
| `plugins.downloader.downloadOnFinish.seconds` | number | `20` | Download if ≤ N s were left unplayed |
| `plugins.downloader.downloadOnFinish.percent` | number | `10` | Download if ≥ N % was played |
| `plugins.downloader.downloadOnFinish.folder` | string? | `undefined` | Separate folder for auto-downloads |
| `plugins.downloader.selectedPreset` | string | `'mp3 (256kbps)'` | `mp3 (256kbps)` (`-b:a 256k`), `Source` (`-acodec copy`, extension from itag), `Custom` |
| `plugins.downloader.customPresetSetting` | `{extension?, ffmpegArgs[]}` | the mp3 preset | Used when `selectedPreset === 'Custom'` |
| `plugins.downloader.skipExisting` | boolean | `false` | Skip files or playlist folders that already exist |
| `plugins.downloader.playlistMaxItems` | number? | `undefined` | **Declared but never read** |

**Menu:** ([menu.ts](../../src/plugins/downloader/menu.ts))
- Download-on-finish submenu: enabled checkbox, a folder chooser, Mode (seconds/percent radio), and Advanced. Advanced is a `custom-electron-prompt` multiInput for the seconds and percent values.
- Download playlist: `downloadPlaylist()` with no argument, which uses the current window URL.
- Choose download folder.
- Presets: radio list of `DefaultPresetList` keys.
- Skip existing: checkbox.

**Files:**
- [index.ts](../../src/plugins/downloader/index.ts): plugin definition and default config.
- [main/index.ts](../../src/plugins/downloader/main/index.ts): backend pipeline (Innertube, PO token, ffmpeg, ID3, playlists, download on finish).
- [main/utils.ts](../../src/plugins/downloader/main/utils.ts): `getFolder`, `sendFeedback`, `cropMaxWidth`, `setBadge`.
- [renderer.tsx](../../src/plugins/downloader/renderer.tsx): menu-item injection and URL resolution.
- [menu.ts](../../src/plugins/downloader/menu.ts): app menu.
- [templates/download.tsx](../../src/plugins/downloader/templates/download.tsx): the Download menu-item JSX.
- [types.ts](../../src/plugins/downloader/types.ts): `Preset`, `DefaultPresetList`, and `VideoFormatList`, an itag-to-container table.
- [style.css](../../src/plugins/downloader/style.css): `.ytmd-menu-item` styling.

**IPC / events:**
- `download-song` (invoke, renderer → main, url)
- `download-playlist-request` (invoke, url)
- `downloader-feedback` (main → renderer, string or undefined)
- Listens to `peard:video-src-changed`, which stores `playingUrl` from `microformat.microformatDataRenderer.urlCanonical`.
- Listens to `peard:player-api-loaded` through raw `ipcMain`.
- Sends `peard:setup-time-changed-listener`.

**DOM anchors:**
- `ytmusic-popup-container`, `ytmusic-menu-popup-renderer tp-yt-paper-listbox`, `tp-yt-paper-listbox #navigation-endpoint`
- `ytmusic-menu-navigation-item-renderer[tabindex="0"|"-1"] #navigation-endpoint`
- Main side, via `executeJavaScript`: `iron-iconset-svg[name="yt-sys-icons"] #youtube_music_monochrome` and `ytmusic-guide-entry-renderer:has(...)`.

**New player bar (2026-10):** partially affected. Two separate issues:
- **Menu entry from the bar.** Injection relies on the old popup stack (`ytmusic-popup-container`/`ytmusic-menu-popup-renderer`, unverified after the redesign). Whether the new bar's ⋮ `button[aria-label=MORE]` in `.ytMusicMiniPlayerRightSection` opens that same popup is **unverified**. Song-row menus elsewhere in the app use the same path and do not depend on the bar. If `ytmusic-popup-container` were missing, `observe(null!)` in `onPlayerApiReady` would throw and no button would ever be injected.
- **Download on finish.** It needs `peard:time-changed`.
  - At `HEAD`, `setupTimeChangedListener` only observed `#progress-bar`, which is dead. `time` then stays 0, so it effectively never triggers. Edge case: seconds mode reduces to `duration <= seconds` and still fires for tracks shorter than the threshold (20 s by default).
  - The **uncommitted working-tree** [song-info-front.ts](../../src/providers/song-info-front.ts) (l.39-67) adds a fallback that sends time on the `<video>` `timeupdate` event once per whole second. This restores it until that change is committed.

**Gotchas:**
- Auto-download passes its folder as the `playlistFolder` argument (l.297-312). In `downloadSongUnsafe`, a set `playlistFolder` suppresses `sendFeedback` and the progress bar, so auto-downloads run silently.
- Non-premium accounts (as detected by the guide-icon heuristic) download `video+audio`, then transcode.
- `Custom` preset settings have no menu editor; edit `customPresetSetting` in the config file. A `>=2.1.0` migration in [config/store.ts:129](../../src/config/store.ts) converts the old `preset`/`ffmpegArgs` keys.
- There is one ffmpeg.wasm instance, guarded by a mutex, so conversions run one at a time.
- The PO-token step temporarily assigns `globalThis.window`/`document` in the main process and cleans them up afterwards.
- `getPlaylistID(new URL(playingUrl))` throws if `playingUrl` is still undefined and the given URL has no list id. That exception is uncaught inside `downloadPlaylist`.

---

## Synced Lyrics (`synced-lyrics`)
**What it does:**
- Takes over the player page's **Lyrics** tab and keeps that tab enabled at all times. The native lyrics are hidden and replaced with a virtualised list showing either time-synced lines (highlighted and auto-scrolled to the current line) or plain lyrics.
- A provider picker at the top switches between YTMusic, LRCLib, MusixMatch and LyricsGenius (star one per video); clicking a synced line seeks to it. Optional extras: romanization (ja/ko/zh/th/bn/hi), Chinese simplified⇄traditional conversion, time codes, and four line-effect styles.

**Why it exists:** YouTube Music's own lyrics are often missing or unsynced.

**How it works:**
- *Fetch trigger*:
  - In renderer `start` ([renderer/index.ts:77](../../src/plugins/synced-lyrics/renderer/index.ts)), `netFetch` is bound to `ipc.invoke('synced-lyrics:fetch')`.
  - Every `peard:update-song-info` calls `fetchLyrics(info)` ([renderer/store.ts:54](../../src/plugins/synced-lyrics/renderer/store.ts)).
  - `fetchLyrics` runs **all** providers in parallel and caches results per `videoId` in an in-memory `Map`. Results are written to the Solid store `lyricsStore.lyrics[provider]` (`{state:'fetching'|'done'|'error', data, error}`), but only if `getSongInfo().videoId` still matches.
  - `retrySearch` (l.143) re-runs one provider. The Error view's refetch button uses it.
- *Providers* ([providers/index.ts](../../src/plugins/synced-lyrics/providers/index.ts) enum order = picker order; instances in [providers/renderer.ts](../../src/plugins/synced-lyrics/providers/renderer.ts)):
  - **YTMusic** ([YTMusic.ts](../../src/plugins/synced-lyrics/providers/YTMusic.ts)):
    - Calls `/next` through `document.querySelector('ytmusic-app').networkManager.fetch`, then finds the tab whose `pageType === 'MUSIC_PAGE_TYPE_TRACK_LYRICS'` and takes its `browseId`.
    - POSTs `browse` to the third-party proxy `https://ytmbrowseproxy.zvz.be/` (comment: rate-limited to 2 req/s), using client `26` / `7.01.05`.
    - Synced lines come from `elementRenderer…timedLyricsModel.lyricsData.timedLyricsData[].cueRange`, where `♪` becomes an empty line. Plain lyrics come from `messageRenderer` or `musicDescriptionShelfRenderer`. `'Lyrics not available'` means null.
  - **LRCLib** ([LRCLib.ts](../../src/plugins/synced-lyrics/providers/LRCLib.ts)):
    - Searches `https://lrclib.net/api/search` by artist, track and album.
    - If there are no hits and `showLyricsEvenIfInexact` is on, it retries with `q=<alternativeTitle||title>`, then with `q=<title>`.
    - Results are filtered by Jaro-Winkler artist similarity > 0.9, also checked against song `tags`. The hit with the closest duration wins; it is rejected if more than 15 s off or instrumental. Its `syncedLyrics` go through `LRC.parse`.
  - **MusixMatch** ([MusixMatch.ts](../../src/plugins/synced-lyrics/providers/MusixMatch.ts)):
    - Uses the desktop API `apic-desktop.musixmatch.com/ws/1.1/` with `app_id=web-desktop-app-v1.0`.
    - The user token comes from `token.get` and is cached in `localStorage['ytm:synced-lyrics:mxm:token']` for 60 s. A 401 triggers a re-init.
    - It queries `macro.subtitles.get` (`lyrics_richsynched`, LRC format). Responses are validated with zod.
    - Track id `115264642` ("Coldplay - Paradise" false match) is rejected.
    - Requests go through **main-process `net.fetch`** ([backend.ts](../../src/plugins/synced-lyrics/backend.ts)) because of forbidden headers (Cookie/Authority).
  - **LyricsGenius** ([LyricsGenius.ts](../../src/plugins/synced-lyrics/providers/LyricsGenius.ts)): plain lyrics only.
    - Calls `genius.com/api/search/song`, ranks hits by exact title and artist-substring match, fetches the song page, and pulls the lyrics HTML out of `window.__PRELOADED_STATE__` with a regex.
    - Unreleased songs and "instrumental" give null.
  - **Megalobiz** ([Megalobiz.ts](../../src/plugins/synced-lyrics/providers/Megalobiz.ts)): code exists but is commented out of both the enum and the map ("too unstable and slow").
  - YTMusic, LRCLib and Genius use the **renderer's** `fetch`. Only MusixMatch goes through IPC.
- *LRC parser* ([parsers/lrc.ts](../../src/plugins/synced-lyrics/parsers/lrc.ts)):
  - Handles multiple `[mm:ss.cc]` stamps per line, `[tag:value]` headers, `[offset:]` (added to each line's `timeInMs`), and `<mm:ss.cc>` word stamps (collapsed into text).
  - Each line's `duration` = next line's start − its own start. The last line is `Infinity`.
  - An empty line at 0 is prepended if the first line starts after 300 ms.
  - Tests: [parsers/lrc.test.ts](../../src/plugins/synced-lyrics/parsers/lrc.test.ts) (Playwright test runner).
- *Sync*:
  - `onPlayerApiReady` stores `_ytAPI`, subscribes `videoDataChange` to `videodatachange`, and calls it once directly. The first call creates one 100 ms `setInterval` (guarded by `if (!this.updateTimestampInterval)`) that sets `currentTime = _ytAPI.getCurrentTime()*1000` ([renderer/index.ts:55-59](../../src/plugins/synced-lyrics/renderer/index.ts)).
  - `LyricsRenderer` ([renderer/renderer.tsx:234](../../src/plugins/synced-lyrics/renderer/renderer.tsx)) assigns each line a status: `upcoming` if `timeInMs >= t`, `previous` if `t - timeInMs >= duration`, otherwise `current`.
  - It scrolls the `virtua` `VList` so the current line (index + 1) is centred.
- *Tab takeover*:
  - `videoDataChange` waits for the lyrics tab header `#tabsContent > .tab-header:nth-of-type(2)` and removes its `disabled` attribute. A `MutationObserver` on the header strips `disabled` again, and when `aria-selected` changes it calls `tabStates`.
  - `tabStates.true` ([renderer/utils.tsx:24](../../src/plugins/synced-lyrics/renderer/utils.tsx)) appends `#synced-lyrics-container` to `#tab-renderer[page-type="MUSIC_PAGE_TYPE_TRACK_LYRICS"]` once and renders `LyricsRenderer` into it.
  - CSS hides every other child of that tab ([style.css:2-15](../../src/plugins/synced-lyrics/style.css)).
- *Provider choice* ([renderer/components/LyricsPicker.tsx](../../src/plugins/synced-lyrics/renderer/components/LyricsPicker.tsx)):
  - Unless you switched manually for this video, a starred provider (`localStorage['ytmd-sl-starred-<videoId>']`) wins. Next is `preferredProvider` if it has lines or lyrics. Otherwise the highest `providerBias` wins: +1 done, +2 has lines, +1 YTMusic with lines, +1 has plain lyrics, with penalties when these are missing.
  - The manual-switch flag resets on `dataloaded`.
- *Rendering details*:
  - [SyncedLine.tsx](../../src/plugins/synced-lyrics/renderer/components/SyncedLine.tsx) splits words into spans with staggered delays and sets `--lyrics-duration`. An empty line shows `defaultTextString`; an array value animates through its frames over the line's duration.
  - Romanization: `romanize()` detects the language with `tinyld`, then uses kuroshiro+kuromoji for ja (the dictionary loads from `cdn.jsdelivr.net`), es-hangul+hanja for ko, pinyin-pro for zh, `@dehoist/romanize-thai` with `Intl.Segmenter` for th, and Sanscript for bn/hi. Chinese conversion uses `chinese-conv` ([renderer/utils.tsx:89-263](../../src/plugins/synced-lyrics/renderer/utils.tsx)).
  - Line effects set CSS variables on `:root` ([renderer/renderer.tsx:31-127](../../src/plugins/synced-lyrics/renderer/renderer.tsx)).

**Config:** (`restartNeeded: true`)

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plugins.synced-lyrics.enabled` | boolean | `false` | (enabled by this user) |
| `plugins.synced-lyrics.preferredProvider` | `'YTMusic'`\|`'LRCLib'`\|`'MusixMatch'`\|`'LyricsGenius'`? | `undefined` | Forced if it returned lyrics |
| `plugins.synced-lyrics.preciseTiming` | boolean | `true` | **No effect.** Only in index, menu and types, never read |
| `plugins.synced-lyrics.showLyricsEvenIfInexact` | boolean | `true` | Only affects LRCLib's fallback `q=` search |
| `plugins.synced-lyrics.showTimeCodes` | boolean | `false` | Prefix `[mm:ss:cc]` to synced lines |
| `plugins.synced-lyrics.defaultTextString` | string \| string[] | `'♪'` | Text for empty or instrumental lines; an array is animated |
| `plugins.synced-lyrics.lineEffect` | `'fancy'`\|`'scale'`\|`'offset'`\|`'focus'` | `'fancy'` | CSS line style |
| `plugins.synced-lyrics.romanization` | boolean | `true` | Show a romanized line under non-Latin lyrics |
| `plugins.synced-lyrics.convertChineseCharacter` | `'simplifiedToTraditional'`\|`'traditionalToSimplified'`\|`'disabled'`? | `undefined` (= disabled) | Han conversion |

**Menu:** ([menu.ts](../../src/plugins/synced-lyrics/menu.ts))
- Preferred provider: radio list of None plus the 4 providers.
- Precise timing: checkbox, which has no effect.
- Line effect: radio, fancy / scale / offset / focus.
- Default text string: `♪`, `" "`, `...` (animated), `•••` (animated), `———`.
- Romanization: checkbox.
- Convert Chinese characters: radio, disabled / s→t / t→s.
- Show time codes: checkbox.
- Show lyrics even if inexact: checkbox.

**Files:**
- [index.ts](../../src/plugins/synced-lyrics/index.ts): plugin definition and defaults.
- [backend.ts](../../src/plugins/synced-lyrics/backend.ts): `synced-lyrics:fetch` handler (main `net.fetch` returning `[status, text, headers]`).
- [menu.ts](../../src/plugins/synced-lyrics/menu.ts): app menu.
- [types.ts](../../src/plugins/synced-lyrics/types.ts): config, `LineLyrics`, `LyricProvider`.
- [style.css](../../src/plugins/synced-lyrics/style.css): tab override, variables, animations.
- [parsers/lrc.ts](../../src/plugins/synced-lyrics/parsers/lrc.ts) and its test: LRC parser.
- [providers/index.ts](../../src/plugins/synced-lyrics/providers/index.ts): `ProviderNames` enum and zod schema.
- [providers/renderer.ts](../../src/plugins/synced-lyrics/providers/renderer.ts): provider instances.
- Provider implementations: [YTMusic.ts](../../src/plugins/synced-lyrics/providers/YTMusic.ts), [LRCLib.ts](../../src/plugins/synced-lyrics/providers/LRCLib.ts), [MusixMatch.ts](../../src/plugins/synced-lyrics/providers/MusixMatch.ts), [LyricsGenius.ts](../../src/plugins/synced-lyrics/providers/LyricsGenius.ts), and [Megalobiz.ts](../../src/plugins/synced-lyrics/providers/Megalobiz.ts) (disabled).
- [renderer/index.ts](../../src/plugins/synced-lyrics/renderer/index.ts): lifecycle, time polling, tab observer.
- [renderer/store.ts](../../src/plugins/synced-lyrics/renderer/store.ts): fetch, cache, store.
- [renderer/renderer.tsx](../../src/plugins/synced-lyrics/renderer/renderer.tsx): `LyricsRenderer`, config signal, line-effect variables.
- [renderer/utils.tsx](../../src/plugins/synced-lyrics/renderer/utils.tsx): selectors, `tabStates`, canonicalize, romanizers.
- `renderer/components/`:
  - [LyricsPicker](../../src/plugins/synced-lyrics/renderer/components/LyricsPicker.tsx)
  - [SyncedLine](../../src/plugins/synced-lyrics/renderer/components/SyncedLine.tsx)
  - [PlainLyrics](../../src/plugins/synced-lyrics/renderer/components/PlainLyrics.tsx)
  - [ErrorDisplay](../../src/plugins/synced-lyrics/renderer/components/ErrorDisplay.tsx) (stack trace and refetch button)
  - [LoadingKaomoji](../../src/plugins/synced-lyrics/renderer/components/LoadingKaomoji.tsx)
  - [NotFoundKaomoji](../../src/plugins/synced-lyrics/renderer/components/NotFoundKaomoji.tsx)

**IPC / events:**
- `synced-lyrics:fetch` (invoke, renderer → main: `(url, init)` → `[status, body, headers]`)
- Listens to `peard:update-song-info`.
- Player API `videodatachange`, used in `renderer/index.ts` and `LyricsPicker`.

**DOM anchors:**
- `#tabsContent > .tab-header:nth-of-type(2)` (lyrics tab header)
- `#tab-renderer[page-type="MUSIC_PAGE_TYPE_TRACK_LYRICS"]`
- `ytmusic-app` (`networkManager`, YTMusic provider)
- Its own: `#synced-lyrics-container`, `.synced-lyrics-vlist`
- `selectors.body.root` (`ytmusic-description-shelf-renderer`) is declared but unused.

**New player bar (2026-10):** unaffected. No player-bar selectors are used. Time comes from `_ytAPI.getCurrentTime()` polling, song info from `peard:update-song-info`, and seeking from `_ytAPI.seekTo`. Caveat: `.tab-header:nth-of-type(2)` and `#tab-renderer[page-type=…]` are not on the verified-live list; only `#tabsContent`, `tp-yt-paper-tab` and `ytmusic-tab-renderer` are. If the header selector failed, `waitForElement` would poll forever and the tab would never be taken over.

**Gotchas:**
- `preciseTiming` toggle does nothing.
- The picker shows the enum key `LyricsGenius`, but the class's `name` is `'Genius'`.
- Every provider runs for every song, including network calls to lrclib.net, musixmatch, genius.com and the zvz.be proxy, even when a better result already exists.
- The cache is in memory only and lives as long as the renderer.
- The time-poll interval is created on the first `videoDataChange()` call (from `onPlayerApiReady`) and never cleared (there is no `stop`).
- `LRC.parse` adds `offset` to each line's start and then computes its duration from the next line's start, which has not been shifted yet. With a non-zero `[offset:]`, every line's duration except the last is off by `−offset`.
- MusixMatch caches its token in `localStorage` with a 60 s expiry, but the expiry is only checked in `init()`. Within a session the in-memory token is reused until a 401 or a failed init triggers `reinit()`. After a renderer reload the stored token is almost always expired, so `token.get` runs again.

---

## Captions Selector (`captions-selector`)
**What it does:**
- Adds a subtitles icon button to the player bar's right controls. Clicking it opens a native prompt listing the video's caption tracks plus "None", sets the chosen track, and shows a toast.
- It can re-apply the last chosen language on every song (`autoload`) or unload captions entirely (`disableCaptions`).

**Why it exists:** YouTube Music has no UI for choosing caption or subtitle tracks on music videos.

**How it works:**
- Renderer ([renderer.tsx](../../src/plugins/captions-selector/renderer.tsx)):
  - `onPlayerApiReady` (l.83) Solid-`render`s `CaptionsSettingButton` into `document.querySelector('.right-controls-buttons')!` (l.151).
  - It then reads `playerApi.getOption('captions','tracklist')` and attaches `videoChangeListener` to `<video>` `peard:src-changed` (l.157-159).
  - `videoChangeListener` (l.47):
    - If `disableCaptions`, it calls `unloadModule('captions')` and hides the button.
    - Otherwise it calls `loadModule('captions')`, and after 250 ms re-reads the tracklist. If `autoload && lastCaptionsCode`, it sets the track to `{languageCode}`. It hides the button when there are no tracks.
  - On click (l.91), the button `ipc.invoke('peard:captions-selector', labels, currentIndex)`. The chosen index sets `lastCaptionsCode` and the track (or `{}` for None), shows a `ytmusic-app.toastService` toast, then `playVideo()`.
- Backend ([back.ts](../../src/plugins/captions-selector/back.ts)) handles `peard:captions-selector` with a `custom-electron-prompt` `select` dialog.

**Config:** (`restartNeeded` not declared, so treated as false)

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plugins.captions-selector.enabled` | boolean | `false` | |
| `plugins.captions-selector.disableCaptions` | boolean | `false` | Unload the captions module on every song |
| `plugins.captions-selector.autoload` | boolean | `false` | Re-apply `lastCaptionsCode` on every song |
| `plugins.captions-selector.lastCaptionsCode` | string | `''` | Last chosen language code (set by the plugin) |

**Menu:** "Autoload" checkbox and "Disable captions" checkbox ([index.ts:36](../../src/plugins/captions-selector/index.ts)).

**Files:**
- [index.ts](../../src/plugins/captions-selector/index.ts): plugin definition and menu.
- [back.ts](../../src/plugins/captions-selector/back.ts): prompt handler.
- [renderer.tsx](../../src/plugins/captions-selector/renderer.tsx): button, player-API caption calls.
- [templates/captions-settings-template.tsx](../../src/plugins/captions-selector/templates/captions-settings-template.tsx): `yt-icon-button.player-captions-button` with a subtitles SVG.

**IPC / events:**
- `peard:captions-selector` (invoke, renderer → main: `(labels[], currentIndex)` → selected index or null)
- DOM CustomEvent `peard:src-changed` on `<video>`.

**DOM anchors:** `.right-controls-buttons` (mount point and removal in `stop`), `video`, `ytmusic-app` (toast service).

**New player bar (2026-10):** likely broken.
- `.right-controls-buttons` lived inside the old `ytmusic-player-bar #right-controls`. [docs/custom/limited-repeat.md](../custom/limited-repeat.md) lists it as an old-bar-only fallback. In the new layout it is `null`, so `render(…, null!)` has no mount point and `onPlayerApiReady` fails at l.86 before l.154-159 run.
- Result: no button, no tracklist read, and no `peard:src-changed` listener. `autoload` and `disableCaptions` are dead as well.
- The player-API caption calls themselves (`loadModule`/`setOption`) do not depend on the bar.

**Gotchas:**
- `back.ts` registers `peard:captions-selector` but `stop` calls `removeHandler('captionsSelector')`, so the handler is never removed.
- The 100 ms and 250 ms `setTimeout`s are timing guesses for the captions module to load.

---

## SponsorBlock (`sponsorblock`)
**What it does:** For each new video, it fetches crowd-sourced skip segments from SponsorBlock: sponsor, intro, outro, interaction, selfpromo and music_offtopic. When playback enters a segment, it jumps to the segment's end.

**Why it exists:** Music videos often contain non-music intros, outros and sponsor reads.

**How it works:**
- Backend ([index.ts:43](../../src/plugins/sponsorblock/index.ts)):
  - On `peard:video-src-changed`, it GETs `${apiURL}/api/skipSegments?videoID=<id>&categories=<JSON array>`.
  - A non-200 response or an error gives `[]`.
  - Segments are merged and sorted by `sortSegments` ([segments.ts](../../src/plugins/sponsorblock/segments.ts), which unions overlapping `[start,end]` ranges), then sent with `ipc.send('sponsorblock-skip', segments)`.
- Renderer:
  - `start` stores the received segments.
  - `onPlayerApiReady` adds a `timeupdate` listener to `<video>`: if `start <= currentTime < end`, it sets `currentTime = end`.
  - An `emptied` listener resets the segments.

**Config:** (`restartNeeded: true`; `apiURL`/`categories` are read once at backend start)

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plugins.sponsorblock.enabled` | boolean | `false` | |
| `plugins.sponsorblock.apiURL` | string | `'https://sponsor.ajay.app'` | SponsorBlock server |
| `plugins.sponsorblock.categories` | string[] | all six listed above | Categories to skip |

**Menu:** none; edit the config file.

**Files:**
- [index.ts](../../src/plugins/sponsorblock/index.ts): backend fetch and renderer skip.
- [segments.ts](../../src/plugins/sponsorblock/segments.ts): `sortSegments` merge.
- [types.ts](../../src/plugins/sponsorblock/types.ts): `Segment`, `SkipSegment`.
- [tests/segments.test.js](../../src/plugins/sponsorblock/tests/segments.test.js): Playwright test of `sortSegments`.

**IPC / events:** listens to `peard:video-src-changed` (main); sends `sponsorblock-skip` (main → renderer, `Segment[]`).

**DOM anchors:** `video`.

**New player bar (2026-10):** unaffected. It uses only `<video>` events and the player-API-driven `peard:video-src-changed`.

**Gotchas:**
- Segment times are not checked against video duration.
- A segment that arrives late (after the network round trip) is only applied from then on.
- In dev builds, each skip is logged.

---

## Skip Disliked Songs (`skip-disliked-songs`)
**What it does:** When the current song's like status becomes DISLIKE, it clicks Next.

**Why it exists:** Disliking a song in YouTube Music does not skip it.

**How it works:** [index.ts](../../src/plugins/skip-disliked-songs/index.ts)
- `start` uses `waitForElement('#like-button-renderer')` (l.19), then puts a `MutationObserver` on that element's attributes.
- When `like-status == 'DISLIKE'`, it clicks `yt-icon-button.next-button` (l.24).
- `stop` disconnects the observer.

**Config:** no `config` object, so it defaults to `{ enabled: false }`. `restartNeeded: false`.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plugins.skip-disliked-songs.enabled` | boolean | `false` | |

**Menu:** none.

**Files:** [index.ts](../../src/plugins/skip-disliked-songs/index.ts) (the whole plugin, 40 lines).

**IPC / events:** none.

**DOM anchors:** `#like-button-renderer` (attribute `like-status`), `yt-icon-button.next-button`.

**New player bar (2026-10):** likely broken. Both `#like-button-renderer` and `.next-button` are dead.
- [utils/wait-for-element.ts](../../src/utils/wait-for-element.ts) defaults to `maxRetry: -1`, so `waitForElement` polls every 100 ms **forever** and never resolves. No observer is ever attached.
- New-bar equivalents already exist in the working-tree [providers/dom-elements.ts](../../src/providers/dom-elements.ts): `getLikeButton('dislike')` (`aria-pressed`) and `getPlayerControl('Next')`. Alternatively, use the app store.

**Gotchas:** `stop()` cannot cancel the pending `waitForElement` interval. Toggling the plugin off before the element appears leaves the 100 ms poll running.

---

## Album Actions (`album-actions`)
**What it does:** On album and playlist pages, it adds four buttons to the header action row: "Undislike all", "Dislike all", "Like all" and "Unlike all". Each icon is partially filled to show what share of the tracks already has that state. Clicking one clicks the matching like/dislike button on every track row.

**Why it exists:** YouTube Music has no bulk like/dislike for a whole album or playlist.

**How it works:** [index.tsx](../../src/plugins/album-actions/index.tsx)
- `start` (l.40) calls `onPageChange` and observes `#browse-page` subtree mutations (non-null asserted). `onPageChange` (l.52):
  1. Waits for `#continuations`, then renders the four templates into a flex container.
  2. Finds the track list: `ytmusic-playlist-shelf-renderer`, or the last `ytmusic-shelf-renderer`.
  3. Observes every `yt-button-shape.ytmusic-like-button-renderer` for attribute changes; a change re-runs `stop()` + `start()`.
  4. If the list is fully loaded (`#continuations` has no children), it counts `#button-shape-like|dislike > button[aria-pressed=true|false]`. A state with zero tracks is hidden; otherwise the CSS mask size is set to `100% (100 - pct)%`.
  5. Inserts `div#ytmd-album-action-buttons.action-buttons` before the last child of `#action-buttons`' parent, if no `.like-menu` exists yet.
- `loadFullList` (l.210):
  1. Reads the clicked button id (`alllike`, `alldislike`, `allundislike`, `allunlike`).
  2. Observes `#continuations` and moves it into view (`position:absolute; top:0; left:50%`) so YouTube lazy-loads the remaining rows.
  3. When the loader is empty, `applyToList` clicks every matching row button.

**Config:** `restartNeeded: false`, `addedVersion: '3.2.X'`.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plugins.album-actions.enabled` | boolean | `false` | |

**Menu:** none.

**Files:**
- [index.tsx](../../src/plugins/album-actions/index.tsx): logic.
- `templates/`: [like-button.tsx](../../src/plugins/album-actions/templates/like-button.tsx), [dislike-button.tsx](../../src/plugins/album-actions/templates/dislike-button.tsx), [undislike-button.tsx](../../src/plugins/album-actions/templates/undislike-button.tsx) and [unlike-button.tsx](../../src/plugins/album-actions/templates/unlike-button.tsx). Each is a `button.like-menu` with a fixed id and a masked SVG fill.
- [templates/index.ts](../../src/plugins/album-actions/templates/index.ts): re-exports.

**IPC / events:** none.

**DOM anchors:**
- Page and loader: `#browse-page`, `#continuations`, `#action-buttons`
- Track list: `ytmusic-playlist-shelf-renderer`, `:nth-last-child(1 of ytmusic-shelf-renderer)`
- Row buttons: `yt-button-shape.ytmusic-like-button-renderer`, `#button-shape-like > button`, `#button-shape-dislike > button` (`aria-pressed`)
- Its own: `.like-menu`, `#ytmd-album-action-buttons`

**New player bar (2026-10):** unaffected. It only touches browse-page header and track-row like buttons, not the player bar. Those browse-page selectors were not part of the live verification.

**Gotchas:**
- `stop()` removes the `.like-menu` buttons but not the `#ytmd-album-action-buttons` wrapper. After that the `.like-menu` existence check passes again, so every stop/start cycle (which any row like change triggers) inserts another wrapper. Empty wrappers accumulate.
- `start()` throws if `#browse-page` is absent when the plugin starts.
- Every like-button attribute change triggers a full stop/start, which re-renders the buttons.
- `waitForElement('#continuations')` polls forever on pages without it. The `waiting` flag prevents stacking.

---

## Performance improvement [Beta] (`performance-improvement`)
**What it does:** No UI. At renderer start it injects two third-party userscripts by CY Fung (MIT) that try to cut CPU and memory use of the YouTube Music web app.

**Why it exists:** The Polymer-based YouTube Music page creates many elements and fires many timers, which costs CPU and RAM.

**How it works:** [index.ts:15](../../src/plugins/performance-improvement/index.ts) calls `injectRm3()` and then `injectCpuTamer()`.
- **rm3** ([scripts/rm3/rm3.js](../../src/plugins/performance-improvement/scripts/rm3/rm3.js)):
  - Wraps `document.createElement` (l.757) and the Polymer component hooks `createComponent_`, `attached` and `detached`.
  - It records detached component elements. Every `CHECK_INTERVAL = 400` ms, elements older than `CONFIRM_TIME = 4000` ms go into per-tag "available pools", and new `createComponent_` calls reuse pooled elements instead of creating fresh ones.
  - Exposes debug helpers on the exported `rm3` object. The expansion of the name "rm3" is unclear from code.
- **CPU tamer** ([scripts/cpu-tamer/index.ts](../../src/plugins/performance-improvement/scripts/cpu-tamer/index.ts)):
  - If WebGL is available it uses the animation-frame variant, otherwise the DOM-mutation variant.
  - Both take clean timer functions from a temporary iframe and replace `window.setTimeout`/`setInterval`/`clearTimeout`/`clearInterval`.
  - Wrapped callbacks are deferred to the next animation frame (a hidden `#a-f` element with a 1 ms CSS animation, via `onanimationiteration`) or to a MutationObserver tick. Deferral happens **only** when a media `timeupdate` fired within the last 800 ms *and* that timer was scheduled within the last 800 ms. Otherwise the handler runs immediately ([cpu-tamer-by-animationframe.js:70-79](../../src/plugins/performance-improvement/scripts/cpu-tamer/cpu-tamer-by-animationframe.js), l.226-237).
  - A global key (`nzsxclvflluv`) prevents double injection.

**Config:** `restartNeeded: true`, `addedVersion: '3.9.X'`.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plugins.performance-improvement.enabled` | boolean | **`true`** | |

**Menu:** none.

**Files:**
- [index.ts](../../src/plugins/performance-improvement/index.ts): plugin definition.
- [scripts/rm3/rm3.js](../../src/plugins/performance-improvement/scripts/rm3/rm3.js), with [rm3.d.ts](../../src/plugins/performance-improvement/scripts/rm3/rm3.d.ts) and [index.ts](../../src/plugins/performance-improvement/scripts/rm3/index.ts): element recycling.
- [scripts/cpu-tamer/index.ts](../../src/plugins/performance-improvement/scripts/cpu-tamer/index.ts): GPU check and variant choice.
- [cpu-tamer-by-animationframe.js](../../src/plugins/performance-improvement/scripts/cpu-tamer/cpu-tamer-by-animationframe.js) and [cpu-tamer-by-dom-mutation.js](../../src/plugins/performance-improvement/scripts/cpu-tamer/cpu-tamer-by-dom-mutation.js), plus their `.d.ts` files: the two timer-patch variants.

**IPC / events:** none. Internally it listens for the capturing `timeupdate` event on `document`.

**DOM anchors:** none from YouTube. It inserts its own `#a-f` element and `style#afscript`.

**New player bar (2026-10):** unaffected. No selectors; it patches globals and Polymer prototypes.

**Gotchas:**
- This is the only plugin in this domain that is **on by default**.
- It globally patches `setTimeout`/`setInterval` and `document.createElement` for the whole renderer, including every other plugin. Timer callbacks can be delayed to the next frame, which matters for timing-sensitive plugin code such as polling loops or the `setTimeout` waits in captions-selector.
- Recycled Polymer elements could, in principle, carry stale state; the risk is unclear from code.
