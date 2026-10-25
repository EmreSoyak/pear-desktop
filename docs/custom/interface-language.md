# English Interface (`english-interface`)

**Origin:** custom (2026-10-01; its own plugin since 2026-10-25, before that core code in `src/providers/youtube-language.ts` + `src/index.ts`)
**Type:** main-process plugin · **Default:** on · **restartNeeded:** true

## What it does

Keeps the YouTube Music web interface in English, permanently, whatever the
Google account's region.

## Why it exists

On 2026-10-01 the interface came up in Turkish. The app's own language
(`options.language`) was `en`, and `navigator.language` was `en-US`, but YouTube
chose `HL=tr` / `GL=TR` from the account or IP region, because its `PREF` cookie
had no `hl` key. Emre wants it to never change from English.

## How it works

[`src/plugins/english-interface/`](../../src/plugins/english-interface/):

- `index.ts`: `backend.start({ window })` awaits `forceEnglishInterface(window.webContents.session)`, logging and swallowing any error so a cookie failure can never stop the app from loading. Main plugins start inside `createMainWindow` (`loadAllMainPlugins`, awaited) **before** `loadURL`, so the cookie is in place for the first request.
- `pref-cookie.ts`: `forceEnglishInterface(session)`:
  1. Reads the `PREF` cookie for `https://music.youtube.com`.
  2. If `hl` isn't `en`, sets it, keeping every other PREF key (`repeat`, `volume`, `autoplay`, `guide_collapsed`, ...). It writes back with domain `.youtube.com`, path `/`, `secure`, and a 2-year expiry.
  3. Subscribes once (module flag `watching`) to `session.cookies` `changed`. Whenever YouTube rewrites PREF without `hl=en` (it rewrites PREF on any preference change, and its language picker would set `hl`), the value is put back.

`GL` (region) is deliberately left alone.

## Config

| Key | Type | Default |
|---|---|---|
| `plugins.english-interface.enabled` | boolean | true |

## Verified

- 2026-10-01: with `hl=tr` planted in PREF before launch, the build came up with `ytcfg HL=en`, `<html lang="en">`, and the repeat button titled "Repeat off".
- 2026-10-01: with `hl=tr` written mid-session from the page, PREF was back to `hl=en` within 1.5s.
- 2026-10-25, as a plugin: `hl=tr` planted from the main process was back to `en` within 1.5s, page `HL=en`, "Repeat off".

## Gotchas

- When testing, plant `hl=tr` first. Otherwise a cookie left over from earlier
  testing makes it pass by accident (LESSONS #17).
- If YouTube ever ignores `hl` in PREF, appending `?hl=en` to the loaded URL is
  the fallback lever. It isn't needed today.
