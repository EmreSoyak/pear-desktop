import { createPlugin } from '@/utils';
import { t } from '@/i18n';

import { setupHoverPopup } from './popup';

// Hovering the tray icon shows a small card with album art and
// previous / play-pause / next. Everything lives in this folder:
//   popup.ts       the window, placement, hover tracking, self-heal
//   popup.html     the card itself
//   hover-debug.ts diagnostic log (%APPDATA%\YouTube Music\logs\hover-popup.log)
// The notifications plugin reads `isHoverPopupVisible()` to hold back toasts
// while the card is up. Docs: docs/custom/tray-hover-mini-player.md
export default createPlugin({
  name: () => t('plugins.tray-hover.name'),
  description: () => t('plugins.tray-hover.description'),
  // The tray handler and the popup window are set up once per launch
  restartNeeded: true,
  config: {
    enabled: true,
  },
  backend: {
    start({ window }) {
      setupHoverPopup(window);
    },
  },
});
