# Local speaker analysis

The personal Mac build can analyze a saved recording after a meeting. Enter the
participant count (1–12, default 2); only two-person Chinese recordings were
evaluated. The acoustic model produces anonymous speaker turns, not real names,
separate audio tracks, or word alignment. Automatic participant count is omitted.
No private audio/text is uploaded and clicking Analyze never installs dependencies.

## Configure this Mac

From the repository root, reuse the verified project-local environment:

```sh
../Work/diarization/.venv/bin/python scripts/personal/setup_speakers.py \
  --runtime ../Work/diarization \
  --ffmpeg /opt/homebrew/bin/ffmpeg --ffprobe /opt/homebrew/bin/ffprobe
```

The script verifies Python 3.12, sherpa-onnx and sherpa-onnx-core 2.0.1, NumPy
2.2.6, exact public model SHA-256 hashes and working FFmpeg/ffprobe executables.
It writes absolute paths to
`~/Library/Application Support/com.autumncry.meetily.personal/speaker-runtime.json`.
The app invokes the configured venv interpreter with isolated Python mode and
direct process arguments. It uses its compiled-in worker source, so installed
app operation does not depend on a repository worker path. Keep the venv's
base Python installation, environment, models and configured FFmpeg binaries.
Do not move them without rerunning setup. Venv Python symlinks are intentionally
not resolved to the base interpreter.

For a new environment, use an installed Python 3.12 interpreter:

```sh
python3.12 scripts/personal/setup_speakers.py --install \
  --runtime ../Work/diarization \
  --ffmpeg /absolute/path/to/ffmpeg --ffprobe /absolute/path/to/ffprobe
```

Only this explicit `--install` command downloads dependencies and public model
weights. It does not require Hugging Face credentials. The app checks model and
configured FFmpeg hashes before each run; after a deliberate FFmpeg upgrade,
rerun setup to verify executables and refresh the configuration. Missing or
changed dependencies produce a visible repair instruction. Refresh readiness
after repair; a launch/import/decoding error remains visible and permits retry.
The local runtime is an external dependency of this personal build, not a
self-contained redistributable app.

## Results and edits

Open **Speakers** in the transcript panel. Analyze asynchronously; progress shows
the current phase and elapsed time rather than a fabricated percentage. Cancel
and normal app exit terminate the owned worker process group, including FFmpeg.
Only one job per meeting is allowed; different meetings may be analyzed
independently. No microphone or system capture is started by analysis.

Runs are stored transactionally in SQLite with meeting ID, source SHA-256,
original worker metadata, and immutable turns. The first successful run becomes
active. Later runs are saved separately and require **Apply selected result**.
The selector restores previous runs together with their names and merge history.
Cluster numbers have meaning only within their run.

Names are Unicode, up to 120 characters. **Merge voices** merges groups in the
selected run; **Undo last merge** restores the previous grouping. These human
corrections are independent overlays; raw turns and original names remain
recoverable. No time-boundary correction editor is provided in this iteration.
No transcript, audio, or summary is rewritten by speaker edits. The transcript
view and Markdown, DOCX and PDF export adapters share interval labeling: all
overlapping voices are shown as mixed/ambiguous; missing bounds and unassigned
gaps stay explicit. Text is never split on model boundaries. Turn timestamps
are listed for inspection; the existing meeting detail view has no playback
seek control to reuse.

If source audio changes during a run, validation fails and retains prior data.
Cancelled, unsuccessful, invalid or empty results never become saved runs.
App crashes can leave small temporary worker/result files under
`speaker-jobs`; they contain anonymous turn metadata only and are not active
results. Completed/cancelled jobs remove their own temporary directory.

## Model attribution and limitations

FP32 pyannote segmentation 3.0: MIT,
SHA-256 `220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079`.
Chinese CAMPPlus from 3D-Speaker: Apache-2.0,
SHA-256 `f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11`.
sherpa-onnx runtime: Apache-2.0. Public asset URLs are fixed in the setup script;
license texts are in `scripts/personal/speaker-licenses` and copied next to
the runtime models by setup.

The local experiment compared two-person intervals with Plaud-generated
reference labels; those are not human ground truth or an accuracy/DER benchmark.
Short speech, overlap, noisy/remote microphones, wrong participant counts and
three or more speakers remain unvalidated. Review anonymous grouping before
assigning names. The model cannot establish someone's identity.
