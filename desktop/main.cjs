// Aurora desktop: the Electron main process.
//
// The app is the same local server the browser version uses. This process starts that server as
// a child on a random free 127.0.0.1 port, with its data in the OS app-data folder, and shows it
// in a locked-down window: no Node in the page, sandboxed renderer, no new windows, no permission
// grants beyond copy and video fullscreen, and every link that leaves the local origin opens in
// the system browser. Around it sit the native bits a desktop app should have: a tray with the
// unread count, a global shortcut to the command palette, a notification when the morning
// edition is ready, aurora:// links for sharing something to follow, an opt-in start at login, and
// Quick look: a small Spotlight-style window with the top posts, summoned by a second shortcut,
// `aurora --quick` or aurora://quick.

'use strict';

const { app, BrowserWindow, Menu, Notification, Tray, globalShortcut, ipcMain, nativeImage, shell, screen } = require('electron');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const SHOT = process.env.AURORA_SHOT || ''; // screenshot mode: hidden window, capture, quit
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
// Apps opened from Finder get a bare PATH (/usr/bin:/bin:...). Append Homebrew's folders so the
// server can find yt-dlp, uv and a system node the way it does from a terminal.
if (IS_MAC) {
  const have = (process.env.PATH || '').split(':');
  const extra = ['/opt/homebrew/bin', '/usr/local/bin'].filter((d) => !have.includes(d));
  if (extra.length) process.env.PATH = [...have.filter(Boolean), ...extra].join(':');
}
const EDITION_ID = 'morning-edition';
const PALETTE_SHORTCUT = 'CommandOrControl+Shift+Space';
const GROUND = '#05060a';
const START_HIDDEN = process.argv.includes('--hidden'); // launched at login: tray only
// Quick look's shortcut. Ctrl+Alt+Space is free in Omarchy, GNOME, KDE and Windows; on macOS
// Ctrl+Option+Space switches input sources, so there it is Option+Space. Change it with
// "quickShortcut" in desktop.json or AURORA_QUICK_SHORTCUT ("off" turns it off).
const QUICK_DEFAULT = IS_MAC ? 'Alt+Space' : 'Control+Alt+Space';
const QUICK_SIZE = { width: 620, height: 560 };
/** `aurora --quick` or an aurora://quick link: show Quick look rather than the main window. */
const isQuickLink = (a) => {
  try {
    const u = new URL(a);
    return u.protocol === 'aurora:' && (u.hostname === 'quick' || u.pathname.replace(/^\/+|\/+$/g, '') === 'quick');
  } catch {
    return false;
  }
};
const wantsQuick = (argv) => argv.includes('--quick') || argv.some(isQuickLink);
const START_QUICK = wantsQuick(process.argv);

// A separate profile folder (tests, a portable copy): AURORA_USER_DATA=/path/to/folder.
if (process.env.AURORA_USER_DATA) app.setPath('userData', path.resolve(process.env.AURORA_USER_DATA));

let win = null;
let quickWin = null;
let pendingQuick = START_QUICK; // asked for before the server was up
let tray = null;
let server = null; // { child, port, origin }
let quitting = false;
let pendingFollow = null; // a follow link that arrived before the window was ready
let unread = 0;
let editionSeen = null;

// ---------- single instance and deep links

if (!SHOT && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (wantsQuick(argv)) {
      toggleQuick();
      return;
    }
    const link = argv.find((a) => a.startsWith('aurora://'));
    if (link) handleDeepLink(link);
    showWindow();
  });
}

// macOS delivers aurora:// links as an event, possibly before the app is ready.
app.on('open-url', (e, link) => {
  e.preventDefault();
  handleDeepLink(link);
});

/** aurora://follow?url=https://… (or any aurora:// link with ?follow=) asks the agent to follow it. */
function parseFollow(link) {
  let u;
  try {
    u = new URL(link);
  } catch {
    return null;
  }
  if (u.protocol !== 'aurora:') return null;
  const target = u.searchParams.get('url') || u.searchParams.get('follow') || '';
  if (u.hostname && u.hostname !== 'follow' && !u.searchParams.has('follow')) return null;
  try {
    const t = new URL(target);
    if (t.protocol !== 'https:' && t.protocol !== 'http:') return null;
    return t.href.slice(0, 2000);
  } catch {
    return null;
  }
}

