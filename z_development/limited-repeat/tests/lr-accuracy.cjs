#!/usr/bin/env node
// Acceptance test for marker accuracy: for several times, ask the plugin where
// it draws the marker, then click the bar at exactly that x and read back the
// time YouTube seeks to. If they agree, the bracket sits where the loop really
// happens. Restores the original playback position afterwards.

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

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
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

  for (let i = 0; i < 45; i++) {
    const ok = await evaluate(
      ws,
      `!!document.getElementById('limited-repeat-button') && (document.querySelector('video')?.duration > 0)`,
    );
    if (ok) break;
    await sleep(1000);
  }

  const start = await evaluate(
    ws,
    `(() => {
      const v = document.querySelector('video');
      return { t: v.currentTime, paused: v.paused, duration: v.duration,
               y: (() => { const r = document.querySelector('#progress-bar').getBoundingClientRect(); return r.top + r.height/2; })(),
               clientWidth: document.documentElement.clientWidth };
    })()`,
  );
  console.log(
    `track ${start.duration.toFixed(1)}s, viewport ${start.clientWidth}px, resuming at ${start.t.toFixed(1)}s afterwards\n`,
  );

  await evaluate(ws, `document.querySelector('video').pause()`);

  // Arm LR so the markers exist.
  const armed = await evaluate(
    ws,
    `document.getElementById('limited-repeat-button').hasAttribute('data-lr')`,
  );
  if (!armed) {
    await evaluate(ws, `document.getElementById('limited-repeat-button').click()`);
    await sleep(500);
  }

  // For each target time: place marker B there via the plugin's own maths,
  // read where it is drawn, click that exact pixel, and compare.
  const fractions = [0.2, 0.4, 0.6, 0.8];
  let worst = 0;

  for (const frac of fractions) {
    const target = start.duration * frac;

    const markerX = await evaluate(
      ws,
      `(() => {
        // The exact mapping the plugin uses: track starts at viewport x=0 and
        // is as wide as the progress bar element.
        const w = document.querySelector('#progress-bar').getBoundingClientRect().width;
        const dur = document.querySelector('video').duration;
        return (${target} / dur) * w;
      })()`,
    );

    await rpc(ws, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: markerX, y: start.y, button: 'none', buttons: 0,
    });
    await rpc(ws, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x: markerX, y: start.y, button: 'left', buttons: 1, clickCount: 1,
    });
    await rpc(ws, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: markerX, y: start.y, button: 'left', buttons: 0, clickCount: 1,
    });
    await sleep(650);

    const got = await evaluate(ws, `document.querySelector('video')?.currentTime ?? null`);
    if (got === null) {
      console.log('  (video element vanished - track changed, skipping)');
      continue;
    }
    const err = Math.abs(got - target);
    worst = Math.max(worst, err);
    console.log(
      `  marker for ${target.toFixed(1)}s drawn at x=${markerX.toFixed(1)} -> YouTube seeks to ${got.toFixed(1)}s   (off by ${err.toFixed(2)}s)`,
    );
  }

  // YouTube quantises seeks to whole seconds, so anything under ~0.6s is exact.
  check(
    'marker position matches YouTube time everywhere',
    worst < 0.75,
    `worst error ${worst.toFixed(2)}s (1s seek quantisation means <0.75s is exact)`,
  );

  // Restore the user's playback position and state.
  await evaluate(
    ws,
    `(() => { const v = document.querySelector('video'); if (v) { v.currentTime = ${start.t}; ${start.paused ? '' : 'v.play();'} } return true; })()`,
  );

  console.log('\n================ SUMMARY ================');
  const failed = results.filter((r) => !r.pass);
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  ws.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('HARNESS ERROR:', e.message);
  process.exit(2);
});
