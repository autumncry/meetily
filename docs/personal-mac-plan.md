# Meetily Personal Mac Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development task-by-task. The user explicitly authorized implementation in this chat; continue through the stages without asking again for plan approval.

**Goal:** Deliver a usable Mac fork with local PDF/DOCX/Markdown exports, optional meeting detection, and a validated speaker workflow when feasible.

**Architecture:** Retain Tauri/Rust/Next.js. Normalize meeting documents once and render through three format adapters. Separate native audio observation, meeting-detection policy, and recording orchestration; preserve end-of-recording persistence. Speaker work is a final gated experiment.

**Tech Stack:** Tauri 2, Rust, React 18/Next.js 14, SQLite, Bun tests; local document generators and a bundled CJK font.

**Spec:** [personal-mac-spec.md](personal-mac-spec.md)

## Global Constraints

- Only the user's current Apple Silicon Mac; no MCP implementation.
- All materials stay under the user-specified Meetily project root; private Ref/Validation/Work/Builds never enter Git.
- No private recordings or transcript bodies uploaded to an API or remote repository.
- Preserve reference inputs; Plaud labels are comparison data, not human gold truth.
- Implement exports first, meeting detection second, speaker work last.
- Keep MIT notices; use public APIs and appropriately licensed dependencies.
- Default detection Off; reminders offer one-click start through the existing flow, with manual stop only.
- Optional diarization is accepted only with real audio evidence; failed experiments may be omitted as explicitly authorized.

## Review Focus

- A long Chinese meeting exports every segment, including those beyond the UI page, without dropped characters or unreadable glyphs.
- A summary edited immediately before export uses the visible edited content and preserves headings, lists and tables.
- Cancelled save dialogs, failed writes and unsupported content must not report successful exports.
- Repeated activity events, silence and navigation must not create duplicate reminders or recordings.
- Re-running transcription/diarization must not silently discard manual speaker corrections.

### Task 1: Local document exports

**Files:** Create `frontend/src/lib/meeting-export/` (normalized model and format adapters), `frontend/src/hooks/meeting-details/useExportOperations.ts`, an export control component and `frontend/tests/lib/meeting-export.test.ts`. Modify `frontend/src/app/meeting-details/page-content.tsx`, its meeting header/summary/transcript controls as needed, and `frontend/src/components/AISummary/BlockNoteSummaryView.tsx` to expose current structured content. Update package manifest/lock and Tauri dialog capabilities only as needed. Bundle a licensed CJK font with attribution in frontend assets.

**Interfaces:** Export `ExportFormat = 'md' | 'docx' | 'pdf'` and `ExportContent = 'summary' | 'transcript' | 'both'`. A pure `buildMeetingDocument` consumes title/date, complete transcripts, and current summary content; `renderMeetingDocument(document, format)` produces bytes with filename/mime metadata. The hook fetches all transcript pages, obtains latest editor blocks, opens a save dialog, and writes locally. Keep native file I/O separate from pure rendering so references can exercise the real renderers outside the app.

- [ ] Add meaningful failing tests for long/full transcript ordering, Chinese/emoji, metadata/timestamps, BlockNote/Markdown/legacy summaries, safe filenames, empty content and cancelled save behavior.
- [ ] Implement normalized conversion and Markdown/DOCX/PDF adapters. Use editable DOCX text and embedded CJK searchable PDF text, with pagination and no remote asset proxy. Preserve headings/lists/tables; explicitly handle unsupported image content without silently losing surrounding text.
- [ ] Add format/content selection and busy/error states to the meeting details view. Exports must be available without a generated summary when a transcript exists.
- [ ] Run targeted and existing frontend tests, TypeScript and production build. Generate short and long local reference exports under parent `Validation/exports`; structurally check text completeness and visually inspect rendered PDF/DOCX.
- [ ] Commit source/fixtures only; no private data, model weights or generated reference exports. Record commands and limitations in `Work/task-1-report.md`.

### Task 2: Meeting detection reminders

**Files:** Add or extend the macOS audio observation and related command/state modules. Create a pure detection policy and tests; create a frontend detector provider/hook/settings. Reuse the existing home-page start action rather than introducing native background recording control.

**Interfaces:** Native observation returns app identity and active input/output observations without content. Policy consumes observations, enabled state and whether a recording is already active; produces one reminder per activity session. Clicking start routes through the existing home-page start flow. Settings persist enablement and allowlist locally. Native polling/observation must have real cancellation and not leak listeners/threads on toggles.

- [ ] Add failing tests for stable activity, deduplicated reminders, non-meeting playback, self-exclusion, session-ending grace period, paused/manual recordings, disabled mode and observer cleanup.
- [ ] Add explicit enable/disable settings with Off default. Observe a small configurable allowlist; disclose browser-app granularity. Reminders present a visible start action and dismiss option.
- [ ] Reuse manual start/readiness validation and manual stop/persistence. Repeated clicks must not initiate duplicate starts; reminders must not appear while already recording or paused.
- [ ] Run native policy tests, frontend orchestration tests, Rust check/build and UI interaction checks; distinguish mocked state tests from actual OS/process observation. Record what was tested on this Mac.
- [ ] Commit and record verification in `Work/task-2-report.md`.

### Task 3: Bounded speaker experiment and optional integration

**Files:** Local experiment tools/results under parent `Work/diarization` and `Validation/diarization`; only reusable source may enter `Code/scripts/personal/`. If the experiment passes, add meeting-speaker/turn data, commands, frontend controls and tests through current Rust/SQLite services.

**Interfaces:** A local acoustic backend returns timestamped anonymous speaker turns, separate from human display names. Meeting-local speaker IDs and manual overrides are stable across reprocessing. Export adapters consume display labels through a normalized document field.

- [ ] Evaluate an available real local diarization model on a bounded representative audio sample, then compare intervals and labels to Plaud reference without treating it as gold truth. No private audio cloud calls; do not read/download gated model credentials without authorization.
- [ ] If the model cannot run or output cannot be validated, record failure evidence and omit automated separation. A reference-import/manual-label workflow may be retained only if clearly labeled and useful, never represented as acoustic detection.
- [ ] If viable, add tests for name changes, transactional merges, undo/correction persistence and reprocessing safety, then integrate post-meeting separation plus visible progress/error state.
- [ ] Validate on two-speaker Chinese data and disclose overlap/alignment errors. Commit only verified functionality; record the accept/omit decision in `Work/task-3-report.md`.

### Task 4: Mac delivery and whole-branch verification

**Files:** Create `script/build_and_run.sh` and personal build documentation/config. Use a distinct `com.autumncry.meetily.personal` app ID and `Meetily Personal` display name; disable upstream updater replacement. Produce bundles under parent `Builds`.

**Interfaces:** The script uses project-local Rust/CMake tools when present, builds the actual Tauri app and sidecars for arm64, and supports build-only / launch / verify modes. It must not terminate the user's unrelated Meetily app.

- [ ] Run relevant full frontend and native tests, production frontend build and native release packaging. Separate inherited failures from regressions with baseline evidence; fix blockers necessary for delivery.
- [ ] Launch and inspect the real app, exercise export controls and detector settings, render exported files and record evidence under Validation.
- [ ] Perform an independent whole-branch review of actual changes. Fix important findings, then create a final local build and concise usage/limitations report.
- [ ] Keep private inputs and caches outside Git. Push source branch to the user's fork only after source review and verification; do not publish releases or merge upstream.
