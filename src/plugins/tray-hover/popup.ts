import { BrowserWindow, screen, app, powerMonitor } from 'electron';

import HoverPopupAsset from './popup.html?asset';

import { errorMessage, flushHoverLog, hoverLog } from './hover-debug';

import { getSongControls } from '@/providers/song-controls';
import {
  registerCallback,
  type SongInfo,
  SongInfoEvent,
} from '@/providers/song-info';
import {
  setTrayOnMouseMove,
  getTrayBounds,
  getTrayMouseMoveListenerCount,
} from '@/tray';

const POPUP_WIDTH = 380;
const POPUP_HEIGHT = 85;
const SHADOW_PAD = 8;
const GAP = 4;

// Diagnostics cadence. Both timers are cheap: the invariant check only
// writes when something changes, the heartbeat writes one line.
const HOVER_SESSION_GAP = 2000;
const INVARIANT_CHECK_INTERVAL = 30 * 1000;
const HEARTBEAT_INTERVAL = 10 * 60 * 1000;

// Exported so interactive.ts can suppress toast notifications
// while the hover popup is visible
let _isVisible = false;
export const isHoverPopupVisible = () => _isVisible;

let setupCount = 0;

export const setupHoverPopup = (win: BrowserWindow) => {
  const songControls = getSongControls(win);
  let currentSongInfo: SongInfo | null = null;
  let popup: BrowserWindow | null = null;
  let popupReady = false;
  let mouseTracker: ReturnType<typeof setInterval> | null = null;

  setupCount++;

  // Diagnostic state
  let lastMouseMove = 0;
  let shownAt = 0;
  let sessionEarlyReturnLogged = false;
  let lastAnomaly = '';
  // True during the 250ms fade-out, when the flag is legitimately still set
  // with no tracker running
  let hidePending = false;
  let counters = {
    mouseMoves: 0,
    sessions: 0,
    shows: 0,
    hides: 0,
    resumes: 0,
    earlyReturns: 0,
    jsErrors: 0,
    songUpdates: 0,
  };

  const runJs = (code: string) => {
    if (!popup || popup.isDestroyed()) return;
    popup.webContents.executeJavaScript(code).catch((err: unknown) => {
      counters.jsErrors++;
      hoverLog('js-error', { code, error: errorMessage(err) });
    });
  };

  const snapshot = () => {
    const destroyed = popup ? popup.isDestroyed() : null;
    const live = popup && !destroyed ? popup : null;
    return {
      flagVisible: _isVisible,
      popupExists: !!popup,
      destroyed,
      winVisible: live ? live.isVisible() : null,
      onTop: live ? live.isAlwaysOnTop() : null,
      popupBounds: live ? live.getBounds() : null,
      ready: popupReady,
      tracking: !!mouseTracker,
      hasSong: !!currentSongInfo,
      trayBounds: getTrayBounds() ?? null,
      trayListeners: getTrayMouseMoveListenerCount(),
      cursor: screen.getCursorScreenPoint(),
    };
  };

  const createPopup = () => {
    popup = new BrowserWindow({
      width: POPUP_WIDTH + SHADOW_PAD * 2,
      height: POPUP_HEIGHT + SHADOW_PAD * 2,
      frame: false,
      transparent: true,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    hoverLog('popup-created');

    popup.loadFile(HoverPopupAsset);

    popup.webContents.on('did-finish-load', () => {
      popupReady = true;
      hoverLog('popup-loaded');
    });

    popup.webContents.on('did-fail-load', (_event, code, description) => {
      hoverLog('popup-load-failed', { code, description });
    });

    popup.webContents.on('render-process-gone', (_event, details) => {
      hoverLog('popup-renderer-gone', { ...details, ...snapshot() });
    });

    popup.on('unresponsive', () => hoverLog('popup-unresponsive'));
    popup.on('responsive', () => hoverLog('popup-responsive'));

    // Window shown or hidden by anything, including the OS (e.g. Win+D)
    popup.on('show', () => hoverLog('win-show-event', { flagVisible: _isVisible }));
    popup.on('hide', () => hoverLog('win-hide-event', { flagVisible: _isVisible }));

    // Button clicks from the popup HTML via document.title changes
    popup.on('page-title-updated', (event, title) => {
      if (!title.startsWith('act:')) return;
      event.preventDefault();
      const cmd = title.split(':')[1];
      hoverLog('button', { cmd });

      switch (cmd) {
        case 'playPause':
          songControls.playPause();
          break;
        case 'previous':
          songControls.previous();
          break;
        case 'next':
          songControls.next();
          break;
      }
    });

    popup.on('closed', () => {
      hoverLog('popup-closed', { flagVisible: _isVisible });
      popup = null;
      popupReady = false;
      _isVisible = false;
      stopMouseTracking();
    });
  };

  const positionPopup = () => {
    if (!popup) return;

    const bounds = getTrayBounds();
    if (!bounds) {
      hoverLog('position-skipped', { reason: 'no-tray-bounds' });
      return;
    }

    const display = screen.getDisplayNearestPoint({
      x: bounds.x,
      y: bounds.y,
    });
    const workArea = display.workArea;
    const winW = POPUP_WIDTH + SHADOW_PAD * 2;
    const winH = POPUP_HEIGHT + SHADOW_PAD * 2;

    // Center horizontally on tray icon
    let x = Math.round(bounds.x + bounds.width / 2 - winW / 2);
    // Position above tray icon
    let y = bounds.y - winH - GAP;

    // Keep within screen bounds
    x = Math.max(
      workArea.x,
      Math.min(x, workArea.x + workArea.width - winW),
    );

    // If tray is at top of screen, position below instead
    if (bounds.y < workArea.y + workArea.height / 2) {
      y = bounds.y + bounds.height + GAP;
    }

    y = Math.max(workArea.y, y);
    popup.setPosition(x, y);

    return { x, y, trayBounds: bounds, workArea, scale: display.scaleFactor };
  };

  const isCursorOver = (bounds: Electron.Rectangle): boolean => {
    const cursor = screen.getCursorScreenPoint();
    return (
      cursor.x >= bounds.x &&
      cursor.x <= bounds.x + bounds.width &&
      cursor.y >= bounds.y &&
      cursor.y <= bounds.y + bounds.height
    );
  };

  // Poll cursor position every 150ms while popup is visible.
  // If mouse is on neither the popup nor the tray icon, hide.
  const startMouseTracking = () => {
    if (mouseTracker) return;
    mouseTracker = setInterval(() => {
      try {
        if (!popup || !_isVisible) {
          stopMouseTracking();
          return;
        }

        const overPopup = isCursorOver(popup.getBounds());
        const trayBounds = getTrayBounds();
        const overTray = trayBounds ? isCursorOver(trayBounds) : false;

        if (!overPopup && !overTray) {
          doHide();
          stopMouseTracking();
        }
      } catch (err) {
        hoverLog('tracker-error', { error: errorMessage(err), ...snapshot() });
      }
    }, 150);
  };

  const stopMouseTracking = () => {
    if (mouseTracker) {
      clearInterval(mouseTracker);
      mouseTracker = null;
    }
  };

  const logEarlyReturn = (reason: string) => {
    counters.earlyReturns++;
    // Once per hover session, so a dead popup can't flood the log
    if (sessionEarlyReturnLogged) return;
    sessionEarlyReturnLogged = true;
    hoverLog('show-skipped', { reason, ...snapshot() });
  };

  const doShow = () => {
    // Self-heal, logged first so the log still shows what went wrong
    if (popup && popup.isDestroyed()) {
      hoverLog('heal', { reason: 'popup-destroyed-not-cleared', ...snapshot() });
      popup = null;
      popupReady = false;
      _isVisible = false;
      stopMouseTracking();
    }
    if (popup && _isVisible && !hidePending && !popup.isVisible()) {
      // Hidden behind our back (e.g. by the OS), so the flag would block
      // showInactive() forever
      hoverLog('heal', { reason: 'flag-visible-window-hidden', ...snapshot() });
      _isVisible = false;
      stopMouseTracking();
    }

    if (!popup) createPopup();
    if (!popup) return logEarlyReturn('no-popup');
    if (!currentSongInfo) return logEarlyReturn('no-song');

    const placement = positionPopup();

    if (!_isVisible) {
      popup.showInactive();
      _isVisible = true;
      shownAt = Date.now();
      counters.shows++;
      startMouseTracking();
      hoverLog('show', {
        ...placement,
        cursor: screen.getCursorScreenPoint(),
        ready: popupReady,
        winVisible: popup.isVisible(),
        onTop: popup.isAlwaysOnTop(),
      });
    } else if (!mouseTracker && !hidePending) {
      // Flag says visible but nothing will ever hide it again
      logEarlyReturn('flag-visible-without-tracker');
    }

    if (popupReady) {
      pushSongInfo();
      runJs('window.showPopup()');
    }
  };

  const doHide = () => {
    if (!popup || !_isVisible) return;

    if (popupReady) {
      runJs('window.hidePopup()');
    }

    // Wait for CSS fade-out animation before hiding the window
    hidePending = true;
    setTimeout(() => {
      hidePending = false;
      try {
        if (popup && _isVisible) {
          // Final check: is the cursor back on popup or tray?
          const overPopup = isCursorOver(popup.getBounds());
          const trayBounds = getTrayBounds();
          const overTray = trayBounds ? isCursorOver(trayBounds) : false;
          if (overPopup || overTray) {
            // Cursor came back, re-show and resume tracking
            counters.resumes++;
            runJs('window.showPopup()');
            startMouseTracking();
            return;
          }

          popup.hide();
          _isVisible = false;
          counters.hides++;
          hoverLog('hide', {
            shownMs: Date.now() - shownAt,
            cursor: screen.getCursorScreenPoint(),
            popupBounds: popup.getBounds(),
            trayBounds: trayBounds ?? null,
          });
        }
      } catch (err) {
        hoverLog('hide-error', { error: errorMessage(err), ...snapshot() });
      }
    }, 250);
  };

  const pushSongInfo = () => {
    if (!popup || !popupReady || !currentSongInfo) return;

    const data = JSON.stringify({
      title: currentSongInfo.title,
      artist: currentSongInfo.artist,
      imageSrc: currentSongInfo.imageSrc || '',
      isPaused: currentSongInfo.isPaused ?? false,
    });

    runJs(`window.updateSongInfo(${data})`);
  };

  // Tray hover triggers popup
  const onTrayMouseMove = () => {
    const now = Date.now();
    counters.mouseMoves++;
    if (now - lastMouseMove > HOVER_SESSION_GAP) {
      counters.sessions++;
      sessionEarlyReturnLogged = false;
      hoverLog('hover-start', snapshot());
    }
    lastMouseMove = now;

    try {
      doShow();
    } catch (err) {
      hoverLog('show-error', { error: errorMessage(err), ...snapshot() });
    }
  };
  setTrayOnMouseMove(onTrayMouseMove);

  // Track current song info
  registerCallback((songInfo, event) => {
    if (event === SongInfoEvent.TimeChanged) return;
    if (!songInfo.artist && !songInfo.title) return;

    if (!currentSongInfo) hoverLog('first-song');
    counters.songUpdates++;
    currentSongInfo = { ...songInfo };
    if (_isVisible) pushSongInfo();
  });

  // Catches the moment the popup state goes bad, even if nobody is hovering.
  // Writes only when the anomaly changes.
  const checkInvariants = () => {
    let anomaly = '';
    const live = popup && !popup.isDestroyed() ? popup : null;
    if (popup && popup.isDestroyed()) anomaly = 'popup-destroyed-not-cleared';
    else if (_isVisible && !mouseTracker && !hidePending) anomaly = 'flag-visible-without-tracker';
    else if (live && _isVisible !== live.isVisible())
      anomaly = 'flag-window-mismatch';
    else if (getTrayMouseMoveListenerCount() === 0)
      anomaly = 'tray-hover-listener-lost';

    if (anomaly !== lastAnomaly) {
      hoverLog(anomaly ? 'ANOMALY' : 'anomaly-cleared', {
        anomaly: anomaly || lastAnomaly,
        ...snapshot(),
      });
      lastAnomaly = anomaly;
    }
    if (anomaly) healAnomaly(anomaly, live);
  };

  // Runs after the ANOMALY line is written, so the log keeps the evidence
  const healAnomaly = (anomaly: string, live: BrowserWindow | null) => {
    switch (anomaly) {
      case 'popup-destroyed-not-cleared':
        popup = null;
        popupReady = false;
        _isVisible = false;
        stopMouseTracking();
        break;
      case 'flag-visible-without-tracker':
      case 'flag-window-mismatch':
        if (_isVisible && live?.isVisible()) {
          // Visible with nobody tracking: let the tracker decide to hide it
          startMouseTracking();
        } else if (_isVisible) {
          _isVisible = false;
          stopMouseTracking();
        } else if (live?.isVisible()) {
          live.hide();
        }
        break;
      case 'tray-hover-listener-lost':
        setTrayOnMouseMove(onTrayMouseMove);
        break;
      default:
        return;
    }
    hoverLog('heal', { reason: anomaly, ...snapshot() });
  };

  const invariantTimer = setInterval(() => {
    try {
      checkInvariants();
    } catch (err) {
      hoverLog('invariant-error', { error: errorMessage(err) });
    }
  }, INVARIANT_CHECK_INTERVAL);

  const heartbeatTimer = setInterval(() => {
    try {
      const lastMoveAgoS = lastMouseMove
        ? Math.round((Date.now() - lastMouseMove) / 1000)
        : null;
      hoverLog('heartbeat', { ...counters, lastMoveAgoS, ...snapshot() });
      counters = {
        mouseMoves: 0,
        sessions: 0,
        shows: 0,
        hides: 0,
        resumes: 0,
        earlyReturns: 0,
        jsErrors: 0,
        songUpdates: 0,
      };
    } catch (err) {
      hoverLog('heartbeat-error', { error: errorMessage(err) });
    }
  }, HEARTBEAT_INTERVAL);

  // System events that commonly break tray icons and window placement
  powerMonitor.on('suspend', () => hoverLog('sys-suspend'));
  powerMonitor.on('resume', () => hoverLog('sys-resume', snapshot()));
  powerMonitor.on('lock-screen', () => hoverLog('sys-lock'));
  powerMonitor.on('unlock-screen', () => hoverLog('sys-unlock', snapshot()));
  screen.on('display-added', () => hoverLog('sys-display-added'));
  screen.on('display-removed', () => hoverLog('sys-display-removed'));
  screen.on('display-metrics-changed', (_event, _display, changed) =>
    hoverLog('sys-display-changed', { changed, trayBounds: getTrayBounds() ?? null }),
  );

  hoverLog('setup', {
    setupCount,
    pid: process.pid,
    version: app.getVersion(),
    electron: process.versions.electron,
    trayListeners: getTrayMouseMoveListenerCount(),
  });

  // Cleanup on quit
  app.once('before-quit', () => {
    clearInterval(invariantTimer);
    clearInterval(heartbeatTimer);
    stopMouseTracking();
    hoverLog('quit', counters);
    flushHoverLog();
    popup?.close();
  });
};
