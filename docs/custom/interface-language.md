# Interface Language Pinned to English

**Origin:** custom (2026-10-01) · **Type:** core, main process · **Always on** (no toggle)

## What it does

Keeps the YouTube Music web interface in English, permanently, whatever the
Google account's region.

## Why it exists

On 2026-10-01 the interface came up in Turkish. The app's own language
(`options.language`) was `en`, and `navigator.language` was `en-US`, but YouTube
chose `HL=tr` / `GL=TR` from the account or IP region, because its `PREF` cookie
had no `hl` key. Emre wants it to never change from English.

## How it works

[`src/providers/youtube-language.ts`](../../src/providers/youtube-language.ts) exports `forceEnglishInterface(session)`, called from
`createMainWindow` in [`src/index.ts`](../../src/index.ts) right before
`loadURL`:

1. Reads the `PREF` cookie for `https://music.youtube.com`.
2. If `hl` isn't `en`, sets it, keeping every other PREF key (`repeat`,
   `volume`, `autoplay`, `guide_collapsed`, ...). It writes back with domain
   `.youtube.com`, path `/`, `secure`, and a 2-year expiry.
3. Subscribes once (module flag `watching`) to `session.cookies` `changed`.
   Whenever YouTube rewrites PREF without `hl=en` (it rewrites PREF on any
   preference change, and its language picker would set `hl`), the value is
   put back.

Failures are caught and logged ("Could not pin the interface language") so
that a cookie error can never stop the app from loading.

`GL` (region) is deliberately left alone.

## Verified

- With `hl=tr` planted in PREF before launch, the new build came up with `ytcfg HL=en`, `<html lang="en">`, and the repeat button titled "Repeat off".
- With `hl=tr` written mid-session from the page, PREF was back to `hl=en` within 1.5s.

## Gotchas

- When testing, plant `hl=tr` first. Otherwise a cookie left over from earlier
  testing makes it pass by accident (LESSONS #17).
- If YouTube ever ignores `hl` in PREF, appending `?hl=en` to the loaded URL is
  the fallback lever. It isn't needed today.
