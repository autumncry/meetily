# Build and use Meetily Personal

This fork targets this Apple Silicon Mac. Keep the repository in the `Code`
directory of the Meetily project; `Work` holds optional local tools/caches and
`Builds` receives the installable app. These parent folders remain outside Git.

Run from the repository root:

```sh
./script/build_and_run.sh --build-only # release app, no launch or process changes
./script/build_and_run.sh              # build and launch the personal app
./script/build_and_run.sh --verify     # also check its bundle ID is running
./script/build_and_run.sh --build-only --debug-build # faster debug packaging
```

The Codex Run action invokes the same script. It uses local Rust/CMake tools
under `../Work` when present and ordinary installed tools otherwise. It requires
Node, npx (or pnpm 9.15.9), an arm64 Rust toolchain,
CMake and Xcode command-line tools. Install frontend dependencies once with
`pnpm install --frozen-lockfile` in `frontend`. The script builds the local
`llama-helper` sidecar with Metal and lets Tauri build/bundle FFmpeg. Cargo/npm or
first-time FFmpeg/ONNX dependencies may need network access; it never installs
tools globally or downloads inference models. Subsequent builds reuse caches.

The committed profile is `frontend/src-tauri/tauri.personal.conf.json`. It sets
`Meetily Personal`, bundle ID `com.autumncry.meetily.personal`, and the
`personal-mac` Cargo feature. Use this profile through the script, not upstream
clean-build scripts that erase caches or install global dependencies. The profile
disables updater artifacts/endpoints; the personal native build omits the updater
plugin and the UI update service skips upstream requests. Update this app by
rebuilding the fork. The upstream profile remains available separately.

`../Builds/Meetily Personal.app` is copied with `ditto` and verified with
`codesign --verify --deep --strict`, preserving Tauri's ad-hoc signatures and
entitlements. It is a local Mac build, not a notarized distribution. Default Run
quits only `com.autumncry.meetily.personal`; it does not kill by the shared
`meetily` executable name. `--build-only` never launches or quits an app.

The bundle ID isolates the app's database, stores and model directory from the
official application. Fresh personal recordings/imports use
`~/Movies/meetily-personal-recordings` (Documents fallback); official
`meetily-recordings` directories and existing user preferences are preserved,
without moving/deleting recordings. Existing personal preferences pointing at a
custom or old directory are kept. A non-personal build keeps the upstream default.

On first launch, choose **Configure models later — open without downloading**
to inspect/export existing meetings or configure Settings without downloading
Parakeet or a built-in summary model. Missing models remain not ready and
recording still requires an installed transcription model. For Chinese, select
multilingual **Whisper** in Settings (the fresh personal default is
`large-v3-turbo`); choose/download the desired size yourself. Parakeet does not
support Chinese. The alternative onboarding button explicitly downloads
Parakeet plus the recommended summary model. Custom summary API settings remain
available, and deferring setup preserves existing summary-provider settings.

Microphone/system-audio permissions are requested through the existing recording
flow when needed. The configure-later path does not grant permissions or imply
that a real recording was tested.

Optional post-meeting speaker analysis uses a separately configured local Python
and ONNX runtime. Follow [speaker setup and repair](personal-speakers-runtime.md)
once, then open **Speakers** in a saved meeting's transcript panel. Analyze never
downloads dependencies and requires an explicit participant count.
