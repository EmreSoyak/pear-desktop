import { createPlugin, LoggerPrefix } from '@/utils';
import { t } from '@/i18n';

import { forceEnglishInterface } from './pref-cookie';

// Keeps YouTube Music's interface in English whatever the account's region,
// by pinning `hl=en` in YouTube's PREF cookie (pref-cookie.ts).
// Main plugins start before the page is loaded, so the cookie is in place for
// the first request. Docs: docs/custom/interface-language.md
export default createPlugin({
  name: () => t('plugins.english-interface.name'),
  description: () => t('plugins.english-interface.description'),
  // The cookie watcher is installed once per launch
  restartNeeded: true,
  config: {
    enabled: true,
  },
  backend: {
    async start({ window }) {
      // Never let a cookie failure stop the app from loading
      await forceEnglishInterface(window.webContents.session).catch((error) =>
        console.error(
          LoggerPrefix,
          'Could not pin the interface language',
          error,
        ),
      );
    },
  },
});
