// The bridge the Aurora desktop app (desktop/preload.cjs) exposes. Absent in a browser.
interface AuroraDesktop {
  platform: string;
  onCommand(cb: (cmd: 'palette' | 'follow' | 'page' | 'post' | 'alerts' | 'ambient' | 'ask' | 'quick', arg?: string) => void): void;
  /** Quick look's window only (desktop/main.cjs checks the sender). Older desktop builds lack it. */
  quick?: { hide(): void; openPost(id: string): void; ask(text: string): void; openMain(): void };
  /** Shows the desktop app's Quick look window (from the main window). Older desktop builds lack it. */
  showQuick?(): void;
  /** Native full screen for the Aurora window (Ambient). Older desktop builds lack it. */
  setFullScreen?(on: boolean): void;
  setTitleBarColors(bg: string, fg: string): void;
}

interface Window {
  auroraDesktop?: AuroraDesktop;
}
