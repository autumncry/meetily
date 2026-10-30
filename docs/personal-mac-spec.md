# Meetily Personal Mac scope

Authorized on 2026-10-30 by the user: fork Meetily and implement, in order, PDF/Word/Markdown exports, automatic meeting detection, then an experimental speaker diarization/naming/merging workflow if it can be validated. MCP is excluded. Only this user's Apple Silicon Mac is supported.

The project root is the parent of this repository. Ref contains private Plaud audio and reference transcripts; Research contains prior research; Builds contains installable bundles; Validation contains local test artifacts; Work contains local tools and task reports. Ref, Validation, Work, Builds, credentials, and private transcript contents must never enter Git commits or remote uploads.

## Required behavior

1. Export a meeting summary, transcript, or both to UTF-8 Markdown, editable DOCX, and searchable PDF. Export full transcripts rather than only visible/paginated rows. Preserve Chinese text, timestamps, title, and supported summary structure. Use the latest visible editor contents. Show save/cancel/failure state; no success toast on cancellation. Keep rendering local and bundle needed font assets.
2. Detect likely meetings on macOS using an explicit application allowlist and native audio-process activity. Offer Off and Ask modes; default Off. Ask presents a reminder with one-click start through the existing recording workflow. Recording ends manually. Suppress repeated reminders during the same activity session, exclude our own audio activity, and keep visible status/manual control. Do not promise detection of every browser tab or every meeting application.
3. Preserve the existing manual recording completion flow. Detection and reminder actions must handle duplicate events, navigation, already-active/paused recordings, app restarts and observer disposal without duplicate recordings. Unattended automatic start/stop is outside this iteration because the user asked for detection, not unattended recording.
4. Attempt speaker separation after recording using a real local model or validated local service; ordinary text LLM output is not speaker ground truth. Support stable meeting-local speaker IDs, display-name editing, merging and correction persistence. Reference Plaud text is a comparison artifact, not a human-verified gold dataset. If acoustic separation cannot be validated, do not expose it as working; report the limitation and retain verified export/detection work. No paid cloud API calls or private audio uploads are needed for this work.

## Implementation decisions

- Retain Tauri/Rust/React; avoid a wholesale rewrite and the archived Python backend.
- Keep a separate app identity for this personal build and disable upstream auto-update replacement. Preserve local official-app data.
- Prefer independent document adapters behind one normalized document model. Markdown is not the only source for rich structure.
- Keep detection policy pure and testable, with native observation separated from recording orchestration.
- Reuse the existing UI recording workflow for the reminder's start action; do not add automated stop or a second persistence path.
- Build an ad-hoc-signed local .app for this Mac, with a reproducible project-local build/run script.

## Acceptance

Verify representative short and long Chinese reference transcripts in all three export formats, inspect PDF/DOCX rendering, and ensure full text is retained. Test detection state transitions and frontend integration. Build the native app and inspect the real UI. Actual live microphone/system recording and macOS permission prompts are distinct from simulated tests and must be reported accurately. Optional diarization requires real audio evaluation, with limitations documented rather than invented accuracy scores.