function handleDeepLink(link) {
  if (isQuickLink(link)) {
    toggleQuick();
    return;
  }
  const target = parseFollow(link);
  if (!target) return;
  if (win && server && !win.webContents.isLoading()) {
    win.webContents.send('aurora:command', 'follow', target);
    showWindow();
  } else {
    pendingFollow = target;
  }
}

// ---------- settings (window bounds, start at login, the last edition we told you about)

const settingsPath = () => path.join(app.getPath('userData'), 'desktop.json');
function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return {};
  }
}
function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2));
  } catch {
    /* settings are a convenience */
  }
  return next;
}

// ---------- the server child process

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Where the server code lives: bundled next to the app, or the repo checkout in development. */
function serverRoot() {
  return app.isPackaged ? path.join(process.resourcesPath, 'aurora') : path.resolve(__dirname, '..');
}

/**
 * Which Node runs the server. The server is TypeScript run by Node's type stripping, and its
 * connector sandbox starts sub-processes with process.execPath, so it wants a real Node binary:
 *   1. the official Node bundled into packaged builds (resources/node),
 *   2. AURORA_NODE or a system `node` new enough to strip types (22.18+ / 23.6+), for development,
 *   3. as a last resort Electron's own Node (ELECTRON_RUN_AS_NODE). The app works, but
 *      AI-built connectors that run as Node sub-processes cannot start there.
 */
function nodeRuntime() {
  const exe = IS_WIN ? 'node.exe' : path.join('bin', 'node');
  const bundled = app.isPackaged ? path.join(process.resourcesPath, 'node', exe) : path.join(__dirname, 'build', 'node', exe);
  if (fs.existsSync(bundled)) return { cmd: bundled, env: {}, kind: 'bundled' };
  for (const cand of [process.env.AURORA_NODE, 'node'].filter(Boolean)) {
    try {
      const v = execFileSync(cand, ['-p', 'process.versions.node'], { encoding: 'utf8', timeout: 5000, windowsHide: true }).trim();
      const [maj, min] = v.split('.').map(Number);
      if (maj >= 24 || (maj === 23 && min >= 6) || (maj === 22 && min >= 18)) return { cmd: cand, env: {}, kind: `system ${v}` };
    } catch {
      /* not there */
    }
  }
  return { cmd: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' }, kind: `electron ${process.versions.node}` };
}

// Where the server keeps its data; set when the server starts.
let dataDir = '';

/** When the owner lock is on, the server honours its local.key from this computer in place of a session. */
function lockHeaders() {
  try {
    return dataDir ? { 'x-aurora-key': fs.readFileSync(path.join(dataDir, 'local.key'), 'utf8').trim() } : {};
  } catch {
    return {};
  }
}

function get(port, p, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout, headers: lockHeaders() }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => (res.statusCode === 200 ? resolve(body) : reject(new Error(`HTTP ${res.statusCode}`))));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function startServer() {
  const port = await freePort();
  const root = serverRoot();
  const runtime = nodeRuntime();
  const userData = app.getPath('userData');
  const logDir = path.join(userData, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const log = fs.openSync(path.join(logDir, 'server.log'), 'a');
  fs.writeSync(log, `\n--- ${new Date().toISOString()} starting on 127.0.0.1:${port} with ${runtime.kind} node\n`);

  const env = {
    ...process.env,
    ...runtime.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    SOCIAL_READER_DATA: process.env.SOCIAL_READER_DATA || path.join(userData, 'data'),
    AURORA_DESKTOP: '1',
  };
  dataDir = env.SOCIAL_READER_DATA;
  // Never let a stray setting widen the bind address from inside the desktop app.
  delete env.ALLOW_NON_LOCAL;
  delete env.SR_ALLOWED_HOSTS;

  const child = spawn(runtime.cmd, ['--disable-warning=ExperimentalWarning', path.join(root, 'server', 'main.ts')], {
    cwd: root,
    env,
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  server = { child, port, origin: `http://127.0.0.1:${port}` };
  child.on('exit', (code, signal) => {
    fs.writeSync(log, `--- server exited (${code ?? signal})\n`);
    if (!quitting && server?.child === child) {
      server = null;
      showError(`The Aurora server stopped (${code ?? signal}). The log is at ${path.join(logDir, 'server.log')}.`);
    }
  });

  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error('The server could not start. See the server log.');
    try {
      await get(port, '/api/health', 1500);
      return server;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error('The server took too long to start.');
}

function stopServer() {
  const s = server;
  server = null;
  if (!s || s.child.exitCode !== null) return;
  s.child.kill('SIGTERM');
  setTimeout(() => {
    if (s.child.exitCode === null) s.child.kill('SIGKILL');
  }, 3000).unref();
}

// ---------- the window

function isLocal(url) {
  try {
    return !!server && new URL(url).origin === server.origin;
  } catch {
    return false;
  }
}

function openOutside(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:') void shell.openExternal(u.href);
  } catch {
    /* not a link */
  }
}

// Every web contents (window, devtools, iframes' owners) gets the same rules.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (e, url) => {
    if (isLocal(url)) return;
    e.preventDefault();
    openOutside(url);
  });
  contents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: 'deny' };
  });
  contents.on('will-attach-webview', (e) => e.preventDefault());
});

