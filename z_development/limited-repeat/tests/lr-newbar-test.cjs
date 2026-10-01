#!/usr/bin/env node
// Drives the running app over CDP and checks Limited Repeat on YouTube's new
// player bar (`ytmusic-miniplayer`, seen 2026-10). Real input only
// (Input.dispatchMouseEvent), and marker accuracy is checked against YouTube's
// own seek mapping - never against our formula. See LESSONS.md #2.
//
//   start "" "pack\win-unpacked\YouTube Music.exe" --remote-debugging-port=9222
//   node z_development/limited-repeat/tests/lr-newbar-test.cjs
//
// Plays the current track and moves the playhead; leaves repeat mode as found.

const http = require('http');
const { WebSocket } = require('ws');

const CDP_PORT = 9222;
let msgId = 1;
let failures = 0;

const getJSON = (path) =>
  new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: CDP_PORT, path }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rpc(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = msgId++;
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 30000);
    const onMessage = (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(ws, expression) {
  const r = await rpc(ws, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (r.exceptionDetails) {
    throw new Error(
      'JS error: ' +
        (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text),
    );
  }
  return r.result.value;
}

function check(name, pass, detail = '') {
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

async function main() {
  const targets = await getJSON('/json/list');
  const page = targets.find(
    (t) => t.type === 'page' && /music\.youtube\.com/.test(t.url ?? ''),
  );
  if (!page) throw new Error('no music.youtube.com page - is the app running with --remote-debugging-port=9222?');

  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => {
    ws.once('open', res);
    ws.once('error', rej);
  });

  const mouse = async (type, x, y, buttons = 0) =>
    rpc(ws, 'Input.dispatchMouseEvent', {
      type, x, y, button: type === 'mouseMoved' && !buttons ? 'none' : 'left', buttons, clickCount: 1,
    });
  const click = async (x, y) => {
    await mouse('mouseMoved', x, y);
    await mouse('mousePressed', x, y, 1);
    await mouse('mouseReleased', x, y, 0);
  };
  const drag = async (fromX, toX, y) => {
    await mouse('mouseMoved', fromX, y);
    await mouse('mousePressed', fromX, y, 1);
    for (let i = 1; i <= 10; i++) {
      await mouse('mouseMoved', fromX + ((toX - fromX) * i) / 10, y, 1);
      await sleep(15);
    }
    await mouse('mouseReleased', toX, y, 0);
  };
  const state = () => evaluate(ws, 'window.__limitedRepeat');
  const video = (expr) => evaluate(ws, `(() => { const v = document.querySelector('video'); return ${expr}; })()`);
  const centre = (selector) =>
    evaluate(ws, `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top, left: r.left, width: r.width, height: r.height }; })()`);
  const repeatMode = () => evaluate(ws, `document.querySelector('#queue').queue.store.getState().queue.repeatMode`);

  // --- Setup: playing, LR off, repeat mode remembered ---
  const initialRepeat = await repeatMode();
  if ((await state())?.active) await evaluate(ws, `document.getElementById('limited-repeat-button').click()`);
  await video('v.play().then(() => true)');
  await sleep(500);
  const duration = await video('v.duration');
  const bar = await centre('input.ytMusicMiniPlayerProgressBar');
  check('new seek bar present', !!bar, bar ? `width=${bar.width.toFixed(1)}` : '');
  // Click the bar's top row - YouTube's right-hand section overlaps its lower
  // half on the right side of the window.
  const barY = bar.top + 0.5;

  // --- Ground truth: where does YouTube seek for a given x? ---
  // Paused, or playback moves on while we wait for the seek to settle.
  const sampleX = bar.left + bar.width * 0.3;
  // Start well away from the sample point, so a click that failed to seek
  // shows up as a wrong reading instead of passing by coincidence.
  await video('(v.pause(), v.currentTime = 30, true)');
  await sleep(800);
  await evaluate(ws, `window.__lrSeeked = new Promise((r) => document.querySelector('video').addEventListener('seeked', () => r(true), { once: true })); true`);
  await click(sampleX, barY);
  const seeked = await evaluate(ws, `Promise.race([window.__lrSeeked, new Promise((r) => setTimeout(() => r(false), 4000))])`);
  await sleep(300);
  const groundTruth = await video('v.currentTime');
  check('ground-truth click seeked', seeked && Math.abs(groundTruth - 30) > 60, `t=${groundTruth.toFixed(2)}s`);
  await video('v.play().then(() => true)');
  console.log(`ground truth: x=${sampleX.toFixed(1)} -> YouTube seeks to ${groundTruth.toFixed(2)}s (duration ${duration.toFixed(1)}s)`);

  // --- Arm via a real click on the button ---
  const btn = await centre('#limited-repeat-button');
  check('LR button present', !!btn);
  const hitBtn = await evaluate(ws, `document.elementFromPoint(${btn.x}, ${btn.y})?.closest('#limited-repeat-button') !== null`);
  check('real click at LR button lands on it', hitBtn);
  await click(btn.x, btn.y);
  await sleep(600);
  let s = await state();
  check('LR armed by real click', s?.active === true);
  check('markers start at track ends', s.a === 0 && Math.abs(s.b - duration) < 0.01, `a=${s.a} b=${s.b?.toFixed(2)}`);

  // --- Markers sit on the bar and are grabbable ---
  const ha = await centre('#limited-repeat-overlay .lr-handle[data-side="a"]');
  const hb = await centre('#limited-repeat-overlay .lr-handle[data-side="b"]');
  check('markers vertically centred on the seek bar', Math.abs(ha.y - (bar.top + bar.height / 2)) < 1.5, `marker y=${ha.y.toFixed(1)} bar y=${(bar.top + bar.height / 2).toFixed(1)}`);
  const hitA = await evaluate(ws, `document.elementFromPoint(${ha.x}, ${ha.y})?.dataset?.side`);
  check('real click at A marker lands on it', hitA === 'a', `hit=${hitA}`);

  // --- Drag A to the ground-truth x: LR must agree with YouTube ---
  await drag(ha.x, sampleX, ha.y);
  await sleep(300);
  s = await state();
  // LR maps the raw pointer x; ±0.5s is YouTube's seek rounding.
  const errA = s.a - groundTruth;
  const secPerPx = duration / (bar.width - 12);
  check('A marker matches YouTube seek mapping', Math.abs(errA) <= 0.5 + secPerPx, `A=${s.a.toFixed(2)}s truth=${groundTruth.toFixed(2)}s err=${errA.toFixed(2)}s (1px=${secPerPx.toFixed(2)}s)`);

  // --- Drag B close to A for a short loop ---
  const hb2 = await centre('#limited-repeat-overlay .lr-handle[data-side="b"]');
  const loopPx = Math.max(3, 6 / secPerPx); // ~6 seconds, at least 3px
  await drag(hb2.x, sampleX + loopPx, hb2.y);
  await sleep(300);
  s = await state();
  check('B marker set after A', s.b > s.a, `A=${s.a.toFixed(2)} B=${s.b.toFixed(2)} (loop ${(s.b - s.a).toFixed(2)}s)`);

  // --- Mask applied, and the masked bar still takes clicks ---
  const mask = await evaluate(ws, `getComputedStyle(document.querySelector('input.ytMusicMiniPlayerProgressBar')).webkitMaskImage`);
  check('seek bar masked outside the loop', /linear-gradient/.test(mask));
  // YouTube rewrites the bar's whole `style` attribute as it plays; the mask
  // must survive every rewrite (it used to flicker off until the next layout).
  const flicker = await evaluate(ws, `new Promise((resolve) => {
    const i = document.querySelector('input.ytMusicMiniPlayerProgressBar');
    let rewrites = 0, lost = 0;
    const ob = new MutationObserver(() => { rewrites++; if (getComputedStyle(i).webkitMaskImage === 'none') lost++; });
    ob.observe(i, { attributes: true, attributeFilter: ['style'] });
    setTimeout(() => { ob.disconnect(); resolve({ rewrites, lost }); }, 3000);
  })`);
  check('mask survives YouTube rewriting the bar style', flicker.rewrites > 0 && flicker.lost === 0, `${flicker.rewrites} rewrites, mask lost ${flicker.lost}x`);
  const maskedHit = await evaluate(ws, `document.elementFromPoint(${bar.left + bar.width * 0.8}, ${barY})?.className ?? ''`);
  check('masked part of the bar still hit-tests to the bar', /ytMusicMiniPlayerProgressBar/.test(maskedHit), maskedHit);

  // --- A click on the bar's centre line on the right half lands on YouTube's
  //     right-hand section (it overlaps the bar). That is still the user
  //     aiming at the bar, and must not spend LR. ---
  const overlapX = bar.left + bar.width * 0.8;
  const overlapY = bar.top + bar.height / 2 + 0.5;
  const overlapTarget = await evaluate(ws, `document.elementFromPoint(${overlapX}, ${overlapY})?.className ?? ''`);
  await click(overlapX, overlapY);
  await sleep(400);
  check('click on the overlapped part of the bar keeps LR armed', (await state()).active === true, `landed on ${overlapTarget.split(' ')[0]}`);

  // --- The loop: playback wraps from B to A ---
  await video(`(v.currentTime = ${s.a}, v.play().then(() => true))`);
  let maxT = 0;
  let wrapped = false;
  let prev = 0;
  const deadline = Date.now() + (s.b - s.a + 6) * 1000;
  while (Date.now() < deadline) {
    const t = await video('v.currentTime');
    if (t > maxT) maxT = t;
    if (prev > s.a + (s.b - s.a) / 2 && t < prev - 1) {
      wrapped = true;
      break;
    }
    prev = t;
    await sleep(20);
  }
  check('playback wraps from B back to A', wrapped);
  const overshoot = maxT - s.b;
  // The fine timer only helps if timers run on time. Chromium throttles them
  // to ~250ms when the window is hidden in the tray, so report the cadence.
  const timerGap = await evaluate(ws, `new Promise((r) => { const g = []; let l = performance.now(); const id = setInterval(() => { const n = performance.now(); g.push(n - l); l = n; if (g.length >= 12) { clearInterval(id); g.sort((a, b) => a - b); r(g[6]); } }, 25); })`);
  check('loop overshoot past B under 100ms', overshoot < 0.1, `overshoot=${(overshoot * 1000).toFixed(0)}ms, 25ms timer actually fires every ${timerGap.toFixed(0)}ms`);
  check('LR still armed after looping', (await state()).active === true);

  // --- Play/pause keeps LR armed ---
  const pp = await centre('.ytmusicPlayerControlsPlayPauseButton button');
  await click(pp.x, pp.y);
  await sleep(500);
  check('play/pause leaves LR armed', (await state()).active === true);
  await click(pp.x, pp.y);
  await sleep(500);

  // --- Repeat button (real click) spends LR ---
  const rep = await centre('.ytmusicPlayerControlsRepeatButton button');
  await click(rep.x, rep.y);
  await sleep(500);
  check('real click on repeat spends LR', (await state()).active === false);

  // --- Programmatic repeat change (the IPC path uses element.click(), which
  //     fires no pointerdown) also spends LR, via the app store ---
  await evaluate(ws, `document.getElementById('limited-repeat-button').click()`);
  await sleep(300);
  check('re-armed', (await state()).active === true);
  await evaluate(ws, `document.querySelector('.ytmusicPlayerControlsRepeatButton button').click()`);
  await sleep(500);
  check('programmatic repeat change spends LR', (await state()).active === false);
  const unmasked = await evaluate(ws, `getComputedStyle(document.querySelector('input.ytMusicMiniPlayerProgressBar')).webkitMaskImage`);
  check('mask removed when LR is spent', unmasked === 'none', unmasked);

  // --- Restore repeat mode ---
  for (let i = 0; i < 3 && (await repeatMode()) !== initialRepeat; i++) {
    await evaluate(ws, `document.querySelector('.ytmusicPlayerControlsRepeatButton button').click()`);
    await sleep(300);
  }
  check('repeat mode restored', (await repeatMode()) === initialRepeat, initialRepeat);

  ws.close();
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(2);
});
