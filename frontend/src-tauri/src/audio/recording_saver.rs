use std::sync::{Arc, Mutex};
use tokio::sync::Mutex as AsyncMutex;
use anyhow::Result;
use log::{info, warn, error};
use tauri::{AppHandle, Runtime, Emitter};
use tokio::sync::mpsc;
use serde::{Serialize, Deserialize};
use std::path::PathBuf;

use super::recording_state::AudioChunk;
use super::audio_processing::create_meeting_folder;
use super::incremental_saver::IncrementalAudioSaver;

/// Structured transcript segment for JSON export
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptSegment {
    pub id: String,
    pub text: String,
    pub audio_start_time: f64, // Seconds from recording start
    pub audio_end_time: f64,   // Seconds from recording start
    pub duration: f64,          // Segment duration in seconds
    pub display_time: String,   // Formatted time for display like "[02:15]"
    pub confidence: f32,
    pub sequence_id: u64,
}

/// Meeting metadata structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingMetadata {
    pub version: String,
    pub meeting_id: Option<String>,
    pub meeting_name: Option<String>,
    pub created_at: String,
    pub completed_at: Option<String>,
    pub duration_seconds: Option<f64>,
    pub devices: DeviceInfo,
    pub audio_file: String,
    pub transcript_file: String,
    pub sample_rate: u32,
    pub status: String,  // "recording", "completed", "error"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceInfo {
    pub microphone: Option<String>,
    pub system_audio: Option<String>,
}

/// New recording saver using incremental saving strategy
pub struct RecordingSaver {
    incremental_saver: Option<Arc<AsyncMutex<IncrementalAudioSaver>>>,
    meeting_folder: Option<PathBuf>,
    finalized_audio_path: Option<PathBuf>,
    meeting_name: Option<String>,
    metadata: Option<MeetingMetadata>,
    transcript_segments: Arc<Mutex<Vec<TranscriptSegment>>>,
    is_saving: Arc<Mutex<bool>>,
}

impl RecordingSaver {
    pub fn new() -> Self {
        Self {
            incremental_saver: None,
            meeting_folder: None,
            finalized_audio_path: None,
            meeting_name: None,
            metadata: None,
            transcript_segments: Arc::new(Mutex::new(Vec::new())),
            is_saving: Arc::new(Mutex::new(false)),
        }
    }

    /// Set the meeting name for this recording session
    pub fn set_meeting_name(&mut self, name: Option<String>) {
        self.meeting_name = name;
    }

    /// Set device information in metadata
    pub fn set_device_info(&mut self, mic_name: Option<String>, sys_name: Option<String>) {
        if let Some(ref mut metadata) = self.metadata {
            metadata.devices.microphone = mic_name;
            metadata.devices.system_audio = sys_name;

            // Write updated metadata to disk if folder exists
            if let Some(folder) = &self.meeting_folder {
                let metadata_clone = metadata.clone();
                if let Err(e) = self.write_metadata(folder, &metadata_clone) {
                    warn!("Failed to update metadata with device info: {}", e);
                }
            }
        }
    }

    /// Add or update a structured transcript segment (upserts based on sequence_id)
    /// Also saves incrementally to disk
    pub fn add_transcript_segment(&self, segment: TranscriptSegment) {
        if let Ok(mut segments) = self.transcript_segments.lock() {
            // Check if segment with same sequence_id exists (update it)
            if let Some(existing) = segments.iter_mut().find(|s| s.sequence_id == segment.sequence_id) {
                *existing = segment.clone();
                info!("Updated transcript segment {} (seq: {}) - total segments: {}",
                      segment.id, segment.sequence_id, segments.len());
            } else {
                // New segment, add it
                segments.push(segment.clone());
                info!("Added new transcript segment {} (seq: {}) - total segments: {}",
                      segment.id, segment.sequence_id, segments.len());
            }
        } else {
            error!("Failed to lock transcript segments for adding segment {}", segment.id);
        }

        // NEW: Save incrementally to disk
        if let Some(folder) = &self.meeting_folder {
            if let Err(e) = self.write_transcripts_json(folder) {
                warn!("Failed to write incremental transcript update: {}", e);
            }
        }
    }

