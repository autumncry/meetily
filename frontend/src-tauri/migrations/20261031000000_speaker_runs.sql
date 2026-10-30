CREATE TABLE speaker_runs (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    audio_hash TEXT NOT NULL,
    requested_speakers INTEGER NOT NULL,
    raw_result TEXT NOT NULL,
    overlay TEXT NOT NULL
);
CREATE INDEX speaker_runs_meeting ON speaker_runs(meeting_id);
CREATE TABLE speaker_active (
    meeting_id TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES speaker_runs(id) ON DELETE CASCADE
);