// Copy buttons and video fullscreen are the only things the page may ask for, and only the
// local app may ask. Camera, microphone, location, notifications and the rest are refused.
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen']);
function permissionOk(contents, permission, origin) {
  return ALLOWED_PERMISSIONS.has(permission) && isLocal(origin || contents?.getURL() || '');
}

function windowBounds() {
  const shotSize = /^(\d+)x(\d+)$/.exec(process.env.AURORA_SHOT_SIZE || '');
  if (SHOT && shotSize) return { width: Number(shotSize[1]), height: Number(shotSize[2]) };
  const saved = readSettings().bounds;
  const area = screen.getPrimaryDisplay().workAreaSize;
  const fallback = { width: Math.min(1440, area.width), height: Math.min(940, area.height) };
  if (!saved || typeof saved.width !== 'number') return fallback;
  const visible = screen.getAllDisplays().some((d) => {
    const b = d.workArea;
    return saved.x < b.x + b.width && saved.x + saved.width > b.x && saved.y < b.y + b.height && saved.y + saved.height > b.y;
  });
  return visible ? saved : { width: saved.width, height: saved.height };
}

function createWindow() {
  const chrome = SHOT
    ? {}
    : IS_MAC
    ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 18 } }
    : { titleBarStyle: 'hidden', titleBarOverlay: { color: GROUND, symbolColor: '#c9cdd8', height: 36 } };
  win = new BrowserWindow({
    ...windowBounds(),
    minWidth: 380,
    minHeight: 480,
    show: false,
    title: 'Aurora',
    backgroundColor: GROUND,
    icon: iconPath('512x512.png'),
    ...chrome,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      spellcheck: true,
      devTools: !app.isPackaged || process.env.AURORA_DEVTOOLS === '1',
      // Screenshot mode renders off screen, so it works on a machine with no display.
      offscreen: !!SHOT,
    },
  });

  const ses = win.webContents.session;
  ses.setPermissionRequestHandler((contents, permission, cb, details) => cb(permissionOk(contents, permission, details.requestingUrl)));
  ses.setPermissionCheckHandler((contents, permission, origin) => permissionOk(contents, permission, origin));
  ses.setDevicePermissionHandler(() => false);

  win.on('ready-to-show', () => {
    if (!SHOT && !START_HIDDEN) win.show();
  });
  const saveBounds = () => {
    if (win && !win.isMaximized() && !win.isMinimized() && !win.isFullScreen()) writeSettings({ bounds: win.getBounds() });
  };
  win.on('resized', saveBounds);
  win.on('moved', saveBounds);
  win.on('close', (e) => {
    // With a tray, closing the window keeps Aurora syncing in the background (as on macOS).
    if (!quitting && !SHOT && (tray || IS_MAC)) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    win = null;
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    if (d.reason !== 'clean-exit' && server) win?.loadURL(server.origin);
  });
  return win;
}

