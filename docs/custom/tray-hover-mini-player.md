# Tray Hover Mini-Player (`plugins.notifications.hoverControls`)

**Origin:** custom extension of the upstream `notifications` plugin (Emre, 2026-04-15)
**Type:** main-process feature inside a plugin · **Default:** `hoverControls: true` (in code; EMRE-FEATURES.md wrongly says off), active only when the notifications plugin is enabled · **User config:** notifications on

## What it does

Hovering the tray icon shows a small floating card: album art, title, artist,
and previous / play-pause / next. It stays while the cursor is on the icon or
the card, and fades when it leaves.

That gives three tiers of tray interaction: **hover** for a glance and controls,
**click** to toggle the toast, **double-click** for the full window.

## Why it exists

The interactive toast disappears after about 5s, and the tray context menu has
no art or feedback. This is a quick, on-demand control without opening the app.

## How it works

| Part | File | Mechanism |
|---|---|---|
| Popup window | [`src/plugins/notifications/hover-popup.ts`](../../src/plugins/notifications/hover-popup.ts) | Frameless, transparent, `alwaysOnTop`, `skipTaskbar` `BrowserWindow`. Size 380×85 plus 8px shadow padding. Created lazily on the first hover |
| Placement | same, `positionPopup` | Centred on `getTrayBounds()` and 4px above it, or below when the tray is in the top half of the screen. Clamped to the display work area |
| Show trigger | same | `setTrayOnMouseMove(doShow)`, which uses the deferred-handler queue in [`src/tray.ts`](../../src/tray.ts). The window appears with `showInactive()`, so it doesn't steal focus |
| Hover tracking | same, `startMouseTracking` | Polls `screen.getCursorScreenPoint()` every **150ms** against the popup and tray bounds, because HTML `mouseenter`/`mouseleave` were unreliable on Windows. When the cursor is on neither, it hides with a 250ms fade and re-checks before the final `hide()` |
| Buttons | [`assets/hover-popup.html`](../../assets/hover-popup.html) + `page-title-updated` | Buttons use `onmousedown` (`onclick` gets swallowed by window activation) and set `document.title = 'act:<cmd>:<counter>'`. Main listens to `page-title-updated` and calls `getSongControls(win).playPause/previous/next` |
| Song data | same | `registerCallback` from `@/providers/song-info` (ignoring `TimeChanged`), then `executeJavaScript('window.updateSongInfo(...)')` |
| Toast suppression | [`src/plugins/notifications/interactive.ts`](../../src/plugins/notifications/interactive.ts) | `isHoverPopupVisible()` is checked before `sendNotification`, so no toast appears while the card is up |
| Wiring | [`main.ts`](../../src/plugins/notifications/main.ts), [`index.ts`](../../src/plugins/notifications/index.ts), [`menu.ts`](../../src/plugins/notifications/menu.ts) | `if (config.hoverControls) setupHoverPopup(win)`. Config key `hoverControls`. Menu: Notifications → Interactive Settings → "Show mini-player on tray hover" |

## Dependencies on the player bar

Prev/next go through `songControls` → IPC `peard:previous-video` /
`peard:next-video` → [`src/renderer.ts`](../../src/renderer.ts). These clicked
`.previous-button.ytmusic-player-bar` and **broke when YouTube removed that bar
on 2026-10-01**. They were fixed the same day to click
`.ytmusicPlayerControls{Previous,Next}Button button`, and verified with
`z_development/player-bar/tests/core-ipc-test.cjs`. See [../player-bar.md](../player-bar.md).

## Gotchas

These came from the original work (LESSONS #5 and #6):

- `focusable: false` kills JS events on Windows, so the popup is focusable but shown inactive.
- `console.log` IPC is unreliable from an unfocused window, which is why the `document.title` trick is used. The counter keeps repeated clicks distinct.
- Handlers registered before the tray existed used to be dropped silently.
