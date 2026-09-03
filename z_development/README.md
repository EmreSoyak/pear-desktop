# z_development

Working notes for the custom features added to this fork of
[th-ch/youtube-music](https://github.com/th-ch/youtube-music).

The point of this folder is that **nobody should have to re-derive how a feature
works by reading the whole codebase again**. One subfolder per feature, each
holding what was built, why it was built that way, what broke, and how to test
it.

## Read this first

**[LESSONS.md](LESSONS.md)** — the mines we already stepped on. Read it before
touching this project. It covers the build process that can destroy a working
install, YouTube's progress-bar geometry, Windows/Electron event traps, and how
to actually test changes in the running app instead of guessing.

## Features

| Feature | Folder | Status |
|---------|--------|--------|
| Limited Repeat (A–B loop) | [limited-repeat/](limited-repeat/) | Shipped, tested |

Earlier features (Audio-Only, Playback Recovery, Virtual Desktop Awareness, Tray
Hover Mini-Player) are documented in [`../EMRE-FEATURES.md`](../EMRE-FEATURES.md);
they predate this folder and have no subfolder yet.

## Layout for a new feature

```
z_development/<feature-name>/
  README.md      what it does, how it works, why these decisions, known limits
  tests/         runnable verification (see limited-repeat/tests for the pattern)
```

## Build and run

```bash
pnpm build                      # compile to dist/
build.bat                       # full rebuild + package into pack/
start.bat                       # launch the packaged app
```

**Do not** run `electron-builder` directly against `pack/` — see the first entry
in LESSONS.md for why that can destroy a working install, and for the safe
build-to-temp-then-copy procedure.
