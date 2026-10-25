# Virtual Desktop Awareness (`virtual-desktop`)

**Origin:** custom (Emre, 2026-04-15; its own plugin since 2026-10-25, before that the core option `options.trayMoveToCurrentDesktop`)
**Type:** main-process plugin · **Default:** off · **restartNeeded:** false · **User config:** off (never set)

## What it does

Showing the window (tray click, tray menu "Show", or launching a second
instance) brings it to the virtual desktop you're on, instead of switching you
to the desktop where the window lives.

## Why it exists

Emre runs YouTube Music on a far-away virtual desktop. Clicking the tray yanked
the view back to that desktop.

## How it works

[`src/plugins/virtual-desktop/index.ts`](../../src/plugins/virtual-desktop/index.ts):

```ts
win.setVisibleOnAllWorkspaces(true);  // appears on the current desktop
win.show();
win.setVisibleOnAllWorkspaces(false); // stays there
```

Core has one generic hook for it, in [`src/window-utils.ts`](../../src/window-utils.ts):

| Core | Role |
|---|---|
| `showWindow(win, { focus })` | how the app shows the main window. Default: `show()`, then `focus()` if asked |
| `setShowWindowHandler(fn \| null)` | lets a plugin replace that. This plugin sets it in `start()` and clears it in `stop()` |

`showWindow` is called from the tray click and the tray menu "Show" in
[`src/tray.ts`](../../src/tray.ts), and from the `second-instance` handler in
[`src/index.ts`](../../src/index.ts).

Toggle: **Plugins → Virtual Desktop Awareness** (it used to be Options → Tray →
"Move to current virtual desktop on show").

## Config

| Key | Type | Default |
|---|---|---|
| `plugins.virtual-desktop.enabled` | boolean | false |

`migrateForkSettings` ([`src/config/store.ts`](../../src/config/store.ts)) moves an old `options.trayMoveToCurrentDesktop` value here and deletes the old key.

## Related core change from the same original commit: deferred tray handlers

Plugins load (`loadAllMainPlugins`) **before** `setUpTray`.
[`src/tray.ts`](../../src/tray.ts) queues `setTrayOnClick` / `setTrayOnDoubleClick` /
`setTrayOnMouseMove` calls made before the tray exists and applies them at the
end of `setUpTray`. The [tray hover mini-player](tray-hover-mini-player.md) relies on it.

## Gotchas

- Not verified across real virtual desktops after the 2026-10-25 move (the code path is unchanged; only where it lives moved).
- New player bar (2026-10): **unaffected** (main process only).
