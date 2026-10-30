import React from 'react';
import { useMeetingDetection } from '@/contexts/MeetingDetectionProvider';
import { DETECTION_APPS } from '@/lib/meeting-detection';
export function MeetingDetectionSettings() {
  const { preferences, loaded, saving, error, health, updatePreferences } = useMeetingDetection();
  return <section className="space-y-3 border-t pt-6" aria-labelledby="meeting-detection-title">
    <h4 id="meeting-detection-title" className="text-base font-medium text-gray-900">Meeting detection</h4>
    <label className="flex items-center justify-between gap-4 rounded-lg border p-4">
      <span><span className="block font-medium">Ask before recording</span><span className="text-sm text-gray-600">Off by default. Show a reminder; only your click starts a recording.</span></span>
      <input type="checkbox" role="switch" aria-label="Ask before recording" checked={preferences.mode === 'ask'} disabled={!loaded || saving} onChange={event => void updatePreferences({ ...preferences, mode: event.target.checked ? 'ask' : 'off' })} className="h-5 w-5 accent-blue-600" />
    </label>
    <fieldset disabled={!loaded || saving} className="space-y-2 rounded-lg border p-4">
      <legend className="px-1 text-sm font-medium">Apps to watch</legend>
      {DETECTION_APPS.map(app => <label key={app.id} className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={preferences.allowedBundleIds.includes(app.id)} className="h-4 w-4 accent-blue-600" onChange={event => void updatePreferences({ ...preferences, allowedBundleIds: event.target.checked ? [...preferences.allowedBundleIds, app.id] : preferences.allowedBundleIds.filter(id => id !== app.id) })} />
        {app.name}{app.browser ? ' (entire browser)' : ''}
      </label>)}
    </fieldset>
    <p className="text-xs text-gray-600">Uses local app identity and audio activity only. Browser detection covers the whole app and cannot identify a meeting tab. Shared or unrecognized helper processes may be missed. Audio tests can trigger reminders; muted or listen-only meetings may be missed. Muting a meeting app does not mute Meetily. Recordings always stop manually.</p>
    <p role="status" className="text-sm text-gray-600">{saving ? 'Saving…' : preferences.mode === 'ask' && !preferences.allowedBundleIds.length ? 'Select at least one app to watch.' : ({ off: 'Off', checking: 'Checking audio activity…', watching: 'Watching selected apps', unavailable: 'Detection temporarily unavailable. Retrying…' })[health]}</p>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
  </section>;
}
