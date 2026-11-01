//! Local post-meeting analysis. Acoustic turns and human overlays are separate.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Row, SqlitePool};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Turn {
    pub start: f64,
    pub end: f64,
    pub speaker: String,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Overlay {
    pub names: BTreeMap<String, String>,
    pub aliases: BTreeMap<String, String>,
    pub undo: Vec<BTreeMap<String, String>>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Run {
    pub id: String,
    pub meeting_id: String,
    pub created_at: String,
    pub audio_hash: String,
    pub requested_speakers: u8,
    pub duration: f64,
    pub turns: Vec<Turn>,
    pub overlay: Overlay,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Snapshot {
    pub active_id: Option<String>,
    pub runs: Vec<Run>,
}
pub const SEGMENTATION_HASH: &str =
    "220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079";
pub const EMBEDDING_HASH: &str = "f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11";
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn number(raw: &Value, path: &str) -> Result<f64, String> {
    raw.pointer(path)
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite())
        .ok_or_else(|| format!("Invalid result field: {path}"))
}
pub fn validate(raw: &Value, hash: &str, count: u8) -> Result<Vec<Turn>, String> {
    if !(1..=12).contains(&count) {
        return Err("Participant count must be 1–12.".into());
    }
    let valid_hash = |s: &str| {
        s.len() == 64
            && s.bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    };
    if !valid_hash(hash)
        || raw["schema_version"] != "meetily.local-diarization.v1"
        || raw["status"] != "ok"
        || raw["input"]["source_sha256"] != hash
        || number(raw, "/input/start_seconds")? != 0.0
        || raw["input"]["sample_rate_hz"] != 16000
        || raw["input"]["channels"] != 1
        || raw["configuration"]["requested_speakers"] != count
        || raw["configuration"]["provider"] != "cpu"
        || raw["models"]["segmentation"]["sha256"] != SEGMENTATION_HASH
        || raw["models"]["embedding"]["sha256"] != EMBEDDING_HASH
        || !raw["input"]["decoded_f32le_sha256"]
            .as_str()
            .is_some_and(valid_hash)
    {
        return Err("Worker result contract, models or audio hash do not match.".into());
    }
    for path in [
        "/environment/python",
        "/environment/platform",
        "/environment/sherpa_onnx",
        "/environment/sherpa_onnx_core",
        "/environment/numpy",
    ] {
        if !raw.pointer(path).is_some_and(Value::is_string) {
            return Err(format!("Missing result field: {path}"));
        }
    }
    for path in [
        "/configuration/threads",
        "/configuration/cluster_threshold",
        "/timing/decode_seconds",
        "/timing/model_init_seconds",
        "/timing/inference_seconds",
        "/timing/total_seconds",
        "/timing/inference_real_time_factor",
        "/resources/process_peak_rss_bytes",
    ] {
        if number(raw, path)? < 0.0 {
            return Err("Negative result metadata.".into());
        }
    }
    let duration = number(raw, "/input/duration_seconds")?;
    let source_duration = number(raw, "/input/source_duration_seconds")?;
    if duration <= 0.0 || (source_duration - duration).abs() > 0.15 {
        return Err("Analysis must cover the whole recording.".into());
    }
    let turns: Vec<Turn> = serde_json::from_value(raw["turns"].clone()).map_err(err)?;
    if turns.is_empty() || turns.len() > 1_000_000 {
        return Err("No speaker turns found, or result too large.".into());
    }
    let mut previous = 0.0;
    let mut ids = BTreeSet::new();
    for t in &turns {
        let id = t
            .speaker
            .strip_prefix("speaker-")
            .and_then(|s| s.parse::<u8>().ok());
        if !id.is_some_and(|n| n >= 1 && n <= count && t.speaker == format!("speaker-{n:02}"))
            || !t.start.is_finite()
            || !t.end.is_finite()
            || t.start < previous
            || t.start < 0.0
            || t.end <= t.start
            || t.end > duration
        {
            return Err("Invalid, unordered or out-of-range speaker turn.".into());
        }
        previous = t.start;
        ids.insert(&t.speaker);
    }
    if raw["validation"]["finite_sorted_valid_bounds"] != true
        || number(raw, "/validation/bounds_start_seconds")? != 0.0
        || (number(raw, "/validation/bounds_end_seconds")? - duration).abs() > 0.001
        || raw["validation"]["turn_count"].as_u64() != Some(turns.len() as u64)
        || raw["validation"]["speaker_count"].as_u64() != Some(ids.len() as u64)
    {
        return Err("Result validation metadata disagrees with turns.".into());
    }
    Ok(turns)
}
pub async fn persist(
    pool: &SqlitePool,
    meeting: &str,
    raw: &Value,
    hash: &str,
    count: u8,
) -> Result<String, String> {
    let turns = validate(raw, hash, count)?;
    let detected = turns
        .iter()
        .map(|turn| &turn.speaker)
        .collect::<BTreeSet<_>>()
        .len();
    let id = uuid::Uuid::new_v4().to_string();
    let mut tx = pool.begin().await.map_err(err)?;
    sqlx::query("INSERT INTO speaker_runs (id,meeting_id,created_at,audio_hash,requested_speakers,raw_result,overlay) VALUES (?,?,?,?,?,?,?)")
        .bind(&id).bind(meeting).bind(chrono::Utc::now().to_rfc3339()).bind(hash).bind(count as i64)
        .bind(raw.to_string()).bind(serde_json::to_string(&Overlay::default()).map_err(err)?)
        .execute(&mut *tx).await.map_err(err)?;
    // Only a matching first run may auto-activate. A requested count is not a
    // guarantee, and later runs must not undo an explicit decision to hide labels.
    if detected == count as usize {
        sqlx::query("INSERT INTO speaker_active (meeting_id,run_id) SELECT ?,? WHERE NOT EXISTS (SELECT 1 FROM speaker_runs WHERE meeting_id=? AND id<>?) ON CONFLICT(meeting_id) DO NOTHING")
            .bind(meeting).bind(&id).bind(meeting).bind(&id).execute(&mut *tx).await.map_err(err)?;
    }
    tx.commit().await.map_err(err)?;
    Ok(id)
}
pub async fn snapshot(pool: &SqlitePool, meeting: &str) -> Result<Snapshot, String> {
    let mut tx = pool.begin().await.map_err(err)?;
    let active_id = sqlx::query_scalar("SELECT run_id FROM speaker_active WHERE meeting_id=?")
        .bind(meeting)
        .fetch_optional(&mut *tx)
        .await
        .map_err(err)?;
    let rows = sqlx::query(
        "SELECT * FROM speaker_runs WHERE meeting_id=? ORDER BY created_at DESC,id DESC",
    )
    .bind(meeting)
    .fetch_all(&mut *tx)
    .await
    .map_err(err)?;
    let mut runs = Vec::new();
    for row in rows {
        let raw: Value = serde_json::from_str(row.get("raw_result")).map_err(err)?;
        runs.push(Run {
            id: row.get("id"),
            meeting_id: row.get("meeting_id"),
            created_at: row.get("created_at"),
            audio_hash: row.get("audio_hash"),
            requested_speakers: row.get::<i64, _>("requested_speakers") as u8,
            duration: number(&raw, "/input/duration_seconds")?,
            turns: serde_json::from_value(raw["turns"].clone()).map_err(err)?,
            overlay: serde_json::from_str(row.get("overlay")).map_err(err)?,
        });
    }
    tx.commit().await.map_err(err)?;
    Ok(Snapshot { active_id, runs })
}
fn resolve<'a>(overlay: &'a Overlay, id: &'a str) -> Result<&'a str, String> {
    let mut next = id;
    let mut seen = BTreeSet::new();
    while let Some(target) = overlay.aliases.get(next) {
        if !seen.insert(next) {
            return Err("Cyclic merge.".into());
        }
        next = target;
    }
    Ok(next)
}
pub async fn edit(
    pool: &SqlitePool,
    meeting: &str,
    run: &str,
    action: &str,
    speaker: &str,
    value: &str,
) -> Result<(), String> {
    let mut tx = pool.begin().await.map_err(err)?;
    if action == "deactivate" {
        // Compare-and-delete protects an active result selected concurrently.
        // No raw result or overlay is rewritten by hiding labels.
        let removed = sqlx::query("DELETE FROM speaker_active WHERE meeting_id=? AND run_id=?")
            .bind(meeting)
            .bind(run)
            .execute(&mut *tx)
            .await
            .map_err(err)?
            .rows_affected();
        if removed != 1 {
            return Err(
                "The active result changed or is already hidden. Refresh before hiding labels."
                    .into(),
            );
        }
        tx.commit().await.map_err(err)?;
        return Ok(());
    }
    // A write first acquires SQLite's write lock before reading mutable overlays.
    let found = sqlx::query("UPDATE speaker_runs SET overlay=overlay WHERE id=? AND meeting_id=?")
        .bind(run)
        .bind(meeting)
        .execute(&mut *tx)
        .await
        .map_err(err)?
        .rows_affected();
    if found != 1 {
        return Err("Result does not belong to this meeting.".into());
    }
    let row =
        sqlx::query("SELECT raw_result,overlay FROM speaker_runs WHERE id=? AND meeting_id=?")
            .bind(run)
            .bind(meeting)
            .fetch_one(&mut *tx)
            .await
            .map_err(err)?;
    let raw: Value = serde_json::from_str(row.get("raw_result")).map_err(err)?;
    let turns: Vec<Turn> = serde_json::from_value(raw["turns"].clone()).map_err(err)?;
    let ids: BTreeSet<_> = turns.iter().map(|t| t.speaker.as_str()).collect();
    let mut overlay: Overlay = serde_json::from_str(row.get("overlay")).map_err(err)?;
    match action {
        "activate" => {
            sqlx::query("INSERT INTO speaker_active(meeting_id,run_id) VALUES (?,?) ON CONFLICT(meeting_id) DO UPDATE SET run_id=excluded.run_id")
                .bind(meeting).bind(run).execute(&mut *tx).await.map_err(err)?;
        }
        "rename" => {
            if !ids.contains(speaker)
                || value.chars().count() > 120
                || value.chars().any(char::is_control)
            {
                return Err(
                    "Name must be at most 120 characters without control characters.".into(),
                );
            }
            if value.trim().is_empty() {
                overlay.names.remove(speaker);
            } else {
                overlay.names.insert(speaker.into(), value.trim().into());
            }
        }
        "merge" => {
            if speaker == value
                || !ids.contains(speaker)
                || !ids.contains(value)
                || resolve(&overlay, speaker)? == resolve(&overlay, value)?
            {
                return Err("Choose two distinct groups in this result.".into());
            }
            // Merge whole groups; aliases point to roots, and the original names remain recoverable.
            let source = resolve(&overlay, speaker)?.to_string();
            let target = resolve(&overlay, value)?.to_string();
            overlay.undo.push(overlay.aliases.clone());
            overlay.aliases.insert(source, target);
            resolve(&overlay, speaker)?;
        }
        "undo" => {
            overlay.aliases = overlay.undo.pop().ok_or("No merge to undo.")?;
        }
        _ => return Err("Unknown speaker edit.".into()),
    }
    sqlx::query("UPDATE speaker_runs SET overlay=? WHERE id=? AND meeting_id=?")
        .bind(serde_json::to_string(&overlay).map_err(err)?)
        .bind(run)
        .bind(meeting)
        .execute(&mut *tx)
        .await
        .map_err(err)?;
    tx.commit().await.map_err(err)?;
    Ok(())
}
pub mod runtime;
#[cfg(test)]
mod tests;
