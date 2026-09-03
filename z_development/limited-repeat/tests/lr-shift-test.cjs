#!/usr/bin/env node
// Checks the Shift grab-assist: holding Shift must enlarge the marker hit area
// (so a click well away from the bracket still grabs it) without moving the
// brackets, and must revert cleanly on release.

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

const snapshot = (ws) =>
  evaluate(
    ws,
    `(() => {
      const o = document.getElementById('limited-repeat-overlay');
      const out = { grab: o.hasAttribute('data-grab'), handles: {} };
      for (const h of o.querySelectorAll('.lr-handle')) {
        const r = h.getBoundingClientRect();
        const cs = getComputedStyle(h, '::before');
        out.handles[h.dataset.side] = {
          w: Math.round(r.width), h: Math.round(r.height),
          centre: Math.round(r.left + r.width / 2),
        };
      }
      return out;
    })()`,
  );

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

  // Arm LR.
  const armed = await evaluate(
    ws,
    `document.getElementById('limited-repeat-button').hasAttribute('data-lr')`,
  );
  if (!armed) {
    await evaluate(ws, `document.getElementById('limited-repeat-button').click()`);
    await sleep(500);
  }

  const before = await snapshot(ws);
  console.log('normal:', JSON.stringify(before.handles));
  check('normal hit area is the small one', before.handles.a.w < 40, `${before.handles.a.w}px wide`);
  check('grab mode off by default', before.grab === false);

  // Press and hold Shift.
  await rpc(ws, 'Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 8,
  });
  await sleep(350);

  const held = await snapshot(ws);
  console.log('shift held:', JSON.stringify(held.handles));
  check('Shift enables grab mode', held.grab === true);
  check(
    'hit area grows while Shift is held',
    held.handles.a.w > before.handles.a.w * 2,
    `${before.handles.a.w}px -> ${held.handles.a.w}px`,
  );
  check(
    'brackets do NOT move when Shift is held',
    Math.abs(held.handles.a.centre - before.handles.a.centre) <= 1 &&
      Math.abs(held.handles.b.centre - before.handles.b.centre) <= 1,
    `A ${before.handles.a.centre}->${held.handles.a.centre}, B ${before.handles.b.centre}->${held.handles.b.centre}`,
  );

  // A point 35px away from the marker should now hit the handle.
  const farHit = await evaluate(
    ws,
    `(() => {
      const o = document.getElementById('limited-repeat-overlay');
      const h = o.querySelector('.lr-handle[data-side="b"]');
      const r = h.getBoundingClientRect();
      const cy = r.top + r.height / 2;
      const cx = r.left + r.width / 2;
      const probe = document.elementFromPoint(cx - 35, cy);
      return { hit: probe === h, tag: probe ? (probe.className?.toString?.().slice(0, 40) || probe.tagName) : null };
    })()`,
  );
  check('a click 35px off the bracket grabs it while Shift is held', farHit.hit, farHit.tag ?? '');

  // Release Shift.
  await rpc(ws, 'Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 0,
  });
  await sleep(350);

  const after = await snapshot(ws);
  check('releasing Shift restores the normal hit area', after.grab === false && after.handles.a.w === before.handles.a.w, `${after.handles.a.w}px`);
  check(
    'brackets unchanged after release',
    after.handles.a.centre === before.handles.a.centre &&
      after.handles.b.centre === before.handles.b.centre,
  );

  console.log('\n================ SUMMARY ================');
  const failed = results.filter((r) => !r.pass);
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  for (const f of failed) console.log(`  FAILED: ${f.name}`);
  ws.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('HARNESS ERROR:', e.message);
  process.exit(2);
});
