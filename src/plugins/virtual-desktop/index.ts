import { createPlugin } from '@/utils';
import { t } from '@/i18n';
import { setShowWindowHandler } from '@/window-utils';

import type { BrowserWindow } from 'electron';

// Showing the window (tray click, tray menu "Show", launching a second
// instance) brings it to the virtual desktop you are on, instead of switching
// you to the desktop where it lives. Core calls `showWindow()` in those places;
// this plugin swaps in how the window is shown.
// Docs: docs/custom/virtual-desktop.md

// Pinning the window to all workspaces makes it appear on the current one;
// unpinning leaves it there.
const showOnCurrentDesktop = (win: BrowserWindow) => {
  win.setVisibleOnAllWorkspaces(true);
  win.show();
  win.setVisibleOnAllWorkspaces(false);
};

export default createPlugin({
  name: () => t('plugins.virtual-desktop.name'),
  description: () => t('plugins.virtual-desktop.description'),
  restartNeeded: false,
  config: {
    enabled: false,
  },
  backend: {
    start() {
      setShowWindowHandler(showOnCurrentDesktop);
    },
    stop() {
      setShowWindowHandler(null);
    },
  },
});
