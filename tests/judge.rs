mod common;

use axum::http::{Method, StatusCode};
use common::{Auth, Fixture, now_ms, send};
use serde_json::{Value, json};

fn item(fx: &Fixture, team: usize, crit: usize, value: Value, edited_at: i64) -> Value {
    json!({ "team_id": fx.team_ids[team], "criterion_id": fx.criterion_ids[crit],
            "value_x100": value, "note": null, "edited_at": edited_at })
}

fn statuses(resp: &common::Resp) -> Vec<String> {
    assert_eq!(resp.status, StatusCode::OK, "{:?}", resp.body);
    resp.body["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| match r.get("error") {
            Some(e) => format!("{}:{}", r["status"].as_str().unwrap(), e.as_str().unwrap()),
            None => r["status"].as_str().unwrap().to_string(),
        })
        .collect()
}

#[tokio::test]
async fn judge_endpoints_require_a_valid_active_token() {
    let fx = Fixture::new(1, true).await;
    for (method, uri) in [
        (Method::GET, "/api/judge/session"),
        (Method::PUT, "/api/judge/scores"),
        (Method::POST, "/api/judge/submit"),
        (Method::POST, "/api/judge/heartbeat"),
        (Method::GET, "/api/judge/stream"),
    ] {
        let none = send(
            &fx.app,
            method.clone(),
            uri,
            Some(json!({ "items": [] })),
            Auth::None,
        )
        .await;
        assert_eq!(none.status, StatusCode::UNAUTHORIZED, "{uri}");
        let bad = send(
            &fx.app,
            method,
            uri,
            Some(json!({ "items": [] })),
            Auth::Bearer("nope"),
        )
        .await;
        assert_eq!(bad.status, StatusCode::UNAUTHORIZED, "{uri}");
    }
    // Deactivated judge is locked out.
    fx.admin(
        Method::PATCH,
        &format!("/judges/{}", fx.judges[0].0),
        Some(json!({ "is_active": false })),
    )
    .await;
    assert_eq!(
        fx.judge(0, Method::GET, "/judge/session", None)
            .await
            .status,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn session_payload_and_draft_behaviour() {
    let fx = Fixture::new(1, false).await;
    // In draft the session works, but writes are rejected.
    let session = fx.judge(0, Method::GET, "/judge/session", None).await;
    assert_eq!(session.status, StatusCode::OK);
    assert_eq!(session.body["event"]["status"], "draft");
    assert_eq!(session.body["teams"].as_array().unwrap().len(), 2);
    assert_eq!(session.body["criteria"].as_array().unwrap().len(), 2);
    assert_eq!(session.body["event"]["alert"]["version"], 0);
    assert_eq!(session.body["event"]["overlay"]["opacity"], 35);
    assert_eq!(session.body["judge"]["name"], "Судья 1");

    let write = fx
        .put_scores(0, json!([item(&fx, 0, 0, json!(100), now_ms())]))
        .await;
    assert_eq!(statuses(&write), ["rejected:invalid_state"]);
    assert_eq!(
        fx.judge(0, Method::POST, "/judge/submit", None)
            .await
            .status,
        StatusCode::CONFLICT
    );
}

#[tokio::test]
async fn score_sync_ok_stale_rejected_and_delete() {
    let fx = Fixture::new(2, true).await;
    let t = now_ms() - 10_000;

    let first = fx
        .put_scores(0, json!([item(&fx, 0, 0, json!(700), t)]))
        .await;
    assert_eq!(statuses(&first), ["ok"]);
    let session = fx.judge(0, Method::GET, "/judge/session", None).await;
    assert_eq!(session.body["scores"][0]["value_x100"], 700);
    assert_eq!(session.body["scores"][0]["edited_at"], t);

    // Idempotent resend and a newer edit.
    assert_eq!(
        statuses(
            &fx.put_scores(0, json!([item(&fx, 0, 0, json!(700), t)]))
                .await
        ),
        ["ok"]
    );
    assert_eq!(
        statuses(
            &fx.put_scores(0, json!([item(&fx, 0, 0, json!(800), t + 1000)]))
                .await
        ),
        ["ok"]
    );

    // Older edit loses and gets the server version.
    let stale = fx
        .put_scores(0, json!([item(&fx, 0, 0, json!(100), t + 500)]))
        .await;
    assert_eq!(statuses(&stale), ["stale"]);
    assert_eq!(stale.body["results"][0]["server"]["value_x100"], 800);
    assert_eq!(stale.body["results"][0]["server"]["edited_at"], t + 1000);

    // Per-item validation in one batch: out of range, wrong step, foreign team, unknown criterion,
    // negative value; the valid one still applies.
    let mixed = fx
        .put_scores(
            0,
            json!([
                item(&fx, 0, 0, json!(1100), t),
                item(&fx, 0, 1, json!(75), t),
                { "team_id": "foreign", "criterion_id": fx.criterion_ids[0], "value_x100": 100, "edited_at": t },
                { "team_id": fx.team_ids[0], "criterion_id": "foreign", "value_x100": 100, "edited_at": t },
                item(&fx, 1, 0, json!(-100), t),
                item(&fx, 1, 1, json!(250), t),
            ]),
        )
        .await;
    assert_eq!(
        statuses(&mixed),
        [
            "rejected:validation",
            "rejected:validation",
            "rejected:not_found",
            "rejected:not_found",
            "rejected:validation",
            "ok"
        ]
    );

    // Another judge's data is separate; a foreign judge cannot touch it.
    assert_eq!(
        statuses(
            &fx.put_scores(1, json!([item(&fx, 0, 0, json!(300), t)]))
                .await
        ),
        ["ok"]
    );
    let session = fx.judge(0, Method::GET, "/judge/session", None).await;
    assert_eq!(session.body["scores"].as_array().unwrap().len(), 2);

    // null deletes; deleting a missing score is ok; an older delete is stale.
    assert_eq!(
        statuses(
            &fx.put_scores(0, json!([item(&fx, 0, 0, Value::Null, t + 2000)]))
                .await
        ),
        ["ok"]
    );
    assert_eq!(
        statuses(
            &fx.put_scores(0, json!([item(&fx, 0, 0, Value::Null, t + 3000)]))
                .await
        ),
        ["ok"]
    );
    let session = fx.judge(0, Method::GET, "/judge/session", None).await;
    assert_eq!(session.body["scores"].as_array().unwrap().len(), 1);
    let older_delete = fx
        .put_scores(0, json!([item(&fx, 1, 1, Value::Null, t - 5)]))
        .await;
    assert_eq!(statuses(&older_delete), ["stale"]);

    // Edits far in the future are refused.
    let future = fx
        .put_scores(
            0,
            json!([item(&fx, 0, 0, json!(100), now_ms() + 3 * 86_400_000)]),
        )
        .await;
    assert_eq!(statuses(&future), ["rejected:validation"]);

    // Notes are stored only when enabled.
    fx.put_scores(
        0,
        json!([{ "team_id": fx.team_ids[0], "criterion_id": fx.criterion_ids[0],
                              "value_x100": 100, "note": "заметка", "edited_at": t + 9000 }]),
    )
    .await;
    let session = fx.judge(0, Method::GET, "/judge/session", None).await;
    let note = session.body["scores"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["value_x100"] == 100)
        .unwrap()["note"]
        .clone();
    assert!(note.is_null());
}

#[tokio::test]
async fn notes_are_kept_when_enabled() {
    let fx = Fixture::new(1, false).await;
    fx.admin(
        Method::PATCH,
        &format!("/events/{}", fx.event_id),
        Some(json!({ "notes_enabled": true })),
    )
    .await;
    fx.transition(json!({ "to": "judging" })).await;
    let resp = fx
        .put_scores(
            0,
            json!([{ "team_id": fx.team_ids[0], "criterion_id": fx.criterion_ids[0],
                                 "value_x100": 100, "note": " хорошо ", "edited_at": now_ms() }]),
        )
        .await;
    assert_eq!(statuses(&resp), ["ok"]);
    let session = fx.judge(0, Method::GET, "/judge/session", None).await;
    assert_eq!(session.body["scores"][0]["note"], "хорошо");
}

#[tokio::test]
async fn locked_grace_window_uses_edited_at() {
    let fx = Fixture::new(1, true).await;
    let t = now_ms() - 60_000;
    fx.put_scores(0, json!([item(&fx, 0, 0, json!(100), t)]))
        .await;
    let locked = fx.transition(json!({ "to": "locked" })).await;
    let locked_at = locked.body["event"]["locked_at"].as_i64().unwrap();

    let resp = fx
        .put_scores(
            0,
            json!([
                item(&fx, 0, 1, json!(100), locked_at - 1),
                item(&fx, 1, 0, json!(100), locked_at),
                item(&fx, 1, 1, json!(100), locked_at + 1),
            ]),
        )
        .await;
    assert_eq!(statuses(&resp), ["ok", "ok", "rejected:invalid_state"]);

    // Once finalized nothing is accepted any more.
    fx.transition(json!({ "to": "finalized", "force": true, "reason": "тест" }))
        .await;
    let resp = fx
        .put_scores(0, json!([item(&fx, 1, 1, json!(100), t)]))
        .await;
    assert_eq!(statuses(&resp), ["rejected:invalid_state"]);
}

#[tokio::test]
async fn submit_requires_complete_sheet_then_blocks_writes_until_unsubmit() {
    let fx = Fixture::new(1, true).await;
    let t = now_ms() - 1000;
    fx.put_scores(
        0,
        json!([
            item(&fx, 0, 0, json!(100), t),
            item(&fx, 0, 1, json!(100), t),
            item(&fx, 1, 0, json!(100), t)
        ]),
    )
    .await;

    let incomplete = fx.judge(0, Method::POST, "/judge/submit", None).await;
    assert_eq!(incomplete.status, StatusCode::CONFLICT);
    assert_eq!(incomplete.body["error"], "invalid_state");
    assert_eq!(
        incomplete.body["details"]["missing"],
        json!([{ "team_id": fx.team_ids[1], "criterion_id": fx.criterion_ids[1] }])
    );

    fx.put_scores(0, json!([item(&fx, 1, 1, json!(100), t)]))
        .await;
    let done = fx.judge(0, Method::POST, "/judge/submit", None).await;
    assert_eq!(done.status, StatusCode::OK, "{:?}", done.body);
    assert!(done.body["judge"]["submitted_at"].is_i64());
    assert_eq!(
        fx.event().await["judges"][0]["submitted_at"],
        done.body["judge"]["submitted_at"]
    );

    // Submitted sheets reject writes; resubmitting is idempotent.
    let blocked = fx
        .put_scores(0, json!([item(&fx, 0, 0, json!(200), t + 10)]))
        .await;
    assert_eq!(statuses(&blocked), ["rejected:sheet_submitted"]);
    assert_eq!(
        fx.judge(0, Method::POST, "/judge/submit", None)
            .await
            .status,
        StatusCode::OK
    );

    let un = fx.judge(0, Method::POST, "/judge/unsubmit", None).await;
    assert_eq!(un.status, StatusCode::OK);
    assert!(un.body["judge"]["submitted_at"].is_null());
    let again = fx
        .put_scores(0, json!([item(&fx, 0, 0, json!(200), t + 10)]))
        .await;
    assert_eq!(statuses(&again), ["ok"]);

    // Submit/unsubmit only while judging.
    fx.transition(json!({ "to": "locked" })).await;
    assert_eq!(
        fx.judge(0, Method::POST, "/judge/submit", None)
            .await
            .status,
        StatusCode::CONFLICT
    );
    assert_eq!(
        fx.judge(0, Method::POST, "/judge/unsubmit", None)
            .await
            .status,
        StatusCode::CONFLICT
    );
}

#[tokio::test]
async fn admin_reopen_allows_edits_again() {
    let fx = Fixture::new(1, true).await;
    fx.score_all(0, 500, 250).await;
    assert_eq!(
        fx.judge(0, Method::POST, "/judge/submit", None)
            .await
            .status,
        StatusCode::OK
    );
    let reopened = fx
        .admin(
            Method::POST,
            &format!("/judges/{}/reopen", fx.judges[0].0),
            Some(json!({ "reason": "ошибся" })),
        )
        .await;
    assert_eq!(reopened.status, StatusCode::OK);
    let write = fx
        .put_scores(0, json!([item(&fx, 0, 0, json!(900), now_ms())]))
        .await;
    assert_eq!(statuses(&write), ["ok"]);
}

#[tokio::test]
async fn heartbeat_updates_last_seen_and_pending() {
    let fx = Fixture::new(1, true).await;
    let mut rx = fx.state.sse.subscribe(&fx.event_id);
    let resp = fx
        .judge(
            0,
            Method::POST,
            "/judge/heartbeat",
            Some(json!({ "pending_count": 3 })),
        )
        .await;
    assert_eq!(resp.status, StatusCode::NO_CONTENT);
    assert_eq!(rx.try_recv().unwrap(), judgeflow::sse::ChangeKind::Presence);
    assert!(
        rx.try_recv().is_err(),
        "heartbeat must notify presence only"
    );
    let judge = fx.event().await["judges"][0].clone();
    assert_eq!(judge["pending_count"], 3);
    assert!(judge["last_seen_at"].is_i64());
}

#[tokio::test]
async fn score_batch_notifies_scores_once() {
    let fx = Fixture::new(1, true).await;
    let mut rx = fx.state.sse.subscribe(&fx.event_id);
    let t = now_ms();
    fx.put_scores(
        0,
        json!([
            item(&fx, 0, 0, json!(100), t),
            item(&fx, 0, 1, json!(100), t),
            item(&fx, 1, 0, json!(100), t)
        ]),
    )
    .await;
    assert_eq!(rx.try_recv().unwrap(), judgeflow::sse::ChangeKind::Scores);
    assert!(rx.try_recv().is_err());
}

#[tokio::test]
async fn deleted_score_is_a_tombstone_that_blocks_older_edits() {
    let fx = Fixture::new(1, true).await;
    let t = now_ms() - 10_000;
    fx.put_scores(0, json!([item(&fx, 0, 0, json!(700), t)]))
        .await;
    assert_eq!(
        statuses(
            &fx.put_scores(0, json!([item(&fx, 0, 0, Value::Null, t + 2000)]))
                .await
        ),
        ["ok"]
    );

    // An older offline edit from another device must not resurrect the score.
    let stale = fx
        .put_scores(0, json!([item(&fx, 0, 0, json!(300), t + 1000)]))
        .await;
    assert_eq!(statuses(&stale), ["stale"]);
    assert_eq!(
        stale.body["results"][0]["server"],
        json!({ "value_x100": null, "note": null, "edited_at": t + 2000 })
    );
    let session = fx.judge(0, Method::GET, "/judge/session", None).await;
    assert!(session.body["scores"].as_array().unwrap().is_empty());

    // A newer edit wins over the tombstone.
    assert_eq!(
        statuses(
            &fx.put_scores(0, json!([item(&fx, 0, 0, json!(400), t + 3000)]))
                .await
        ),
        ["ok"]
    );
    let session = fx.judge(0, Method::GET, "/judge/session", None).await;
    assert_eq!(session.body["scores"][0]["value_x100"], 400);
}

#[tokio::test]
async fn tombstones_are_not_counted_anywhere() {
    let fx = Fixture::new(1, true).await;
    let t = now_ms() - 10_000;
    fx.put_scores(
        0,
        json!([
            item(&fx, 0, 0, json!(100), t),
            item(&fx, 0, 1, json!(100), t),
            item(&fx, 1, 0, json!(100), t),
            item(&fx, 1, 1, json!(100), t)
        ]),
    )
    .await;
    fx.put_scores(0, json!([item(&fx, 1, 1, Value::Null, t + 1)]))
        .await;

    let judge = fx.event().await["judges"][0].clone();
    assert_eq!(judge["scored_count"], 3);

    let matrix = fx
        .admin(
            Method::GET,
            &format!("/events/{}/matrix", fx.event_id),
            None,
        )
        .await;
    let cell = matrix.body["cells"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["team_id"] == fx.team_ids[1])
        .unwrap();
    assert_eq!(cell["scored"], 1);

    let incomplete = fx.judge(0, Method::POST, "/judge/submit", None).await;
    assert_eq!(incomplete.status, StatusCode::CONFLICT);
    assert_eq!(
        incomplete.body["details"]["missing"],
        json!([{ "team_id": fx.team_ids[1], "criterion_id": fx.criterion_ids[1] }])
    );

    let mut conn = fx.state.pool.acquire().await.unwrap();
    let event = judgeflow::domain::load_event(&mut conn, &fx.event_id)
        .await
        .unwrap();
    let inputs = judgeflow::domain::ranking_inputs(&mut conn, &event)
        .await
        .unwrap();
    assert_eq!(inputs.len(), 1);
    assert_eq!(inputs[0].1.scores.len(), 3);
}

#[tokio::test]
async fn migrations_apply_on_a_fresh_database() {
    let fx = Fixture::new(1, true).await;
    let nullable: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM pragma_table_info('scores') WHERE name = 'value_x100' AND \"notnull\" = 0")
            .fetch_one(&fx.state.pool)
            .await
            .unwrap();
    assert_eq!(nullable, 1);
    let indexes: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name IN ('scores_team_id', 'scores_criterion_id')",
    )
    .fetch_one(&fx.state.pool)
    .await
    .unwrap();
    assert_eq!(indexes, 2);
}
