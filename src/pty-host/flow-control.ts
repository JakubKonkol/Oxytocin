export interface FlowControlOptions {
  pause: () => void;
  resume: () => void;
  highWatermark?: number;
  lowWatermark?: number;
  /** Resume anyway when no ACK arrives for this long while paused (protects against a stuck renderer). */
  ackTimeoutMs?: number;
  onTimeout?: () => void;
}

/**
 * ACK-based flow control: counts characters sent to renderers but not yet acknowledged; pauses the PTY
 * above the high watermark (100k) and resumes below the low watermark (5k). Without attached renderers
 * nothing is paused — the headless mirror consumes everything.
 */
export class FlowController {
  private unacked = 0;
  private paused = false;
  private attached = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly high: number;
  private readonly low: number;
  private readonly timeoutMs: number;

  constructor(private readonly o: FlowControlOptions) {
    this.high = o.highWatermark ?? 100_000;
    this.low = o.lowWatermark ?? 5_000;
    this.timeoutMs = o.ackTimeoutMs ?? 5_000;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get unacknowledged(): number {
    return this.unacked;
  }

  setAttached(attached: boolean): void {
    this.attached = attached;
    if (!attached) {
      this.unacked = 0;
      this.doResume();
    }
  }

  onSent(chars: number): void {
    if (!this.attached) return;
    this.unacked += chars;
    if (!this.paused && this.unacked > this.high) {
      this.paused = true;
      this.o.pause();
      this.armTimeout();
    }
  }

  onAck(chars: number): void {
    this.unacked = Math.max(0, this.unacked - chars);
    if (this.paused) {
      if (this.unacked < this.low) this.doResume();
      else this.armTimeout();
    }
  }

  private armTimeout(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.paused) return;
      this.o.onTimeout?.();
      this.unacked = 0;
      this.doResume();
    }, this.timeoutMs);
  }

  private doResume(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.paused) return;
    this.paused = false;
    this.o.resume();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
