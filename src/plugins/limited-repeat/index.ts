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
  __lrOriginalRepeatClick?: () => void;
  __lrPatched?: boolean;
};

// How close to point B we switch from `timeupdate` (~4 Hz, up to 250ms of
// overshoot) to a fine-grained timer, so the loop point stays tight.
const FINE_WINDOW_SECONDS = 1;
const FINE_TICK_MS = 25;
// Smallest allowed gap between the two markers.
const MIN_RANGE_SECONDS = 0.5;
// How often the marker overlay re-measures the progress bar.
const LAYOUT_TICK_MS = 400;

const BUTTON_ID = 'limited-repeat-button';
const OVERLAY_ID = 'limited-repeat-overlay';
const STYLE_ID = 'limited-repeat-style';

// A repeat-style loop arrow with an A-B bracket underneath.
const BUTTON_SVG = `
<svg viewBox="0 0 24 24" focusable="false">
  <path d="M7 7h10v2.5l3.5-3.5L17 2.5V5H5v5h2V7z" />
  <path d="M17 17H7v-2.5L3.5 18 7 21.5V19h12v-5h-2v3z" />
  <rect x="6.25" y="10.4" width="1.5" height="3.2" rx="0.5" />
  <rect x="16.25" y="10.4" width="1.5" height="3.2" rx="0.5" />
</svg>
`;

