# Lessons — read before you touch this project

Hard-won, mostly the expensive way. Each entry is a real failure that cost time
in this repo.

---

## 1. Never run electron-builder against `pack/` — it can destroy your working app

**What happened.** `electron-builder` **empties the output directory before it
refills it**. A packaging run against `pack/` hit a locked `app.asar`, aborted
partway, and left `pack/win-unpacked/` with only the `.exe` — no `icudtl.dat`,
no `ffmpeg.dll`, no `locales/`. The app stopped launching entirely
(`Invalid file descriptor to ICU data received` in `debug.log`). Retrying made
it worse, because each retry emptied the directory again.

**The rule.** Build to a temp directory *outside* the project, verify it is
complete, and only then copy into `pack/`:

```bash
SCRATCH=/tmp/lrbuild            # anywhere outside the repo
rm -rf "$SCRATCH"
./node_modules/.bin/electron-builder --win dir:x64 -p never \
  --config.directories.output="$SCRATCH"

# A complete win-unpacked has 20 entries. Check before copying.
[ "$(ls "$SCRATCH/win-unpacked/" | wc -l)" -eq 20 ] || exit 1

cp -rf "$SCRATCH/win-unpacked/." pack/win-unpacked/
```

A failed build then costs nothing. `build.bat` is fine for normal use; this
matters when iterating.

**Also:** close the app before copying (`Stop-Process -Force`), or `app.asar`
will be locked.

**Two related traps:**

- `electron-builder` exits non-zero on a **code-signing** step that needs admin
  rights (`Cannot create symbolic link ... winCodeSign`). This is cosmetic for a
  local unsigned build — packaging itself already succeeded. Check the output
  files, not just the exit code.
- A locked `app.asar` **cannot be deleted or renamed, but can be overwritten**.
  `cp -f` succeeds where `rm` and `mv` fail. Don't go hunting for the lock
  holder; just overwrite.

---

## 2. Test in the running app over CDP — don't eyeball it, and don't trust synthetic events

Guessing whether a UI change works wastes the user's time. The app can be driven
directly:

```bash
start "" "pack\win-unpacked\YouTube Music.exe" --remote-debugging-port=9222
node z_development/limited-repeat/tests/lr-test.cjs
```

Connect to `http://127.0.0.1:9222/json/list`, take the page whose URL matches
`music.youtube.com`, open its `webSocketDebuggerUrl`, and use `Runtime.evaluate`.
`ws` is already a dependency. See `limited-repeat/tests/` for a working harness.

**The trap that cost the most here:** `element.dispatchEvent(new PointerEvent(...))`
**bypasses hit-testing**. A drag test built that way passed 24/24 while the
feature was unusable with a real mouse, because nothing verified that a click at
those coordinates actually *reaches* the element.

Use **`Input.dispatchMouseEvent`** instead — it goes through real hit-testing:

```js
await rpc(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
await rpc(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved',   x: x2, y, button: 'left', buttons: 1 });
await rpc(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y, button: 'left', buttons: 0, clickCount: 1 });
```

`document.elementFromPoint(x, y)` is a cheap way to assert "a real click here
lands on my element".

**A test that agrees with the bug is worth nothing.** One harness computed its
target coordinates with the same wrong formula the plugin used, so it passed
while being 2.6s off. When a test passes suspiciously easily, check that it
derives its expectations independently — ideally from ground truth (what
YouTube itself does), not from our own code.

---

## 3. YouTube's progress bar: the element box is NOT the track

`#progress-bar`'s bounding rect is **offset ~17px to the left** of the track it
represents. Its *width* is correct; its *left* is not. Mapping time onto the
element box puts every marker out by 1–3%, which on a one-hour track is ~40
seconds.

**The correct mapping** — the track starts at viewport `x = 0` and is as wide as
the element:

```js
const width = document.querySelector('#progress-bar').getBoundingClientRect().width;
const x = (time / duration) * width;          // time -> pixels
const time = (x / width) * duration;          // pixels -> time
```

Verified across three window sizes by clicking the bar at known x positions and
reading back `video.currentTime` (`tests/lr-calib.cjs` does this).

**Notes for anyone re-measuring it:**

- YouTube **quantises seeks to whole seconds**, so single samples carry ±0.5s of
  noise. Fit a line through many samples; don't trust one.
- `documentElement.clientWidth` matches the track *sometimes* (when a scrollbar
  happens to be present) and not otherwise. It fitted one dataset perfectly by
  luck and failed the next. Two datasets minimum before believing a formula.
- The bar's shadow DOM is **closed** — you cannot measure the inner track
  directly. Calibrate empirically instead.

