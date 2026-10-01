# Docs

A map of this codebase, so nobody has to search it again. **Start at
[`index.json`](index.json)**: every plugin, custom feature and core module
gets one entry saying where its doc and source live, what it touches (config
keys, IPC channels, DOM anchors), and how it fares on YouTube's current player
bar.

| File | Covers |
|---|---|
| [index.json](index.json) | machine-readable map of everything below |
| [architecture.md](architecture.md) | process model, boot sequence, plugin system, config, the **full IPC channel reference**, providers, tray/menu, build, types |
| [player-bar.md](player-bar.md) | YouTube's player-bar DOM (new and old), the `dom-elements.ts` helpers, how every control and feed was ported in the 2026-10 redesign |
| [custom/](custom/) | the features added in this fork: [limited-repeat](custom/limited-repeat.md), [audio-only](custom/audio-only.md), [playback-recovery](custom/playback-recovery.md), [virtual-desktop](custom/virtual-desktop.md), [tray-hover-mini-player](custom/tray-hover-mini-player.md), [interface-language](custom/interface-language.md) |
| [plugins/](plugins/) | upstream plugins by domain: [playback-audio](plugins/playback-audio.md), [appearance-ui](plugins/appearance-ui.md), [integrations](plugins/integrations.md), [content-library](plugins/content-library.md), [system-controls](plugins/system-controls.md) |
| [dev-tooling.md](dev-tooling.md) | build/install scripts, the safe build, CDP test harnesses, diagnostics, git remotes |
| [changelog.md](changelog.md) | every change this fork made on top of upstream, with commits |

Related, not duplicated here:

- [`../z_development/LESSONS.md`](../z_development/LESSONS.md): traps already hit. **Read it before changing anything.**
- [`../z_development/limited-repeat/`](../z_development/limited-repeat/README.md): LR design notes and harnesses
- [`../EMRE-FEATURES.md`](../EMRE-FEATURES.md): the upstream-PR write-up of the custom features. Where it disagrees with these docs, these docs were checked against the code on 2026-10-01

## Keeping it current

When you change a plugin, update its section and its `index.json` entry in the
same change. If YouTube changes the page, update [player-bar.md](player-bar.md)
and the `newPlayerBarStatus` fields.
