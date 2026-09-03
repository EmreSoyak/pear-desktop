# Limited Repeat (LR)

An A–B loop for the current song, driven by two draggable `[` and `]` markers on
the progress bar.

**Plugin:** `src/plugins/limited-repeat/index.ts` (renderer-only, single file)
**Settings:** Plugins → Limited Repeat (off by default, no restart needed)
**Status:** shipped and verified against the running app

---

## What it does

A dedicated **LR button** sits in the player bar between repeat and shuffle.

| Action | Result |
|--------|--------|
| Click **LR** | Arms it. `[` appears at 0:00 and `]` at the end of the track. Button turns red. |
| Drag `[` / `]` | Sets the loop range. Playback drops into the range when you let go. |
| Hold **Shift** | Grab area grows from 28px to 90×44px. Brackets don't move. |
| Press play outside the range | Jumps to `[` and starts the loop. |
| Click **LR** again | Off. Markers vanish, bar returns to normal. |

While armed, YouTube's red progress line is **masked to the loop range** — no red
outside the brackets — with a neutral grey track shown outside it.

### How it ends

LR is deliberately disposable and never persists:

- Clicking the LR button
- Any other player-bar control (repeat, shuffle, next, previous, like…)
- **Except play/pause**, which leaves it armed
- Changing song — and it does *not* come back if you return to that song
- Nothing is saved to config; it dies with the track

---

## Design decisions, and why

### It's a separate button, not a fourth repeat mode

The original design put LR as a fourth position on the repeat button
(`NONE → ALL → ONE → LR`). **This did not work.** Reassigning
`ytmusic-player-bar.onRepeatButtonClick` intercepts programmatic calls but *not*
real mouse clicks — YouTube wires its own internal handler, so the native cycle
ran `ONE → NONE` and the override never fired.

A separate button avoids fighting a third-party state machine entirely. The
method patch is still in place, but only so that changing repeat mode via the
API server / global shortcuts (`peard:switch-repeat` in `src/renderer.ts`)
also spends LR.

### Markers are dragged, not set by shift+click

Shift+click on the progress bar was the first design. It never worked — the
slider consumes the event and just seeks. Draggable handles are also simply a
better fit for "move them wherever I want".

### Time ↔ pixel mapping

**This was the source of a visible ~2.6s offset between where a bracket looked
like it was and where the loop actually happened.**

`#progress-bar`'s bounding rect is offset ~17px left of the track it represents;
its *width* is right, its *left* is not. Correct mapping:

```js
const width = document.querySelector('#progress-bar').getBoundingClientRect().width;
const x = (time / duration) * width;   // track starts at viewport x = 0
```

Established empirically across three window sizes (`tests/lr-calib.cjs`). Full
detail in [../LESSONS.md](../LESSONS.md) §3.

Two dead ends worth not repeating: `documentElement.clientWidth` fits *some*
window states by coincidence, and the bar's shadow DOM is closed so the inner
track cannot be measured directly.

### No clamping of marker positions

An earlier version clamped handles into the viewport so the one at 0:00 stayed
grabbable. **That clamp displaced the markers from their true times** — a second
source of the offset. It's gone. Instead the bracket glyphs are drawn *inwards*
from the marker position (`[` extends right, `]` extends left), so both stay
visible at the extremes, and Shift solves the grabbing problem.

### `mask-image`, not `clip-path`

Hiding the progress line outside the range uses a CSS mask. `clip-path` would
also clip hit-testing and silently break seeking outside the loop.

Mask percentages are relative to the element's own box, which is offset from the
track — `applyBarMask()` converts through viewport coordinates.

### `data-lr`, never `title`

`src/providers/song-info-front.ts` observes the **`title`** attribute on
`#right-controls .repeat` and broadcasts `queue.repeatMode` to the API server and
websocket clients when it changes. Writing `title` would publish a stale repeat
mode to external consumers.

### Loop precision

`timeupdate` fires ~4×/second — enough to overshoot B by 250ms, which is audible
on a short loop. It's used as a coarse guard, handing off to a 25ms timer for the
last second before B. Measured overshoot: **0.03–0.06s**.

### Interaction with Playback Recovery

A short A–B loop makes `currentTime` oscillate rather than advance, which the
Playback Recovery watchdog could read as a frozen player and "fix" by skipping
the track. LR publishes `window.__limitedRepeatActive` and
`src/plugins/playback-recovery/index.ts` stands down while it is set.

`window.__limitedRepeat` also exposes `{ active, a, b }` read-only, which is
what the test harnesses assert against.

### Not looping mid-drag

Looping is suppressed while `this.dragging` is set. Without that, dragging a
marker while the playhead sits outside the new range yanks playback around
while you're still aiming.

---

## Config

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `false` | Standard plugin toggle |
| `logToConsole` | `false` | Logs state changes and loop points to DevTools |

---

## Files

| File | Role |
|------|------|
| `src/plugins/limited-repeat/index.ts` | The whole plugin |
| `src/plugins/playback-recovery/index.ts` | Stands down while LR is looping |
| `src/i18n/resources/en.json` | `plugins.limited-repeat.*` strings |

---

## Tests

See [tests/README.md](tests/README.md). All are runnable against the live app.

Last measured results:

| Test | Result |
|------|--------|
| `lr-test.cjs` | 24/24 — button, overlay, markers, mask, cancel rules |
| `lr-loop-test.cjs` | 7/7 — real mouse drag to a 10s window, loops, 0.06s overshoot |
| `lr-accuracy.cjs` | 1/1 — marker position vs YouTube time, worst error 0.40s |
| `lr-shift-test.cjs` | 8/8 — Shift grows hit area 28→90px, brackets don't move |

`lr-accuracy.cjs` is the one that matters if anything ever looks "shifted"
again. YouTube rounds seeks to whole seconds, so 0.5s is the measurement floor —
anything under that is exact.

---

## Known limits

- The loop range is not saved anywhere. That's intentional.
- Marker positions are recomputed every 400ms and on resize; a layout change
  from something other than a resize can be up to 400ms stale.
- Only one loop range per track — no multiple regions.
- Untested on macOS and Linux. The geometry work assumed this Windows build;
  `lr-calib.cjs` should be re-run if the layout differs there.
