'use client';
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { DEFAULT_DETECTION_PREFERENCES, DETECTION_APPS, DetectionPreferences, AudioActivity, MeetingDetectionPolicy, parseDetectionPreferences } from '@/lib/meeting-detection';
import { MeetingDetectionPoller } from '@/lib/meeting-detection-poller';
import { DetectionStartRequest } from '@/lib/detection-start-request';
import { DetectionSaveError, meetingDetectionService } from '@/services/meetingDetectionService';
import { recordingService } from '@/services/recordingService';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { RecordingStatus, useRecordingState } from '@/contexts/RecordingStateContext';
interface DetectionContext {
  preferences: DetectionPreferences;
  loaded: boolean;
  saving: boolean;
  error: string | null;
  health: 'off' | 'checking' | 'watching' | 'unavailable';
  updatePreferences: (preferences: DetectionPreferences) => Promise<void>;
}
const Context = createContext<DetectionContext | null>(null);
export const useMeetingDetection = () => {
  const context = useContext(Context);
  if (!context) throw new Error('MeetingDetectionProvider is required');
  return context;
};
export function MeetingDetectionProvider({ children, ready }: { children: React.ReactNode; ready: boolean }) {
  const [preferences, setPreferences] = useState<DetectionPreferences>(DEFAULT_DETECTION_PREFERENCES);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [settingsRevision, setSettingsRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<DetectionContext['health']>('off');
  const [reminder, setReminder] = useState<string | null>(null);
  const recording = useRecordingState();
  const { handleRecordingToggle } = useSidebar();
  const busy = recording.isRecording || recording.isPaused
    || ![RecordingStatus.IDLE, RecordingStatus.COMPLETED, RecordingStatus.ERROR].includes(recording.status);
  const active = ready && loaded && !saving && preferences.mode === 'ask' && preferences.allowedBundleIds.length > 0;
  const current = useRef({ active, busy, preferences, handleRecordingToggle });
  current.current = { active, busy, preferences, handleRecordingToggle };
  const mounted = useRef(false);
  const saveLock = useRef(false);
  const startLock = useRef(false);
  const startRequest = useRef<DetectionStartRequest | null>(null);
  const epoch = useRef(0);
  const reminderRef = useRef<string | null>(null);
  const lastSample = useRef<{ apps: AudioActivity[]; at: number } | null>(null);
  const nativeBusy = useRef(false);
  const policy = useRef(new MeetingDetectionPolicy());
  const poller = useRef<MeetingDetectionPoller | null>(null);

  const dismiss = () => { reminderRef.current = null; setReminder(null); };
  if (!poller.current) poller.current = new MeetingDetectionPoller(
    async () => {
      const apps = await meetingDetectionService.snapshot(current.current.preferences.allowedBundleIds);
      // Also reconcile backend recording state before considering a reminder:
      // the initial React state can be stale after a webview reload.
      const state = await recordingService.getRecordingState();
      nativeBusy.current = state.is_recording || state.is_paused;
      return apps;
    },
    apps => {
      if (!mounted.current || !current.current.active || saveLock.current) return;
      const now = performance.now();
      lastSample.current = apps === null ? null : { apps, at: now };
      setHealth(apps === null ? 'unavailable' : 'watching');
      const suppressed = current.current.busy || nativeBusy.current;
      const candidate = policy.current.observe(apps, now, current.current.preferences.allowedBundleIds, suppressed);
      const existing = apps?.find(app => app.bundleId === reminderRef.current);
      if (suppressed || !existing?.inputActive || !existing.outputActive) dismiss();
      if (candidate) { reminderRef.current = candidate; setReminder(candidate); }
    },
  );

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    void meetingDetectionService.load().then(prefs => {
      if (!cancelled) setPreferences(prefs);
    }).catch(() => {
      if (!cancelled) setError('Could not load meeting detection settings. Detection is Off.');
    }).finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; mounted.current = false; ++epoch.current; startRequest.current?.cancel(); poller.current!.stop(); };
  }, []);

  const allowedKey = preferences.allowedBundleIds.join('|');
  useEffect(() => {
    ++epoch.current;
    dismiss();
    lastSample.current = null;
    policy.current.suspend();
    if (active) { setHealth('checking'); poller.current!.start(); }
    else { setHealth('off'); poller.current!.stop(); }
    return () => { ++epoch.current; startRequest.current?.cancel(); poller.current!.stop(); };
  }, [active, allowedKey, settingsRevision]);

  useEffect(() => { if (busy) { dismiss(); startRequest.current?.cancel(); } }, [busy]);

  const updatePreferences = async (next: DetectionPreferences) => {
    if (saveLock.current || !loaded) return;
    saveLock.current = true;
    ++epoch.current;
    startRequest.current?.cancel();
    poller.current!.stop();
    dismiss();
    setSaving(true); setError(null);
    const previous = current.current.preferences;
    try {
      const validated = parseDetectionPreferences(next);
      await meetingDetectionService.save(validated, previous);
      if (mounted.current) setPreferences(validated);
    } catch (failure) {
      if (mounted.current) {
        if (failure instanceof DetectionSaveError && failure.rollbackFailed) setPreferences({ ...previous, mode: 'off' });
        setError(failure instanceof DetectionSaveError ? failure.message : 'Could not save meeting detection settings. Previous settings retained.');
      }
    } finally {
      saveLock.current = false;
      if (mounted.current) {
        setSaving(false);
        // React may batch saving=true/false into one render. Reconcile even when
        // a failed save retained the identical mode and selection.
        setSettingsRevision(value => value + 1);
      }
    }
  };

  const start = async (bundleId: string) => {
    if (startLock.current || saveLock.current || reminderRef.current !== bundleId || !current.current.active || current.current.busy) return;
    startLock.current = true;
    const generation = epoch.current;
    let request: DetectionStartRequest | null = null;
    dismiss(); // Consume immediately; failed starts remain manual retries.
    try {
      const state = await recordingService.getRecordingState();
      const sample = lastSample.current;
      const app = sample?.apps.find(app => app.bundleId === bundleId);
      if (!mounted.current || generation !== epoch.current || !current.current.active || current.current.busy
        || state.is_recording || state.is_paused || !app?.inputActive || !app.outputActive
        || !sample || performance.now() - sample.at > 3000) return;
      // The existing Sidebar action reaches the home model/device/readiness flow
      // on every route. Detection never invokes native recording start or stop.
      request = new DetectionStartRequest(() => {
        const sample = lastSample.current;
        const app = sample?.apps.find(app => app.bundleId === bundleId);
        return mounted.current && generation === epoch.current && current.current.active && !saveLock.current
          && !current.current.busy && !nativeBusy.current && !!app?.inputActive && !!app.outputActive
          && !!sample && performance.now() - sample.at <= 3000;
      });
      startRequest.current = request;
      current.current.handleRecordingToggle(request);
      await request.done;
    } catch {
      if (mounted.current && generation === epoch.current) toast.error('Could not check recording state. Please start recording manually.');
    } finally {
      request?.finish();
      if (startRequest.current === request) startRequest.current = null;
      startLock.current = false;
    }
  };

  return <Context.Provider value={{ preferences, loaded, saving, error, health, updatePreferences }}>
    {children}
    {reminder && active && !busy && <aside role="status" aria-label="Meeting detected" className="fixed bottom-6 right-6 z-50 max-w-sm rounded-lg border border-blue-200 bg-white p-4 shadow-lg">
      <p className="font-semibold">Possible meeting in {DETECTION_APPS.find(app => app.id === reminder)?.name}</p>
      <p className="mt-1 text-sm text-gray-600">This app is using audio input and output. Start recording when you are ready, and stop it manually when finished.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="rounded-md bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700" onClick={() => start(reminder)}>Start recording</button>
        <button type="button" className="rounded-md border px-3 py-2 text-sm hover:bg-gray-50" onClick={dismiss}>Ignore this meeting</button>
      </div>
    </aside>}
  </Context.Provider>;
}
