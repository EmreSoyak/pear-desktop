# Player Layout (`player-layout`)

**Origin:** custom (2026-10-25) · **Type:** renderer plugin, CSS only · **Default:** on · **restartNeeded:** false

## What it does

Moves the Up Next / Lyrics / Related side panel on the player page flush
against the window's right edge.

## Why it exists

YouTube pads the player page's `.content` on both sides with
`--ytmusic-player-page-horizontal-padding` (56px), its own CSS:
`ytmusic-player-page:not([is-mweb-modernization-enabled]) .content.ytmusic-player-page { padding: var(--ytmusic-player-page-vertical-padding) var(--ytmusic-player-page-horizontal-padding) 0 }`.
That left a visible gap right of the queue.

## How it works

[`src/plugins/player-layout/style.css`](../../src/plugins/player-layout/style.css),
injected as `<style id="player-layout-style">`:

```css
ytmusic-player-page:not([is-mweb-modernization-enabled]) .side-panel.ytmusic-player-page {
  margin-right: calc(-1 * var(--ytmusic-player-page-horizontal-padding, 56px)) !important;
}
```

Only the side panel is pulled into the padding. Zeroing `.content`'s
`padding-right` instead widened the main panel too, and YouTube then cropped
the top of the album art (tried 2026-10-25).

Measured at 1536px: side panel 1054–1480 → 1110–1536, main panel width 702 → 758, art uncropped.

## Config

| Key | Type | Default |
|---|---|---|
| `plugins.player-layout.enabled` | boolean | true |
