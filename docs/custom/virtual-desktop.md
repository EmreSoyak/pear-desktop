# Virtual Desktop Awareness (`options.trayMoveToCurrentDesktop`)

**Origin:** custom (Emre, 2026-04-15) · **Type:** core option (not a plugin) · **Default:** off
**User config:** *not set*: the key is absent from `%APPDATA%\YouTube Music\config.json`, so the default (off) applies.

## What it does

Showing the window (tray click, tray menu "Show", or launching a second
instance) brings it to the virtual desktop you're on, instead of switching you
to the desktop where the window lives.

## Why it exists

Emre runs YouTube Music on a far-away virtual desktop. Clicking the tray yanked
the view back to that desktop.

## How it works

[`src/window-utils.ts`](../../src/window-utils.ts) `showOnCurrentDesktop(win)`:

```ts
win.setVisibleOnAllWorkspaces(true);  // appears on the current desktop
win.show();
win.setVisibleOnAllWorkspaces(false); // stays there
```

It is used in three places, each guarded by `config.get('options.trayMoveToCurrentDesktop')`:

| Where | File |
|---|---|
| Tray click (show branch) | [`src/tray.ts`](../../src/tray.ts) |
| Tray context menu "Show" | [`src/tray.ts`](../../src/tray.ts) |
| `second-instance` handler | [`src/index.ts`](../../src/index.ts) |

Toggle: **Options → Tray → "Move to current virtual desktop on show"**
([`src/menu.ts`](../../src/menu.ts),
i18n `main.menu.options.submenu.tray.submenu.move-to-current-desktop`). Default
in [`src/config/defaults.ts`](../../src/config/defaults.ts).

## Related core change in the same commit: deferred tray handlers

Plugins load (`loadAllMainPlugins`) **before** `setUpTray`. Before this change,
`setTrayOnClick` / `setTrayOnDoubleClick` calls from plugins were silently
dropped. [`src/tray.ts`](../../src/tray.ts) now queues them
(`pendingClick` / `pendingDoubleClick` / `pendingMouseMove`) and applies them
at the end of `setUpTray`. It also adds `setTrayOnMouseMove` and
`getTrayBounds`, used by the [tray hover mini-player](tray-hover-mini-player.md).

## Gotchas

- The same commit made DevTools open in dev mode only when `OPEN_DEVTOOLS` is
  set ([`src/index.ts`](../../src/index.ts) `initTheme`).
- New player bar (2026-10): **unaffected** (main process only).
