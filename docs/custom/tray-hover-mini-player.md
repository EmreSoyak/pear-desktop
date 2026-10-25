# Tray Hover Mini-Player (`tray-hover`)

**Origin:** custom (Emre, 2026-04-15; its own plugin since 2026-10-25, before that part of `notifications`)
**Type:** main-process plugin · **Default:** on · **restartNeeded:** true · **User config:** on

## What it does

Hovering the tray icon shows a small floating card: album art, title, artist,
and previous / play-pause / next. It stays while the cursor is on the icon or
the card, and fades when it leaves.

That gives three tiers of tray interaction: **hover** for a glance and controls,
**click** to toggle the toast, **double-click** for the full window.

## Why it exists

The interactive toast disappears after about 5s, and the tray context menu has
no art or feedback. This is a quick, on-demand control without opening the app.

## Where everything is

All in [`src/plugins/tray-hover/`](../../src/plugins/tray-hover/):

| File | Role |
|---|---|
| `index.ts` | the plugin: `backend.start` calls `setupHoverPopup(window)` |
| `popup.ts` | the window, placement, hover tracking, button actions, diagnostics, self-heal |
| `popup.html` | the card itself |
| `hover-debug.ts` | the diagnostic log writer (keep it off upstream PR branches) |

## How it works

| Part | Mechanism |
|---|---|
| Popup window | Frameless, transparent, `alwaysOnTop`, `skipTaskbar` `BrowserWindow`. Size 380×85 plus 8px shadow padding. Created lazily on the first hover |
| Placement | `positionPopup`: centred on `getTrayBounds()` and 4px above it, or below when the tray is in the top half of the screen. Clamped to the display work area |
| Show trigger | `setTrayOnMouseMove(onTrayMouseMove)`, through the deferred-handler queue in [`src/tray.ts`](../../src/tray.ts) (plugins load before the tray exists). The window appears with `showInactive()`, so it doesn't steal focus |
| Hover tracking | `startMouseTracking` polls `screen.getCursorScreenPoint()` every **150ms** against the popup and tray bounds, because HTML `mouseenter`/`mouseleave` were unreliable on Windows. When the cursor is on neither, it hides with a 250ms fade and re-checks before the final `hide()` |
| Buttons | Buttons in `popup.html` use `onmousedown` (`onclick` gets swallowed by window activation) and set `document.title = 'act:<cmd>:<counter>'`. Main listens to `page-title-updated` and calls `getSongControls(win).playPause/previous/next` |
| Song data | `registerCallback` from `@/providers/song-info` (ignoring `TimeChanged`), then `executeJavaScript('window.updateSongInfo(...)')` |
| Toast suppression | [`notifications/interactive.ts`](../../src/plugins/notifications/interactive.ts) imports `isHoverPopupVisible()` from `@/plugins/tray-hover/popup` and skips `sendNotification` while the card is up |

## Diagnostics and self-heal (2026-10-23 / 2026-10-25)

The card "dies" after hours or days and comes back on restart. The cause isn't
known yet, so the plugin logs to
`%APPDATA%\YouTube Music\logs\hover-popup.log` (rotates at 2MB to `.1`):

- `hover-start` when a hover session begins, `show`/`hide`, `show-skipped` with the reason when `doShow` bails out
- `ANOMALY` when the state goes bad, checked every 30s even with nobody hovering: `popup-destroyed-not-cleared`, `flag-visible-without-tracker`, `flag-window-mismatch`, `tray-hover-listener-lost`
- `js-error`, `popup-renderer-gone`, `popup-unresponsive`, `sys-*` (suspend, resume, lock, display changes), a `heartbeat` every 10 minutes

**Reading it.** `hover-start` with no `show` after it means `doShow` bailed out
(see `show-skipped`). No `hover-start` at all means tray mouse-move events
stopped arriving, which no self-heal inside the popup can fix.

**Self-heal.** Each known bad state is logged first and repaired second, so the log keeps the evidence (`heal` lines):
- a destroyed popup that was never cleared is dropped and recreated;
- a visible flag on a window the OS hid is reset;
- a lost tray listener is re-registered.

**The installed build before 2026-10-25 didn't contain the logger**, so nothing was recorded until then.

## Config

| Key | Type | Default |
|---|---|---|
| `plugins.tray-hover.enabled` | boolean | true |

Migrated on first launch by `migrateForkSettings` ([`src/config/store.ts`](../../src/config/store.ts)): enabled if `notifications` was enabled and its old `hoverControls` wasn't false, and `hoverControls` is removed.

## Dependencies on the player bar

Prev/next go through `songControls` → IPC `peard:previous-video` /
`peard:next-video` → [`src/renderer.ts`](../../src/renderer.ts), which clicks
`.ytmusicPlayerControls{Previous,Next}Button button` since YouTube's 2026-10-01
redesign. See [../player-bar.md](../player-bar.md).

## Gotchas

These came from the original work (LESSONS #5 and #6):

- `focusable: false` kills JS events on Windows, so the popup is focusable but shown inactive.
- `console.log` IPC is unreliable from an unfocused window, which is why the `document.title` trick is used. The counter keeps repeated clicks distinct.
- Handlers registered before the tray existed used to be dropped silently.
