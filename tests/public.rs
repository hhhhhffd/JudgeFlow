mod common;

use axum::http::{Method, StatusCode};
use common::{Auth, Fixture, now_ms, send};
use serde_json::{Value, json};

async fn public(fx: &Fixture) -> common::Resp {
    send(
        &fx.app,
        Method::GET,
        &format!("/api/public/events/{}", fx.event_id),
        None,
        Auth::None,
    )
    .await
}

async fn set_visibility(fx: &Fixture, visibility: &str) {
    let resp = fx
        .admin(
            Method::PATCH,
            &format!("/events/{}", fx.event_id),
            Some(json!({ "visibility": visibility })),
        )
        .await;
    assert_eq!(resp.status, StatusCode::OK);
}

async fn results(fx: &Fixture, mode: &str) -> Value {
    let resp = fx
        .admin(
            Method::GET,
            &format!("/events/{}/results?mode={mode}", fx.event_id),
            None,
        )
        .await;
    assert_eq!(resp.status, StatusCode::OK, "{:?}", resp.body);
    resp.body
}

fn row_for<'a>(results: &'a Value, name: &str) -> &'a Value {
    results["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["team_name"] == name)
        .unwrap()
}

#[tokio::test]
async fn provisional_vs_official_and_missing_scores_are_not_zero() {
    let fx = Fixture::new(2, true).await;
    // Judge 1: full sheet. Alpha = 100.00, Beta = 50.00.
    let t = now_ms();
    let full = json!([
        { "team_id": fx.team_ids[0], "criterion_id": fx.criterion_ids[0], "value_x100": 1000, "edited_at": t },
        { "team_id": fx.team_ids[0], "criterion_id": fx.criterion_ids[1], "value_x100": 500, "edited_at": t },
        { "team_id": fx.team_ids[1], "criterion_id": fx.criterion_ids[0], "value_x100": 500, "edited_at": t },
        { "team_id": fx.team_ids[1], "criterion_id": fx.criterion_ids[1], "value_x100": 250, "edited_at": t },
    ]);
    fx.put_scores(0, full).await;
    // Judge 2: only Alpha complete, Beta half-filled (incomplete sheet is excluded, not zero).
    fx.put_scores(
        1,
        json!([
            { "team_id": fx.team_ids[0], "criterion_id": fx.criterion_ids[0], "value_x100": 0, "edited_at": t },
            { "team_id": fx.team_ids[0], "criterion_id": fx.criterion_ids[1], "value_x100": 0, "edited_at": t },
            { "team_id": fx.team_ids[1], "criterion_id": fx.criterion_ids[0], "value_x100": 0, "edited_at": t },
        ]),
    )
    .await;

    let provisional = results(&fx, "provisional").await;
    assert_eq!(provisional["mode"], "provisional");
    let alpha = row_for(&provisional, "Альфа");
    assert_eq!(alpha["score_x100"], 5000);
    assert_eq!(alpha["sheets"], 2);
    assert_eq!(alpha["rank"], 1);
    let beta = row_for(&provisional, "Бета");
    assert_eq!(beta["score_x100"], 5000);
    assert_eq!(beta["sheets"], 1);
    assert_eq!(beta["team_id"], json!(fx.team_ids[1]));
    assert!(provisional["snapshot"].is_null());

    // Default mode is provisional; nobody submitted so official has no scores.
    let default = fx
        .admin(
            Method::GET,
            &format!("/events/{}/results", fx.event_id),
            None,
        )
        .await;
    assert_eq!(default.body["mode"], "provisional");
    let official = results(&fx, "official").await;
    assert!(
        official["rows"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["score_x100"].is_null() && r["rank"].is_null())
    );

    assert_eq!(
        fx.judge(0, Method::POST, "/judge/submit", None)
            .await
            .status,
        StatusCode::OK
    );
    let official = results(&fx, "official").await;
    assert_eq!(row_for(&official, "Альфа")["score_x100"], 10000);
    assert_eq!(row_for(&official, "Бета")["score_x100"], 5000);
    assert_eq!(official["rows"][0]["team_name"], "Альфа");
    let bad = fx
        .admin(
            Method::GET,
            &format!("/events/{}/results?mode=nope", fx.event_id),
            None,
        )
        .await;
    assert_eq!(bad.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn finalized_official_results_come_from_the_snapshot() {
    let fx = Fixture::new(1, true).await;
    fx.score_all(0, 1000, 500).await;
    fx.judge(0, Method::POST, "/judge/submit", None).await;
    fx.transition(json!({ "to": "locked" })).await;
    fx.transition(json!({ "to": "finalized" })).await;

    // Tamper with the live data: the snapshot must not change.
    sqlx::query("UPDATE scores SET value_x100 = 0")
        .execute(&fx.state.pool)
        .await
        .unwrap();
    let official = results(&fx, "official").await;
    assert_eq!(row_for(&official, "Альфа")["score_x100"], 10000);
    assert!(official["snapshot"]["id"].is_string());
    assert!(official["snapshot"]["created_at"].is_i64());
    let live = results(&fx, "provisional").await;
    assert_eq!(row_for(&live, "Альфа")["score_x100"], 0);

    // Un-finalize: official is computed live again; re-finalizing adds a newer snapshot.
    fx.transition(json!({ "to": "locked", "reason": "проверка" }))
        .await;
    let recomputed = results(&fx, "official").await;
    assert_eq!(row_for(&recomputed, "Альфа")["score_x100"], 0);
    assert!(recomputed["snapshot"].is_null());
    fx.transition(json!({ "to": "finalized" })).await;
    let second = results(&fx, "official").await;
    assert_eq!(row_for(&second, "Альфа")["score_x100"], 0);
    assert_ne!(second["snapshot"]["id"], official["snapshot"]["id"]);
}

#[tokio::test]
async fn public_visibility_matrix() {
    let fx = Fixture::new(1, false).await;

    // Draft: 404 everywhere, including the stream.
    assert_eq!(public(&fx).await.status, StatusCode::NOT_FOUND);
    let stream = send(
        &fx.app,
        Method::GET,
        &format!("/api/public/events/{}/stream", fx.event_id),
        None,
        Auth::None,
    )
    .await;
    assert_eq!(stream.status, StatusCode::NOT_FOUND);
    assert_eq!(
        send(
            &fx.app,
            Method::GET,
            "/api/public/events/unknown",
            None,
            Auth::None
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );

    fx.transition(json!({ "to": "judging" })).await;
    fx.score_all(0, 1000, 500).await;

    // Live (judging): hidden / totals / full. Per-judge data is never shown.
    set_visibility(&fx, "hidden").await;
    let hidden = public(&fx).await;
    assert_eq!(hidden.status, StatusCode::OK);
    assert!(hidden.body["results"].is_null());
    assert!(hidden.body["event"].get("criteria").is_none());
    assert_eq!(hidden.body["event"]["status"], "judging");

    set_visibility(&fx, "live_totals").await;
    let totals = public(&fx).await;
    let row = &totals.body["results"]["rows"][0];
    assert_eq!(row["score_x100"], 10000);
    assert_eq!(row["team_name"], "Альфа");
    assert_eq!(row["criteria"], json!([]));
    assert_eq!(row["judges"], json!([]));
    assert!(totals.body["event"].get("criteria").is_none());

    set_visibility(&fx, "live_full").await;
    let full = public(&fx).await;
    let row = &full.body["results"]["rows"][0];
    assert_eq!(row["criteria"].as_array().unwrap().len(), 2);
    assert_eq!(row["judges"], json!([]));
    assert_eq!(full.body["event"]["criteria"][0]["name"], "Идея");
    assert!(full.body["event"]["criteria"][0].get("max_x100").is_none());

    // Finalized still follows the visibility setting (provisional-style, no judges).
    fx.judge(0, Method::POST, "/judge/submit", None).await;
    fx.transition(json!({ "to": "locked" })).await;
    fx.transition(json!({ "to": "finalized" })).await;
    set_visibility(&fx, "hidden").await;
    assert!(public(&fx).await.body["results"].is_null());
    set_visibility(&fx, "live_totals").await;
    let finalized = public(&fx).await;
    assert_eq!(finalized.body["results"]["rows"][0]["judges"], json!([]));
    assert_eq!(finalized.body["results"]["rows"][0]["criteria"], json!([]));

    // Published: snapshot with totals, criteria and per-judge scores, whatever the visibility.
    fx.transition(json!({ "to": "published" })).await;
    for visibility in ["hidden", "live_totals", "live_full"] {
        set_visibility(&fx, visibility).await;
        let published = public(&fx).await;
        let row = &published.body["results"]["rows"][0];
        assert_eq!(published.body["event"]["status"], "published");
        assert_eq!(row["score_x100"], 10000, "{visibility}");
        assert_eq!(row["criteria"].as_array().unwrap().len(), 2, "{visibility}");
        assert_eq!(row["judges"][0]["score_x100"], 10000, "{visibility}");
        assert_eq!(row["judges"][0]["judge_name"], "Судья 1");
        assert_eq!(
            published.body["event"]["criteria"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }

    // Public payload leaks no admin-only data.
    let text = public(&fx).await.body.to_string();
    assert!(!text.contains("token"));
    assert!(!text.contains("created_by"));

    // Un-publish hides per-judge data again.
    fx.transition(json!({ "to": "finalized" })).await;
    set_visibility(&fx, "live_full").await;
    let again = public(&fx).await;
    assert_eq!(again.body["results"]["rows"][0]["judges"], json!([]));
}

#[tokio::test]
async fn public_stream_opens_for_non_draft_events() {
    let fx = Fixture::new(1, true).await;
    let request = axum::http::Request::builder()
        .uri(format!("/api/public/events/{}/stream", fx.event_id))
        .body(axum::body::Body::empty())
        .unwrap();
    // Only the headers are inspected: the body is an endless stream.
    let resp = tower::ServiceExt::oneshot(fx.app.clone(), request)
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(resp.headers()["content-type"], "text/event-stream");
}

/// The public ranking is cached per event; every change that notifies SSE must drop it.
#[tokio::test]
async fn public_results_cache_is_invalidated_by_changes() {
    let fx = Fixture::new(2, true).await;
    set_visibility(&fx, "live_full").await;
    let rows = |body: &Value| body["results"]["rows"].as_array().unwrap().clone();

    // Prime the cache while nobody has scored.
    let first = public(&fx).await;
    assert_eq!(first.status, StatusCode::OK);
    assert!(rows(&first.body).iter().all(|r| r["score_x100"].is_null()));
    // A second request is served from the cache and is identical.
    assert_eq!(public(&fx).await.body, first.body);

    // Scores.
    fx.score_all(0, 1000, 500).await;
    let scored = rows(&public(&fx).await.body);
    assert_eq!(
        row_for(&json!({ "rows": scored }), "Альфа")["score_x100"],
        10000
    );

    // Event: the title is part of the public payload.
    let renamed = fx
        .admin(
            Method::PATCH,
            &format!("/events/{}", fx.event_id),
            Some(json!({ "title": "Новое имя" })),
        )
        .await;
    assert_eq!(renamed.status, StatusCode::OK, "{:?}", renamed.body);
    assert_eq!(public(&fx).await.body["event"]["title"], "Новое имя");

    // Judges: deactivating the only judge who scored empties the ranking's sheets.
    let deactivated = fx
        .admin(
            Method::PATCH,
            &format!("/judges/{}", fx.judges[0].0),
            Some(json!({ "is_active": false })),
        )
        .await;
    assert_eq!(deactivated.status, StatusCode::OK, "{:?}", deactivated.body);
    let after_judge = rows(&public(&fx).await.body);
    assert!(after_judge.iter().all(|r| r["score_x100"].is_null()));

    // Event: hiding results is applied immediately.
    set_visibility(&fx, "hidden").await;
    assert!(public(&fx).await.body["results"].is_null());
}