    /// Legacy method for backward compatibility - converts text to basic segment
    pub fn add_transcript_chunk(&self, text: String) {
        let segment = TranscriptSegment {
            id: format!("seg_{}", chrono::Utc::now().timestamp_millis()),
            text,
            audio_start_time: 0.0,
            audio_end_time: 0.0,
            duration: 0.0,
            display_time: "[00:00]".to_string(),
            confidence: 1.0,
            sequence_id: 0,
        };
        self.add_transcript_segment(segment);
    }

    /// Start accumulation with optional incremental saving
    ///
    /// # Arguments
    /// * `auto_save` - If true, creates checkpoints and enables saving. If false, audio chunks are discarded.
    pub fn start_accumulation(
        &mut self,
        auto_save: bool,
        mut receiver: mpsc::UnboundedReceiver<AudioChunk>,
    ) {
        if auto_save {
            info!("Initializing incremental audio saver for recording (auto-save ENABLED)");
        } else {
            info!("Starting recording without audio saving (auto-save DISABLED - transcripts only)");
        }

        // Initialize meeting folder and incremental saver ONLY if auto_save is enabled
        if auto_save {
            if let Some(name) = self.meeting_name.clone() {
                match self.initialize_meeting_folder(&name, true) {
                    Ok(()) => info!("Successfully initialized meeting folder with checkpoints"),
                    Err(e) => {
                        error!("Failed to initialize meeting folder: {}", e);
                        // Continue anyway - will use fallback flat structure
                    }
                }
            }
        } else {
            // When auto_save is false, still create meeting folder for transcripts/metadata
            // but skip .checkpoints directory
            if let Some(name) = self.meeting_name.clone() {
                match self.initialize_meeting_folder(&name, false) {
                    Ok(()) => info!("Successfully initialized meeting folder (transcripts only)"),
                    Err(e) => {
                        error!("Failed to initialize meeting folder: {}", e);
                    }
                }
            }
        }

        // Start accumulation task
        let is_saving_clone = self.is_saving.clone();
        let incremental_saver_arc = self.incremental_saver.clone();
        let save_audio = auto_save;

        tokio::spawn(async move {
            info!("Recording saver accumulation task started (save_audio: {})", save_audio);

            while let Some(chunk) = receiver.recv().await {
                // Check if we should continue
                let should_continue = if let Ok(is_saving) = is_saving_clone.lock() {
                    *is_saving
                } else {
                    false
                };

                if !should_continue {
                    break;
                }

                // Only process audio chunks if auto_save is enabled
                if save_audio {
                    // Add chunk to incremental saver
                    if let Some(saver_arc) = &incremental_saver_arc {
                        let mut saver_guard = saver_arc.lock().await;
                        if let Err(e) = saver_guard.add_chunk(chunk) {
                            error!("Failed to add chunk to incremental saver: {}", e);
                        }
                    } else {
                        error!("Incremental saver not available while accumulating");
                    }
                } else {
                    // auto_save is false: discard audio chunk (no-op)
                    // Transcription already happened in the pipeline before this point
                }
            }

            info!("Recording saver accumulation task ended");
        });

        // Set saving flag
        if let Ok(mut is_saving) = self.is_saving.lock() {
            *is_saving = true;
        }
    }

