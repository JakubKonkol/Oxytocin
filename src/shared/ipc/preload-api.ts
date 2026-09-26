/** Shape of `window.oxy` exposed by the preload script. */
export interface OxyPreloadApi {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  /** Subscribes to a push event; returns an unsubscribe function. */
  on(event: string, listener: (payload: unknown) => void): () => void;
  /** Absolute path of a dropped File (File.path no longer exists in Electron ≥ 32). */
  getPathForFile(file: File): string;
  readonly platform: 'win32' | 'darwin' | 'linux';
  readonly e2e: boolean;
}
