#!/usr/bin/env node
// Calibrates the real pixel -> time mapping of YouTube's progress bar by
// clicking it at known x positions and reading back currentTime. Reports the
// usable track's left edge and width, and compares them to the element's box.

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
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 30000);
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

async function main() {
  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    try {
      const targets = await getJSON('/json/list');
      page = targets.find(
        (t) => t.type === 'page' && /music\.youtube\.com/.test(t.url ?? ''),
      );
    } catch {
      /* not up */
    }
    if (!page) await sleep(1000);
  }
  if (!page) {
    console.log('could not attach');
    process.exit(1);
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl, {
    perMessageDeflate: false,
    maxPayload: 256 * 1024 * 1024,
  });
  await new Promise((res, rej) => {
    ws.once('open', res);
    ws.once('error', rej);
  });
  await rpc(ws, 'Runtime.enable');

  // Make sure LR is OFF so the mask/overlay cannot interfere with clicks.
  const armed = await evaluate(
    ws,
    `document.getElementById('limited-repeat-button')?.hasAttribute('data-lr')`,
  );
  if (armed) {
    await evaluate(ws, `document.getElementById('limited-repeat-button').click()`);
    await sleep(400);
  }

  const geom = await evaluate(
    ws,
    `(() => {
      const pb = document.querySelector('#progress-bar');
      const r = pb.getBoundingClientRect();
      return { left: r.left, right: r.right, width: r.width, y: r.top + r.height / 2,
               duration: document.querySelector('video').duration };
    })()`,
  );
  console.log(
    `element box: left=${geom.left.toFixed(1)} right=${geom.right.toFixed(1)} width=${geom.width.toFixed(1)}  duration=${geom.duration.toFixed(1)}s`,
  );

  await evaluate(ws, `document.querySelector('video').pause()`);

  async function clickAt(x) {
    await rpc(ws, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x, y: geom.y, button: 'none', buttons: 0,
    });
    await rpc(ws, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y: geom.y, button: 'left', buttons: 1, clickCount: 1,
    });
    await rpc(ws, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y: geom.y, button: 'left', buttons: 0, clickCount: 1,
    });
    await sleep(700);
    return evaluate(ws, `document.querySelector('video').currentTime`);
  }

  // Sample several x positions across the visible part of the bar.
  const xs = [];
  const startX = Math.max(geom.left + 40, 40);
  const endX = Math.min(geom.right - 40, 1450);
  for (let i = 0; i <= 4; i++) {
    xs.push(startX + ((endX - startX) * i) / 4);
  }

  const samples = [];
  for (const x of xs) {
    const t = await clickAt(x);
    samples.push({ x, t });
    console.log(`  click x=${x.toFixed(1)}  ->  t=${t.toFixed(2)}s`);
  }

  // Least-squares fit t = m*x + c, then invert to get the track geometry.
  const n = samples.length;
  const sx = samples.reduce((a, s) => a + s.x, 0);
  const st = samples.reduce((a, s) => a + s.t, 0);
  const sxx = samples.reduce((a, s) => a + s.x * s.x, 0);
  const sxt = samples.reduce((a, s) => a + s.x * s.t, 0);
  const m = (n * sxt - sx * st) / (n * sxx - sx * sx);
  const c = (st - m * sx) / n;

  // t = m*x + c  =>  x(t=0) = -c/m ; width = duration/m
  const trackLeft = -c / m;
  const trackWidth = geom.duration / m;

  console.log('\n--- calibration result ---');
  console.log(`true track left  = ${trackLeft.toFixed(2)}px   (element box left  = ${geom.left.toFixed(2)})`);
  console.log(`true track width = ${trackWidth.toFixed(2)}px  (element box width = ${geom.width.toFixed(2)})`);
  console.log(`inset left  = ${(trackLeft - geom.left).toFixed(2)}px`);
  console.log(`inset right = ${(geom.right - (trackLeft + trackWidth)).toFixed(2)}px`);

  const errAtMid =
    Math.abs(
      ((geom.width / 2 + geom.left - trackLeft) / trackWidth) * geom.duration -
        geom.duration / 2,
    );
  console.log(
    `\nusing the element box instead of the true track mis-places the middle of the song by ~${errAtMid.toFixed(2)}s`,
  );

  // Re-calibrate at a different window width to learn whether the inset is a
  // constant number of pixels or scales with the bar.
  console.log('=== second pass at a narrower viewport ===');
  const base = await evaluate(ws, `({ w: window.innerWidth, h: window.innerHeight })`);
  console.log(`(pass 1 innerWidth was ${base.w})`);

  await rpc(ws, 'Emulation.setDeviceMetricsOverride', {
    width: 1100, height: base.h, deviceScaleFactor: 0, mobile: false,
  });
  await sleep(1500);

  const geom2 = await evaluate(
    ws,
    `(() => {
      const pb = document.querySelector('#progress-bar');
      const r = pb.getBoundingClientRect();
      return { left: r.left, right: r.right, width: r.width, y: r.top + r.height / 2,
               duration: document.querySelector('video').duration, inner: window.innerWidth };
    })()`,
  );
  console.log(`element box: left=${geom2.left.toFixed(1)} right=${geom2.right.toFixed(1)} width=${geom2.width.toFixed(1)} innerWidth=${geom2.inner}`);

  const samples2 = [];
  for (let i = 0; i <= 4; i++) {
    const x = 60 + ((geom2.inner - 120) * i) / 4;
    await rpc(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: geom2.y, button: 'none', buttons: 0 });
    await rpc(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y: geom2.y, button: 'left', buttons: 1, clickCount: 1 });
    await rpc(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y: geom2.y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(700);
    const t = await evaluate(ws, `document.querySelector('video').currentTime`);
    samples2.push({ x, t });
    console.log(`  click x=${x.toFixed(1)}  ->  t=${t.toFixed(2)}s`);
  }

  const n2 = samples2.length;
  const sx2 = samples2.reduce((a, s) => a + s.x, 0);
  const st2 = samples2.reduce((a, s) => a + s.t, 0);
  const sxx2 = samples2.reduce((a, s) => a + s.x * s.x, 0);
  const sxt2 = samples2.reduce((a, s) => a + s.x * s.t, 0);
  const m2 = (n2 * sxt2 - sx2 * st2) / (n2 * sxx2 - sx2 * sx2);
  const c2 = (st2 - m2 * sx2) / n2;
  const trackLeft2 = -c2 / m2;
  const trackWidth2 = geom2.duration / m2;

  console.log(`true track left  = ${trackLeft2.toFixed(2)}  (box left  = ${geom2.left.toFixed(2)}, innerWidth ${geom2.inner})`);
  console.log(`true track width = ${trackWidth2.toFixed(2)}  (box width = ${geom2.width.toFixed(2)})`);

  console.log('=== comparison ===');
  console.log(`pass 1: box(${geom.left.toFixed(1)}, ${geom.width.toFixed(1)})  track(${trackLeft.toFixed(2)}, ${trackWidth.toFixed(2)})  boxInset=${(trackLeft-geom.left).toFixed(2)}  trackVsInner=${(trackWidth/base.w).toFixed(4)}`);
  console.log(`pass 2: box(${geom2.left.toFixed(1)}, ${geom2.width.toFixed(1)})  track(${trackLeft2.toFixed(2)}, ${trackWidth2.toFixed(2)})  boxInset=${(trackLeft2-geom2.left).toFixed(2)}  trackVsInner=${(trackWidth2/geom2.inner).toFixed(4)}`);

  await rpc(ws, 'Emulation.clearDeviceMetricsOverride', {});
  await sleep(800);

  ws.close();
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(2);
});
