# Personal speaker analysis integration

Decision after the authorized local experiment: integrate optional post-meeting acoustic speaker turns with an explicit participant count. Do not expose automatic count by default; it over-split the tested two-person sample. This is experimental anonymous diarization, not identity recognition or separate audio tracks. User-provided Plaud labels are reference outputs, not gold truth.

## Scope and runtime

- Reuse the proven local sherpa-onnx 2.0.1 CPU + public pyannote segmentation3.0 + Chinese CAMPPlus pipeline. Preserve its model/runtime licenses and exact public model hashes. No private audio/text network requests.
- Ship the reusable Python worker source and a reproducible local setup/configuration script. Model weights, Python environment and private results stay outside Git. Use configured absolute executable/model paths, passed as process arguments without a shell; no arbitrary URL input or model auto-download during analysis.
- Only this Mac is supported. Existing project-local environment may be used, but its Python/runtime dependency must be documented and validated. An unavailable environment/model must produce an actionable error, not an empty successful result. Prefer bundled FFmpeg when usable; explicitly configured local ffprobe is acceptable on this machine.
- Analyze a meeting's saved local recording asynchronously. Require an explicit count (1–12); default2, tested only on two-person recordings. Show progress/busy/error and cancellation. Prevent concurrent jobs for the same meeting. Cancellation and app teardown must terminate owned work without touching unrelated processes.

## Durable data and reprocessing

- Store complete analysis runs independently, tied to meeting ID and source-audio hash. Validate schema, finite ordered in-range turns and anonymous speaker IDs before committing anything.
- Keep model turns immutable and separate from human display names, merge aliases and any turn corrections. Use stable IDs within each run, never treat cluster numbering as stable across reruns.
- A first successful run may become active. A rerun must not overwrite the current active result or its manual changes: retain the old run and present the new run for explicit application. Provide a result selector so previous runs and names remain recoverable.
- Names are Unicode strings. Merges are transactional within one run, with self/cross-run/cycle validation and a way to undo the merge. Do not mutate original transcript text or delete recordings.

## UI and export

- Add a focused Speakers panel to meeting details: backend readiness, participant count, Analyze/Cancel, result selection/application, names and merge controls, and timestamped speaker turns. Reuse existing audio seeking where possible.
- Transcript timestamps are coarse VAD chunks. Do not invent word-level alignment or split text based solely on model boundaries. A chunk overlapping multiple speakers must be marked as mixed/ambiguous rather than assigning a false single speaker.
- Derive transcript display labels from the active run and overlay names/merges. Export adapters receive these labels without duplicating the rendering logic; names should update in transcript exports. Preserve all transcript text and timestamps. Summary text is not rewritten merely because a speaker was renamed.

## Verification

- Test invalid model output/error/cancel leaves prior data unchanged; editing names/merges survives reload; self/cyclic/cross-run merges are rejected; undo restores grouping; a rerun cannot erase or silently replace manual changes.
- Test interval labels for single, mixed, gap and overlapping turns; coarse chunks must not claim finer attribution than evidence supports.
- Test UI readiness, participant count, job state, cancel/error, apply-result and editable labels. Test one exported document includes current labels while preserving source content.
- Reuse actual local experiment assets for an end-to-end integration check; do not commit private audio, reference labels or generated runs. Root performs native GUI acceptance and final build/review.

This design adds no MCP, cloud transcription, voiceprint enrollment, unattended recording or cross-platform support.
