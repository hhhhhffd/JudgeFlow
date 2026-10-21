mod common;

use axum::http::{Method, StatusCode};
use common::{Auth, Fixture, Resp, now_ms, send};
use judgeflow::sse::ChangeKind;
use serde_json::{Value, json};

/// Builds an event with one judge and teams `T1..Tn`, where team `i` gets a score proportional to
/// `levels[i]` (1..=10, equal levels tie). Returns the fixture in `locked` status when `finalize`
/// is false and `finalized` otherwise.
async fn ceremony(levels: &[i64], finalize: bool) -> Fixture {
    let fx = Fixture::new(1, false).await;
    let mut team_ids = fx.team_ids.clone();
    for i in team_ids.len()..levels.len() {
        let resp = fx
            .admin(
                Method::POST,
                &format!("/events/{}/teams", fx.event_id),
                Some(json!({ "name": format!("Команда {}", i + 1) })),
            )
            .await;
        assert_eq!(resp.status, StatusCode::OK, "{:?}", resp.body);
        team_ids.push(resp.body["id"].as_str().unwrap().to_string());
    }
    assert_eq!(
        fx.transition(json!({ "to": "judging" })).await.status,
        StatusCode::OK
    );
    let at = now_ms();
    let items: Vec<Value> = team_ids
        .iter()
        .zip(levels)
        .flat_map(|(team, level)| {
            [
                json!({ "team_id": team, "criterion_id": fx.criterion_ids[0], "value_x100": level * 100, "edited_at": at }),
                json!({ "team_id": team, "criterion_id": fx.criterion_ids[1], "value_x100": level * 50, "edited_at": at }),
            ]
        })
        .collect();
    let saved = fx.put_scores(0, Value::Array(items)).await;
    assert_eq!(saved.status, StatusCode::OK, "{:?}", saved.body);
    let submitted = fx.judge(0, Method::POST, "/judge/submit", None).await;
    assert_eq!(submitted.status, StatusCode::OK, "{:?}", submitted.body);
    assert_eq!(
        fx.transition(json!({ "to": "locked" })).await.status,
        StatusCode::OK
    );
    if finalize {
        let done = fx.transition(json!({ "to": "finalized" })).await;
        assert_eq!(done.status, StatusCode::OK, "{:?}", done.body);
    }
    fx
}

async fn reveal(fx: &Fixture, action: &str) -> Resp {
    fx.admin(
        Method::POST,
        &format!("/events/{}/stage/reveal", fx.event_id),
        Some(json!({ "action": action })),
    )
    .await
}

async fn patch(fx: &Fixture, body: Value) -> Resp {
    fx.admin(
        Method::PATCH,
        &format!("/events/{}", fx.event_id),
        Some(body),
    )
    .await
}

async fn stage(fx: &Fixture) -> Resp {
    send(
        &fx.app,
        Method::GET,
        &format!("/api/public/events/{}/stage", fx.event_id),
        None,
        Auth::None,
    )
    .await
}