function showWindow() {
  if (!win) {
    if (!app.isReady()) return;
    createWindow();
    if (server) void win.loadURL(server.origin);
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/**
 * The splash and error page, as a data: URL. Packaged builds turn off the file:// protocol's
 * extra privileges (an Electron fuse), so nothing in the window is ever loaded from disk.
 */
function loadingPage(error = '') {
  const esc = (t) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = fs.readFileSync(path.join(__dirname, 'loading.html'), 'utf8').replace('<!--ERROR-->', esc(String(error).slice(0, 600)));
  return `data:text/html;charset=utf-8;base64,${Buffer.from(html).toString('base64')}`;
}

function showError(message) {
  if (!win) return;
  void win.loadURL(loadingPage(message));
  if (!SHOT) win.show();
}

// The page sends the colours of its current theme so the window controls blend in.
// Ambient asks for native full screen and gives it back when it closes.
ipcMain.on('aurora:fullscreen', (e, on) => {
  if (!win || e.sender !== win.webContents || !isLocal(e.senderFrame?.url ?? '')) return;
  win.setFullScreen(on === true);
});

/** Ambient on the screen under the pointer: move the window there, then open it full screen. */
function ambientHere() {
  if (!server) return;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  if (!win) {
    showWindow();
    if (!win) return;
    win.setBounds(display.workArea);
    void win.loadURL(`${server.origin}/?ambient=1`);
    win.webContents.once('did-finish-load', () => win?.setFullScreen(true));
    return;
  }
  if (win.isFullScreen()) win.setFullScreen(false);
  win.setBounds(display.workArea);
  showWindow();
  win.webContents.send('aurora:command', 'ambient');
}

ipcMain.on('aurora:titlebar', (e, colors) => {
  if (!win || e.sender !== win.webContents || IS_MAC || !isLocal(e.senderFrame?.url ?? '')) return;
  const hex = (v) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : null);
  const color = hex(colors?.bg);
  const symbolColor = hex(colors?.fg);
  if (color && symbolColor) {
    try {
      win.setTitleBarOverlay({ color, symbolColor });
    } catch {
      /* not every window manager supports it */
    }
  }
});

// ---------- Quick look

/** The shortcut from desktop.json or the environment; null when turned off. */
function quickShortcut() {
  const v = String(process.env.AURORA_QUICK_SHORTCUT ?? readSettings().quickShortcut ?? QUICK_DEFAULT).trim();
  return !v || /^(off|none|false)$/i.test(v) ? null : v;
}

/**
 * A second window on the same local page (/?quick=1), with the same locked-down preferences as the
 * main one. It shares the main window's session, so the owner lock's sign-in carries over. It hides
 * on blur or Escape rather than closing, so the next summon is instant.
 */
function createQuickWindow() {
  quickWin = new BrowserWindow({
    ...QUICK_SIZE,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: 'Aurora quick look',
    backgroundColor: GROUND,
    icon: iconPath('512x512.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      spellcheck: true,
      devTools: !app.isPackaged || process.env.AURORA_DEVTOOLS === '1',
      offscreen: !!SHOT,
    },
  });
  if (!IS_MAC) quickWin.setAlwaysOnTop(true, 'pop-up-menu');
  quickWin.on('page-title-updated', (e) => e.preventDefault());
  quickWin.on('blur', () => {
    if (!SHOT) quickWin?.hide();
  });
  quickWin.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      quickWin.hide();
    }
  });
  quickWin.on('closed', () => {
    quickWin = null;
  });
  quickWin.webContents.on('render-process-gone', (_e, d) => {
    if (d.reason !== 'clean-exit' && server) quickWin?.loadURL(`${server.origin}/?quick=1`);
  });
  if (server) void quickWin.loadURL(`${server.origin}/?quick=1`);
  return quickWin;
}

