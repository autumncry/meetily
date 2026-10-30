import { invoke } from '@tauri-apps/api/core';
import { Store } from '@tauri-apps/plugin-store';
import { AudioActivity, DetectionPreferences, parseDetectionPreferences } from '@/lib/meeting-detection';

const KEY = 'meeting_detection_v1';
export class DetectionSaveError extends Error {
  constructor(public rollbackFailed: boolean) {
    super(rollbackFailed
      ? 'Could not save meeting detection settings or restore the saved preference. Detection is Off for this run; check settings after restarting.'
      : 'Could not save meeting detection settings. Previous settings restored.');
  }
}
export const meetingDetectionService = {
  async load(): Promise<DetectionPreferences> {
    const store = await Store.load('preferences.json', { autoSave: false, defaults: {} });
    return parseDetectionPreferences(await store.get(KEY));
  },
  async save(next: DetectionPreferences, previous: DetectionPreferences): Promise<void> {
    const store = await Store.load('preferences.json', { autoSave: false, defaults: {} });
    try {
      await store.set(KEY, next);
      await store.save();
    } catch {
      // Restore the in-memory store too, so another preference's later save cannot
      // accidentally persist an enablement whose save was reported as failed.
      try { await store.set(KEY, previous); await store.save(); }
      catch { throw new DetectionSaveError(true); }
      throw new DetectionSaveError(false);
    }
  },
  snapshot(allowedBundleIds: string[]): Promise<AudioActivity[]> {
    return invoke('get_meeting_audio_snapshot', { allowedBundleIds });
  },
};
