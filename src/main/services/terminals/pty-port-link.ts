/**
 * Decides when main hands the renderer a new PTY MessagePort: whenever the
 * shell document finishes loading while the PTY Host runs, and whenever the PTY Host (re)starts while the shell
 * is loaded. "Loaded" tracks the main frame only — `webContents.isLoading()` also reports plugin iframes, and a
 * host that became ready during an iframe load would never get its port (blank terminals).
 */
export class PtyPortLink {
  private shellLoaded = false;

  constructor(
    private readonly hostRunning: () => boolean,
    private readonly connect: () => void,
  ) {}

  get loaded(): boolean {
    return this.shellLoaded;
  }

  /** `did-finish-load` of the main frame. */
  shellDidLoad(): void {
    this.shellLoaded = true;
    if (this.hostRunning()) this.connect();
  }

  /** A main-frame navigation (reload) started or the renderer process went away. */
  shellDidUnload(): void {
    this.shellLoaded = false;
  }

  /** The PTY Host started or restarted. */
  hostDidBecomeReady(): void {
    if (this.shellLoaded) this.connect();
  }
}