function showQuick() {
  if (!server) {
    pendingQuick = true;
    return;
  }
  if (!quickWin) createQuickWindow();
  // Centre it on the screen under the pointer, a little above the middle, like Spotlight. Wayland
  // compositors place windows themselves; see docs/desktop.md for a Hyprland window rule.
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  quickWin.setBounds({ ...QUICK_SIZE, x: Math.round(area.x + (area.width - QUICK_SIZE.width) / 2), y: Math.round(area.y + Math.max(24, (area.height - QUICK_SIZE.height) * 0.3)) });
  quickWin.show();
  quickWin.focus();
  quickWin.webContents.send('aurora:command', 'quick');
}

function toggleQuick() {
  if (quickWin && quickWin.isVisible() && quickWin.isFocused()) quickWin.hide();
  else showQuick();
}

/** Run a command in the main window, after it has loaded if it is still loading. */
function sendToMain(cmd, arg) {
  showWindow();
  if (!win) return;
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => win?.webContents.send('aurora:command', cmd, arg));
  else win.webContents.send('aurora:command', cmd, arg);
}

// The main window's palette and What's new can open Quick look too.
ipcMain.on('aurora:quick-show', (e) => {
  if (!win || e.sender !== win.webContents || !isLocal(e.senderFrame?.url ?? '')) return;
  showQuick();
});

// Quick look's only way to reach the main window. Anything from another window, a frame that is
// not the local app, or a malformed argument is ignored.
ipcMain.on('aurora:quick', (e, action, arg) => {
  if (!quickWin || e.sender !== quickWin.webContents || !isLocal(e.senderFrame?.url ?? '')) return;
  const text = typeof arg === 'string' ? arg.trim() : '';
  if (action === 'hide') {
    quickWin.hide();
  } else if (action === 'main') {
    quickWin.hide();
    showWindow();
  } else if (action === 'post' && text && text.length <= 300) {
    quickWin.hide();
    sendToMain('post', text);
  } else if (action === 'ask' && text) {
    quickWin.hide();
    sendToMain('ask', text.slice(0, 2000));
  }
});

// ---------- tray, unread count and the morning edition

function iconPath(name) {
  // Icons sit outside the asar archive so the OS notification service can read them by path.
  return path.join(__dirname, 'assets', name).replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

function createTray() {
  const img = nativeImage.createFromPath(iconPath(IS_MAC ? 'trayTemplate.png' : 'tray.png'));
  if (img.isEmpty()) return;
  if (IS_MAC) img.setTemplateImage(true);
  try {
    tray = new Tray(img);
  } catch {
    tray = null; // no system tray here (some Linux desktops)
    return;
  }
  tray.setToolTip('Aurora');
  tray.on('click', () => showWindow());
  updateTray();
}

function updateTray() {
  const label = unread ? `${unread.toLocaleString()} unread` : 'All caught up';
  app.setBadgeCount(unread);
  if (!tray) return;
  tray.setToolTip(`Aurora · ${label}`);
  if (IS_MAC) tray.setTitle(unread ? ` ${unread > 999 ? '999+' : unread}` : '');
  const startAtLogin = !!readSettings().startAtLogin;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Aurora', click: () => showWindow() },
      { label: 'Command palette', accelerator: PALETTE_SHORTCUT, click: () => openPalette() },
      { label: 'Quick look', accelerator: quickShortcut() ?? undefined, click: () => showQuick() },
      { label: 'Ambient on this screen', click: () => ambientHere() },
      { label, enabled: false },
      { type: 'separator' },
      { label: 'Start at login', type: 'checkbox', checked: startAtLogin, click: (item) => setStartAtLogin(item.checked) },
      { type: 'separator' },
      { label: 'Quit Aurora', accelerator: 'CommandOrControl+Q', click: () => app.quit() },
    ]),
  );
}

let refreshTimer = null;
function scheduleRefresh(delay = 1500) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void refreshLibrary(), delay);
}