    /// Initialize meeting folder structure and metadata
    ///
    /// # Arguments
    /// * `meeting_name` - Name of the meeting
    /// * `create_checkpoints` - Whether to create .checkpoints/ directory and IncrementalAudioSaver
    fn initialize_meeting_folder(&mut self, meeting_name: &str, create_checkpoints: bool) -> Result<()> {
        // Load preferences to get base recordings folder
        let base_folder = super::recording_preferences::get_default_recordings_folder();

        // Create meeting folder structure (with or without .checkpoints/ subdirectory)
        let meeting_folder = create_meeting_folder(&base_folder, meeting_name, create_checkpoints)?;

        // Only initialize incremental saver if checkpoints are needed (auto_save is true)
        if create_checkpoints {
            let incremental_saver = IncrementalAudioSaver::new(meeting_folder.clone(), 48000)?;
            self.incremental_saver = Some(Arc::new(AsyncMutex::new(incremental_saver)));
            info!("✅ Incremental audio saver initialized for meeting: {}", meeting_name);
        } else {
            info!("⚠️  Skipped incremental audio saver (auto-save disabled)");
        }

        // Create initial metadata
        let metadata = MeetingMetadata {
            version: "1.0".to_string(),
            meeting_id: None,  // Will be set by backend
            meeting_name: Some(meeting_name.to_string()),
            created_at: chrono::Utc::now().to_rfc3339(),
            completed_at: None,
            duration_seconds: None,
            devices: DeviceInfo {
                microphone: None,  // Could be enhanced to store actual device names
                system_audio: None,
            },
            audio_file: if create_checkpoints { "audio.mp4".to_string() } else { "".to_string() },
            transcript_file: "transcripts.json".to_string(),
            sample_rate: 48000,
            status: "recording".to_string(),
        };

        // Write initial metadata.json
        self.write_metadata(&meeting_folder, &metadata)?;

        self.finalized_audio_path = None;
        self.meeting_folder = Some(meeting_folder);
        self.metadata = Some(metadata);

        Ok(())
    }

    /// Write metadata.json to disk (atomic write with temp file)
    fn write_metadata(&self, folder: &PathBuf, metadata: &MeetingMetadata) -> Result<()> {
        let metadata_path = folder.join("metadata.json");
        let temp_path = folder.join(".metadata.json.tmp");

        let json_string = serde_json::to_string_pretty(metadata)?;
        std::fs::write(&temp_path, json_string)?;
        std::fs::rename(&temp_path, &metadata_path)?;  // Atomic

        Ok(())
    }

    /// Write transcripts.json to disk (atomic write with temp file and validation)
    fn write_transcripts_json(&self, folder: &PathBuf) -> Result<()> {
        // Clone segments to avoid holding lock during I/O
        let segments_clone = if let Ok(segments) = self.transcript_segments.lock() {
            segments.clone()
        } else {
            error!("Failed to lock transcript segments for writing");
            return Err(anyhow::anyhow!("Failed to lock transcript segments"));
        };

        info!("Writing {} transcript segments to JSON", segments_clone.len());

        let transcript_path = folder.join("transcripts.json");
        let temp_path = folder.join(".transcripts.json.tmp");

        // Create JSON structure
        let json = serde_json::json!({
            "version": "1.0",
            "segments": segments_clone,
            "last_updated": chrono::Utc::now().to_rfc3339(),
            "total_segments": segments_clone.len()
        });

        // Serialize to pretty JSON string
        let json_string = serde_json::to_string_pretty(&json)
            .map_err(|e| {
                error!("Failed to serialize transcripts to JSON: {}", e);
                anyhow::anyhow!("JSON serialization failed: {}", e)
            })?;

        // Write to temp file with error handling
        std::fs::write(&temp_path, &json_string)
            .map_err(|e| {
                error!("Failed to write transcript temp file to {}: {}", temp_path.display(), e);
                anyhow::anyhow!("Failed to write temp file: {}", e)
            })?;

        // Verify temp file was written correctly
        if !temp_path.exists() {
            error!("Temp transcript file does not exist after write: {}", temp_path.display());
            return Err(anyhow::anyhow!("Temp file verification failed"));
        }

        // Atomic rename
        std::fs::rename(&temp_path, &transcript_path)
            .map_err(|e| {
                error!("Failed to rename transcript file from {} to {}: {}",
                       temp_path.display(), transcript_path.display(), e);
                anyhow::anyhow!("Failed to rename transcript file: {}", e)
            })?;

        info!("✅ Successfully wrote transcripts.json with {} segments", segments_clone.len());
        Ok(())
    }

    // in frontend/src-tauri/src/audio/recording_saver.rs
    pub fn get_stats(&self) -> (usize, u32) {
        if let Some(ref saver) = self.incremental_saver {
            if let Ok(guard) = saver.try_lock() {
                (guard.get_checkpoint_count() as usize, 48000)
            } else {
                (0, 48000)
            }
        } else {
            (0, 48000)
        }
    }

