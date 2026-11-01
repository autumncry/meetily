use super::*;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicI32, Ordering},
        Arc, Mutex,
    },
};
use tauri::Manager;
use tokio::{process::Command, sync::Mutex as AsyncMutex};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Config {
    pub python: PathBuf,
    pub segmentation: PathBuf,
    pub embedding: PathBuf,
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
    pub ffmpeg_sha256: String,
    pub ffprobe_sha256: String,
}
#[derive(Clone, Default, Serialize)]
pub struct Status {
    pub state: String,
    pub message: String,
    pub elapsed_seconds: u64,
}
pub struct Job {
    pub status: AsyncMutex<Status>,
    cancel: CancellationToken,
    group: AtomicI32,
}
impl Job {
    fn new() -> Self {
        Self {
            status: AsyncMutex::new(Status {
                state: "running".into(),
                message: "Preparing local analysis…".into(),
                elapsed_seconds: 0,
            }),
            cancel: CancellationToken::new(),
            group: AtomicI32::new(0),
        }
    }
}
#[derive(Default)]
pub struct Jobs(Mutex<HashMap<String, Arc<Job>>>);
fn kill_group(id: i32) {
    #[cfg(unix)]
    if id > 0 {
        extern "C" {
            fn kill(pid: i32, signal: i32) -> i32;
        }
        // The child is launched in its own process group, including its FFmpeg children.
        unsafe {
            kill(-id, 9);
        }
    }
}
struct OwnedChild<'a> {
    child: tokio::process::Child,
    job: &'a Job,
}
impl Drop for OwnedChild<'_> {
    fn drop(&mut self) {
        kill_group(self.job.group.swap(0, Ordering::SeqCst));
        let _ = self.child.start_kill();
    }
}
async fn run_child(
    mut command: Command,
    output: &Path,
    progress: &Path,
    job: &Job,
) -> Result<Value, String> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.as_std_mut().process_group(0);
    }
    command
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if job.cancel.is_cancelled() {
        return Err("Analysis cancelled.".into());
    }
    let child = command.spawn().map_err(|_| {
        "Could not launch Python. Repair the speaker runtime with setup_speakers.py.".to_string()
    })?;
    job.group
        .store(child.id().unwrap_or(0) as i32, Ordering::SeqCst);
    let mut owned = OwnedChild { child, job };
    let started = std::time::Instant::now();
    let exit = loop {
        tokio::select! {
            _=job.cancel.cancelled()=>{return Err("Analysis cancelled.".into());},
            status=owned.child.wait()=>{break status.map_err(err)?;},
            _=tokio::time::sleep(std::time::Duration::from_millis(300))=>{
                if started.elapsed().as_secs()>7200 {return Err("Analysis timed out after two hours.".into());}
                let mut status=job.status.lock().await;
                status.elapsed_seconds=started.elapsed().as_secs();
                if let Ok(bytes)=tokio::fs::read(progress).await {
                    if let Ok(value)=serde_json::from_slice::<Value>(&bytes) {
                        if let Some(phase)=value["phase"].as_str() {status.message=phase.chars().take(120).collect();}
                    }
                }
            }
        }
    };
    // A crashed worker may leave its decoder alive. Stop any remaining members
    // of this owned group, then discard the group ID before publishing status.
    kill_group(job.group.swap(0, Ordering::SeqCst));
    if job.cancel.is_cancelled() {
        return Err("Analysis cancelled.".into());
    }
    if !exit.success() {
        return Err("Local speaker worker failed. Check audio and repair the Python/models configuration using setup_speakers.py.".into());
    }
    let size = tokio::fs::metadata(output)
        .await
        .map_err(|_| "Worker produced no result.")?
        .len();
    if size > 64 * 1024 * 1024 {
        return Err("Worker result exceeds 64 MiB.".into());
    }
    let bytes = tokio::fs::read(output).await.map_err(err)?;
    let raw: Value = serde_json::from_slice(&bytes).map_err(|_| "Worker produced invalid JSON.")?;
    Ok(raw)
}
pub fn hash_file(path: &Path) -> Result<String, String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).map_err(err)?;
    let mut h = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = f.read(&mut buf).map_err(err)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(format!("{:x}", h.finalize()))
}
impl Config {
    fn load(dir: &Path) -> Result<Self, String> {
        let bytes=std::fs::read(dir.join("speaker-runtime.json")).map_err(|_|"Speaker runtime is not configured. Run scripts/personal/setup_speakers.py once; see docs/personal-speakers-runtime.md.")?;
        let config: Self = serde_json::from_slice(&bytes)
            .map_err(|_| "Invalid speaker-runtime.json. Run setup_speakers.py to repair it.")?;
        for path in [
            &config.python,
            &config.segmentation,
            &config.embedding,
            &config.ffmpeg,
            &config.ffprobe,
        ] {
            if !path.is_absolute() || !path.is_file() {
                return Err("A configured Python, model or FFmpeg file is missing. Run setup_speakers.py to repair it.".into());
            }
        }
        Ok(config)
    }
    fn verify(&self) -> Result<(), String> {
        for (path, expected) in [
            (&self.segmentation, SEGMENTATION_HASH),
            (&self.embedding, EMBEDDING_HASH),
            (&self.ffmpeg, self.ffmpeg_sha256.as_str()),
            (&self.ffprobe, self.ffprobe_sha256.as_str()),
        ] {
            if hash_file(path)? != expected {
                return Err("A model or FFmpeg hash changed. Re-run setup_speakers.py after verifying local dependencies.".into());
            }
        }
        Ok(())
    }
}
async fn analyze(
    config: Config,
    audio: PathBuf,
    dir: PathBuf,
    count: u8,
    job: &Job,
) -> Result<(Value, String), String> {
    let audio_for_hash = audio.clone();
    let (config, hash) = tokio::task::spawn_blocking(move || {
        config.verify()?;
        let hash = hash_file(&audio_for_hash)?;
        Ok::<_, String>((config, hash))
    })
    .await
    .map_err(err)??;
    if job.cancel.is_cancelled() {
        return Err("Analysis cancelled.".into());
    }
    tokio::fs::create_dir_all(&dir).await.map_err(err)?;
    let worker = dir.join("worker.py");
    let output = dir.join("result.json");
    let progress = dir.join("progress.json");
    tokio::fs::write(
        &worker,
        include_str!("../../../../scripts/personal/run_diarization.py"),
    )
    .await
    .map_err(err)?;
    let mut command = Command::new(&config.python);
    command
        .arg("-I")
        .arg(&worker)
        .arg(&audio)
        .arg("--output")
        .arg(&output)
        .arg("--progress")
        .arg(&progress)
        .arg("--speakers")
        .arg(count.to_string())
        .arg("--segmentation")
        .arg(&config.segmentation)
        .arg("--embedding")
        .arg(&config.embedding)
        .arg("--ffmpeg")
        .arg(&config.ffmpeg)
        .arg("--ffprobe")
        .arg(&config.ffprobe);
    let raw = run_child(command, &output, &progress, job).await?;
    let after = tokio::task::spawn_blocking(move || hash_file(&audio))
        .await
        .map_err(err)??;
    if after != hash {
        return Err("Saved audio changed during analysis; previous results were retained.".into());
    }
    validate(&raw, &hash, count)?;
    Ok((raw, hash))
}
impl Jobs {
    pub fn shutdown(&self) {
        if let Ok(jobs) = self.0.lock() {
            for job in jobs.values() {
                job.cancel.cancel();
                kill_group(job.group.load(Ordering::SeqCst));
            }
        }
    }
    fn get(&self, meeting: &str) -> Option<Arc<Job>> {
        self.0.lock().ok()?.get(meeting).cloned()
    }
    fn reserve(&self, meeting: &str) -> Result<Arc<Job>, String> {
        let mut jobs = self.0.lock().map_err(err)?;
        if let Some(job) = jobs.get(meeting) {
            if job
                .status
                .try_lock()
                .map(|s| s.state == "running")
                .unwrap_or(true)
            {
                return Err("Speaker analysis is already running for this meeting.".into());
            }
        }
        let job = Arc::new(Job::new());
        jobs.insert(meeting.into(), job.clone());
        Ok(job)
    }
}
#[derive(Serialize)]
pub struct View {
    pub supported: bool,
    pub ready: bool,
    pub readiness: String,
    pub status: Status,
    pub snapshot: Snapshot,
}
#[tauri::command]
pub async fn speaker_view(app: tauri::AppHandle, meeting_id: String) -> Result<View, String> {
    let state = app.state::<crate::state::AppState>();
    let snapshot = snapshot(state.db_manager.pool(), &meeting_id).await?;
    let config = Config::load(&app.path().app_data_dir().map_err(err)?);
    let status = match app.state::<Jobs>().get(&meeting_id) {
        Some(job) => job.status.lock().await.clone(),
        None => Status::default(),
    };
    let supported = cfg!(all(feature = "personal-mac", target_os = "macos"));
    Ok(View {
        supported,
        ready: supported && config.is_ok(),
        readiness: config.err().unwrap_or_else(|| {
            "Local runtime configured; dependency hashes checked before every analysis.".into()
        }),
        status,
        snapshot,
    })
}
#[tauri::command]
pub async fn speaker_start(
    app: tauri::AppHandle,
    meeting_id: String,
    count: u8,
) -> Result<(), String> {
    if !cfg!(all(feature = "personal-mac", target_os = "macos")) {
        return Err("Speaker analysis is available only in the personal Mac build.".into());
    }
    if !(1..=12).contains(&count) {
        return Err("Participant count must be 1–12.".into());
    }
    if crate::audio::recording_commands::is_recording().await {
        return Err("Finish recording before analyzing speakers.".into());
    }
    let data = app.path().app_data_dir().map_err(err)?;
    let config = Config::load(&data)?;
    let pool = app
        .state::<crate::state::AppState>()
        .db_manager
        .pool()
        .clone();
    let folder: Option<String> = sqlx::query_scalar("SELECT folder_path FROM meetings WHERE id=?")
        .bind(&meeting_id)
        .fetch_optional(&pool)
        .await
        .map_err(err)?
        .flatten();
    let audio = crate::audio::retranscription::find_audio_file(Path::new(
        &folder.ok_or("This meeting has no saved audio folder.")?,
    ))
    .map_err(|_| "No saved audio found for this meeting.")?;
    let job = app.state::<Jobs>().reserve(&meeting_id)?;
    let dir = data
        .join("speaker-jobs")
        .join(uuid::Uuid::new_v4().to_string());
    tauri::async_runtime::spawn(async move {
        let result = analyze(config, audio, dir.clone(), count, &job).await;
        // Cancellation and commit share this lock: a cancelled job cannot commit later.
        let mut status = job.status.lock().await;
        let result = if job.cancel.is_cancelled() {
            Err("Analysis cancelled.".into())
        } else {
            match result {
                Ok((raw, hash)) => persist(&pool, &meeting_id, &raw, &hash, count)
                    .await
                    // persist validates that this count equals the unique raw IDs.
                    .map(|_| {
                        raw["validation"]["speaker_count"]
                            .as_u64()
                            .unwrap_or_default()
                    }),
                Err(e) => Err(e),
            }
        };
        match result {
            Ok(detected) => {
                status.state = "complete".into();
                status.message = if detected != count as u64 {
                    format!("Saved as an inactive preview: requested {count}, detected {detected}. The requested count is not guaranteed. Review this result before applying it; existing active labels are unchanged.")
                } else {
                    format!("Analysis saved: requested {count}, detected {detected}. Existing active results and names were retained; apply a new result explicitly.")
                };
            }
            Err(e) => {
                status.state = if job.cancel.is_cancelled() {
                    "cancelled"
                } else {
                    "error"
                }
                .into();
                status.message = e;
            }
        }
        drop(status);
        let _ = tokio::fs::remove_dir_all(dir).await;
    });
    Ok(())
}
#[tauri::command]
pub async fn speaker_cancel(app: tauri::AppHandle, meeting_id: String) -> Result<(), String> {
    if let Some(job) = app.state::<Jobs>().get(&meeting_id) {
        let mut status = job.status.lock().await;
        if status.state == "running" {
            job.cancel.cancel();
            status.message = "Cancelling local analysis…".into();
            kill_group(job.group.load(Ordering::SeqCst));
        }
    }
    Ok(())
}
#[tauri::command]
pub async fn speaker_edit(
    app: tauri::AppHandle,
    meeting_id: String,
    run_id: String,
    action: String,
    speaker: String,
    value: String,
) -> Result<Snapshot, String> {
    let state = app.state::<crate::state::AppState>();
    edit(
        state.db_manager.pool(),
        &meeting_id,
        &run_id,
        &action,
        &speaker,
        &value,
    )
    .await?;
    snapshot(state.db_manager.pool(), &meeting_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn failed_worker_cannot_leave_its_child_running() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("result.json");
        let leaked = dir.path().join("leaked-child");
        let mut command = Command::new("/usr/bin/python3");
        command.arg("-c").arg(
            "import subprocess,sys;subprocess.Popen([sys.executable,'-c',\"import time,sys;time.sleep(.4);open(sys.argv[1],'w').write('alive')\",sys.argv[1]]);sys.exit(1)"
        ).arg(&leaked);
        assert!(
            run_child(command, &output, &dir.path().join("progress"), &Job::new())
                .await
                .is_err()
        );
        tokio::time::sleep(std::time::Duration::from_millis(650)).await;
        assert!(
            !leaked.exists(),
            "The owned worker's descendant survived failure"
        );
    }
    #[tokio::test]
    async fn process_success_nonzero_and_cancel_are_distinct() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("result.json");
        let progress = dir.path().join("progress.json");
        let make = |script: &str| {
            let mut c = Command::new("/usr/bin/python3");
            c.arg("-c").arg(script).arg(&output);
            c
        };
        let script = "import sys,json;open(sys.argv[1],'w').write(json.dumps({'status':'ok'}))";
        assert_eq!(
            run_child(make(script), &output, &progress, &Job::new())
                .await
                .unwrap()["status"],
            "ok"
        );
        assert!(run_child(
            make(&(script.to_owned() + ";sys.exit(1)")),
            &output,
            &progress,
            &Job::new()
        )
        .await
        .is_err());
        let job = Arc::new(Job::new());
        let other = job.clone();
        let future = tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            other.cancel.cancel();
        });
        let now = std::time::Instant::now();
        let result = run_child(make("import time;time.sleep(60)"), &output, &progress, &job).await;
        future.await.unwrap();
        assert_eq!(result.unwrap_err(), "Analysis cancelled.");
        assert!(now.elapsed().as_secs() < 5);
        assert_eq!(job.group.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn same_meeting_guard_and_shutdown_terminate_owned_process() {
        let jobs = Jobs::default();
        let job = jobs.reserve("m").unwrap();
        assert!(jobs.reserve("m").is_err());
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("result");
        let progress = dir.path().join("progress");
        let other = job.clone();
        let task = tokio::spawn(async move {
            let mut command = Command::new("/usr/bin/python3");
            command.arg("-c").arg("import time;time.sleep(60)");
            run_child(command, &output, &progress, &other).await
        });
        for _ in 0..100 {
            if job.group.load(Ordering::SeqCst) > 0 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(job.group.load(Ordering::SeqCst) > 0);
        jobs.shutdown();
        assert_eq!(
            tokio::time::timeout(std::time::Duration::from_secs(3), task)
                .await
                .unwrap()
                .unwrap()
                .unwrap_err(),
            "Analysis cancelled."
        );
        assert_eq!(job.group.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn failed_cancelled_or_invalid_child_preserves_previous_data() {
        let pool = super::super::tests::db().await;
        let good = super::super::tests::output();
        let hash = "a".repeat(64);
        let first = persist(&pool, "m", &good, &hash, 2).await.unwrap();
        edit(&pool, "m", &first, "rename", "speaker-01", "保留名字")
            .await
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        for kind in ["exit", "invalid", "cancel"] {
            let output = dir.path().join(kind);
            let progress = dir.path().join("progress");
            let job = Job::new();
            let mut command = Command::new("/usr/bin/python3");
            command
                .arg("-c")
                .arg(match kind {
                    "exit" => "import sys;open(sys.argv[1],'w').write(sys.argv[2]);sys.exit(1)",
                    "invalid" => "import sys;open(sys.argv[1],'w').write('{}')",
                    _ => "import time;time.sleep(60)",
                })
                .arg(&output)
                .arg(good.to_string());
            if kind == "cancel" {
                job.cancel.cancel();
            }
            let result = match run_child(command, &output, &progress, &job).await {
                Ok(raw) => persist(&pool, "m", &raw, &hash, 2).await.map(|_| ()),
                Err(e) => Err(e),
            };
            assert!(result.is_err());
            let current = snapshot(&pool, "m").await.unwrap();
            assert_eq!(current.active_id, Some(first.clone()));
            assert_eq!(current.runs.len(), 1);
            assert_eq!(current.runs[0].overlay.names["speaker-01"], "保留名字");
        }
    }
    #[tokio::test]
    #[ignore = "Requires explicit local config, audio and output directory; never uses microphone or network"]
    async fn real_local_helper_e2e() {
        let config_dir =
            PathBuf::from(std::env::var("MEETILY_SPEAKER_TEST_CONFIG_DIR").expect("config dir"));
        let audio = PathBuf::from(std::env::var("MEETILY_SPEAKER_TEST_AUDIO").expect("audio"));
        let output =
            PathBuf::from(std::env::var("MEETILY_SPEAKER_TEST_OUTPUT_DIR").expect("output dir"));
        assert!(
            config_dir.is_absolute() && audio.is_absolute() && output.is_absolute(),
            "Use absolute paths: cargo tests run from the package directory."
        );
        tokio::fs::create_dir_all(&output).await.unwrap();
        let (raw, hash) = analyze(
            Config::load(&config_dir).unwrap(),
            audio,
            output.join("worker"),
            2,
            &Job::new(),
        )
        .await
        .unwrap();
        tokio::fs::write(
            output.join("native-result.json"),
            serde_json::to_vec_pretty(&raw).unwrap(),
        )
        .await
        .unwrap();
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                sqlx::sqlite::SqliteConnectOptions::new()
                    .filename(output.join("native-test.sqlite"))
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        sqlx::query("CREATE TABLE meetings(id TEXT PRIMARY KEY)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::raw_sql(include_str!(
            "../../migrations/20261031000000_speaker_runs.sql"
        ))
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO meetings VALUES ('native-e2e')")
            .execute(&pool)
            .await
            .unwrap();
        let id = persist(&pool, "native-e2e", &raw, &hash, 2).await.unwrap();
        edit(
            &pool,
            "native-e2e",
            &id,
            "rename",
            "speaker-01",
            "人工标注甲",
        )
        .await
        .unwrap();
        pool.close().await;
        let reopened = SqlitePool::connect_with(
            sqlx::sqlite::SqliteConnectOptions::new().filename(output.join("native-test.sqlite")),
        )
        .await
        .unwrap();
        let saved = snapshot(&reopened, "native-e2e").await.unwrap();
        assert_eq!(saved.active_id, Some(id));
        assert_eq!(saved.runs[0].overlay.names["speaker-01"], "人工标注甲");
        assert!(!saved.runs[0].turns.is_empty());
        tokio::fs::write(
            output.join("native-snapshot.json"),
            serde_json::to_vec_pretty(&saved).unwrap(),
        )
        .await
        .unwrap();
        println!(
            "Native helper persisted and reloaded {} turns, duration {:.2}s",
            saved.runs[0].turns.len(),
            saved.runs[0].duration
        );
    }
}
