use super::*;
use serde_json::json;

pub(super) fn output() -> Value {
    json!({"schema_version":"meetily.local-diarization.v1","status":"ok",
        "input":{"source_sha256":"a".repeat(64),"decoded_f32le_sha256":"b".repeat(64),"source_duration_seconds":10.0,"start_seconds":0.0,"duration_seconds":10.0,"sample_rate_hz":16000,"channels":1},
        "models":{"segmentation":{"sha256":"220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079"},"embedding":{"sha256":"f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11"}},
        "configuration":{"requested_speakers":2,"provider":"cpu","threads":2,"cluster_threshold":0.5},
        "environment":{"python":"3.12.14","platform":"test","sherpa_onnx":"2.0.1","sherpa_onnx_core":"2.0.1","numpy":"2.2.6"},
        "timing":{"decode_seconds":1,"model_init_seconds":1,"inference_seconds":1,"total_seconds":3,"inference_real_time_factor":0.1},
        "resources":{"process_peak_rss_bytes":100},
        "validation":{"finite_sorted_valid_bounds":true,"bounds_start_seconds":0,"bounds_end_seconds":10,"turn_count":2,"speaker_count":2},
        "turns":[{"start":0.0,"end":4.0,"speaker":"speaker-01"},{"start":3.5,"end":10.0,"speaker":"speaker-02"}]})
}
pub(super) async fn db() -> SqlitePool {
    let p = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::query("CREATE TABLE meetings(id TEXT PRIMARY KEY)")
        .execute(&p)
        .await
        .unwrap();
    sqlx::raw_sql(include_str!(
        "../../migrations/20261031000000_speaker_runs.sql"
    ))
    .execute(&p)
    .await
    .unwrap();
    sqlx::query("INSERT INTO meetings VALUES ('m'), ('other')")
        .execute(&p)
        .await
        .unwrap();
    p
}
#[test]
fn accepts_overlap_but_rejects_wrong_contract_bounds_ids_and_count() {
    let good = output();
    assert_eq!(validate(&good, &"a".repeat(64), 2).unwrap().len(), 2);
    for (path, value) in [
        ("/schema_version", json!("future")),
        ("/status", json!("error")),
        ("/input/source_sha256", json!("c".repeat(64))),
        ("/input/start_seconds", json!(1)),
        ("/turns/0/start", json!(-1)),
        ("/turns/1/start", json!(-0.5)),
        ("/turns/1/end", json!(11)),
        ("/turns/1/speaker", json!("Alice")),
        ("/turns/1/speaker", json!("speaker-03")),
        ("/turns", json!([])),
    ] {
        let mut bad = good.clone();
        *bad.pointer_mut(path).unwrap() = value;
        assert!(validate(&bad, &"a".repeat(64), 2).is_err(), "{path}");
    }
    assert!(validate(&good, &"a".repeat(64), 0).is_err());
    assert!(validate(&good, &"a".repeat(64), 13).is_err());
}
#[tokio::test]
async fn rerun_is_inactive_names_merges_undo_and_versions_survive_reload() {
    let p = db().await;
    let first = persist(&p, "m", &output(), &"a".repeat(64), 2)
        .await
        .unwrap();
    edit(&p, "m", &first, "rename", "speaker-01", "张老师")
        .await
        .unwrap();
    edit(&p, "m", &first, "merge", "speaker-02", "speaker-01")
        .await
        .unwrap();
    let second = persist(&p, "m", &output(), &"a".repeat(64), 2)
        .await
        .unwrap();
    let s = snapshot(&p, "m").await.unwrap();
    assert_eq!(s.active_id, Some(first.clone()));
    let old = s.runs.iter().find(|r| r.id == first).unwrap();
    assert_eq!(old.overlay.names["speaker-01"], "张老师");
    assert_eq!(old.overlay.aliases["speaker-02"], "speaker-01");
    assert!(s
        .runs
        .iter()
        .find(|r| r.id == second)
        .unwrap()
        .overlay
        .names
        .is_empty());
    assert!(edit(&p, "m", &first, "merge", "speaker-01", "speaker-02")
        .await
        .is_err());
    assert!(edit(&p, "m", &first, "merge", "speaker-01", "speaker-01")
        .await
        .is_err());
    assert!(edit(&p, "other", &first, "rename", "speaker-01", "wrong")
        .await
        .is_err());
    assert!(edit(
        &p,
        "m",
        &first,
        "merge",
        "speaker-01",
        "other-run/speaker-02"
    )
    .await
    .is_err());
    edit(&p, "m", &first, "undo", "", "").await.unwrap();
    let s = snapshot(&p, "m").await.unwrap();
    assert!(s
        .runs
        .iter()
        .find(|r| r.id == first)
        .unwrap()
        .overlay
        .aliases
        .is_empty());
    edit(&p, "m", &second, "activate", "", "").await.unwrap();
    assert_eq!(snapshot(&p, "m").await.unwrap().active_id, Some(second));
    edit(&p, "m", &first, "activate", "", "").await.unwrap();
    let mut bad = output();
    bad["turns"][0]["end"] = json!(100);
    assert!(persist(&p, "m", &bad, &"a".repeat(64), 2).await.is_err());
    let s = snapshot(&p, "m").await.unwrap();
    assert_eq!(s.runs.len(), 2);
    assert_eq!(s.active_id, Some(first));
}