    /// Stop and save using incremental saving approach
    ///
    /// # Arguments
    /// * `app` - Tauri app handle for emitting events
    pub async fn stop_and_save<R: Runtime>(
        &mut self,
        app: &AppHandle<R>,
    ) -> Result<Option<String>, String> {
        info!("Stopping recording saver");

        // Stop accumulation
        if let Ok(mut is_saving) = self.is_saving.lock() {
            *is_saving = false;
        }

        // Give time for final chunks
        tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;

        // Finalize audio once. Transcript-only sessions still need completed metadata.
        let final_audio_path = if let Some(path) = &self.finalized_audio_path {
            // Checkpoints are removed after success. A retry or late ASR flush
            // must reuse the saved audio instead of attempting to merge it again.
            Some(path.clone())
        } else if let Some(saver_arc) = &self.incremental_saver {
            let mut saver = saver_arc.lock().await;
            match saver.finalize().await {
                Ok(path) => {
                    info!("✅ Successfully finalized audio: {}", path.display());
                    self.finalized_audio_path = Some(path.clone());
                    Some(path)
                }
                Err(e) => {
                    error!("❌ Failed to finalize incremental saver: {}", e);
                    return Err(format!("Failed to finalize audio: {}", e));
                }
            }
        } else {
            info!("No audio saver initialized - finalizing transcripts and metadata only");
            None
        };

        // Save final transcripts.json with validation
        if let Some(folder) = &self.meeting_folder {
            if let Err(e) = self.write_transcripts_json(folder) {
                error!("❌ Failed to write final transcripts: {}", e);
                return Err(format!("Failed to save transcripts: {}", e));
            }

            // Verify transcripts were written correctly
            let transcript_path = folder.join("transcripts.json");
            if !transcript_path.exists() {
                error!("❌ Transcript file was not created at: {}", transcript_path.display());
                return Err("Transcript file verification failed".to_string());
            }
            info!("✅ Transcripts saved and verified at: {}", transcript_path.display());
        }

        // Update metadata to completed status with actual recording duration
        if let (Some(folder), Some(mut metadata)) = (&self.meeting_folder, self.metadata.clone()) {
            metadata.status = "completed".to_string();
            metadata.completed_at.get_or_insert_with(|| chrono::Utc::now().to_rfc3339());

            // The stop command clears RecordingState before saving. ASR end times
            // describe speech coverage, while the finalized file also contains silence
            // and AAC/concat timing. Read the actual saved audio without decoding it.
            // Without saved audio, leave duration unknown rather than substitute
            // wall-clock time or speech coverage for playable recording duration.
            metadata.duration_seconds = final_audio_path.as_ref()
                .map(|path| super::import::extract_duration_from_metadata(path))
                .transpose()
                .map_err(|e| format!("Failed to read finalized audio duration: {}", e))?;

            if let Err(e) = self.write_metadata(folder, &metadata) {
                error!("❌ Failed to update metadata to completed: {}", e);
                return Err(format!("Failed to update metadata: {}", e));
            }

            info!("✅ Metadata updated with duration: {:?}s", metadata.duration_seconds);
            self.metadata = Some(metadata);
        }

        // Emit the existing audio-save event only when audio was saved.
        if let Some(final_audio_path) = &final_audio_path {
            let save_event = serde_json::json!({
                "audio_file": final_audio_path.to_string_lossy(),
                "transcript_file": self.meeting_folder.as_ref()
                    .map(|f| f.join("transcripts.json").to_string_lossy().to_string()),
                "meeting_name": self.meeting_name,
                "meeting_folder": self.meeting_folder.as_ref()
                    .map(|f| f.to_string_lossy().to_string())
            });

            if let Err(e) = app.emit("recording-saved", &save_event) {
                warn!("Failed to emit recording-saved event: {}", e);
            }
        }

        // Retain segments until this saver is dropped. Late ASR updates and
        // repeated saves must preserve the already written transcript segments.

        Ok(final_audio_path.map(|path| path.to_string_lossy().to_string()))
    }

    /// Get the meeting folder path (for passing to backend)
    pub fn get_meeting_folder(&self) -> Option<&PathBuf> {
        self.meeting_folder.as_ref()
    }

    /// Get accumulated transcript segments (for reload sync)
    pub fn get_transcript_segments(&self) -> Vec<TranscriptSegment> {
        if let Ok(segments) = self.transcript_segments.lock() {
            segments.clone()
        } else {
            Vec::new()
        }
    }