---

## 4. Masking vs clipping: `clip-path` blocks clicks, `mask-image` does not

To hide part of an element visually while keeping it clickable, use
`mask-image` / `-webkit-mask-image`. `clip-path` also clips hit-testing, which
would have silently broken seeking on the masked part of the progress bar.

Mask percentages are relative to the **element's own box**, so if the element is
offset from the thing you are aligning to (see #3), convert through viewport
coordinates first.

---

## 5. Windows + Electron: unfocused windows swallow events

From the tray hover mini-player work:

- `focusable: false` **kills JS events entirely** on Windows.
- `console.log`-based IPC is unreliable from an unfocused window.
- `onclick` gets swallowed by window activation — use `onmousedown`, which fires
  first, and signal the main process by setting `document.title` and listening
  for `page-title-updated`. Append a counter so repeated identical clicks still
  fire.
- HTML `mouseenter`/`mouseleave` are unreliable for tray hover; poll
  `screen.getCursorScreenPoint()` from the main process instead.

---

## 6. Plugins load before the tray exists

`loadAllMainPlugins()` runs before `setUpTray()`, so `setTrayOnClick` /
`setTrayOnDoubleClick` / `setTrayOnMouseMove` calls made from a plugin were
silently dropped. Handlers registered early are now queued and applied at the
end of `setUpTray`. If a tray handler seems to do nothing, check this first.

---

## 7. Patching a YouTube web component: methods vs DOM events

`ytmusic-player-bar.onRepeatButtonClick` can be reassigned, and doing so
intercepts **programmatic** calls (`src/renderer.ts` uses it for the
`peard:switch-repeat` IPC path from the API server and global shortcuts).

It does **not** intercept real mouse clicks — YouTube wires its own internal
handler, so the native cycle runs and your override never sees it. If you need
both, patch the method *and* intercept `pointerdown` in the capture phase.

This is why Limited Repeat ended up as its own button rather than a fourth
state on the repeat button: fighting a third-party component's state machine
was fragile, and a separate control is simpler and more robust.

---

## 8. Don't touch attributes something else is observing

`src/providers/song-info-front.ts` puts a `MutationObserver` on
`#right-controls .repeat` filtered to the **`title`** attribute, and on fire it
broadcasts `queue.repeatMode` over IPC to the API server and websocket clients.

Writing to that button's `title` therefore publishes a *stale* repeat mode to
external consumers. Use a `data-*` attribute for your own state.

Grep for `MutationObserver` before writing to any YouTube-owned element.

---

## 9. Plugin config gotchas

- `restartNeeded: false` works: enabling a plugin at runtime re-runs
  `onPlayerApiReady` (`src/renderer.ts`, the `plugin:enable` handler). You do
  not need a restart to pick up a newly enabled renderer plugin.
- Plugins are **auto-discovered** by glob (`src/plugins/*/index.{ts,tsx}`) in
  `vite-plugins/plugin-importer.mts`. Adding a folder is enough — there is no
  registry to edit. You do need an i18n entry in `src/i18n/resources/en.json`.
- Helper methods on a renderer plugin must be declared in the `createPlugin`
  generic's property type, or `this.foo()` fails typecheck. Several older
  plugins skip this and leave standing errors — see #10.

---

## 10. `pnpm typecheck` is not clean on this branch

There are ~41 pre-existing errors in `audio-only` (7), `playback-recovery` (33)
and `api-server/.../websocket.ts` (1), caused by helper methods missing from the
`createPlugin` generic. They are harmless at runtime — the build uses
esbuild/rolldown and does not typecheck.

**Check only your own files:**

```bash
pnpm typecheck 2>&1 | grep "your-plugin-name"
```

`pnpm lint` does not run at all — `eslint-plugin-perfectionist` is not
installed.

---

## 11. Git remotes are not what you'd assume

- `origin` = `th-ch/youtube-music` — **upstream, not ours.** Never push here.
- `fork` = `EmreSoyak/pear-desktop` — this is the one to push to.

There is no `stage` or `main` branch; the integration branch is **`master`**.
Local `master` tracks `origin/master`, so pushes must name the remote
explicitly: `git push fork master`.

---

## 12. Working with the owner of this repo

- **Never commit or push without being asked.** Approval for one git operation
  does not carry to the next. Leave finished work in the working tree and say
  what's ready.
- **Verify before reporting done.** "It builds" is not "it works". Drive the
  real app (#2) and report measured numbers.
- Bash heredocs in this environment mangle escape sequences (`\n` inside a
  quoted heredoc has come out as a literal newline, breaking generated JS).
  Prefer the Write/Edit tools for file content.
