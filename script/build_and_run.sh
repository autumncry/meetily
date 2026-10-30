#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_DIR="$(cd "$ROOT_DIR/.." && pwd)"
WORK_DIR="$PROJECT_DIR/Work"
BUILD_DIR="$PROJECT_DIR/Builds"
APP_NAME="Meetily Personal"
BUNDLE_ID="com.autumncry.meetily.personal"
APP_BUNDLE="$BUILD_DIR/$APP_NAME.app"
MODE=run
PROFILE=release

usage() {
  echo "Usage: $0 [--build-only|--launch|--verify] [--debug-build]"
  echo "Builds the personal Apple Silicon app into ../Builds; default builds and launches."
}
for arg in "$@"; do
  case "$arg" in
    --build-only) MODE=build-only ;;
    --launch) MODE=run ;;
    --verify) MODE=verify ;;
    --debug-build) PROFILE=debug ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo "This personal profile supports Apple Silicon macOS only." >&2
  exit 1
fi

# Reuse project-local tools/caches when available. Never install global tools.
if [[ -x "$WORK_DIR/cargo/bin/cargo" && -d "$WORK_DIR/rustup" ]]; then
  export CARGO_HOME="$WORK_DIR/cargo"
  export RUSTUP_HOME="$WORK_DIR/rustup"
  export PATH="$WORK_DIR/cargo/bin:$PATH"
fi
if [[ -x "$WORK_DIR/build-tools/bin/cmake" ]]; then
  export PATH="$WORK_DIR/build-tools/bin:$PATH"
fi
if [[ -d "$WORK_DIR/target" ]]; then
  export CARGO_TARGET_DIR="$WORK_DIR/target"
fi
if [[ -d "$WORK_DIR/npm-cache" ]]; then
  export npm_config_cache="$WORK_DIR/npm-cache"
fi
export NEXT_TELEMETRY_DISABLED=1
for tool in cargo cmake node; do
  command -v "$tool" >/dev/null || { echo "Missing $tool. Install it or provide project-local tools under ../Work." >&2; exit 1; }
done
if command -v npx >/dev/null; then
  # Pinned package runner; uses the local npm cache when present, no global install.
  PNPM=(npx --yes pnpm@9.15.9)
elif command -v pnpm >/dev/null && [[ "$(pnpm --version)" == 9.15.9 ]]; then
  PNPM=(pnpm)
else
  echo "Provide npx or pnpm 9.15.9; the build will not replace dependencies with a different pnpm version." >&2; exit 1
fi
if [[ ! -d "$ROOT_DIR/frontend/node_modules" ]]; then
  echo "Frontend dependencies are missing. Run pnpm install --frozen-lockfile in frontend first." >&2
  exit 1
fi

TARGET_ROOT="${CARGO_TARGET_DIR:-$ROOT_DIR/frontend/src-tauri/target}"
if [[ "$TARGET_ROOT" != /* ]]; then
  # Cargo resolves a relative target path from its working directory below.
  TARGET_ROOT="$ROOT_DIR/frontend/$TARGET_ROOT"
fi
export CARGO_TARGET_DIR="$TARGET_ROOT"
HOST_TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
[[ "$HOST_TRIPLE" == aarch64-apple-darwin ]] || { echo "Expected arm64 Rust toolchain, found $HOST_TRIPLE" >&2; exit 1; }

# Build/reuse the real sidecar through Cargo's incremental cache. Do not reuse an
# arbitrary stale app bundle or require a globally installed helper.
cd "$ROOT_DIR/frontend"
cargo build --locked --release --manifest-path "$ROOT_DIR/llama-helper/Cargo.toml" --features metal
mkdir -p "$ROOT_DIR/frontend/src-tauri/binaries"
cp "$TARGET_ROOT/release/llama-helper" "$ROOT_DIR/frontend/src-tauri/binaries/llama-helper-$HOST_TRIPLE"

TAURI_ARGS=(build --bundles app --config src-tauri/tauri.personal.conf.json)
if [[ "$PROFILE" == debug ]]; then TAURI_ARGS+=(--debug); fi
"${PNPM[@]}" exec tauri "${TAURI_ARGS[@]}"

SOURCE_APP="$TARGET_ROOT/$PROFILE/bundle/macos/$APP_NAME.app"
[[ -d "$SOURCE_APP" ]] || { echo "Missing expected app: $SOURCE_APP" >&2; exit 1; }
verify_identity() {
  local actual_id
  actual_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$1/Contents/Info.plist")"
  [[ "$actual_id" == "$BUNDLE_ID" ]] || { echo "Refusing non-personal bundle: $1 ($actual_id)" >&2; return 1; }
  /usr/bin/codesign --verify --deep --strict "$1"
}
verify_identity "$SOURCE_APP"
mkdir -p "$BUILD_DIR"
STAGE_DIR="$(mktemp -d "$BUILD_DIR/.personal-build.XXXXXX")"
cleanup() {
  if [[ -d "$STAGE_DIR/previous.app" && ! -e "$APP_BUNDLE" ]]; then
    mv "$STAGE_DIR/previous.app" "$APP_BUNDLE"
  fi
  rm -rf "$STAGE_DIR"
}
trap cleanup EXIT
/usr/bin/ditto "$SOURCE_APP" "$STAGE_DIR/$APP_NAME.app"
verify_identity "$STAGE_DIR/$APP_NAME.app"
if [[ -e "$APP_BUNDLE" ]]; then
  verify_identity "$APP_BUNDLE"
  mv "$APP_BUNDLE" "$STAGE_DIR/previous.app"
fi
mv "$STAGE_DIR/$APP_NAME.app" "$APP_BUNDLE"
echo "Built ($PROFILE): $APP_BUNDLE"
if [[ "$MODE" == build-only ]]; then exit 0; fi

# Quit only our registered bundle ID. Never pkill the shared `meetily` process
# name, which could terminate the official application or another checkout.
/usr/bin/osascript -e 'if application id "com.autumncry.meetily.personal" is running then tell application id "com.autumncry.meetily.personal" to quit'
for attempt in {1..50}; do
  RUNNING="$(/usr/bin/osascript -e 'application id "com.autumncry.meetily.personal" is running')"
  [[ "$RUNNING" == false ]] && break
  sleep 0.1
done
[[ "$RUNNING" == false ]] || { echo "Personal app did not quit; close it and rerun. No process was force-killed." >&2; exit 1; }
/usr/bin/open -n "$APP_BUNDLE"
if [[ "$MODE" == verify ]]; then
  sleep 2
  [[ "$(/usr/bin/osascript -e 'application id "com.autumncry.meetily.personal" is running')" == true ]]
  echo "Meetily Personal is running (UI/permissions still need manual validation)."
fi
