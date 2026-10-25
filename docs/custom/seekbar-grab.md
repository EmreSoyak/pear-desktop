# Seek Bar Grab Area (`seekbar-grab`)

**Origin:** custom (2026-10-25) · **Type:** renderer plugin, CSS only · **Default:** on · **restartNeeded:** false

## What it does

Makes YouTube's seek bar easy to grab. The red line stays 3px, but it takes
clicks and drags across 21px, grows to 7px while hovered or dragged, and a drag
that starts just off it no longer selects the player bar's text.

## Why it exists

YouTube's 2026-10 seek bar is a native `<input type=range>` only 3px tall. On
the right half of the window YouTube's own right-hand section
(`.ytMusicMiniPlayerRightSection`) covers the lower half of it. Measured with
real clicks (LESSONS #2):

| | Before | After |
|---|---|---|
| Left half | seeks only within a 3px band (y=790–793) | 21px band (y=781.5–802.5) |
| Right half | about 1px | 21px |
| A drag that misses | starts a text selection over the player bar or the page | n/a |

## How it works

[`src/plugins/seekbar-grab/style.css`](../../src/plugins/seekbar-grab/style.css),
injected as `<style id="seekbar-grab-style">` by `index.ts`
(`renderer.start` / `stop`):

| Rule | Why |
|---|---|
| input: `box-sizing: content-box; height: 3px; padding: 9px 0; margin: -9px 0` | 21px hit box, same layout footprint |
| input: `background-clip: content-box; background-origin: content-box` (`!important`) | YouTube draws the fill as an inline `background` shorthand, which resets the clip; these keep the visible line 3px |
| input `:hover`, `:active`: `height: 7px; padding: 7px 0` | grows while you're on it, footprint unchanged |
| wrapper `.ytMusicMiniPlayerProgressBarWrapper`: `z-index: 10; pointer-events: none`, input `pointer-events: auto` | lifts the bar above the right-hand section (z-index 2) without the 23px wrapper itself eating clicks |
| `ytmusic-miniplayer:has(.ytMusicMiniPlayerVolumePopup:not([style*='none']))` wrapper: `z-index: 1` | the volume popup lives in the right section's stacking context and reaches down over the bar; while it is open the bar drops back so the slider keeps its bottom and the popup doesn't close on the way up from the mute button |
| `ytmusic-miniplayer { user-select: none }` | no accidental text selection from a drag next to the bar |

Horizontal geometry is untouched (no horizontal padding), so
[Limited Repeat](limited-repeat.md)'s 6px track inset still holds.

Why `renderer` and not `stylesheets`: the plugin loader only lists plugins that
have a `renderer` (`vite-plugins/plugin-importer.mts`), so a stylesheet-only
plugin is never loaded. And an injected `<style>` can be removed on disable.

## Config

| Key | Type | Default |
|---|---|---|
| `plugins.seekbar-grab.enabled` | boolean | true |

## Verified (2026-10-25)

[`z_development/player-bar/tests/seekbar-grab-test.cjs`](../../z_development/player-bar/tests/seekbar-grab-test.cjs):
20/20: 14 real-mouse drags at -10..+10px on both halves land where released, 4 clicks inside the overlapped strip seek
(within the 0.7s playback runs before reading), no text selected; the volume
popup stays open from the mute button to the slider.
