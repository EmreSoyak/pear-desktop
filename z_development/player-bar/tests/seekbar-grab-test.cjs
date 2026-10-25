// Seek Bar Grab Area (src/plugins/seekbar-grab), against the running app:
//   start "" "pack\win-unpacked\YouTube Music.exe" --remote-debugging-port=9222
//   node z_development/player-bar/tests/seekbar-grab-test.cjs
//
// 1. Real-mouse drags (Input.dispatchMouseEvent, LESSONS #2) across the bar at
//    -10..+10px from the visible 3px line, on the left half and on the right
//    half where YouTube's right-hand section overlaps the bar. Each must seek
//    to where it was released and select no text.
// 2. Moving up from the mute button to the volume slider must keep the volume
//    popup open (the raised hit area once covered the popup's lower part).
//
// Expectations come from the bar's own scale (`max`, what YouTube seeks by)
// and song time from the player API - never video.currentTime, which is
// stream time on the gapless player (LESSONS #18).
const path = require('path');
const WebSocket = require(path.join(__dirname, '../../../node_modules/ws'));

let id = 0;
const rpc = (ws, method, params = {}) => new Promise((res, rej) => {
  const my = ++id;
  const on = (m) => { const d = JSON.parse(m); if (d.id !== my) return; ws.off('message', on); d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result); };
  ws.on('message', on); ws.send(JSON.stringify({ id: my, method, params }));
});
const ev = async (ws, expr) => (await rpc(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mouse = (ws, type, x, y, buttons = 0) => rpc(ws, 'Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1 });

(async () => {
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const page = list.find((p) => p.type === 'page' && p.url.includes('music.youtube.com'));
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r) => ws.on('open', r));

  let pass = 0, fail = 0;
  const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); };

  check('seekbar-grab style present', await ev(ws, `!!document.getElementById('seekbar-grab-style')`));

  // Geometry at rest (the line grows while hovered)
  await mouse(ws, 'mouseMoved', 700, 400);
  await sleep(300);
  const g = await ev(ws, `(() => { const b = document.querySelector('input.ytMusicMiniPlayerProgressBar'); const r = b.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, width: r.width, max: +b.max, title: document.querySelector('#movie_player').getVideoData().title }; })()`);
  const line = (g.top + g.bottom) / 2;
  console.log(`track "${g.title}", bar box ${g.top}..${g.bottom} (${(g.bottom - g.top).toFixed(0)}px), line at y=${line}, scale ${g.max}s`);
  // Range-input track: inset by half the 12px thumb on each side (LESSONS #3)
  const songAt = (x) => ((x - g.left - 6) / (g.width - 12)) * g.max;

  for (const dy of [-10, -6, -3, 0, 3, 6, 10]) {
    for (const [fx1, fx2] of [[0.15, 0.35], [0.6, 0.8]]) {
      const y = line + dy, x1 = Math.round(g.left + g.width * fx1), x2 = Math.round(g.left + g.width * fx2);
      await ev(ws, `document.querySelector('#movie_player').seekTo(5, true); getSelection().removeAllRanges()`);
      await sleep(500);
      const hit = await ev(ws, `(() => { const e = document.elementFromPoint(${x1}, ${y}); return e ? e.tagName.toLowerCase() + '.' + ([...e.classList][0] || '') : null; })()`);
      await mouse(ws, 'mouseMoved', x1, y);
      await mouse(ws, 'mousePressed', x1, y, 1);
      for (let i = 1; i <= 12; i++) { await mouse(ws, 'mouseMoved', x1 + ((x2 - x1) * i) / 12, y + (i % 3) - 1, 1); await sleep(20); }
      await mouse(ws, 'mouseReleased', x2, y, 0);
      await sleep(700);
      const r = await ev(ws, `({ t: document.querySelector('#movie_player').getCurrentTime(), sel: getSelection().toString().length })`);
      const exp = songAt(x2);
      // 1.5s: playback runs on for the 0.7s between release and the read
      check(`drag dy=${String(dy).padStart(3)} ${fx1}->${fx2}`, Math.abs(r.t - exp) < 1.5 && r.sel === 0,
        `hit=${hit} t=${r.t.toFixed(1)} expected~${exp.toFixed(1)} selected=${r.sel}`);
    }
  }

  // Inside the strip YouTube's right-hand section overlaps (from its left edge
  // on): without the lift these presses land on the section and never seek.
  // Run once on a fresh load before the volume popup has ever opened, and once
  // after (the volume rule must not leave the lift switched off).
  const rs = await ev(ws, `document.querySelector('.ytMusicMiniPlayerRightSection').getBoundingClientRect().left`);
  for (const [px, dy] of [[rs + 20, 0], [rs + 20, 4], [rs + 20, 8], [g.left + g.width * 0.9, 4]]) {
    const x = Math.round(px), y = line + dy;
    await ev(ws, `document.querySelector('#movie_player').seekTo(5, true)`);
    await sleep(500);
    const hit = await ev(ws, `(() => { const e = document.elementFromPoint(${x}, ${y}); return e ? e.tagName.toLowerCase() + '.' + ([...e.classList][0] || '') : null; })()`);
    await mouse(ws, 'mouseMoved', x, y);
    await mouse(ws, 'mousePressed', x, y, 1);
    await mouse(ws, 'mouseReleased', x, y, 0);
    await sleep(700);
    const t = await ev(ws, `document.querySelector('#movie_player').getCurrentTime()`);
    const exp = songAt(x);
    check(`click in overlap strip x=${x} dy=${dy}`, hit === 'input.ytMusicMiniPlayerProgressBar' && Math.abs(t - exp) < 1.5,
      `hit=${hit} t=${t.toFixed(1)} expected~${exp.toFixed(1)}`);
  }

  // Volume popup: from the mute button straight up to the slider
  await mouse(ws, 'mouseMoved', 700, 400);
  await sleep(600);
  const btn = await ev(ws, `(() => { const r = document.querySelector('.ytMusicMiniPlayerVolumeWrapper button').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  let closedAt = null, reachedSlider = false;
  for (let y = btn.y; y >= btn.y - 130; y -= 4) {
    await mouse(ws, 'mouseMoved', btn.x, y);
    await sleep(40);
    const s = await ev(ws, `(() => { const p = document.querySelector('.ytMusicMiniPlayerVolumePopup'); const open = getComputedStyle(p).display !== 'none'; const e = document.elementFromPoint(${btn.x}, ${y}); return { open, slider: !!e?.closest('.ytMusicMiniPlayerVolumePopup input') }; })()`);
    if (s.slider) reachedSlider = true;
    if (!s.open && closedAt === null && y < btn.y - 4) closedAt = y;
    if (reachedSlider) break;
  }
  check('volume popup stays open from the mute button to the slider', closedAt === null && reachedSlider,
    closedAt === null ? '' : `closed at y=${closedAt}`);
  await mouse(ws, 'mouseMoved', 700, 400);

  console.log(fail ? `\n${fail} FAILED` : '\nall passed');
  ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