    /// Get meeting name (for reload sync)
    pub fn get_meeting_name(&self) -> Option<String> {
        self.meeting_name.clone()
    }
}

impl Default for RecordingSaver {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::super::recording_state::{DeviceType, RecordingState};
    use super::*;
    use tauri::test::{mock_builder, mock_context, noop_assets};
    use tempfile::TempDir;

    fn synthetic_saver() -> (TempDir, RecordingSaver) {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().to_path_buf();
        std::fs::create_dir(folder.join(".checkpoints")).unwrap();
        let mut saver = RecordingSaver::new();
        saver.meeting_folder = Some(folder.clone());
        saver.metadata = Some(MeetingMetadata {
            version: "1.0".into(),
            meeting_id: None,
            meeting_name: Some("Synthetic duration regression".into()),
            created_at: chrono::Utc::now().to_rfc3339(),
            completed_at: None,
            duration_seconds: None,
            devices: DeviceInfo {
                microphone: None,
                system_audio: None,
            },
            audio_file: "audio.mp4".into(),
            transcript_file: "transcripts.json".into(),
            sample_rate: 48000,
            status: "recording".into(),
        });
        saver.incremental_saver = Some(Arc::new(AsyncMutex::new(
            IncrementalAudioSaver::new(folder, 48000).unwrap(),
        )));
        saver
            .write_metadata(&dir.path().to_path_buf(), saver.metadata.as_ref().unwrap())
            .unwrap();
        (dir, saver)
    }

    fn segment(end: f64) -> TranscriptSegment {
        TranscriptSegment {
            id: "synthetic".into(),
            text: "Synthetic speech".into(),
            audio_start_time: 0.0,
            audio_end_time: end,
            duration: end,
            display_time: "[00:00]".into(),
            confidence: 1.0,
            sequence_id: 0,
        }
    }

    async fn add_synthetic_audio(saver: &RecordingSaver, samples: usize) {
        // A brief tone followed by silence; the file duration includes the quiet tail.
        let data = (0..samples)
            .map(|i| {
                if i < 24000 {
                    (i as f32 * 0.0576).sin() * 0.1
                } else {
                    0.0
                }
            })
            .collect();
        saver
            .incremental_saver
            .as_ref()
            .unwrap()
            .lock()
            .await
            .add_chunk(AudioChunk {
                data,
                sample_rate: 48000,
                timestamp: 0.0,
                chunk_id: 0,
                device_type: DeviceType::Microphone,
            })
            .unwrap();
    }

    fn read_metadata(dir: &TempDir) -> MeetingMetadata {
        serde_json::from_slice(&std::fs::read(dir.path().join("metadata.json")).unwrap()).unwrap()
    }

