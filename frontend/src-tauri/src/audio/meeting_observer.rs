//! Stateless, read-only CoreAudio process queries. No taps, capture, listeners or owned threads.
use serde::Serialize;

#[derive(Debug, Clone)]
struct ProcessActivity {
    pid: u32,
    bundle_id: String,
    input_active: bool,
    output_active: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppAudioActivity {
    bundle_id: String,
    pids: Vec<u32>,
    input_active: bool,
    output_active: bool,
}

// Only explicitly attributable helpers are included. Shared WebKit processes are ambiguous.
fn parent_bundle(bundle: &str) -> Option<&str> {
    match bundle {
        "com.electron.lark" | "com.electron.lark.helper" | "com.electron.lark.helper.Renderer"
        | "com.electron.lark.helper.GPU" | "com.electron.lark.helper.Plugin" => Some("com.electron.lark"),
        "com.google.Chrome" | "com.google.Chrome.helper" | "com.google.Chrome.helper.renderer"
        | "com.google.Chrome.helper.GPU" | "com.google.Chrome.helper.plugin" => Some("com.google.Chrome"),
        "com.alibaba.DingTalkMac" => Some("com.alibaba.DingTalkMac"),
        "com.tencent.xinWeChat" => Some("com.tencent.xinWeChat"),
        "com.apple.Safari" => Some("com.apple.Safari"),
        _ => None,
    }
}

fn aggregate(processes: Vec<ProcessActivity>, allowed: &[String], self_pid: u32, self_bundle: &str) -> Vec<AppAudioActivity> {
    let mut apps = std::collections::BTreeMap::<String, AppAudioActivity>::new();
    for process in processes {
        if process.pid == self_pid || process.bundle_id == self_bundle { continue; }
        let Some(parent) = parent_bundle(&process.bundle_id) else { continue; };
        if parent == self_bundle || !allowed.iter().any(|id| id == parent) { continue; }
        let app = apps.entry(parent.into()).or_insert_with(|| AppAudioActivity {
            bundle_id: parent.into(), pids: vec![], input_active: false, output_active: false,
        });
        app.pids.push(process.pid);
        app.input_active |= process.input_active;
        app.output_active |= process.output_active;
    }
    apps.into_values().map(|mut app| { app.pids.sort_unstable(); app.pids.dedup(); app }).collect()
}

#[cfg(target_os = "macos")]
fn snapshot(allowed: &[String], self_bundle: &str) -> Result<Vec<AppAudioActivity>, String> {
    use cidre::core_audio::System;
    let query_error = |error| format!("CoreAudio process activity is unavailable: {error:?}");
    let processes = System::processes().map_err(query_error)?;
    let mut observed = Vec::new();
    for process in processes {
        let pid = process.pid().map_err(query_error)? as u32;
        if pid == std::process::id() { continue; }
        let bundle_id = process.bundle_id().map_err(query_error)?.to_string();
        let Some(parent) = parent_bundle(&bundle_id) else { continue; };
        if bundle_id == self_bundle || parent == self_bundle || !allowed.iter().any(|id| id == parent) { continue; }
        // Any failed selected-app query makes this entire observation unknown.
        observed.push(ProcessActivity {
            pid, bundle_id,
            input_active: process.is_running_input().map_err(query_error)?,
            output_active: process.is_running_output().map_err(query_error)?,
        });
    }
    Ok(aggregate(observed, allowed, std::process::id(), self_bundle))
}

#[tauri::command]
pub async fn get_meeting_audio_snapshot(app: tauri::AppHandle, allowed_bundle_ids: Vec<String>) -> Result<Vec<AppAudioActivity>, String> {
    #[cfg(target_os = "macos")]
    {
        let self_bundle = app.config().identifier.clone();
        // A finite read-only query runs off the UI thread. No listener or monitor is installed.
        tauri::async_runtime::spawn_blocking(move || snapshot(&allowed_bundle_ids, &self_bundle))
            .await.map_err(|e| format!("Audio activity query failed: {e}"))?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, allowed_bundle_ids);
        Err("Meeting detection requires macOS".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn process(pid: u32, bundle: &str, input: bool, output: bool) -> ProcessActivity {
        ProcessActivity { pid, bundle_id: bundle.into(), input_active: input, output_active: output }
    }
    #[test]
    fn aggregates_explicit_helpers_and_filters_unselected_unknown_and_self() {
        let apps = aggregate(vec![
            process(10, "com.electron.lark", true, false),
            process(11, "com.electron.lark.helper.Renderer", false, true),
            process(12, "com.electron.lark.evil", false, true),
            process(13, "com.google.Chrome", true, true),
            process(14, "unrecognized.app", true, true),
            process(99, "com.electron.lark", true, true),
        ], &["com.electron.lark".into(), "unrecognized.app".into()], 99, "com.autumncry.meetily.personal");
        assert_eq!(apps, vec![AppAudioActivity {
            bundle_id: "com.electron.lark".into(), pids: vec![10, 11], input_active: true, output_active: true,
        }]);
    }
    #[test]
    fn self_bundle_is_excluded_even_when_selected() {
        assert!(aggregate(vec![process(1, "com.electron.lark", true, true)], &["com.electron.lark".into()], 2, "com.electron.lark").is_empty());
    }
    #[test]
    fn shared_webkit_helpers_cannot_be_attributed_to_safari() {
        let apps = aggregate(vec![process(1, "com.apple.Safari", false, true), process(2, "com.apple.WebKit.WebContent", true, false)], &["com.apple.Safari".into()], 99, "self");
        assert_eq!(apps.len(), 1);
        assert!(!apps[0].input_active);
        assert!(apps[0].output_active);
    }
}
