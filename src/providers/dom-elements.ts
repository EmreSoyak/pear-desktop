import type { GetState } from '@/types/datahost-get-state';

export const getSongMenu = () =>
  document.querySelector<HTMLElement>(
    'ytmusic-menu-popup-renderer tp-yt-paper-listbox',
  );

// YouTube Music replaced `ytmusic-player-bar` with `ytmusic-miniplayer`
// (seen 2026-10). The helpers below prefer the new layout and fall back to the
// old one, because YouTube rolls layouts out gradually and can roll them back.

export type PlayerControl =
  | 'Shuffle'
  | 'Previous'
  | 'PlayPause'
  | 'Next'
  | 'Repeat';

const legacyControlSelectors: Record<PlayerControl, string> = {
  Shuffle: '.shuffle.ytmusic-player-bar',
  Previous: '.previous-button.ytmusic-player-bar',
  PlayPause: '#play-pause-button',
  Next: '.next-button.ytmusic-player-bar',
  Repeat: '#right-controls .repeat',
};

export const getPlayerControl = (control: PlayerControl) =>
  document.querySelector<HTMLElement>(
    `.ytmusicPlayerControls${control}Button button`,
  ) ?? document.querySelector<HTMLElement>(legacyControlSelectors[control]);

// The wrapper of a control in the new layout (a sibling of the other controls).
export const getPlayerControlWrapper = (control: PlayerControl) =>
  document.querySelector<HTMLElement>(`.ytmusicPlayerControls${control}Button`);

export const getPlayerBar = () =>
  document.querySelector<HTMLElement>('ytmusic-miniplayer') ??
  document.querySelector<HTMLElement>('ytmusic-player-bar');

// The new seek bar is a native range input whose `value` is a property only.
export const getProgressBar = () =>
  document.querySelector<HTMLInputElement>(
    'input.ytMusicMiniPlayerProgressBar',
  ) ?? document.querySelector<HTMLElement>('#progress-bar');

export const isNewPlayerBar = () =>
  !!document.querySelector('input.ytMusicMiniPlayerProgressBar');

export const getLikeButton = (type: 'like' | 'dislike') =>
  document.querySelector<HTMLElement>(
    `ytmusic-miniplayer ${type}-button-view-model button`,
  );

export const getMuteButton = () =>
  document.querySelector<HTMLElement>('.ytMusicMiniPlayerVolumeWrapper button');

export const getVolumeSlider = () =>
  document.querySelector<HTMLInputElement>(
    '.ytMusicMiniPlayerVolumePopup input',
  );

// The app's redux-style store. `getState()` is also exposed on the old player
// bar, but the store itself outlives both layouts.
export type AppStore = {
  getState: () => GetState;
  subscribe: (listener: () => void) => () => void;
};

export const getAppStore = () =>
  document.querySelector<HTMLElement & { queue?: { store?: AppStore } }>(
    '#queue',
  )?.queue?.store ?? null;