async function refreshLibrary() {
  if (!server) return;
  let lib;
  try {
    lib = JSON.parse(await get(server.port, '/api/library', 15_000));
  } catch {
    return;
  }
  unread = (lib.items ?? []).filter((i) => !i.state?.read && !i.state?.archived).length;
  updateTray();

  const edition = (lib.pages ?? []).find((p) => p.id === EDITION_ID);
  const stamp = edition?.updatedAt ?? null;
  if (editionSeen === null) {
    // The first look sets the baseline: never announce an edition that was already there.
    editionSeen = readSettings().editionSeen ?? stamp ?? '';
    if (stamp && stamp !== editionSeen) announceEdition(edition);
  } else if (stamp && stamp !== editionSeen) {
    announceEdition(edition);
  }
}

// Linux notification daemons (mako, dunst, GNOME) read the body as Pango markup, so post text
// with tags in it would be drawn as formatting. Escape it there; other systems show plain text.
const notifyText = (s) => (process.platform === 'linux' ? s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : s);

function announceEdition(edition) {
  editionSeen = edition.updatedAt;
  writeSettings({ editionSeen });
  if (SHOT || !Notification.isSupported()) return;
  const hero = (edition.blocks ?? []).find((b) => b.type === 'hero');
  const n = new Notification({
    title: 'Your morning edition is ready',
    body: notifyText(String(hero?.subtitle || hero?.title || 'Fresh from your feeds, read it with coffee.').slice(0, 180)),
    icon: iconPath('512x512.png'),
    silent: false,
  });
  n.on('click', () => {
    showWindow();
    win?.webContents.send('aurora:command', 'page', EDITION_ID);
  });
  n.show();
}

/**
 * An alert fired. The page shows its own toast when the window is in front; otherwise this is a
 * native notification. Quiet hours (decided by the server) keep it silent. Post text is untrusted:
 * it goes into the notification as plain text only, trimmed.
 */
function announceAlert(action) {
  if (SHOT || action.quiet || !Notification.isSupported()) return;
  if (win && win.isVisible() && win.isFocused()) return;
  const hits = Array.isArray(action.hits) ? action.hits : [];
  const first = hits[0];
  if (!first) return;
  const plain = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
  const total = Number(action.total) || hits.length;
  const names = [...new Set(hits.map((h) => plain(h.alertName, 60)))];
  const n = new Notification({
    title: (names.length > 1 ? `${names[0]} and ${names.length - 1} more` : names[0]) || 'Aurora alert',
    body: notifyText(total > 1 ? `${total} new matches. ${plain(first.item?.author, 40)}: ${plain(first.item?.text, 120)}` : `${plain(first.item?.author, 40)}: ${plain(first.item?.text, 160)}`),
    icon: iconPath('512x512.png'),
    silent: false,
  });
  n.on('click', () => {
    showWindow();
    if (typeof first.itemId === 'string') win?.webContents.send('aurora:command', total > 1 ? 'alerts' : 'post', first.itemId);
  });
  n.show();
}

/** Listen to the server's event stream so the tray and the edition notice stay current. */
function followEvents() {
  if (!server || quitting) return;
  const s = server;
  const req = http.get({ host: '127.0.0.1', port: s.port, path: '/api/events', headers: lockHeaders() }, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = block.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        try {
          const evt = JSON.parse(line.slice(6));
          if (evt.type === 'library') scheduleRefresh(evt.reason === 'page' ? 300 : 2500);
          else if (evt.type === 'ui' && evt.action && evt.action.kind === 'alert') announceAlert(evt.action);
        } catch {
          /* ignore malformed events */
        }
      }
    });
    res.on('end', () => setTimeout(followEvents, 3000));
  });
  req.on('error', () => setTimeout(followEvents, 3000));
}

// ---------- palette shortcut and start at login

function openPalette() {
  showWindow();
  win?.webContents.send('aurora:command', 'palette');
}

function linuxAutostartFile() {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart', 'aurora.desktop');
}

