import { createPlugin } from '@/utils';
import { t } from '@/i18n';

import style from './style.css?inline';

const STYLE_ID = 'player-layout-style';

// CSS only. Injected from `renderer` rather than `stylesheets`, because the
// loader only picks up plugins that have a renderer, and so that disabling it
// takes effect without a restart.
export default createPlugin({
  name: () => t('plugins.player-layout.name'),
  description: () => t('plugins.player-layout.description'),
  restartNeeded: false,
  config: {
    enabled: true,
  },
  renderer: {
    start() {
      if (document.getElementById(STYLE_ID)) return;
      const element = document.createElement('style');
      element.id = STYLE_ID;
      element.textContent = style;
      document.head.appendChild(element);
    },
    stop() {
      document.getElementById(STYLE_ID)?.remove();
    },
  },
});
