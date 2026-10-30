import type { AudioActivity } from './meeting-detection';
export interface PollClock {
  schedule: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  cancel: (timer: ReturnType<typeof setTimeout>) => void;
}
/** One cancellable serial poll. In-flight OS queries settle but cannot deliver stale results. */
export class MeetingDetectionPoller {
  private active = false;
  private inFlight = false;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(
    private query: () => Promise<AudioActivity[]>,
    private receive: (apps: AudioActivity[] | null) => void,
    private clock: PollClock = { schedule: (fn, ms) => setTimeout(fn, ms), cancel: clearTimeout },
  ) {}
  start() {
    if (this.active) return;
    this.active = true;
    ++this.generation;
    if (!this.inFlight) void this.poll();
  }
  stop() {
    this.active = false;
    ++this.generation;
    if (this.timer !== null) this.clock.cancel(this.timer);
    this.timer = null;
  }
  private async poll() {
    if (!this.active || this.inFlight) return;
    this.timer = null;
    this.inFlight = true;
    const generation = this.generation;
    try {
      const apps = await this.query();
      if (this.active && generation === this.generation) this.receive(apps);
    } catch {
      if (this.active && generation === this.generation) this.receive(null);
    } finally {
      this.inFlight = false;
      if (this.active) this.timer = this.clock.schedule(() => void this.poll(), generation === this.generation ? 1000 : 0);
    }
  }
}
