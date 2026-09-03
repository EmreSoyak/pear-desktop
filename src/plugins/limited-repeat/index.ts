import { createPlugin } from '@/utils';
import { t } from '@/i18n';

import type { MusicPlayer } from '@/types/music-player';
import type { VideoDataChanged } from '@/types/video-data-changed';

export type LimitedRepeatConfig = {
  enabled: boolean;
  logToConsole: boolean;
};

type PlayerBar = HTMLElement & {
  onRepeatButtonClick: () => void;
  getState: () => { queue: { repeatMode: string } };
  __lrOriginalRepeatClick?: () => void;
  __lrPatched?: boolean;
};

// How close to point B we switch from `timeupdate` (~4 Hz, up to 250ms of
// overshoot) to a fine-grained timer, so the loop point stays tight.
const FINE_WINDOW_SECONDS = 1;
const FINE_TICK_MS = 25;
// Tolerance for deciding a manual seek landed outside the A-B region.
const SEEK_TOLERANCE_SECONDS = 0.35;

const STYLE_ID = 'limited-repeat-style';
const BADGE_STYLE = `
#right-controls .repeat[data-lr] {
  position: relative;
  color: #ff0033;
}
#right-controls .repeat[data-lr]::after {
  content: attr(data-lr);
  position: absolute;
  left: 50%;
  bottom: -3px;
  transform: translateX(-50%);
  padding: 0 3px;
  border-radius: 3px;
  background: #ff0033;
  color: #fff;
  font-family: Roboto, sans-serif;
  font-size: 8px;
  font-weight: 700;
  line-height: 11px;
  letter-spacing: 0.03em;
  white-space: nowrap;
  pointer-events: none;
}
`;

