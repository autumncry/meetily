/** A confirmed reminder request lives only in memory, until the home start flow settles. */
export class DetectionStartRequest {
  readonly done: Promise<void>;
  private resolve!: () => void;
  private cancelled = false;
  private claimed = false;
  private settled = false;
  private timer: ReturnType<typeof setTimeout>;

  constructor(private stillValid: () => boolean) {
    this.done = new Promise(resolve => { this.resolve = resolve; });
    this.timer = setTimeout(() => this.cancel(), 30000);
  }
  isValid() { return !this.cancelled && !this.settled && this.stillValid(); }
  claim() {
    if (this.claimed) return false;
    if (!this.isValid()) { this.finish(); return false; }
    this.claimed = true;
    return true;
  }
  cancel() {
    this.cancelled = true;
    clearTimeout(this.timer);
    // A claimed flow keeps its lock until its pending readiness/start work settles.
    if (!this.claimed) this.finish();
  }
  finish() {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this.timer);
    this.resolve();
  }
}