    fn decoded_duration(path: &std::path::Path) -> f64 {
        let output = std::process::Command::new(super::super::ffmpeg::find_ffmpeg_path().unwrap())
            .args(["-v", "error", "-xerror", "-i"])
            .arg(path)
            .args(["-f", "f32le", "-ac", "1", "-ar", "48000", "pipe:1"])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "synthetic audio must decode successfully"
        );
        output.stdout.len() as f64 / 4.0 / 48000.0
    }

    #[tokio::test]
    async fn completed_recording_duration_includes_silent_tail_after_state_cleanup() {
        let app = mock_builder().build(mock_context(noop_assets())).unwrap();
        let (dir, mut saver) = synthetic_saver();
        add_synthetic_audio(&saver, 156000).await; // exactly 3.25 seconds
        saver.add_transcript_segment(segment(0.5));
        // The real command clears state before saving. Duration must not need it.
        let state = RecordingState::new();
        state.start_recording().unwrap();
        state.cleanup();
        let duration = state.get_active_recording_duration();
        assert_eq!(duration, None);
        let path = saver.stop_and_save(app.handle()).await.unwrap().unwrap();
        let actual = decoded_duration(std::path::Path::new(&path));
        assert!(
            (actual - 3.25).abs() < 0.1,
            "synthetic file duration: {actual}"
        );
        let metadata = read_metadata(&dir);
        assert_eq!(metadata.status, "completed");
        let saved = metadata
            .duration_seconds
            .expect("saved audio must have a duration");
        assert!((saved - actual).abs() < 0.1, "duration must describe saved audio, including silence: metadata={saved}, decoded={actual}");
    }

    #[tokio::test]
    async fn repeated_finalization_after_late_asr_keeps_audio_and_completed_duration() {
        let app = mock_builder().build(mock_context(noop_assets())).unwrap();
        let (dir, mut saver) = synthetic_saver();
        add_synthetic_audio(&saver, 156000).await;
        saver.add_transcript_segment(segment(0.5));
        let path = saver.stop_and_save(app.handle()).await.unwrap().unwrap();
        let original_audio = std::fs::read(&path).unwrap();
        let completed = read_metadata(&dir);
        let mut late = segment(0.25); // delayed/out-of-order ASR update
        late.sequence_id = 1;
        late.id = "late-synthetic".into();
        saver.add_transcript_segment(late);
        let repeated_path = saver.stop_and_save(app.handle()).await.unwrap().unwrap();
        assert_eq!(repeated_path, path);
        assert_eq!(std::fs::read(&path).unwrap(), original_audio);
        let repeated = read_metadata(&dir);
        assert_eq!(repeated.duration_seconds, completed.duration_seconds);
        assert_eq!(repeated.completed_at, completed.completed_at);
        let transcripts: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.path().join("transcripts.json")).unwrap())
                .unwrap();
        assert_eq!(
            transcripts["total_segments"], 2,
            "a repeated save must retain earlier segments"
        );
        saver.set_device_info(Some("Synthetic microphone".into()), None);
        assert_eq!(read_metadata(&dir).status, "completed");
        assert_eq!(
            read_metadata(&dir).duration_seconds,
            completed.duration_seconds
        );
    }

    #[tokio::test]
    async fn transcript_only_completion_keeps_duration_unknown_without_audio() {
        let app = mock_builder().build(mock_context(noop_assets())).unwrap();
        let (dir, mut saver) = synthetic_saver();
        saver.incremental_saver = None;
        saver.metadata.as_mut().unwrap().audio_file.clear();
        saver.add_transcript_segment(segment(0.5));
        assert_eq!(saver.stop_and_save(app.handle()).await.unwrap(), None);
        let metadata = read_metadata(&dir);
        assert_eq!(metadata.status, "completed");
        assert!(metadata.completed_at.is_some());
        assert_eq!(
            metadata.duration_seconds, None,
            "ASR coverage is not recording duration"
        );
        assert!(!dir.path().join("audio.mp4").exists());
    }

    #[tokio::test]
    async fn completed_recording_without_asr_uses_merged_audio_duration() {
        let app = mock_builder().build(mock_context(noop_assets())).unwrap();
        let (dir, mut saver) = synthetic_saver();
        add_synthetic_audio(&saver, 1440000).await; // full 30-second checkpoint
        add_synthetic_audio(&saver, 60000).await; // 1.25-second final checkpoint
        assert!(saver.get_transcript_segments().is_empty());
        let path = saver.stop_and_save(app.handle()).await.unwrap().unwrap();
        let actual = decoded_duration(std::path::Path::new(&path));
        assert!(
            (actual - 31.25).abs() < 0.1,
            "merged synthetic file duration: {actual}"
        );
        let metadata = read_metadata(&dir);
        let duration = metadata
            .duration_seconds
            .expect("no ASR is required to measure saved audio");
        assert!(
            (duration - actual).abs() < 0.1,
            "metadata={duration}, decoded={actual}"
        );
        assert_eq!(metadata.status, "completed");
        assert!(!dir.path().join(".checkpoints").exists());
    }

    #[tokio::test]
    async fn empty_saved_audio_does_not_fabricate_completed_duration() {
        let app = mock_builder().build(mock_context(noop_assets())).unwrap();
        let (dir, mut saver) = synthetic_saver();
        assert!(saver.stop_and_save(app.handle()).await.is_err());
        let metadata = read_metadata(&dir);
        assert_eq!(metadata.duration_seconds, None);
        assert_ne!(metadata.status, "completed");
        assert!(!dir.path().join("audio.mp4").exists());
    }
}
