import type { MusicPlayer } from '@/types/music-player';

// YouTube Music plays tracks gapless (seen 2026-10): one media stream runs
// across songs, so the <video> element's `currentTime` and `duration` belong
// to that stream, not to the current song. On the second track `currentTime`
// starts where the first one ended, and `duration` grows as the next track is
// buffered. The player API (`#movie_player`) still reports song-relative time,
// so read and seek through it.
//
// YouTube also replaces the <video> element at some song changes, so never
// keep a reference to it: query it fresh, or listen on the document.

export const getPlayerApi = () =>
  document.querySelector<HTMLElement & MusicPlayer>('#movie_player');

export const getVideo = () =>
  document.querySelector<HTMLVideoElement>('#movie_player video') ??
  document.querySelector<HTMLVideoElement>('video');

const finite = (value: number | undefined) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

// Seconds into the current song.
export const getSongTime = () => {
  const api = getPlayerApi();
  return finite(api?.getCurrentTime?.()) ?? 0;
};

// Length of the current song in seconds, 0 while unknown. `getDuration()` is
// not it: while a track is still streaming in it reports how much has loaded
// (seen growing 359 -> 369 on a 392s track). The seekable end is the length.
export const getSongDuration = () => {
  const api = getPlayerApi();
  const seekableEnd = finite(api?.getProgressState?.()?.seekableEnd) ?? 0;
  if (seekableEnd > 0) return seekableEnd;
  const duration = finite(api?.getDuration?.()) ?? 0;
  return duration > 0 ? duration : 0;
};

// Seek within the current song. Always through the player API: writing the
// element's `currentTime` past what the gapless stream has buffered clamps to
// the stream's end, and YouTube then skips to the next track. `seekTo` was
// measured exact to the millisecond, taking about 6ms.
export const seekSong = (seconds: number) => {
  getPlayerApi()?.seekTo(seconds, true);
};
