# Limited Repeat — test harnesses

These drive the **real running app** over the Chrome DevTools Protocol. They are
not unit tests: they click things, drag things, and watch playback.

## Running them

1. Make sure the plugin is enabled (Plugins → Limited Repeat).
2. Launch the app with the debug port:

   ```
   start "" "pack\win-unpacked\YouTube Music.exe" --remote-debugging-port=9222
   ```

3. Play a track (most tests need a real duration; `lr-loop-test` wants ≥30s).
4. Run from anywhere in the repo:

   ```
   node z_development/limited-repeat/tests/lr-loop-test.cjs
   ```

They use `ws`, resolved from the project's `node_modules` by Node walking up the
directory tree — no install needed, but they must stay inside the repo.

Afterwards, relaunch the app **without** `--remote-debugging-port` for normal use.

## The tests

| File | What it proves |
|------|----------------|
| `lr-test.cjs` | Broad sweep: button exists and sits next to repeat, arming shows the overlay, both markers on screen, overlay doesn't block the bar, region drawn, progress line masked, play/pause keeps LR armed, repeat spends it, mask removed on cancel. |
| `lr-loop-test.cjs` | The real one. Drags both markers with **real mouse input** to a 10-second window mid-song, plays, and confirms it wraps twice with a tight loop point. |
| `lr-accuracy.cjs` | Marker position vs ground truth: for several times, computes where the marker is drawn, clicks that exact pixel, and compares the time YouTube seeks to. Run this if anything ever looks "shifted". Restores your playback position afterwards. |
| `lr-shift-test.cjs` | Shift grows the hit area 28→90px, brackets do not move, a click 35px off the bracket still grabs it, and everything reverts on release. |
| `lr-calib.cjs` | Not a test — a **measuring tool**. Clicks the bar at known x positions across two viewport sizes and least-squares fits the pixel→time mapping. Use it if YouTube changes its player layout, or on another OS. |

## Two things to know before trusting a result

**Synthetic events lie.** `element.dispatchEvent(new PointerEvent(...))` skips
hit-testing. An early version of `lr-test.cjs` passed 24/24 while the feature was
unusable with a real mouse. Anything about clicking or dragging must use
`Input.dispatchMouseEvent`, as `lr-loop-test.cjs` does.

**Don't let the test share the bug.** `lr-loop-test.cjs` once computed its target
coordinates with the same wrong formula the plugin used, so it passed while
sitting 2.6s off target. Assertions should come from ground truth — what YouTube
itself does — not from our own maths.

Also: YouTube quantises seeks to **whole seconds**, so any single click sample
carries ±0.5s of noise. That's why `lr-accuracy.cjs` treats <0.75s as exact and
`lr-calib.cjs` fits a line through many samples.

## They touch your playback

These seek, pause, and play the current track. `lr-accuracy.cjs` restores the
original position; the others leave playback wherever the test ended.
