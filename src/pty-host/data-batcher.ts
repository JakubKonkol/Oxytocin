/**
 * Coalesces PTY output into fewer messages: flushes every `intervalMs` (5 ms) or once `maxChars`
 * (64 KB) are buffered — the VS Code TerminalDataBufferer pattern.
 */
export class DataBatcher {
  private chunks: string[] = [];
  private size = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly onFlush: (data: string) => void,
    private readonly intervalMs = 5,
    private readonly maxChars = 64 * 1024,
  ) {}

  push(data: string): void {
    if (data.length === 0) return;
    this.chunks.push(data);
    this.size += data.length;
    if (this.size >= this.maxChars) {
      this.flush();
      return;
    }
    this.timer ??= setTimeout(() => this.flush(), this.intervalMs);
  }

  get pending(): number {
    return this.size;
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.size === 0) return;
    const data = this.chunks.length === 1 ? this.chunks[0]! : this.chunks.join('');
    this.chunks = [];
    this.size = 0;
    this.onFlush(data);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.chunks = [];
    this.size = 0;
  }
}