const formatTime = (seconds: number) => {
  const total = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

export default createPlugin<
  unknown,
  unknown,
  {
    config: LimitedRepeatConfig | null;
    api: MusicPlayer | null;
    lrActive: boolean;
    pointA: number | null;
    pointB: number | null;
    selfSeek: boolean;
    fineTimer: ReturnType<typeof setInterval> | null;
    playerBarObserver: MutationObserver | null;
    pointerListener: ((e: PointerEvent) => void) | null;
    videoDataListener: ((e: Event) => void) | null;
    timeUpdateListener: (() => void) | null;
    seekedListener: (() => void) | null;
    endedListener: (() => void) | null;
    hookedVideo: HTMLVideoElement | null;
    patchedBar: PlayerBar | null;

    log: (msg: string) => void;
    injectStyle: () => void;
    getVideo: () => HTMLVideoElement | null;
    getPlayerBar: () => PlayerBar | null;
    getRepeatMode: () => string | null;
    patchRepeatButton: () => void;
    unpatchRepeatButton: () => void;
    watchPlayerBar: () => void;
    engage: () => void;
    cancel: (reason: string) => void;
    badgeText: () => string;
    updateBadge: () => void;
    onPointerDown: (event: PointerEvent) => void;
    markPoint: (progressBar: HTMLElement, clientX: number) => void;
    hookVideo: () => void;
    unhookVideo: () => void;
    onTimeUpdate: () => void;
    startFineTimer: () => void;
    clearFineTimer: () => void;
    jumpToA: (forcePlay?: boolean) => void;
    onSeeked: () => void;
  },
  LimitedRepeatConfig
>({
  name: () => t('plugins.limited-repeat.name'),
  description: () => t('plugins.limited-repeat.description'),
  restartNeeded: false,
  config: {
    enabled: false,
    logToConsole: false,
  },
  menu: async ({ getConfig, setConfig }) => {
    const config = await getConfig();

    return [
      {
        label: t('plugins.limited-repeat.menu.log-to-console'),
        type: 'checkbox',
        checked: config.logToConsole,
        async click() {
          const nowConfig = await getConfig();
          setConfig({ logToConsole: !nowConfig.logToConsole });
        },
      },
    ];
  },
  renderer: {
    config: null,
    api: null,
    lrActive: false,
    pointA: null,
    pointB: null,
    selfSeek: false,
    fineTimer: null,
    playerBarObserver: null,
    pointerListener: null,
    videoDataListener: null,
    timeUpdateListener: null,
    seekedListener: null,
    endedListener: null,
    hookedVideo: null,
    patchedBar: null,

    async start({ getConfig }) {
      this.config = await getConfig();
      this.injectStyle();
    },

    onPlayerApiReady(api) {
      this.api = api;

      this.patchRepeatButton();
      this.watchPlayerBar();
      this.hookVideo();

      // A single capture-phase listener on the document handles both
      // shift-click point marking and "any other control cancels LR".
      this.pointerListener = (event: PointerEvent) => this.onPointerDown(event);
      document.addEventListener('pointerdown', this.pointerListener, true);

      // A song change always spends LR - it never survives to another track,
      // nor to a later return to this one.
      this.videoDataListener = ((event: CustomEvent<VideoDataChanged>) => {
        if (event.detail.name === 'dataloaded') {
          this.cancel('song-changed');
          this.hookVideo();
        }
      }) as EventListener;
      document.addEventListener('videodatachange', this.videoDataListener);

      this.log('Limited repeat ready');
    },

    stop() {
      this.cancel('plugin-stopped');
      this.unpatchRepeatButton();

      if (this.playerBarObserver) {
        this.playerBarObserver.disconnect();
        this.playerBarObserver = null;
      }
      if (this.pointerListener) {
        document.removeEventListener('pointerdown', this.pointerListener, true);
        this.pointerListener = null;
      }
      if (this.videoDataListener) {
        document.removeEventListener('videodatachange', this.videoDataListener);
        this.videoDataListener = null;
      }
      this.unhookVideo();
      document.getElementById(STYLE_ID)?.remove();
    },

    onConfigChange(newConfig) {
      this.config = newConfig;
    },

    // --- Internal methods ---

    log(msg: string) {
      if (this.config?.logToConsole) {
        console.log(`[limited-repeat] ${msg}`);
      }
    },

    injectStyle() {
      if (document.getElementById(STYLE_ID)) return;
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = BADGE_STYLE;
      document.head.appendChild(style);
    },

    getVideo(): HTMLVideoElement | null {
      return document.querySelector('video');
    },

    getPlayerBar(): PlayerBar | null {
      return document.querySelector<PlayerBar>('ytmusic-player-bar');
    },

    getRepeatMode(): string | null {
      try {
        return this.getPlayerBar()?.getState().queue.repeatMode ?? null;
      } catch {
        return null;
      }
    },

    // --- Repeat button: extend the cycle with a fourth position ---

    patchRepeatButton() {
      const bar = this.getPlayerBar();
      if (!bar || bar.__lrPatched) return;

      const original = bar.onRepeatButtonClick.bind(bar);
      bar.__lrOriginalRepeatClick = original;
      bar.__lrPatched = true;
      this.patchedBar = bar;

      // Patching the method rather than listening for DOM clicks also covers
      // `peard:switch-repeat` (see src/renderer.ts), which calls this directly.
      bar.onRepeatButtonClick = () => {
        if (this.lrActive) {
          // LR -> NONE: spend it, then let the native cycle move ONE -> NONE.
          this.cancel('repeat-button');
          original();
          return;
        }

        if (this.getRepeatMode() === 'ONE') {
          // ONE -> LR: hold the native cycle at ONE and drive the loop here.
          this.engage();
          return;
        }

        original();
      };

      this.log('Repeat button patched');
    },

    unpatchRepeatButton() {
      const bar = this.getPlayerBar();
      if (!bar?.__lrPatched) return;
      if (bar.__lrOriginalRepeatClick) {
        bar.onRepeatButtonClick = bar.__lrOriginalRepeatClick;
      }
      delete bar.__lrOriginalRepeatClick;
      delete bar.__lrPatched;
      this.patchedBar = null;
    },

    watchPlayerBar() {
      // YouTube can recreate the player bar; re-apply the patch when it does.
      // This fires on every DOM mutation under body, and YouTube mutates
      // constantly during playback - so key off the element's identity rather
      // than the `__lrPatched` flag, which would spend LR mid-loop on any
      // unlucky ordering (including our own teardown).
      this.playerBarObserver = new MutationObserver(() => {
        const bar = this.getPlayerBar();
        if (!bar || bar === this.patchedBar) return;
        this.cancel('player-bar-recreated');
        this.patchRepeatButton();
      });
      this.playerBarObserver.observe(document.body, {
        childList: true,
        subtree: true,
      });
    },

    // --- LR state ---

    engage() {
      this.lrActive = true;
      this.pointA = null;
      this.pointB = null;
      (
        window as Window & { __limitedRepeatActive?: boolean }
      ).__limitedRepeatActive = true;
      this.updateBadge();
      this.log('Engaged - shift+click the progress bar to set A');
    },

    cancel(reason: string) {
      if (!this.lrActive) return;
      this.lrActive = false;
      this.pointA = null;
      this.pointB = null;
      (
        window as Window & { __limitedRepeatActive?: boolean }
      ).__limitedRepeatActive = false;
      this.clearFineTimer();
      this.updateBadge();
      this.log(`Spent (${reason})`);
    },

    badgeText(): string {
      if (this.pointA === null) return 'LR A?';
      if (this.pointB === null) return 'LR B?';
      return 'LR A–B';
    },

    updateBadge() {
      const button = document.querySelector<HTMLElement>(
        '#right-controls .repeat',
      );
      if (!button) return;

      // Deliberately not `title` - src/providers/song-info-front.ts observes
      // that attribute and would broadcast a stale repeat mode to the API.
      if (this.lrActive) {
        button.setAttribute('data-lr', this.badgeText());
      } else {
        button.removeAttribute('data-lr');
      }
    },

    // --- Point marking / cancellation ---

    onPointerDown(event: PointerEvent) {
      if (!this.lrActive) return;

      const target = event.target as HTMLElement | null;
      if (!target?.closest) return;

      const progressBar = target.closest<HTMLElement>('#progress-bar');
      if (progressBar) {
        if (event.shiftKey) {
          // Shift+click marks a point; plain clicks still seek normally.
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          this.markPoint(progressBar, event.clientX);
        }
        return;
      }

      // Clicks outside the player bar (browsing, the queue, etc.) are harmless;
      // a resulting song change cancels LR via `videodatachange` anyway.
      if (!target.closest('ytmusic-player-bar')) return;
      // Play/pause is explicitly safe, and the repeat button is handled by the
      // patched `onRepeatButtonClick` above.
      if (target.closest('#play-pause-button')) return;
      if (target.closest('.repeat')) return;

      this.cancel('other-control');
    },

    markPoint(progressBar: HTMLElement, clientX: number) {
      const video = this.getVideo();
      const duration = video?.duration ?? 0;
      if (!video || !Number.isFinite(duration) || duration <= 0) return;

      const rect = progressBar.getBoundingClientRect();
      if (rect.width <= 0) return;

      const fraction = Math.min(
        1,
        Math.max(0, (clientX - rect.left) / rect.width),
      );
      const time = fraction * duration;

      if (this.pointA === null || this.pointB !== null) {
        // First point, or restarting after a full A-B pair was set.
        this.pointA = time;
        this.pointB = null;
        this.log(`A = ${formatTime(time)}`);
      } else if (time <= this.pointA) {
        // Clicked before A - treat it as moving A rather than an invalid range.
        this.pointA = time;
        this.log(`A moved to ${formatTime(time)}`);
      } else {
        this.pointB = time;
        this.log(
          `B = ${formatTime(time)} - looping ${formatTime(this.pointA)}–${formatTime(time)}`,
        );
        this.jumpToA();
      }

      this.updateBadge();
    },

    // --- The loop itself ---

    hookVideo() {
      const video = this.getVideo();
      if (!video || video === this.hookedVideo) return;

      this.unhookVideo();

      this.timeUpdateListener = () => this.onTimeUpdate();
      this.seekedListener = () => this.onSeeked();
      this.endedListener = () => {
        if (this.lrActive && this.pointA !== null && this.pointB !== null) {
          // `ended` is never a deliberate pause, so always resume here.
          this.jumpToA(true);
        }
      };

      video.addEventListener('timeupdate', this.timeUpdateListener);
      video.addEventListener('seeked', this.seekedListener);
      video.addEventListener('ended', this.endedListener);
      this.hookedVideo = video;
    },

    unhookVideo() {
      const video = this.hookedVideo;
      if (!video) return;
      if (this.timeUpdateListener) {
        video.removeEventListener('timeupdate', this.timeUpdateListener);
      }
      if (this.seekedListener) {
        video.removeEventListener('seeked', this.seekedListener);
      }
      if (this.endedListener) {
        video.removeEventListener('ended', this.endedListener);
      }
      this.timeUpdateListener = null;
      this.seekedListener = null;
      this.endedListener = null;
      this.hookedVideo = null;
    },

    onTimeUpdate() {
      if (!this.lrActive || this.pointA === null || this.pointB === null) {
        return;
      }

      const video = this.getVideo();
      if (!video || video.paused) return;

      if (video.currentTime >= this.pointB) {
        this.jumpToA();
        return;
      }

      // `timeupdate` alone overshoots B by up to 250ms, which is audible on a
      // tight loop - hand off to a fine timer for the last second.
      if (this.pointB - video.currentTime <= FINE_WINDOW_SECONDS) {
        this.startFineTimer();
      }
    },

    startFineTimer() {
      if (this.fineTimer) return;
      this.fineTimer = setInterval(() => {
        if (!this.lrActive || this.pointA === null || this.pointB === null) {
          this.clearFineTimer();
          return;
        }
        const video = this.getVideo();
        if (!video) {
          this.clearFineTimer();
          return;
        }
        if (video.paused) return;
        if (video.currentTime >= this.pointB) {
          this.jumpToA();
        } else if (
          this.pointB - video.currentTime >
          FINE_WINDOW_SECONDS * 1.5
        ) {
          // Moved away from B (a seek, or the loop already wrapped).
          this.clearFineTimer();
        }
      }, FINE_TICK_MS);
    },

    clearFineTimer() {
      if (this.fineTimer) {
        clearInterval(this.fineTimer);
        this.fineTimer = null;
      }
    },

    jumpToA(forcePlay = false) {
      const video = this.getVideo();
      if (!video || this.pointA === null) return;

      const wasPlaying = !video.paused;

      this.clearFineTimer();
      this.selfSeek = true;
      // Setting `currentTime` directly is tighter than `api.seekTo` here.
      video.currentTime = this.pointA;

      // Only resume if playback was actually running - a deliberate pause
      // must not be undone by the loop.
      if ((wasPlaying || forcePlay) && video.paused) {
        void video.play().catch(() => {
          /* ignore - playback may have been stopped deliberately */
        });
      }
    },

    onSeeked() {
      if (!this.lrActive) return;

      if (this.selfSeek) {
        this.selfSeek = false;
        return;
      }

      if (this.pointA === null || this.pointB === null) return;

      const video = this.getVideo();
      if (!video) return;

      // A manual seek out of the loop region means the user wants out of it.
      if (
        video.currentTime < this.pointA - SEEK_TOLERANCE_SECONDS ||
        video.currentTime > this.pointB + SEEK_TOLERANCE_SECONDS
      ) {
        this.cancel('seek-outside-range');
      }
    },
  },
});
