import type { BrowserWindow } from 'electron';

// How the main window is brought up when the app shows it (tray click, tray
// menu "Show", a second instance). A plugin can replace it: the
// virtual-desktop plugin shows the window on the current virtual desktop.
type ShowWindowHandler = (win: BrowserWindow) => void;

let showWindowHandler: ShowWindowHandler | null = null;

export const setShowWindowHandler = (handler: ShowWindowHandler | null) => {
  showWindowHandler = handler;
};

export const showWindow = (win: BrowserWindow, { focus = false } = {}) => {
  if (showWindowHandler) {
    showWindowHandler(win);
    return;
  }
  win.show();
  if (focus) win.focus();
};