fn names(resp: &Resp) -> Vec<String> {
    resp.body["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["team_name"].as_str().unwrap().to_string())
        .collect()
}

/// Levels giving ranks 1,2,2,4,5 for teams Альфа, Бета, Команда 3..5.
const TIED: [i64; 5] = [9, 7, 7, 5, 3];

#[tokio::test]
async fn reveal_goes_from_third_to_first() {
    let fx = ceremony(&[9, 7, 5, 3], true).await;
    assert_eq!(
        patch(&fx, json!({ "stage_view": "podium" })).await.status,
        StatusCode::OK
    );

    let s = stage(&fx).await;
    assert_eq!(
        s.body["stage"],
        json!({
            "view": "podium", "top_n": 3, "revealed": 0, "total_groups": 3, "available": true,
            "track_id": null
        })
    );
    assert!(names(&s).is_empty());

    for (step, expected) in [
        (1, vec!["Команда 3"]),
        (2, vec!["Бета", "Команда 3"]),
        (3, vec!["Альфа", "Бета", "Команда 3"]),
    ] {
        let resp = reveal(&fx, "next").await;
        assert_eq!(resp.status, StatusCode::OK, "{:?}", resp.body);
        assert_eq!(resp.body["event"]["stage_revealed"], step);
        let s = stage(&fx).await;
        assert_eq!(s.body["stage"]["revealed"], step);
        assert_eq!(names(&s), expected);
    }
}

#[tokio::test]
async fn ties_reveal_together_and_top_n_cuts_by_rank() {
    let fx = ceremony(&TIED, true).await;
    patch(&fx, json!({ "stage_view": "podium" })).await;
    assert_eq!(stage(&fx).await.body["stage"]["total_groups"], 2);

    reveal(&fx, "next").await;
    let s = stage(&fx).await;
    assert_eq!(names(&s), ["Бета", "Команда 3"]);
    assert!(
        s.body["rows"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["rank"] == 2 && r["tie"] == true)
    );

    reveal(&fx, "next").await;
    assert_eq!(names(&stage(&fx).await), ["Альфа", "Бета", "Команда 3"]);
}

#[tokio::test]
async fn prev_reset_all_and_clamping() {
    let fx = ceremony(&TIED, true).await;
    let revealed = |r: &Resp| r.body["event"]["stage_revealed"].as_i64().unwrap();

    assert_eq!(revealed(&reveal(&fx, "prev").await), 0, "prev clamps at 0");
    assert_eq!(revealed(&reveal(&fx, "all").await), 2);
    assert_eq!(
        revealed(&reveal(&fx, "next").await),
        2,
        "next clamps at total"
    );
    assert_eq!(revealed(&reveal(&fx, "prev").await), 1);
    assert_eq!(revealed(&reveal(&fx, "reset").await), 0);
    assert_eq!(reveal(&fx, "bogus").await.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn not_available_before_finalize() {
    let fx = ceremony(&TIED, false).await;
    let resp = reveal(&fx, "next").await;
    assert_eq!(resp.status, StatusCode::CONFLICT);
    assert_eq!(resp.body["error"], "invalid_state");

    let s = stage(&fx).await;
    assert_eq!(s.status, StatusCode::OK);
    assert_eq!(s.body["stage"]["available"], false);
    assert_eq!(s.body["rows"], json!([]));

    // Works again once finalized and also after publishing.
    fx.transition(json!({ "to": "finalized" })).await;
    assert_eq!(reveal(&fx, "all").await.status, StatusCode::OK);
    fx.transition(json!({ "to": "published" })).await;
    assert_eq!(reveal(&fx, "reset").await.status, StatusCode::OK);
    assert_eq!(stage(&fx).await.body["stage"]["available"], true);
}

#[tokio::test]
async fn draft_is_not_found_for_public_stage() {
    let fx = Fixture::new(1, false).await;
    assert_eq!(stage(&fx).await.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn leaderboard_shows_rows_below_top_n_podium_hides_them() {
    let fx = ceremony(&TIED, true).await;
    patch(&fx, json!({ "stage_view": "leaderboard" })).await;
    let s = stage(&fx).await;
    assert_eq!(names(&s), ["Команда 4", "Команда 5"]);

    reveal(&fx, "all").await;
    assert_eq!(names(&stage(&fx).await).len(), 5);

    patch(&fx, json!({ "stage_view": "podium" })).await;
    assert_eq!(names(&stage(&fx).await), ["Альфа", "Бета", "Команда 3"]);

    patch(&fx, json!({ "stage_view": "waiting" })).await;
    assert!(names(&stage(&fx).await).is_empty());
}

#[tokio::test]
async fn stage_never_leaks_per_judge_data() {
    let fx = ceremony(&TIED, true).await;
    reveal(&fx, "all").await;
    patch(&fx, json!({ "stage_view": "leaderboard" })).await;
    let s = stage(&fx).await;
    assert_eq!(s.body["rows"].as_array().unwrap().len(), 5);
    for row in s.body["rows"].as_array().unwrap() {
        assert!(row.get("judges").is_none(), "{row}");
        assert!(row["criteria"].is_array());
    }
    assert!(!s.text().contains("Судья 1"));
    assert!(!s.text().contains("judge_id"));
}

#[tokio::test]
async fn patch_validates_and_top_n_change_resets_revealed() {
    let fx = ceremony(&TIED, true).await;
    reveal(&fx, "all").await;

    for bad in [
        json!({ "stage_view": "x" }),
        json!({ "stage_top_n": 0 }),
        json!({ "stage_top_n": 11 }),
    ] {
        assert_eq!(patch(&fx, bad).await.status, StatusCode::BAD_REQUEST);
    }
    // Same value keeps progress; defaults are serialized.
    let same = patch(&fx, json!({ "stage_top_n": 3 })).await;
    assert_eq!(same.body["event"]["stage_revealed"], 2);
    assert_eq!(same.body["event"]["stage_view"], "waiting");

    let changed = patch(&fx, json!({ "stage_top_n": 2 })).await;
    assert_eq!(changed.status, StatusCode::OK);
    assert_eq!(changed.body["event"]["stage_top_n"], 2);
    assert_eq!(changed.body["event"]["stage_revealed"], 0);
    assert_eq!(stage(&fx).await.body["stage"]["total_groups"], 2);
}

#[tokio::test]
async fn reveal_requires_admin_session() {
    let fx = ceremony(&TIED, true).await;
    let resp = send(
        &fx.app,
        Method::POST,
        &format!("/api/events/{}/stage/reveal", fx.event_id),
        Some(json!({ "action": "next" })),
        Auth::None,
    )
    .await;
    assert_eq!(resp.status, StatusCode::UNAUTHORIZED);
    assert_eq!(fx.event().await["event"]["stage_revealed"], 0);
}

#[tokio::test]
async fn stage_changes_are_audited_and_emit_stage_kind() {
    let fx = ceremony(&TIED, true).await;
    let mut rx = fx.state.sse.subscribe(&fx.event_id);

    reveal(&fx, "next").await;
    assert_eq!(rx.try_recv().unwrap(), ChangeKind::Stage);
    assert!(rx.try_recv().is_err());

    patch(&fx, json!({ "stage_view": "podium" })).await;
    assert_eq!(rx.try_recv().unwrap(), ChangeKind::Event);
    assert_eq!(rx.try_recv().unwrap(), ChangeKind::Stage);

    let audit = fx
        .admin(Method::GET, &format!("/events/{}/audit", fx.event_id), None)
        .await;
    let actions: Vec<&str> = audit
        .body
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["action"].as_str().unwrap())
        .collect();
    assert!(actions.contains(&"event.stage_reveal"), "{actions:?}");
}
