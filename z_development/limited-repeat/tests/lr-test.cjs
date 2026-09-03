#!/usr/bin/env node
// Drives the running YouTube Music app over CDP and checks that the
// Limited Repeat plugin actually works. Assumes the app was launched with
// --remote-debugging-port=9222.

const http = require('http');
const { WebSocket } = require('ws');

const CDP_PORT = 9222;
let msgId = 1;

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
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 20000);
    const onMessage = (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
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
  const result = await rpc(ws, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      'JS error: ' +
        (result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text),
    );
  }
  return result.result.value;
}

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

async function findMainPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const targets = await getJSON('/json/list');
      const page = targets.find(
        (t) => t.type === 'page' && /music\.youtube\.com/.test(t.url ?? ''),
      );
      if (page) return page;
    } catch {
      /* app not up yet */
    }
    await sleep(1000);
  }
  return null;
}

async function main() {
  const page = await findMainPage();
  if (!page) {
    console.log('FAIL  could not find the YouTube Music page over CDP');
    process.exit(1);
  }
  console.log('Attached to:', page.url);

  const ws = new WebSocket(page.webSocketDebuggerUrl, {
    perMessageDeflate: false,
    maxPayload: 256 * 1024 * 1024,
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  await rpc(ws, 'Runtime.enable');

  // Wait for the player bar to exist.
  for (let i = 0; i < 60; i++) {
    const ready = await evaluate(
      ws,
      `!!document.querySelector('ytmusic-player-bar') && !!document.querySelector('video')`,
    );
    if (ready) break;
    await sleep(1000);
  }

  // The plugin injects its button from onPlayerApiReady, which can lag the
  // player bar appearing - wait for it rather than racing it.
  for (let i = 0; i < 45; i++) {
    const there = await evaluate(
      ws,
      `!!document.getElementById('limited-repeat-button')`,
    );
    if (there) break;
    await sleep(1000);
  }

  // --- 1. Plugin enabled and button injected ---
  const button = await evaluate(
    ws,
    `(() => {
      const b = document.getElementById('limited-repeat-button');
      if (!b) return null;
      const repeat = document.querySelector('#right-controls .repeat');
      return {
        exists: true,
        nextToRepeat: repeat ? repeat.nextElementSibling === b : false,
        visible: b.getBoundingClientRect().width > 0,
        title: b.title,
      };
    })()`,
  );
  check('LR button exists in the player bar', !!button, button ? '' : 'not found — is the plugin enabled?');
  if (!button) {
    console.log('\nCannot continue without the button.');
    process.exit(1);
  }
  check('LR button sits next to the repeat button', button.nextToRepeat);
  check('LR button is visible', button.visible, `${button.title}`);

  // --- 2. Need a track loaded with a real duration ---
  let duration = await evaluate(ws, `document.querySelector('video')?.duration ?? 0`);
  if (!(duration > 0)) {
    console.log('No track loaded — starting one from the first shelf...');
    await evaluate(
      ws,
      `(() => {
        const item = document.querySelector('ytmusic-responsive-list-item-renderer, ytmusic-two-row-item-renderer');
        item?.querySelector('#play-button, a')?.click();
        return true;
      })()`,
    );
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      duration = await evaluate(ws, `document.querySelector('video')?.duration ?? 0`);
      if (duration > 0) break;
    }
  }
  check('a track is loaded with a duration', duration > 0, `duration=${Math.round(duration)}s`);
  if (!(duration > 0)) {
    console.log('\nCannot test the loop without a playing track.');
    process.exit(1);
  }

  // --- 3. Clicking the button arms LR and shows the markers ---
  await evaluate(ws, `document.getElementById('limited-repeat-button').click()`);
  await sleep(400);

  const armed = await evaluate(
    ws,
    `(() => {
      const b = document.getElementById('limited-repeat-button');
      const o = document.getElementById('limited-repeat-overlay');
      if (!o) return null;
      const cs = getComputedStyle(o);
      const hs = [...o.querySelectorAll('.lr-handle')].map((h) => {
        const r = h.getBoundingClientRect();
        return { side: h.dataset.side, left: Math.round(r.left + r.width / 2), w: Math.round(r.width), h: Math.round(r.height) };
      });
      const pb = document.querySelector('#progress-bar')?.getBoundingClientRect();
      return {
        armedAttr: b.hasAttribute('data-lr'),
        display: cs.display,
        overlayPointerEvents: cs.pointerEvents,
        handles: hs,
        progressBar: pb ? { left: Math.round(pb.left), right: Math.round(pb.right), top: Math.round(pb.top) } : null,
      };
    })()`,
  );
  check('overlay element exists', !!armed);
  check('button shows the armed state', armed?.armedAttr === true);
  check('markers are displayed', armed?.display === 'block', `display=${armed?.display}`);
  check('overlay does not block the bar', armed?.overlayPointerEvents === 'none');
  check('two handles rendered', armed?.handles?.length === 2, JSON.stringify(armed?.handles));

  // Both markers must be inside the window - YouTube's bar can start at a
  // negative x, which previously pushed the '[' marker off-screen.
  const onScreen = await evaluate(
    ws,
    `(() => {
      const o = document.getElementById('limited-repeat-overlay');
      const out = {};
      for (const h of o.querySelectorAll('.lr-handle')) {
        const r = h.getBoundingClientRect();
        out[h.dataset.side] = { left: Math.round(r.left), right: Math.round(r.right), visible: r.left >= 0 && r.right <= window.innerWidth };
      }
      out.winWidth = window.innerWidth;
      return out;
    })()`,
  );
  check('marker [ is on screen', onScreen.a?.visible, JSON.stringify(onScreen.a));
  check('marker ] is on screen', onScreen.b?.visible, JSON.stringify(onScreen.b));

  const masked = await evaluate(
    ws,
    `(() => {
      const el = document.querySelector('#progress-bar');
      const cs = getComputedStyle(el);
      return { mask: cs.webkitMaskImage || cs.maskImage, inline: el.style.getPropertyValue('-webkit-mask-image') };
    })()`,
  );
  check(
    'progress line is masked to the loop range',
    !!masked.inline && masked.inline.includes('linear-gradient'),
    masked.inline ? masked.inline.slice(0, 80) : 'no mask set',
  );

  const pb = armed.progressBar;
  const hA = armed.handles.find((h) => h.side === 'a');
  const hB = armed.handles.find((h) => h.side === 'b');
  check(
    'markers start at each end of the track',
    hA && hB && Math.abs(hA.left - pb.left) < 30 && Math.abs(hB.left - pb.right) < 30,
    `A@${hA?.left} B@${hB?.left} bar=[${pb.left},${pb.right}]`,
  );

  // --- 4. Dragging a handle must move the marker, NOT the playhead ---
  const beforeSeek = await evaluate(ws, `document.querySelector('video').currentTime`);
  const barLeft = pb.left;
  const barWidth = pb.right - pb.left;
  const targetAx = barLeft + barWidth * 0.3; // drag A to 30%
  const targetBx = barLeft + barWidth * 0.4; // drag B to 40%
  const handleY = await evaluate(
    ws,
    `(() => { const h = document.querySelector('#limited-repeat-overlay .lr-handle[data-side="a"]'); const r = h.getBoundingClientRect(); return Math.round(r.top + r.height / 2); })()`,
  );

  async function drag(side, fromX, toX) {
    const sel = `#limited-repeat-overlay .lr-handle[data-side="${side}"]`;
    await evaluate(
      ws,
      `(() => {
        const h = document.querySelector('${sel}');
        const r = h.getBoundingClientRect();
        const y = r.top + r.height / 2;
        const opts = (x) => ({ clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 });
        h.dispatchEvent(new PointerEvent('pointerdown', opts(${fromX})));
        h.dispatchEvent(new PointerEvent('pointermove', opts(${toX})));
        h.dispatchEvent(new PointerEvent('pointerup', { ...opts(${toX}), buttons: 0 }));
        return true;
      })()`,
    );
    await sleep(200);
  }

  await drag('a', hA.left, targetAx);
  await drag('b', hB.left, targetBx);
  await sleep(300);

  const afterDrag = await evaluate(
    ws,
    `(() => {
      const o = document.getElementById('limited-repeat-overlay');
      const hs = {};
      for (const h of o.querySelectorAll('.lr-handle')) {
        const r = h.getBoundingClientRect();
        hs[h.dataset.side] = Math.round(r.left + r.width / 2);
      }
      const region = o.querySelector('.lr-region').getBoundingClientRect();
      return { hs, region: { left: Math.round(region.left), width: Math.round(region.width) }, currentTime: document.querySelector('video').currentTime };
    })()`,
  );

  check(
    'dragging moved marker A',
    Math.abs(afterDrag.hs.a - targetAx) < 25,
    `A now @${afterDrag.hs.a}, wanted ~${Math.round(targetAx)}`,
  );
  check(
    'dragging moved marker B',
    Math.abs(afterDrag.hs.b - targetBx) < 25,
    `B now @${afterDrag.hs.b}, wanted ~${Math.round(targetBx)}`,
  );
  const lrState = await evaluate(ws, `window.__limitedRepeat`);
  check(
    'plugin reports the dragged range',
    lrState && lrState.active && lrState.b !== null,
    `A=${lrState?.a?.toFixed(1)}s B=${lrState?.b?.toFixed(1)}s`,
  );
  check(
    'playback ends up inside the loop, not seeked to the click point',
    afterDrag.currentTime >= lrState.a - 1 && afterDrag.currentTime <= lrState.b + 1,
    `currentTime ${beforeSeek.toFixed(1)} -> ${afterDrag.currentTime.toFixed(1)}, range ${lrState.a.toFixed(1)}-${lrState.b.toFixed(1)}`,
  );
  check('highlighted region drawn between markers', afterDrag.region.width > 5);

  // --- 5. The loop actually loops ---
  const loopInfo = await evaluate(
    ws,
    `(() => {
      const s = window.__limitedRepeat;
      return { A: s.a, B: s.b, dur: document.querySelector('video').duration };
    })()`,
  );
  const A = loopInfo.A;
  const B = loopInfo.B;
  console.log(`Loop range: ${A.toFixed(1)}s - ${B.toFixed(1)}s (track ${loopInfo.dur.toFixed(0)}s)`);

  // Seek to just before B and press play; it should wrap back to A.
  await evaluate(
    ws,
    `(() => {
      const v = document.querySelector('video');
      v.currentTime = ${(B - 1.2).toFixed(3)};
      v.play();
      return true;
    })()`,
  );

  let wrapped = false;
  let minSeen = Infinity;
  let maxSeen = 0;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const ct = await evaluate(ws, `document.querySelector('video').currentTime`);
    maxSeen = Math.max(maxSeen, ct);
    if (ct < B - 0.5) minSeen = Math.min(minSeen, ct);
    if (maxSeen > A + 0.5 && ct < A + 1.5 && ct < maxSeen) {
      wrapped = true;
      break;
    }
  }
  check(
    'playback loops from B back to A',
    wrapped,
    `max reached ${maxSeen.toFixed(1)}s, wrapped back to ~${minSeen === Infinity ? '?' : minSeen.toFixed(1)}s`,
  );

  const overshoot = maxSeen - B;
  check(
    'loop point is tight (overshoot < 0.4s)',
    overshoot < 0.4,
    `overshoot ${overshoot.toFixed(2)}s`,
  );

  // --- 6. Clicking another control spends LR; play/pause does not ---
  await evaluate(ws, `document.querySelector('#play-pause-button')?.click()`);
  await sleep(400);
  const afterPlayPause = await evaluate(
    ws,
    `document.getElementById('limited-repeat-button').hasAttribute('data-lr')`,
  );
  check('play/pause leaves LR armed', afterPlayPause === true);

  await evaluate(
    ws,
    `(() => { const r = document.querySelector('#right-controls .repeat'); r.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 })); return true; })()`,
  );
  await sleep(400);
  const afterRepeat = await evaluate(
    ws,
    `(() => ({
      armed: document.getElementById('limited-repeat-button').hasAttribute('data-lr'),
      overlay: getComputedStyle(document.getElementById('limited-repeat-overlay')).display,
    }))()`,
  );
  check('clicking repeat spends LR', afterRepeat.armed === false);
  check('markers disappear when LR is spent', afterRepeat.overlay === 'none');

  const unmasked = await evaluate(
    ws,
    `document.querySelector('#progress-bar').style.getPropertyValue('-webkit-mask-image')`,
  );
  check('progress bar mask removed when LR is spent', !unmasked, `mask="${unmasked}"`);

  // Restore playback state.
  await evaluate(ws, `document.querySelector('video').play()`);

  console.log('\n================ SUMMARY ================');
  const failed = results.filter((r) => !r.pass);
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('FAILED:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ' — ' + f.detail : ''}`);
  }
  ws.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('HARNESS ERROR:', e.message);
  process.exit(2);
});
