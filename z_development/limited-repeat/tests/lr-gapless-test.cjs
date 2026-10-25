// Limited Repeat on YouTube's gapless player (LESSONS #18), against the running app:
//   start "" "pack\win-unpacked\YouTube Music.exe" --remote-debugging-port=9222
//   node z_development/limited-repeat/tests/lr-gapless-test.cjs <aFromEnd> <bFromEnd> <watchSeconds>
// e.g. `15 0 48` (A 15s before the end, B left at the end: the case that broke)
// or `70 58 30` (B mid-song). Run it on a later track of the stream, not the
// first: let a song roll over first, so the stream offset is non-zero.
//
// Arms LR with real clicks, drags B to (scale - bFromEnd; 0 = leave it at the
// end) and A to (scale - aFromEnd), seeks to 3s before A through the player
// API, then samples every 250ms. Passing looks like: active=true at the end,
// loops >= 2, a/b and handle positions unchanged, same title throughout.
// Song time comes from the player API and the scale from the bar's own `max`,
// never from the video element, whose clock spans the whole stream.
const path = require('path');
const WebSocket = require(path.join(__dirname, '../../../node_modules/ws'));
let id = 0;
const rpc = (ws, method, params = {}) => new Promise((res, rej) => {
  const my = ++id;
  const on = (m) => { const d = JSON.parse(m); if (d.id !== my) return; ws.off('message', on); d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result); };
  ws.on('message', on); ws.send(JSON.stringify({ id: my, method, params }));
});
const ev = async (ws, expr) => {
  const r = await rpc(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500));
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mouse = (ws, type, x, y, buttons = 0) => rpc(ws, 'Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1 });
const click = async (ws, x, y) => { await mouse(ws, 'mouseMoved', x, y); await mouse(ws, 'mousePressed', x, y, 1); await mouse(ws, 'mouseReleased', x, y, 0); };

(async () => {
  const [aFromEnd, bFromEnd, watch] = process.argv.slice(2).map(Number);
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const page = list.find((p) => p.type === 'page' && p.url.includes('music.youtube.com'));
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r) => ws.on('open', r));
  await rpc(ws, 'Runtime.enable');
  ws.on('message', (m) => {
    const d = JSON.parse(m);
    if (d.method === 'Runtime.consoleAPICalled') {
      const txt = d.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
      if (/LRPROBE/.test(txt)) console.log(`  [event] ${txt.slice(8, 200)}`);
    }
  });

  await ev(ws, `(() => {
    if (window.__lrProbe) return;
    window.__lrProbe = true;
    const t0 = performance.now();
    const api = () => document.querySelector('#movie_player');
    const log = (m) => console.log('LRPROBE ' + ((performance.now() - t0) / 1000).toFixed(2) + ' ' + m + ' song=' + api().getCurrentTime().toFixed(2));
    document.addEventListener('videodatachange', (e) => log('videodatachange ' + e.detail?.name));
    for (const t of ['ended', 'seeked', 'emptied']) {
      document.addEventListener(t, (e) => { if (e.target.tagName === 'VIDEO') log(t); }, true);
    }
  })()`);

  const state = () => ev(ws, `(() => {
    const api = document.querySelector('#movie_player');
    const vid = document.querySelector('#movie_player video');
    const lr = window.__limitedRepeat || {};
    const hA = document.querySelector('#limited-repeat-overlay .lr-handle[data-side=a]');
    const hB = document.querySelector('#limited-repeat-overlay .lr-handle[data-side=b]');
    const ov = document.getElementById('limited-repeat-overlay');
    return { song: api.getCurrentTime(), dur: +document.querySelector('input.ytMusicMiniPlayerProgressBar').max, len: api.getProgressState().seekableEnd, media: vid.currentTime, paused: vid.paused, active: lr.active, a: lr.a, b: lr.b,
      hA: hA && parseFloat(hA.style.left), hB: hB && parseFloat(hB.style.left), ovW: ov && parseFloat(ov.style.width),
      title: api.getVideoData().title.slice(0, 28) };
  })()`);

  let s = await state();
  console.log('initial', s);
  const btnRect = async () => JSON.parse(await ev(ws, `JSON.stringify(document.getElementById('limited-repeat-button').getBoundingClientRect())`));
  if (s.active) { const r = await btnRect(); await click(ws, r.x + r.width / 2, r.y + r.height / 2); await sleep(300); }
  const br = await btnRect();
  await click(ws, br.x + br.width / 2, br.y + br.height / 2);
  await sleep(500);
  s = await state();
  console.log('armed', { active: s.active, a: s.a, b: s.b, dur: s.dur });

  const geo = JSON.parse(await ev(ws, `(() => { const o = document.getElementById('limited-repeat-overlay').getBoundingClientRect(); return JSON.stringify({ l: o.left, t: o.top, w: o.width, h: o.height }); })()`));
  const yMid = geo.t + geo.h / 2;
  const xFor = (t) => geo.l + (t / s.dur) * geo.w;
  const drag = async (fromX, toX) => {
    await mouse(ws, 'mouseMoved', fromX, yMid);
    await mouse(ws, 'mousePressed', fromX, yMid, 1);
    for (let i = 1; i <= 10; i++) { await mouse(ws, 'mouseMoved', fromX + ((toX - fromX) * i) / 10, yMid, 1); await sleep(15); }
    await mouse(ws, 'mouseReleased', toX, yMid, 0);
    await sleep(300);
  };
  if (bFromEnd > 0) await drag(xFor(s.dur) - 1, xFor(s.dur - bFromEnd));
  await drag(xFor(0) + 1, xFor(s.dur - aFromEnd));
  s = await state();
  console.log('range set', { a: +s.a.toFixed(2), b: +(s.b ?? s.dur).toFixed(2), dur: s.dur, song: +s.song.toFixed(2), hA: s.hA, hB: s.hB });
  const setA = s.a, setB = s.b;

  // Start 3s before A, through the API (song time)
  await ev(ws, `document.querySelector('#movie_player').seekTo(${Math.max(0, setA - 3)}, true)`);

  const t0 = Date.now();
  let prev = '', loops = 0, lastSong = s.song, firstHA = null, maxSong = 0;
  while (Date.now() - t0 < watch * 1000) {
    s = await state();
    if (s.song < lastSong - 1 && s.active) loops++;
    lastSong = s.song;
    if (s.active) maxSong = Math.max(maxSong, s.song);
    if (firstHA === null && s.hA) firstHA = s.hA;
    const line = `song=${s.song.toFixed(2)}/${s.dur.toFixed(1)} media=${s.media.toFixed(1)} active=${s.active} a=${s.a?.toFixed(2)} b=${s.b?.toFixed?.(2)} hA=${s.hA?.toFixed(1)} hB=${s.hB?.toFixed(1)} "${s.title}"`;
    const key = `${s.active} ${s.a?.toFixed(1)} ${s.b?.toFixed?.(1)} ${s.hA?.toFixed(0)} ${s.hB?.toFixed(0)} ${s.title}`;
    if (key !== prev || Math.round((Date.now() - t0) / 250) % 12 === 0) console.log(((Date.now() - t0) / 1000).toFixed(2).padStart(6), line);
    prev = key;
    await sleep(250);
  }
  console.log(`\nRESULT active=${s.active} loops=${loops} a ${setA?.toFixed(2)}->${s.a?.toFixed(2)} b ${setB?.toFixed?.(2)}->${s.b?.toFixed?.(2)} handleA ${firstHA?.toFixed(1)}->${s.hA?.toFixed(1)} maxSongWhileActive=${maxSong.toFixed(2)} title="${s.title}"`);
  ws.close();
})().catch((e) => { console.error(e); process.exit(1); });
