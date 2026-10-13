// The only bridge between the Aurora page and the desktop shell. It runs sandboxed with
// context isolation, so the page sees this small object and nothing else of Electron or Node.

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const COMMANDS = new Set(['palette', 'follow', 'page', 'post', 'alerts', 'ambient', 'ask', 'quick']);

contextBridge.exposeInMainWorld('auroraDesktop', {
  platform: process.platform,
  /**
   * Commands from the shell: 'palette', 'follow' (with a URL), 'page' (with a page id), 'post' (with a post id), 'alerts',
   * 'ambient', 'ask' (with a question for the agent) and, in Quick look's window, 'quick' (it was just shown).
   */
  onCommand(cb) {
    if (typeof cb !== 'function') return;
    ipcRenderer.on('aurora:command', (_e, cmd, arg) => {
      if (COMMANDS.has(cmd)) cb(cmd, typeof arg === 'string' ? arg : undefined);
    });
  },
  /** Native full screen for the window, used by Ambient. */
  setFullScreen(on) {
    ipcRenderer.send('aurora:fullscreen', on === true);
  },
  /** Show Quick look's window (asked from the main window). */
  showQuick() {
    ipcRenderer.send('aurora:quick-show');
  },
  /**
   * Quick look's window asks the shell to hide it, or to show something in the main window. The main
   * process ignores these from any other window.
   */
  quick: {
    hide() {
      ipcRenderer.send('aurora:quick', 'hide');
    },
    openPost(id) {
      ipcRenderer.send('aurora:quick', 'post', String(id));
    },
    ask(text) {
      ipcRenderer.send('aurora:quick', 'ask', String(text));
    },
    openMain() {
      ipcRenderer.send('aurora:quick', 'main');
    },
  },
  /** Tint the window controls to match the theme (two #rrggbb colours). */
  setTitleBarColors(bg, fg) {
    ipcRenderer.send('aurora:titlebar', { bg: String(bg), fg: String(fg) });
  },
});
