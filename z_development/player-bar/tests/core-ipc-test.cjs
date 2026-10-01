#!/usr/bin/env node
// Checks the core player controls against YouTube's new player bar
// (`ytmusic-miniplayer`, seen 2026-10): the IPC paths behind the tray, the
// hover mini-player, media keys and the taskbar buttons, and the state feeds
// they listen to. Sends *real* IPC from the main process, and reads the result
// from the page.
//
//   start "" "pack\win-unpacked\YouTube Music.exe" --remote-debugging-port=9222 --inspect=9229
//   node z_development/player-bar/tests/core-ipc-test.cjs
//
// Skips forward one track and back, toggles like twice, cycles repeat and mute,
// and nudges the volume - leaving everything as it found it.

const http = require('http');
const { WebSocket } = require('ws');

let failures = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const getJSON = (port, path) =>
  new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(JSON.parse(body)));
      })
      .on('error', reject);
  });

const connect = async (url) => {
  const ws = new WebSocket(url, { perMessageDeflate: false });
  await new Promise((res, rej) => {
    ws.once('open', res);
    ws.once('error', rej);
  });
  let id = 1;
  const evaluate = (expression) =>
    new Promise((resolve, reject) => {
      const myId = id++;
      const onMessage = (raw) => {
        const msg = JSON.parse(raw);
        if (msg.id !== myId) return;
        ws.off('message', onMessage);
        const r = msg.result;
        if (msg.error || r?.exceptionDetails) {
          reject(new Error(JSON.stringify(msg.error ?? r.exceptionDetails.exception?.description ?? r.exceptionDetails)));
        } else resolve(r.result.value);
      };
      ws.on('message', onMessage);
      ws.send(JSON.stringify({ id: myId, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
    });
  return { ws, evaluate };
};

function check(name, pass, detail = '') {
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

async function main() {
  const pages = await getJSON(9222, '/json/list');
  const page = pages.find((t) => t.type === 'page' && /music\.youtube\.com/.test(t.url ?? ''));
  const [mainTarget] = await getJSON(9229, '/json/list');
  const renderer = await connect(page.webSocketDebuggerUrl);
  const main = await connect(mainTarget.webSocketDebuggerUrl);

  // The main process is an ES module, so reach `electron` through createRequire.
  // The setup listeners are singletons per page load: on a second run in the
  // same session they send no initial values, so those checks are skipped.
  const rerun = await main.evaluate(`!!globalThis.__test`);
  await main.evaluate(`(() => {
    if (globalThis.__test) { globalThis.__test.received = {}; return true; }
    const req = process.getBuiltinModule('module').createRequire(process.execPath);
    const { BrowserWindow, ipcMain } = req('electron');
    globalThis.__test = {
      send: (channel, ...args) => {
        const win = BrowserWindow.getAllWindows().find((w) => /music\\.youtube\\.com/.test(w.webContents.getURL()));
        win.webContents.send(channel, ...args);
      },
      received: {},
    };
    for (const ch of ['peard:time-changed', 'peard:repeat-changed', 'peard:like-changed', 'peard:shuffle-changed', 'peard:fullscreen-changed']) {
      ipcMain.on(ch, (_e, value) => { (globalThis.__test.received[ch] ??= []).push(value); });
    }
    return true;
  })()`);
  const send = (channel, ...args) => main.evaluate(`(globalThis.__test.send(${[channel, ...args].map((a) => JSON.stringify(a)).join(', ')}), true)`);
  const received = (channel) => main.evaluate(`globalThis.__test.received[${JSON.stringify(channel)}] ?? []`);
  const page$ = renderer.evaluate;
  const store = (path) => page$(`document.querySelector('#queue').queue.store.getState().${path}`);
  // Not from the URL: on the home page the track plays with no `?v=`.
  const videoId = () => page$(`document.querySelector('#movie_player').getVideoData().video_id`);

  // --- State feeds: the listeners a plugin asks for ---
  for (const ch of ['time', 'repeat', 'like', 'shuffle', 'fullscreen']) {
    await send(`peard:setup-${ch}-changed-listener`);
  }
  await page$(`document.querySelector('video').play().then(() => true)`);
  await sleep(3500);

  const times = await received('peard:time-changed');
  check('elapsed-time feed ticks while playing', times.length >= 2 && times.every((t) => Number.isInteger(t)), `got ${JSON.stringify(times.slice(-4))}`);
  if (rerun) {
    console.log('SKIP  initial-value feeds (second run in this app session - restart the app to cover them)');
  } else {
    const repeat0 = await received('peard:repeat-changed');
    check('repeat feed sends its initial mode', repeat0.length >= 1, JSON.stringify(repeat0));
    const like0 = await received('peard:like-changed');
    check('like feed sends its initial status', like0.length >= 1, JSON.stringify(like0));
    const shuffle0 = await received('peard:shuffle-changed');
    check('shuffle feed sends its initial state', shuffle0.length >= 1, JSON.stringify(shuffle0));
    const fs0 = await received('peard:fullscreen-changed');
    check('fullscreen feed sends its initial state', fs0.length >= 1, JSON.stringify(fs0));
  }

  // --- Next / previous (tray, hover popup, media keys, taskbar) ---
  const startId = await videoId();
  await send('peard:next-video');
  await sleep(3000);
  const nextId = await videoId();
  check('next-video IPC skips forward', nextId && nextId !== startId, `${startId} -> ${nextId}`);
  await send('peard:previous-video');
  await sleep(3000);
  let backId = await videoId();
  // Previous restarts the current track when it has played a few seconds.
  if (backId === nextId) {
    await send('peard:previous-video');
    await sleep(3000);
    backId = await videoId();
  }
  check('previous-video IPC goes back', backId === startId, `${nextId} -> ${backId}`);

  // --- Repeat (switch-repeat IPC) and its feed ---
  const mode0 = await store('queue.repeatMode');
  await send('peard:switch-repeat', 1);
  await sleep(600);
  const mode1 = await store('queue.repeatMode');
  check('switch-repeat IPC changes repeat mode', mode1 !== mode0, `${mode0} -> ${mode1}`);
  const repeatFeed = await received('peard:repeat-changed');
  check('repeat feed reports the change', repeatFeed.at(-1) === mode1, JSON.stringify(repeatFeed));
  await send('peard:switch-repeat', 2);
  await sleep(600);
  check('switch-repeat x2 cycles back', (await store('queue.repeatMode')) === mode0);

  // --- Like (update-like IPC) and its feed ---
  const pressed = (type) => page$(`document.querySelector('ytmusic-miniplayer ${type}-button-view-model button')?.getAttribute('aria-pressed')`);
  const wasLiked = (await pressed('like')) === 'true';
  const wasDisliked = (await pressed('dislike')) === 'true';
  if (!wasLiked) {
    await send('peard:update-like', 'LIKE');
    await sleep(1200);
    check('update-like LIKE likes the track', (await pressed('like')) === 'true');
    const likeFeed = await received('peard:like-changed');
    check('like feed reports LIKE', likeFeed.at(-1) === 'LIKE', JSON.stringify(likeFeed));
    // Undo with a real click on the toggle.
    await page$(`document.querySelector('ytmusic-miniplayer like-button-view-model button').click()`);
    await sleep(1200);
    check('like restored', (await pressed('like')) === (wasLiked ? 'true' : 'false'));
  } else {
    await send('peard:update-like', 'LIKE');
    await sleep(1200);
    check('update-like LIKE on a liked track leaves it liked', (await pressed('like')) === 'true');
    console.log(`      (track already liked${wasDisliked ? ', and disliked?' : ''} - like toggle-on path not exercised)`);
  }

  // --- Mute (toggle-mute IPC) ---
  const muted0 = await page$(`document.querySelector('#movie_player').isMuted()`);
  await send('peard:toggle-mute');
  await sleep(600);
  const muted1 = await page$(`document.querySelector('#movie_player').isMuted()`);
  check('toggle-mute IPC toggles mute', muted1 !== muted0, `${muted0} -> ${muted1}`);
  await send('peard:toggle-mute');
  await sleep(600);
  check('toggle-mute restores', (await page$(`document.querySelector('#movie_player').isMuted()`)) === muted0);

  // --- Volume (update-volume IPC) - must move the slider too, not just audio ---
  const vol0 = await page$(`document.querySelector('#movie_player').getVolume()`);
  const target = vol0 > 50 ? vol0 - 7 : vol0 + 7;
  await send('peard:update-volume', target);
  await sleep(600);
  const vol1 = await page$(`({ api: document.querySelector('#movie_player').getVolume(), slider: Number(document.querySelector('.ytMusicMiniPlayerVolumePopup input').value) })`);
  check('update-volume IPC sets the volume', vol1.api === target, `api=${vol1.api} want ${target}`);
  check('update-volume IPC moves the slider too', vol1.slider === target, `slider=${vol1.slider}`);
  await send('peard:update-volume', vol0);
  await sleep(600);
  check('volume restored', (await page$(`document.querySelector('#movie_player').getVolume()`)) === vol0);

  // --- Shuffle state (get-shuffle) ---
  const shuffleResp = await main.evaluate(`new Promise((resolve) => {
    const req = process.getBuiltinModule('module').createRequire(process.execPath);
    req('electron').ipcMain.once('peard:get-shuffle-response', (_e, v) => resolve(v));
    globalThis.__test.send('peard:get-shuffle');
  })`);
  check('get-shuffle answers from the store', shuffleResp === (await store('queue.shuffleEnabled')), String(shuffleResp));

  renderer.ws.close();
  main.ws.close();
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(2);
});