function setStartAtLogin(on) {
  writeSettings({ startAtLogin: on });
  if (process.platform === 'linux') {
    const file = linuxAutostartFile();
    if (on) {
      const exe = process.env.APPIMAGE || process.execPath;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=Aurora\nExec="${exe}" --hidden\nX-GNOME-Autostart-enabled=true\nNoDisplay=false\n`);
    } else {
      fs.rmSync(file, { force: true });
    }
  } else {
    app.setLoginItemSettings({ openAtLogin: on, openAsHidden: true, args: ['--hidden'] });
  }
  updateTray();
}

// ---------- application menu (macOS needs one for copy, paste and quit shortcuts)

function setMenu() {
  if (!IS_MAC) {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          { label: 'Command Palette', accelerator: 'Command+K', click: () => openPalette() },
          { type: 'separator' },
          { role: 'reload' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      { role: 'windowMenu' },
    ]),
  );
}

// ---------- startup

app.on('before-quit', () => {
  quitting = true;
});
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopServer();
});
app.on('window-all-closed', () => {
  if (!IS_MAC || SHOT) app.quit();
});
app.on('activate', () => showWindow());

async function main() {
  await app.whenReady();
  // Register aurora:// only for installed builds, so a development run never rewrites the
  // system's link handlers.
  if (app.isPackaged) app.setAsDefaultProtocolClient('aurora');
  const coldLink = process.argv.find((a) => a.startsWith('aurora://'));
  if (coldLink) handleDeepLink(coldLink);

  setMenu();
  createWindow();
  await win.loadURL(loadingPage());
  if (!SHOT && !START_HIDDEN && !START_QUICK) win.show();

  try {
    await startServer();
  } catch (e) {
    showError(e.message);
    if (SHOT) setTimeout(() => app.quit(), 1500);
    return;
  }
  const first = new URL(server.origin);
  if (pendingFollow) {
    first.searchParams.set('follow', pendingFollow);
    pendingFollow = null;
  }
  await win.loadURL(first.href);

  if (SHOT && process.env.AURORA_SHOT_COMMAND === 'quick') {
    // Screenshot Quick look instead of the main window.
    createQuickWindow();
    let frame = null;
    quickWin.webContents.on('paint', (_e, _dirty, image) => (frame = image));
    quickWin.webContents.setFrameRate(10);
    await new Promise((r) => setTimeout(r, Number(process.env.AURORA_SHOT_WAIT || 4000)));
    quickWin.webContents.send('aurora:command', 'quick');
    await new Promise((r) => setTimeout(r, 1200));
    quickWin.webContents.invalidate();
    await new Promise((r) => setTimeout(r, 300));
    if (frame) fs.writeFileSync(SHOT, frame.toPNG());
    quitting = true;
    app.quit();
    return;
  }

  if (SHOT) {
    let frame = null;
    win.webContents.on('paint', (_e, _dirty, image) => (frame = image));
    win.webContents.setFrameRate(10);
    await new Promise((r) => setTimeout(r, Number(process.env.AURORA_SHOT_WAIT || 4000)));
    if (process.env.AURORA_SHOT_COMMAND) win.webContents.send('aurora:command', process.env.AURORA_SHOT_COMMAND, process.env.AURORA_SHOT_ARG);
    await new Promise((r) => setTimeout(r, 1200));
    win.webContents.invalidate();
    await new Promise((r) => setTimeout(r, 300));
    if (frame) fs.writeFileSync(SHOT, frame.toPNG());
    quitting = true;
    app.quit();
    return;
  }

  createTray();
  if (!globalShortcut.register(PALETTE_SHORTCUT, openPalette)) {
    console.warn(`Could not register ${PALETTE_SHORTCUT}; another app has it.`);
  }
  // On Wayland Electron's global shortcuts often cannot register; bind `aurora --quick` in the
  // compositor instead (docs/desktop.md).
  const qs = quickShortcut();
  try {
    if (qs && !globalShortcut.register(qs, toggleQuick)) console.warn(`Could not register ${qs} for Quick look; another app has it.`);
  } catch {
    console.warn(`"${qs}" is not a shortcut Electron understands; Quick look has no shortcut.`);
  }
  if (pendingQuick) {
    pendingQuick = false;
    showQuick();
  }
  followEvents();
  scheduleRefresh(500);
  setInterval(() => scheduleRefresh(0), 120_000).unref();
}

main().catch((e) => {
  console.error(e);
  showError(String(e?.message ?? e));
});
