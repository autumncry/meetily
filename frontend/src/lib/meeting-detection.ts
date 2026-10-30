export interface AudioActivity { bundleId: string; inputActive: boolean; outputActive: boolean }
export interface DetectionPreferences { mode: 'off' | 'ask'; allowedBundleIds: string[] }
export const DETECTION_APPS = [
  { id: 'com.electron.lark', name: 'Lark' },
  { id: 'com.alibaba.DingTalkMac', name: 'DingTalk' },
  { id: 'com.tencent.xinWeChat', name: 'WeChat' },
  { id: 'com.google.Chrome', name: 'Google Chrome', browser: true },
  { id: 'com.apple.Safari', name: 'Safari', browser: true },
];
export const DEFAULT_DETECTION_PREFERENCES: DetectionPreferences = { mode: 'off', allowedBundleIds: DETECTION_APPS.slice(0, 3).map(a => a.id) };
export function parseDetectionPreferences(value: unknown): DetectionPreferences {
  const fallback = () => ({ ...DEFAULT_DETECTION_PREFERENCES, allowedBundleIds: [...DEFAULT_DETECTION_PREFERENCES.allowedBundleIds] });
  if (!value || typeof value !== 'object') return fallback();
  const candidate = value as Partial<DetectionPreferences>;
  if (!['off', 'ask'].includes(candidate.mode ?? '') || !Array.isArray(candidate.allowedBundleIds)
    || candidate.allowedBundleIds.some(id => typeof id !== 'string')) return fallback();
  return {
    mode: candidate.mode!,
    allowedBundleIds: [...new Set(candidate.allowedBundleIds)].filter(id => DETECTION_APPS.some(app => app.id === id)),
  };
}
interface Episode { stableSince: number | null; inactiveSince: number | null; consumed: boolean }
/** Pure per-application policy. Unknown samples interrupt continuity; they never end an episode. */
export class MeetingDetectionPolicy {
  private episodes = new Map<string, Episode>();
  private previousTime: number | null = null;

  observe(apps: AudioActivity[] | null, now: number, allowed: string[], busy: boolean): string | null {
    if (this.previousTime !== null && (now - this.previousTime > 3000 || now < this.previousTime)) this.suspend();
    this.previousTime = now;
    if (apps === null) { this.suspend(); return null; }
    let reminder: string | null = null;
    for (const app of DETECTION_APPS) {
      if (!allowed.includes(app.id)) {
        const episode = this.episodes.get(app.id);
        if (episode) { episode.stableSince = null; episode.inactiveSince = null; }
        continue;
      }
      const sample = apps.find(a => a.bundleId === app.id);
      const active = !!sample?.inputActive && !!sample?.outputActive;
      const idle = !sample?.inputActive && !sample?.outputActive;
      const episode = this.episodes.get(app.id) ?? { stableSince: null, inactiveSince: null, consumed: false };
      this.episodes.set(app.id, episode);
      if (idle) {
        episode.stableSince = null;
        episode.inactiveSince ??= now;
        if (now - episode.inactiveSince >= 30000) episode.consumed = false;
      } else {
        episode.inactiveSince = null;
        if (!active) { episode.stableSince = null; continue; }
        episode.stableSince ??= now;
        // Busy activity is consumed immediately, including activity before the stable threshold.
        if (busy) episode.consumed = true;
        if (!episode.consumed && now - episode.stableSince >= 5000) {
          episode.consumed = true;
          reminder ??= app.id;
        }
      }
    }
    return busy ? null : reminder;
  }

  suspend() {
    this.previousTime = null;
    for (const episode of this.episodes.values()) { episode.stableSince = null; episode.inactiveSince = null; }
  }
}
