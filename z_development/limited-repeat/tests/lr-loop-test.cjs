#!/usr/bin/env node
// Real-input test: drags the [ and ] markers with actual mouse events (which
// go through hit-testing, unlike synthetic dispatch), sets a ~10 second window
// mid-song, and watches whether playback loops inside it.

const http = require('http');
const { WebSocket } = require('ws');

const CDP_PORT = 9222;
const LOOP_SECONDS = 10;
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
    console.log('could not attach over CDP');
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

  const info = await evaluate(
    ws,
    `(() => {
      const v = document.querySelector('video');
      const pb = document.querySelector('#progress-bar').getBoundingClientRect();
      return {
        duration: v.duration,
        title: document.querySelector('.ytmusic-player-bar .title')?.textContent?.trim() ?? '?',
        bar: { left: pb.left, width: pb.width, top: pb.top, height: pb.height },
      };
    })()`,
  );
  console.log(`Track: ${info.title}  (${info.duration.toFixed(0)}s)`);

  if (info.duration < LOOP_SECONDS * 3) {
    console.log('Track too short for a meaningful test.');
    process.exit(1);
  }

  // Make sure LR is armed and starts from a clean state.
  const isArmed = await evaluate(
    ws,
    `document.getElementById('limited-repeat-button').hasAttribute('data-lr')`,
  );
  if (isArmed) {
    await evaluate(ws, `document.getElementById('limited-repeat-button').click()`);
    await sleep(300);
  }
  await evaluate(ws, `document.getElementById('limited-repeat-button').click()`);
  await sleep(500);

  // Target a 10 second window starting at the halfway mark.
  const targetA = info.duration / 2;
  const targetB = targetA + LOOP_SECONDS;
  // Same mapping the plugin uses: track starts at viewport x=0.
  const xOf = (t) => (t / info.duration) * info.bar.width;

  async function handleCenter(side) {
    return evaluate(
      ws,
      `(() => {
        const h = document.querySelector('#limited-repeat-overlay .lr-handle[data-side="${side}"]');
        const r = h.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`,
    );
  }

  // A genuine mouse drag: press, several moves, release. These go through the
  // browser's real hit-testing, which synthetic dispatchEvent does not.
  async function realDrag(side, toX) {
    const c = await handleCenter(side);
    const y = c.y;
    await rpc(ws, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: c.x, y, button: 'none', buttons: 0,
    });
    await rpc(ws, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x: c.x, y, button: 'left', buttons: 1, clickCount: 1,
    });
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      const x = c.x + ((toX - c.x) * i) / steps;
      await rpc(ws, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved', x, y, button: 'left', buttons: 1,
      });
      await sleep(20);
    }
    await rpc(ws, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: toX, y, button: 'left', buttons: 0, clickCount: 1,
    });
    await sleep(250);
  }

  const timeBefore = await evaluate(ws, `document.querySelector('video').currentTime`);

  await realDrag('a', xOf(targetA));
  await realDrag('b', xOf(targetB));
  await sleep(400);

  const state = await evaluate(ws, `window.__limitedRepeat`);
  console.log(
    `Markers set to: A=${state.a?.toFixed(1)}s  B=${state.b?.toFixed(1)}s  (wanted ${targetA.toFixed(1)} / ${targetB.toFixed(1)})`,
  );

  check(
    'real mouse drag moved marker A',
    Math.abs(state.a - targetA) < 5,
    `A=${state.a?.toFixed(1)}s vs wanted ${targetA.toFixed(1)}s`,
  );
  check(
    'real mouse drag moved marker B',
    Math.abs(state.b - targetB) < 5,
    `B=${state.b?.toFixed(1)}s vs wanted ${targetB.toFixed(1)}s`,
  );
  const window_ = state.b - state.a;
  check(
    'loop window is about 10 seconds',
    Math.abs(window_ - LOOP_SECONDS) < 3,
    `${window_.toFixed(1)}s`,
  );

  if (!(state.b > state.a)) {
    console.log('Markers not set; cannot test looping.');
    process.exit(1);
  }

  // Start playing just inside the window and watch it go round twice.
  await evaluate(
    ws,
    `(() => { const v = document.querySelector('video'); v.currentTime = ${(state.a + 1).toFixed(3)}; v.play(); return true; })()`,
  );
  await sleep(500);

  console.log('\nWatching playback for 40s...');
  let wraps = 0;
  let last = await evaluate(ws, `document.querySelector('video').currentTime`);
  let maxSeen = last;
  let escaped = false;
  const samples = [];

  for (let i = 0; i < 160; i++) {
    await sleep(250);
    const ct = await evaluate(ws, `document.querySelector('video').currentTime`);
    if (i % 8 === 0) samples.push(ct.toFixed(1));
    maxSeen = Math.max(maxSeen, ct);
    if (ct < last - 1) {
      wraps++;
      console.log(`  wrap ${wraps}: ${last.toFixed(2)}s -> ${ct.toFixed(2)}s`);
    }
    // Did playback escape the loop entirely?
    if (ct > state.b + 2) escaped = true;
    last = ct;
    if (wraps >= 2) break;
  }

  console.log(`  samples: ${samples.join(', ')}`);
  check('playback looped at least twice', wraps >= 2, `${wraps} wraps`);
  check('playback never escaped past B', !escaped, `max seen ${maxSeen.toFixed(2)}s, B=${state.b.toFixed(2)}s`);
  check(
    'loop point is tight',
    maxSeen - state.b < 0.4,
    `overshoot ${(maxSeen - state.b).toFixed(2)}s`,
  );

  const stillArmed = await evaluate(
    ws,
    `document.getElementById('limited-repeat-button').hasAttribute('data-lr')`,
  );
  check('LR still armed after looping', stillArmed === true);

  console.log('\n================ SUMMARY ================');
  const failed = results.filter((r) => !r.pass);
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  for (const f of failed) console.log(`  FAILED: ${f.name}`);
  console.log(`(playhead was at ${timeBefore.toFixed(1)}s before the test)`);

  ws.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('HARNESS ERROR:', e.message);
  process.exit(2);
});