const STYLE = `
#${BUTTON_ID} {
  position: relative;
  flex: none;
  width: 40px;
  height: 40px;
  padding: 8px;
  margin: 0 2px;
  border: 0;
  background: transparent;
  color: inherit;
  opacity: 0.6;
  cursor: pointer;
  -webkit-app-region: no-drag;
}
#${BUTTON_ID}:hover {
  opacity: 1;
}
#${BUTTON_ID} svg {
  width: 100%;
  height: 100%;
  display: block;
  fill: currentcolor;
  pointer-events: none;
}
#${BUTTON_ID}[data-lr] {
  opacity: 1;
  color: #ff0033;
}

/* The marker overlay sits over the progress bar. It must not swallow clicks -
   only the two handles are interactive, so seeking still works everywhere
   else on the bar. */
#${OVERLAY_ID} {
  position: fixed;
  z-index: 2000;
  pointer-events: none;
  display: none;
}
#${OVERLAY_ID}[data-visible] {
  display: block;
}
#${OVERLAY_ID} .lr-track {
  position: absolute;
  top: 50%;
  left: 0;
  right: 0;
  height: 2px;
  transform: translateY(-50%);
  background: rgba(255, 255, 255, 0.2);
  pointer-events: none;
}
#${OVERLAY_ID} .lr-region {
  position: absolute;
  top: 50%;
  height: 6px;
  transform: translateY(-50%);
  background: rgba(255, 0, 51, 0.15);
  pointer-events: none;
}
#${OVERLAY_ID} .lr-handle {
  position: absolute;
  top: 50%;
  width: 28px;
  height: 28px;
  transform: translate(-50%, -50%);
  cursor: ew-resize;
  pointer-events: auto;
  touch-action: none;
}
#${OVERLAY_ID} .lr-handle::before {
  content: '';
  position: absolute;
  top: 5px;
  bottom: 5px;
  width: 6px;
  border: 2px solid #ff0033;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.55);
}
#${OVERLAY_ID} .lr-handle[data-side='a']::before {
  left: 50%;
  border-right: 0;
}
#${OVERLAY_ID} .lr-handle[data-side='b']::before {
  right: 50%;
  border-left: 0;
}
#${OVERLAY_ID} .lr-handle:hover::before,
#${OVERLAY_ID} .lr-handle[data-dragging]::before {
  border-color: #fff;
}

/* Holding Shift widens the grab area only - the brackets stay exactly where
   and how they are drawn. Helps most at 0:00 and at the very end, where a
   marker sits against the window edge. */
#${OVERLAY_ID}[data-grab] .lr-handle {
  width: 90px;
  height: 44px;
  background: rgba(255, 0, 51, 0.12);
  border-radius: 4px;
}
#${OVERLAY_ID}[data-grab] .lr-handle::before {
  top: 12px;
  bottom: 12px;
  border-color: #fff;
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
    pointA: number;
    pointB: number | null;
    selfSeek: boolean;
    dragging: 'a' | 'b' | null;
    fineTimer: ReturnType<typeof setInterval> | null;
    layoutTimer: ReturnType<typeof setInterval> | null;
    playerBarObserver: MutationObserver | null;
    button: HTMLButtonElement | null;
    overlay: HTMLDivElement | null;
    region: HTMLDivElement | null;
    handleA: HTMLDivElement | null;
    handleB: HTMLDivElement | null;
    videoDataListener: ((e: Event) => void) | null;
    pointerListener: ((e: PointerEvent) => void) | null;
    keyDownListener: ((e: KeyboardEvent) => void) | null;
    keyUpListener: ((e: KeyboardEvent) => void) | null;
    blurListener: (() => void) | null;
    timeUpdateListener: (() => void) | null;
    seekedListener: (() => void) | null;
    endedListener: (() => void) | null;
    playListener: (() => void) | null;
    durationListener: (() => void) | null;
    hookedVideo: HTMLVideoElement | null;
    patchedBar: PlayerBar | null;

    log: (msg: string) => void;
    injectStyle: () => void;
    getVideo: () => HTMLVideoElement | null;
    getDuration: () => number;
    getPlayerBar: () => PlayerBar | null;
    getRepeatButton: () => HTMLElement | null;
    getProgressBar: () => HTMLElement | null;
    getTrack: () => { left: number; width: number } | null;
    createButton: () => void;
    createOverlay: () => void;
    layoutOverlay: () => void;
    updateMarkers: () => void;
    applyBarMask: (aFraction: number, bFraction: number) => void;
    clearBarMask: () => void;
    startDrag: (side: 'a' | 'b', event: PointerEvent) => void;
    timeFromClientX: (clientX: number) => number | null;
    patchRepeatButton: () => void;
    unpatchRepeatButton: () => void;
    watchPlayerBar: () => void;
    toggle: () => void;
    engage: () => void;
    cancel: (reason: string) => void;
    updateBadge: () => void;
    publishState: () => void;
    onPointerDown: (event: PointerEvent) => void;
    setGrabMode: (on: boolean) => void;
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
    pointA: 0,
    pointB: null,
    selfSeek: false,
    dragging: null,
    fineTimer: null,
    layoutTimer: null,
    playerBarObserver: null,
    button: null,
    overlay: null,
    region: null,
    handleA: null,
    handleB: null,
    videoDataListener: null,
    pointerListener: null,
    keyDownListener: null,
    keyUpListener: null,
    blurListener: null,
    timeUpdateListener: null,
    seekedListener: null,
    endedListener: null,
    playListener: null,
    durationListener: null,
    hookedVideo: null,
    patchedBar: null,

    async start({ getConfig }) {
      this.config = await getConfig();
      this.injectStyle();
    },

    onPlayerApiReady(api) {
      this.api = api;

      this.createButton();
      this.createOverlay();
      this.patchRepeatButton();
      this.watchPlayerBar();
      this.hookVideo();

      // Spends LR when another player-bar control is used.
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

      window.addEventListener('resize', () => this.layoutOverlay());

      // Hold Shift for a bigger grab area on the markers. Purely additive -
      // the normal hit area still works exactly as before.
      this.keyDownListener = (event: KeyboardEvent) => {
        if (event.key === 'Shift') this.setGrabMode(true);
      };
      this.keyUpListener = (event: KeyboardEvent) => {
        if (event.key === 'Shift') this.setGrabMode(false);
      };
      // Releasing Shift while the window is unfocused would otherwise leave
      // the enlarged area stuck on.
      this.blurListener = () => this.setGrabMode(false);

      window.addEventListener('keydown', this.keyDownListener, true);
      window.addEventListener('keyup', this.keyUpListener, true);
      window.addEventListener('blur', this.blurListener);

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
      if (this.keyDownListener) {
        window.removeEventListener('keydown', this.keyDownListener, true);
        this.keyDownListener = null;
      }
      if (this.keyUpListener) {
        window.removeEventListener('keyup', this.keyUpListener, true);
        this.keyUpListener = null;
      }
      if (this.blurListener) {
        window.removeEventListener('blur', this.blurListener);
        this.blurListener = null;
      }
      this.unhookVideo();
      this.clearBarMask();
      this.button?.remove();
      this.overlay?.remove();
      this.button = null;
      this.overlay = null;
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
      style.textContent = STYLE;
      document.head.appendChild(style);
    },

    getVideo(): HTMLVideoElement | null {
      return document.querySelector('video');
    },

    getDuration(): number {
      const duration = this.getVideo()?.duration ?? 0;
      return Number.isFinite(duration) && duration > 0 ? duration : 0;
    },

    getPlayerBar(): PlayerBar | null {
      return document.querySelector<PlayerBar>('ytmusic-player-bar');
    },

    getRepeatButton(): HTMLElement | null {
      return document.querySelector<HTMLElement>('#right-controls .repeat');
    },

    getProgressBar(): HTMLElement | null {
      return (
        document.querySelector<HTMLElement>('#progress-bar') ??
        document.querySelector<HTMLElement>('ytmusic-player-bar #progress-bar')
      );
    },

    getTrack(): { left: number; width: number } | null {
      // The progress bar's element box is offset to the left of the track it
      // actually represents (measured at -17px), while its *width* matches the
      // track. Determined by clicking the bar at known x positions and reading
      // back currentTime, across three window sizes: the track consistently
      // starts at viewport x=0 and is as wide as the element. Using the
      // element's own left puts every marker out by more than a percent.
      const rect = this.getProgressBar()?.getBoundingClientRect();
      if (rect && rect.width > 0) return { left: 0, width: rect.width };

      const width = document.documentElement.clientWidth;
      return width > 0 ? { left: 0, width } : null;
    },

    // --- The LR button ---

    createButton() {
      if (document.getElementById(BUTTON_ID)) return;

      const repeatButton = this.getRepeatButton();
      const container =
        repeatButton?.parentElement ??
        document.querySelector<HTMLElement>('.right-controls-buttons');
      if (!container) {
        this.log('Could not find the player bar controls to attach the button');
        return;
      }

      const button = document.createElement('button');
      button.id = BUTTON_ID;
      button.className = 'style-scope ytmusic-player-bar';
      button.title = t('plugins.limited-repeat.button.title');
      button.setAttribute('aria-label', button.title);
      button.innerHTML = BUTTON_SVG;

      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.toggle();
      });

      // Sit immediately after the repeat button, alongside shuffle and repeat.
      if (repeatButton) {
        repeatButton.after(button);
      } else {
        container.appendChild(button);
      }

      this.button = button;
      this.updateBadge();
      this.log('Button attached to the player bar');
    },

    // --- The draggable A/B markers ---

    createOverlay() {
      if (document.getElementById(OVERLAY_ID)) return;

      const overlay = document.createElement('div');
      overlay.id = OVERLAY_ID;

      const track = document.createElement('div');
      track.className = 'lr-track';

      const region = document.createElement('div');
      region.className = 'lr-region';

      const handleA = document.createElement('div');
      handleA.className = 'lr-handle';
      handleA.dataset.side = 'a';

      const handleB = document.createElement('div');
      handleB.className = 'lr-handle';
      handleB.dataset.side = 'b';

      // Grab the pointer before the slider ever sees it, so dragging a marker
      // never moves the playhead. `setPointerCapture` keeps the drag alive even
      // when the cursor leaves the handle.
      for (const [side, handle] of [
        ['a', handleA],
        ['b', handleB],
      ] as const) {
        handle.addEventListener(
          'pointerdown',
          (event) => {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            this.startDrag(side, event);
          },
          true,
        );
        // Belt and braces: the slider also reacts to these.
        for (const type of ['mousedown', 'click'] as const) {
          handle.addEventListener(
            type,
            (event) => {
              event.preventDefault();
              event.stopPropagation();
              event.stopImmediatePropagation();
            },
            true,
          );
        }
      }

      overlay.append(track, region, handleA, handleB);
      document.body.appendChild(overlay);

      this.overlay = overlay;
      this.region = region;
      this.handleA = handleA;
      this.handleB = handleB;
    },

    layoutOverlay() {
      const overlay = this.overlay;
      const progressBar = this.getProgressBar();
      const track = this.getTrack();
      if (!overlay || !progressBar || !track) return;

      const rect = progressBar.getBoundingClientRect();

      overlay.style.left = `${track.left}px`;
      overlay.style.top = `${rect.top}px`;
      overlay.style.width = `${track.width}px`;
      overlay.style.height = `${Math.max(rect.height, 28)}px`;

      this.updateMarkers();
    },

    updateMarkers() {
      const duration = this.getDuration();
      if (!this.overlay || !this.region || !this.handleA || !this.handleB) {
        return;
      }
      if (!this.lrActive || duration <= 0) return;

      const track = this.getTrack();
      if (!track) return;

      const b = this.pointB ?? duration;
      // Exact positions - the bracket glyphs are drawn inwards from the marker
      // so both stay visible even at 0:00 and at the very end of the track.
      const aX = (this.pointA / duration) * track.width;
      const bX = (b / duration) * track.width;

      this.handleA.style.left = `${aX}px`;
      this.handleB.style.left = `${bX}px`;
      this.region.style.left = `${aX}px`;
      this.region.style.width = `${Math.max(0, bX - aX)}px`;

      // Hide YouTube's red progress line outside the loop. A mask is used
      // rather than clip-path because clip-path would also block clicks, and
      // seeking on the bar must keep working.
      this.applyBarMask(this.pointA / duration, b / duration);
    },

    applyBarMask(aFraction: number, bFraction: number) {
      const progressBar = this.getProgressBar();
      const track = this.getTrack();
      if (!progressBar || !track) return;

      // The mask is relative to the element's own box, which is offset from
      // the track, so convert through viewport coordinates.
      const rect = progressBar.getBoundingClientRect();
      if (rect.width <= 0) return;
      const toElementFraction = (fraction: number) =>
        (track.left + fraction * track.width - rect.left) / rect.width;

      const a = `${Math.max(0, Math.min(1, toElementFraction(aFraction))) * 100}%`;
      const b = `${Math.max(0, Math.min(1, toElementFraction(bFraction))) * 100}%`;
      const gradient =
        `linear-gradient(to right, transparent 0 ${a}, ` +
        `#000 ${a} ${b}, transparent ${b} 100%)`;

      progressBar.style.setProperty('-webkit-mask-image', gradient);
      progressBar.style.setProperty('mask-image', gradient);
    },

    clearBarMask() {
      const progressBar = this.getProgressBar();
      if (!progressBar) return;
      progressBar.style.removeProperty('-webkit-mask-image');
      progressBar.style.removeProperty('mask-image');
    },

    timeFromClientX(clientX: number): number | null {
      const track = this.getTrack();
      const duration = this.getDuration();
      if (!track || duration <= 0) return null;

      const fraction = Math.min(
        1,
        Math.max(0, (clientX - track.left) / track.width),
      );
      return fraction * duration;
    },

    startDrag(side: 'a' | 'b', event: PointerEvent) {
      const handle = side === 'a' ? this.handleA : this.handleB;
      if (!handle) return;

      this.dragging = side;
      handle.dataset.dragging = '';
      handle.setPointerCapture(event.pointerId);

      const duration = this.getDuration();

      const onMove = (moveEvent: PointerEvent) => {
        moveEvent.preventDefault();
        moveEvent.stopPropagation();

        const time = this.timeFromClientX(moveEvent.clientX);
        if (time === null) return;

        const b = this.pointB ?? duration;
        if (side === 'a') {
          this.pointA = Math.min(time, b - MIN_RANGE_SECONDS);
          if (this.pointA < 0) this.pointA = 0;
        } else {
          this.pointB = Math.max(time, this.pointA + MIN_RANGE_SECONDS);
          if (this.pointB > duration) this.pointB = duration;
        }
        this.updateMarkers();
      };

      const onUp = (upEvent: PointerEvent) => {
        upEvent.preventDefault();
        upEvent.stopPropagation();

        this.dragging = null;
        delete handle.dataset.dragging;
        handle.releasePointerCapture?.(event.pointerId);
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);

        this.log(
          `Loop range ${formatTime(this.pointA)}–${formatTime(this.pointB ?? duration)}`,
        );
        this.updateBadge();

        // Now that the range is settled, drop into it if playback is outside.
        const video = this.getVideo();
        const b = this.pointB ?? duration;
        if (
          video &&
          !video.paused &&
          (video.currentTime < this.pointA || video.currentTime >= b)
        ) {
          this.jumpToA();
        }
      };

      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    },

    // --- Repeat button: changing repeat mode spends LR ---

    patchRepeatButton() {
      const bar = this.getPlayerBar();
      if (!bar || bar.__lrPatched) return;

      const original = bar.onRepeatButtonClick.bind(bar);
      bar.__lrOriginalRepeatClick = original;
      bar.__lrPatched = true;
      this.patchedBar = bar;

      // Real mouse clicks on the repeat button are caught by `onPointerDown`.
      // This patch covers the `peard:switch-repeat` IPC path (see
      // src/renderer.ts), used by the API server and global shortcuts.
      bar.onRepeatButtonClick = () => {
        this.cancel('repeat-mode-changed');
        original();
      };
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
      // Runs on every DOM mutation under body, so key off element identity
      // rather than a flag - otherwise an unlucky ordering spends LR mid-loop.
      this.playerBarObserver = new MutationObserver(() => {
        if (!document.getElementById(BUTTON_ID)) this.createButton();
        if (!document.getElementById(OVERLAY_ID)) this.createOverlay();

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

    toggle() {
      if (this.lrActive) {
        this.cancel('lr-button');
      } else {
        this.engage();
      }
    },

    engage() {
      const duration = this.getDuration();

      this.lrActive = true;
      // Markers start at the two ends of the track; drag them inwards.
      this.pointA = 0;
      this.pointB = duration > 0 ? duration : null;
      (
        window as Window & { __limitedRepeatActive?: boolean }
      ).__limitedRepeatActive = true;

      this.overlay?.setAttribute('data-visible', '');
      this.layoutOverlay();

      // The progress bar moves as the window resizes and as the player bar
      // re-renders, so keep re-measuring while the markers are on screen.
      this.layoutTimer ??= setInterval(
        () => this.layoutOverlay(),
        LAYOUT_TICK_MS,
      );

      this.updateBadge();
      this.log('Armed - drag the [ and ] markers to set the loop');
    },

    cancel(reason: string) {
      if (!this.lrActive) return;
      this.lrActive = false;
      this.pointA = 0;
      this.pointB = null;
      this.dragging = null;
      (
        window as Window & { __limitedRepeatActive?: boolean }
      ).__limitedRepeatActive = false;

      this.clearFineTimer();
      if (this.layoutTimer) {
        clearInterval(this.layoutTimer);
        this.layoutTimer = null;
      }
      this.overlay?.removeAttribute('data-visible');
      this.overlay?.removeAttribute('data-grab');
      this.clearBarMask();

      this.updateBadge();
      this.log(`Spent (${reason})`);
    },

    updateBadge() {
      const button = this.button ?? document.getElementById(BUTTON_ID);
      if (!button) return;

      if (this.lrActive) {
        button.setAttribute('data-lr', '');
      } else {
        button.removeAttribute('data-lr');
      }
      this.publishState();
    },

    publishState() {
      // Read-only snapshot: `playback-recovery` uses the flag, and it makes the
      // loop range inspectable from the console.
      const w = window as Window & {
        __limitedRepeatActive?: boolean;
        __limitedRepeat?: { active: boolean; a: number; b: number | null };
      };
      w.__limitedRepeatActive = this.lrActive;
      w.__limitedRepeat = {
        active: this.lrActive,
        a: this.pointA,
        b: this.pointB,
      };
    },

    setGrabMode(on: boolean) {
      if (!this.overlay) return;
      // Never while dragging - resizing the handle mid-drag is disorienting.
      if (on && (!this.lrActive || this.dragging)) return;
      if (on) {
        this.overlay.setAttribute('data-grab', '');
      } else {
        this.overlay.removeAttribute('data-grab');
      }
    },

    onPointerDown(event: PointerEvent) {
      if (!this.lrActive || this.dragging) return;

      const target = event.target as HTMLElement | null;
      if (!target?.closest) return;

      // Our own controls handle themselves.
      if (target.closest(`#${BUTTON_ID}`)) return;
      if (target.closest(`#${OVERLAY_ID}`)) return;
      // Seeking on the bar is allowed and does not spend LR.
      if (target.closest('#progress-bar')) return;

      // Clicks outside the player bar (browsing, the queue, etc.) are harmless;
      // a resulting song change spends LR via `videodatachange` anyway.
      if (!target.closest('ytmusic-player-bar')) return;
      // Play/pause is the one control that leaves LR armed.
      if (target.closest('#play-pause-button')) return;

      this.cancel('other-control');
    },

    // --- The loop itself ---

    hookVideo() {
      const video = this.getVideo();
      if (!video || video === this.hookedVideo) return;

      this.unhookVideo();

      this.timeUpdateListener = () => this.onTimeUpdate();
      this.seekedListener = () => this.onSeeked();
      this.endedListener = () => {
        if (this.lrActive && this.pointB !== null) {
          // `ended` is never a deliberate pause, so always resume here.
          this.jumpToA(true);
        }
      };
      // Pressing play outside the loop starts it at A.
      this.playListener = () => {
        if (!this.lrActive || this.pointB === null) return;
        const current = video.currentTime;
        if (current < this.pointA || current >= this.pointB) {
          this.jumpToA();
        }
      };
      // The duration is often unknown at the moment LR is armed.
      this.durationListener = () => {
        if (this.lrActive && this.pointB === null) {
          const duration = this.getDuration();
          if (duration > 0) {
            this.pointB = duration;
            this.layoutOverlay();
          }
        }
      };

      video.addEventListener('timeupdate', this.timeUpdateListener);
      video.addEventListener('seeked', this.seekedListener);
      video.addEventListener('ended', this.endedListener);
      video.addEventListener('play', this.playListener);
      video.addEventListener('durationchange', this.durationListener);
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
      if (this.playListener) {
        video.removeEventListener('play', this.playListener);
      }
      if (this.durationListener) {
        video.removeEventListener('durationchange', this.durationListener);
      }
      this.timeUpdateListener = null;
      this.seekedListener = null;
      this.endedListener = null;
      this.playListener = null;
      this.durationListener = null;
      this.hookedVideo = null;
    },

    onTimeUpdate() {
      if (!this.lrActive || this.pointB === null || this.dragging) return;

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
        if (!this.lrActive || this.pointB === null || this.dragging) {
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
      if (!video) return;

      const wasPlaying = !video.paused;

      this.clearFineTimer();
      this.selfSeek = true;
      // Setting `currentTime` directly is tighter than `api.seekTo` here.
      video.currentTime = this.pointA;

      // Only resume if playback was actually running - a deliberate pause must
      // not be undone by the loop.
      if ((wasPlaying || forcePlay) && video.paused) {
        void video.play().catch(() => {
          /* ignore - playback may have been stopped deliberately */
        });
      }
    },

    onSeeked() {
      if (this.selfSeek) {
        this.selfSeek = false;
        return;
      }
      if (!this.lrActive || this.pointB === null) return;

      const video = this.getVideo();
      if (!video) return;

      // Seeking past the end of the loop drops straight back to A. Seeking
      // before A is left alone - it just plays in until the loop catches it.
      if (video.currentTime > this.pointB) {
        this.jumpToA();
      }
    },
  },
});
