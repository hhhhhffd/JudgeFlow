mod common;

use axum::http::{Method, StatusCode};
use common::{Auth, Fixture, send, send_bytes};
use serde_json::json;

const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0];
const JPEG: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, b'J', b'F', b'I', b'F'];

#[tokio::test]
async fn admin_routes_require_a_session() {
    let fx = Fixture::new(1, false).await;
    let id = &fx.event_id;
    let routes: Vec<(Method, String)> = vec![
        (Method::GET, "/api/events".into()),
        (Method::POST, "/api/events".into()),
        (Method::GET, format!("/api/events/{id}")),
        (Method::PATCH, format!("/api/events/{id}")),
        (Method::DELETE, format!("/api/events/{id}")),
        (Method::POST, format!("/api/events/{id}/transition")),
        (Method::POST, format!("/api/events/{id}/teams")),
        (Method::POST, format!("/api/events/{id}/criteria")),
        (Method::POST, format!("/api/events/{id}/judges")),
        (Method::PUT, format!("/api/events/{id}/background")),
        (Method::GET, format!("/api/events/{id}/matrix")),
        (Method::GET, format!("/api/events/{id}/results")),
        (Method::GET, format!("/api/events/{id}/export.csv")),
        (Method::GET, format!("/api/events/{id}/audit")),
        (Method::GET, format!("/api/events/{id}/stream")),
        (
            Method::POST,
            format!("/api/judges/{}/rotate", fx.judges[0].0),
        ),
        (Method::DELETE, format!("/api/teams/{}", fx.team_ids[0])),
    ];
    for (method, uri) in routes {
        let resp = send(&fx.app, method.clone(), &uri, Some(json!({})), Auth::None).await;
        assert_eq!(resp.status, StatusCode::UNAUTHORIZED, "{method} {uri}");
    }
    // A judge token is not an admin session.
    let resp = send(
        &fx.app,
        Method::GET,
        "/api/events",
        None,
        Auth::Bearer(&fx.judges[0].1),
    )
    .await;
    assert_eq!(resp.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn list_and_get_event() {
    let fx = Fixture::new(2, false).await;
    let list = fx.admin(Method::GET, "/events", None).await;
    assert_eq!(list.status, StatusCode::OK);
    let item = &list.body[0];
    assert_eq!(item["teams_count"], 2);
    assert_eq!(item["criteria_count"], 2);
    assert_eq!(item["judges_count"], 2);
    assert_eq!(item["submitted_count"], 0);

    let full = fx.event().await;
    assert_eq!(full["event"]["status"], "draft");
    assert_eq!(full["teams"].as_array().unwrap().len(), 2);
    assert_eq!(full["judges"][0]["scored_count"], 0);
    assert!(full["judges"][0].get("token_hash").is_none());
    let missing = fx.admin(Method::GET, "/events/nope", None).await;
    assert_eq!(missing.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn lifecycle_transitions() {
    let fx = Fixture::new(2, false).await;

    // Invalid jumps.
    for to in ["locked", "finalized", "published", "draft", "bogus"] {
        let resp = fx.transition(json!({ "to": to })).await;
        assert_eq!(resp.status, StatusCode::CONFLICT, "draft -> {to}");
        assert_eq!(resp.body["error"], "invalid_state");
    }

    // draft -> judging needs teams, criteria and an active judge.
    let empty = common::Fixture::new(0, false).await;
    let resp = empty.transition(json!({ "to": "judging" })).await;
    assert_eq!(resp.status, StatusCode::CONFLICT);
    assert_eq!(resp.body["details"]["missing"], json!(["judges"]));

    assert_eq!(
        fx.transition(json!({ "to": "judging" })).await.status,
        StatusCode::OK
    );
    // judging -> locked sets locked_at.
    let locked = fx.transition(json!({ "to": "locked" })).await;
    assert_eq!(locked.status, StatusCode::OK);
    assert!(locked.body["event"]["locked_at"].is_i64());

    // locked -> judging requires a reason.
    let no_reason = fx.transition(json!({ "to": "judging" })).await;
    assert_eq!(no_reason.status, StatusCode::BAD_REQUEST);
    let reopened = fx
        .transition(json!({ "to": "judging", "reason": "ошибка" }))
        .await;
    assert_eq!(reopened.status, StatusCode::OK);
    assert_eq!(reopened.body["event"]["status"], "judging");
    assert!(reopened.body["event"]["locked_at"].is_null());
    fx.transition(json!({ "to": "locked" })).await;

    // Finalize: unsubmitted judges block it and are listed.
    let blocked = fx.transition(json!({ "to": "finalized" })).await;
    assert_eq!(blocked.status, StatusCode::CONFLICT);
    assert_eq!(blocked.body["error"], "invalid_state");
    assert_eq!(
        blocked.body["details"]["unsubmitted"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    // force needs a reason.
    let no_reason = fx
        .transition(json!({ "to": "finalized", "force": true }))
        .await;
    assert_eq!(no_reason.status, StatusCode::BAD_REQUEST);
    let forced = fx
        .transition(json!({ "to": "finalized", "force": true, "reason": "судья ушёл" }))
        .await;
    assert_eq!(forced.status, StatusCode::OK, "{:?}", forced.body);
    assert_eq!(forced.body["event"]["status"], "finalized");

    let results = fx
        .admin(
            Method::GET,
            &format!("/events/{}/results?mode=official", fx.event_id),
            None,
        )
        .await;
    assert!(results.body["snapshot"]["id"].is_string());

    // finalized -> locked needs a reason; finalized <-> published.
    assert_eq!(
        fx.transition(json!({ "to": "locked" })).await.status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        fx.transition(json!({ "to": "published" })).await.status,
        StatusCode::OK
    );
    assert_eq!(
        fx.transition(json!({ "to": "finalized" })).await.status,
        StatusCode::OK
    );
    let back = fx
        .transition(json!({ "to": "locked", "reason": "пересчёт" }))
        .await;
    assert_eq!(back.status, StatusCode::OK);
    // Same-status and other jumps stay invalid.
    assert_eq!(
        fx.transition(json!({ "to": "locked" })).await.status,
        StatusCode::CONFLICT
    );

    let audit = fx
        .admin(Method::GET, &format!("/events/{}/audit", fx.event_id), None)
        .await;
    assert_eq!(audit.status, StatusCode::OK);
    let actions: Vec<&str> = audit
        .body
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["action"].as_str().unwrap())
        .collect();
    assert!(actions.contains(&"event.transition"));
    assert_eq!(audit.body[0]["admin_name"], "owner");
}

#[tokio::test]
async fn finalize_succeeds_without_force_when_everyone_submitted() {
    let fx = Fixture::new(1, true).await;
    fx.score_all(0, 1000, 500).await;
    assert_eq!(
        fx.judge(0, Method::POST, "/judge/submit", None)
            .await
            .status,
        StatusCode::OK
    );
    fx.transition(json!({ "to": "locked" })).await;
    let done = fx.transition(json!({ "to": "finalized" })).await;
    assert_eq!(done.status, StatusCode::OK, "{:?}", done.body);
}

#[tokio::test]
async fn composition_is_draft_only_but_judges_stay_editable() {
    let fx = Fixture::new(1, true).await;
    let id = &fx.event_id;

    let team = fx
        .admin(
            Method::POST,
            &format!("/events/{id}/teams"),
            Some(json!({ "name": "Гамма" })),
        )
        .await;
    assert_eq!(team.status, StatusCode::CONFLICT);
    assert_eq!(team.body["error"], "invalid_state");
    let del = fx
        .admin(Method::DELETE, &format!("/teams/{}", fx.team_ids[0]), None)
        .await;
    assert_eq!(del.status, StatusCode::CONFLICT);
    let crit = fx
        .admin(
            Method::PATCH,
            &format!("/criteria/{}", fx.criterion_ids[0]),
            Some(json!({ "weight": 5 })),
        )
        .await;
    assert_eq!(crit.status, StatusCode::CONFLICT);
    let mode = fx
        .admin(
            Method::PATCH,
            &format!("/events/{id}"),
            Some(json!({ "scoring_mode": "criterion" })),
        )
        .await;
    assert_eq!(mode.status, StatusCode::CONFLICT);
    let order = fx
        .admin(
            Method::PUT,
            &format!("/events/{id}/teams/order"),
            Some(json!({ "ids": fx.team_ids })),
        )
        .await;
    assert_eq!(order.status, StatusCode::CONFLICT);
    // Unchanged value and unrelated fields are fine.
    let ok = fx
        .admin(
            Method::PATCH,
            &format!("/events/{id}"),
            Some(json!({ "scoring_mode": "team", "title": "Новое" })),
        )
        .await;
    assert_eq!(ok.status, StatusCode::OK);

    // Judges can still be added in judging and locked.
    let added = fx
        .admin(
            Method::POST,
            &format!("/events/{id}/judges"),
            Some(json!({ "names": ["Новый"] })),
        )
        .await;
    assert_eq!(added.status, StatusCode::OK);
    fx.transition(json!({ "to": "locked" })).await;
    let renamed = fx
        .admin(
            Method::PATCH,
            &format!("/judges/{}", fx.judges[0].0),
            Some(json!({ "name": "Иван", "is_active": false })),
        )
        .await;
    assert_eq!(renamed.status, StatusCode::OK);
    assert_eq!(renamed.body["name"], "Иван");
    assert_eq!(renamed.body["is_active"], false);

    // ...but not once finalized.
    fx.transition(json!({ "to": "finalized", "force": true, "reason": "тест" }))
        .await;
    let blocked = fx
        .admin(
            Method::POST,
            &format!("/events/{id}/judges"),
            Some(json!({ "names": ["Поздно"] })),
        )
        .await;
    assert_eq!(blocked.status, StatusCode::CONFLICT);
    let rotate = fx
        .admin(
            Method::POST,
            &format!("/judges/{}/rotate", fx.judges[0].0),
            None,
        )
        .await;
    assert_eq!(rotate.status, StatusCode::CONFLICT);
}

#[tokio::test]
async fn teams_and_criteria_validation_and_order() {
    let fx = Fixture::new(0, false).await;
    let id = &fx.event_id;
    for body in [json!({ "name": "   " }), json!({ "name": "x".repeat(201) })] {
        let resp = fx
            .admin(Method::POST, &format!("/events/{id}/teams"), Some(body))
            .await;
        assert_eq!(resp.status, StatusCode::BAD_REQUEST);
        assert_eq!(resp.body["error"], "validation");
    }
    for body in [
        json!({ "name": "c", "max_x100": 1000, "step_x100": 300, "weight": 1 }),
        json!({ "name": "c", "max_x100": 1000, "step_x100": 0, "weight": 1 }),
        json!({ "name": "c", "max_x100": 0, "step_x100": 100, "weight": 1 }),
        json!({ "name": "c", "max_x100": 1000, "step_x100": 100, "weight": 0 }),
        json!({ "name": "c", "max_x100": 1000, "step_x100": 100, "weight": 1001 }),
        json!({ "name": "", "max_x100": 1000, "step_x100": 100, "weight": 1 }),
    ] {
        let resp = fx
            .admin(
                Method::POST,
                &format!("/events/{id}/criteria"),
                Some(body.clone()),
            )
            .await;
        assert_eq!(resp.status, StatusCode::BAD_REQUEST, "{body}");
    }
    // Patch that breaks max % step is rejected, a consistent one applies.
    let bad = fx
        .admin(
            Method::PATCH,
            &format!("/criteria/{}", fx.criterion_ids[0]),
            Some(json!({ "step_x100": 300 })),
        )
        .await;
    assert_eq!(bad.status, StatusCode::BAD_REQUEST);
    let good = fx
        .admin(
            Method::PATCH,
            &format!("/criteria/{}", fx.criterion_ids[0]),
            Some(json!({ "max_x100": 600, "step_x100": 300, "description": "d" })),
        )
        .await;
    assert_eq!(good.status, StatusCode::OK);
    assert_eq!(good.body["max_x100"], 600);
    assert_eq!(good.body["description"], "d");

    // Reorder.
    let mut reversed = fx.team_ids.clone();
    reversed.reverse();
    let order = fx
        .admin(
            Method::PUT,
            &format!("/events/{id}/teams/order"),
            Some(json!({ "ids": reversed })),
        )
        .await;
    assert_eq!(order.status, StatusCode::NO_CONTENT);
    let teams = fx.event().await["teams"].clone();
    assert_eq!(common::ids(&teams), reversed);
    let partial = fx
        .admin(
            Method::PUT,
            &format!("/events/{id}/teams/order"),
            Some(json!({ "ids": [fx.team_ids[0]] })),
        )
        .await;
    assert_eq!(partial.status, StatusCode::BAD_REQUEST);

    let del = fx
        .admin(Method::DELETE, &format!("/teams/{}", fx.team_ids[0]), None)
        .await;
    assert_eq!(del.status, StatusCode::NO_CONTENT);
    assert_eq!(fx.event().await["teams"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn patch_validation_and_alert_version() {
    let fx = Fixture::new(0, false).await;
    let path = format!("/events/{}", fx.event_id);
    for body in [
        json!({ "title": "" }),
        json!({ "quorum": 0 }),
        json!({ "visibility": "everyone" }),
        json!({ "overlay_color": "red" }),
        json!({ "overlay_color": "#12345" }),
        json!({ "overlay_opacity": 101 }),
        json!({ "overlay_opacity": -1 }),
        json!({ "alert_align": "right" }),
        json!({ "scoring_mode": "x" }),
    ] {
        let resp = fx.admin(Method::PATCH, &path, Some(body.clone())).await;
        assert_eq!(resp.status, StatusCode::BAD_REQUEST, "{body}");
    }
    let ok = fx
        .admin(
            Method::PATCH,
            &path,
            Some(json!({ "quorum": 2, "visibility": "live_full", "overlay_color": "#AABBCC", "overlay_opacity": 50,
                          "teams_label": "Проекты", "teams_label_enabled": true, "starts_at": 1700000000000i64 })),
        )
        .await;
    assert_eq!(ok.status, StatusCode::OK, "{:?}", ok.body);
    assert_eq!(ok.body["event"]["quorum"], 2);
    assert_eq!(ok.body["event"]["overlay_color"], "#aabbcc");
    assert_eq!(ok.body["event"]["teams_label"], "Проекты");
    // Explicit null clears, absence keeps.
    let cleared = fx
        .admin(Method::PATCH, &path, Some(json!({ "starts_at": null })))
        .await;
    assert!(cleared.body["event"]["starts_at"].is_null());
    assert_eq!(cleared.body["event"]["teams_label"], "Проекты");

    assert_eq!(cleared.body["event"]["alert_version"], 0);
    let alert = fx
        .admin(
            Method::PATCH,
            &path,
            Some(
                json!({ "alert_enabled": true, "alert_title": "Внимание", "alert_text": "Текст" }),
            ),
        )
        .await;
    assert_eq!(alert.body["event"]["alert_version"], 1);
    let again = fx
        .admin(
            Method::PATCH,
            &path,
            Some(json!({ "alert_text": "Новый текст" })),
        )
        .await;
    assert_eq!(again.body["event"]["alert_version"], 2);
    let unrelated = fx
        .admin(Method::PATCH, &path, Some(json!({ "title": "Другое" })))
        .await;
    assert_eq!(unrelated.body["event"]["alert_version"], 2);
    let off = fx
        .admin(
            Method::PATCH,
            &path,
            Some(json!({ "alert_enabled": false })),
        )
        .await;
    assert_eq!(off.body["event"]["alert_version"], 2);
}

#[tokio::test]
async fn judge_link_works_until_rotated() {
    let fx = Fixture::new(1, true).await;
    let (judge_id, old_token) = fx.judges[0].clone();
    let session = send(
        &fx.app,
        Method::GET,
        "/api/judge/session",
        None,
        Auth::Bearer(&old_token),
    )
    .await;
    assert_eq!(session.status, StatusCode::OK);

    let rotated = fx
        .admin(Method::POST, &format!("/judges/{judge_id}/rotate"), None)
        .await;
    assert_eq!(rotated.status, StatusCode::OK);
    let link = rotated.body["link"].as_str().unwrap();
    let new_token = link.rsplit('/').next().unwrap();
    assert_ne!(new_token, old_token);

    let old = send(
        &fx.app,
        Method::GET,
        "/api/judge/session",
        None,
        Auth::Bearer(&old_token),
    )
    .await;
    assert_eq!(old.status, StatusCode::UNAUTHORIZED);
    let new = send(
        &fx.app,
        Method::GET,
        "/api/judge/session",
        None,
        Auth::Bearer(new_token),
    )
    .await;
    assert_eq!(new.status, StatusCode::OK);

    // The raw token never appears in the event payload.
    let body = fx.event().await.to_string();
    assert!(!body.contains(new_token));

    // Reopen needs a reason and clears submitted_at.
    let no_reason = fx
        .admin(
            Method::POST,
            &format!("/judges/{judge_id}/reopen"),
            Some(json!({})),
        )
        .await;
    assert_eq!(no_reason.status, StatusCode::BAD_REQUEST);
    let reopened = fx
        .admin(
            Method::POST,
            &format!("/judges/{judge_id}/reopen"),
            Some(json!({ "reason": "поправить" })),
        )
        .await;
    assert_eq!(reopened.status, StatusCode::OK);
    assert!(reopened.body["submitted_at"].is_null());

    let deleted = fx
        .admin(Method::DELETE, &format!("/judges/{judge_id}"), None)
        .await;
    assert_eq!(deleted.status, StatusCode::NO_CONTENT);
    let gone = send(
        &fx.app,
        Method::GET,
        "/api/judge/session",
        None,
        Auth::Bearer(new_token),
    )
    .await;
    assert_eq!(gone.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn background_upload_checks_magic_bytes_and_replaces_old_file() {
    let fx = Fixture::new(0, false).await;
    let id = &fx.event_id;
    let path = format!("/api/events/{id}/background");
    let cookie = Auth::Cookie(&fx.cookie);

    // Content type and magic bytes must agree.
    let wrong = send_bytes(
        &fx.app,
        Method::PUT,
        &path,
        "image/png",
        JPEG.to_vec(),
        cookie,
    )
    .await;
    assert_eq!(wrong.status, StatusCode::BAD_REQUEST);
    let script = send_bytes(
        &fx.app,
        Method::PUT,
        &path,
        "image/png",
        b"<script>alert(1)</script>".to_vec(),
        cookie,
    )
    .await;
    assert_eq!(script.status, StatusCode::BAD_REQUEST);
    let svg = send_bytes(
        &fx.app,
        Method::PUT,
        &path,
        "image/svg+xml",
        b"<svg/>".to_vec(),
        cookie,
    )
    .await;
    assert_eq!(svg.status, StatusCode::BAD_REQUEST);
    let mut huge = PNG.to_vec();
    huge.resize(5 * 1024 * 1024 + 1, 0);
    let big = send_bytes(&fx.app, Method::PUT, &path, "image/png", huge, cookie).await;
    assert_eq!(big.status, StatusCode::PAYLOAD_TOO_LARGE);

    let public = format!("/api/public/events/{id}/background");
    assert_eq!(
        send(&fx.app, Method::GET, &public, None, Auth::None)
            .await
            .status,
        StatusCode::NOT_FOUND
    );

    let ok = send_bytes(
        &fx.app,
        Method::PUT,
        &path,
        "image/png",
        PNG.to_vec(),
        cookie,
    )
    .await;
    assert_eq!(ok.status, StatusCode::OK, "{:?}", ok.body);
    assert!(
        ok.body["event"]["background_url"]
            .as_str()
            .unwrap()
            .starts_with(&public)
    );
    let served = send(&fx.app, Method::GET, &public, None, Auth::None).await;
    assert_eq!(served.status, StatusCode::OK);
    assert_eq!(served.headers["content-type"], "image/png");
    assert_eq!(served.bytes, PNG);

    let uploads = fx.state.config.data_dir.join("uploads");
    assert!(uploads.join(format!("{id}.png")).exists());
    let replaced = send_bytes(
        &fx.app,
        Method::PUT,
        &path,
        "image/jpeg",
        JPEG.to_vec(),
        cookie,
    )
    .await;
    assert_eq!(replaced.status, StatusCode::OK);
    assert!(!uploads.join(format!("{id}.png")).exists());
    let served = send(&fx.app, Method::GET, &public, None, Auth::None).await;
    assert_eq!(served.headers["content-type"], "image/jpeg");

    let removed = send(&fx.app, Method::DELETE, &path, None, cookie).await;
    assert_eq!(removed.status, StatusCode::OK);
    assert!(removed.body["event"]["background_url"].is_null());
    assert!(!uploads.join(format!("{id}.jpg")).exists());
    assert_eq!(
        send(&fx.app, Method::GET, &public, None, Auth::None)
            .await
            .status,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn matrix_counts_scored_cells() {
    let fx = Fixture::new(2, true).await;
    fx.put_scores(
        0,
        json!([{ "team_id": fx.team_ids[0], "criterion_id": fx.criterion_ids[0], "value_x100": 300, "edited_at": common::now_ms() }]),
    )
    .await;
    let matrix = fx
        .admin(
            Method::GET,
            &format!("/events/{}/matrix", fx.event_id),
            None,
        )
        .await;
    assert_eq!(matrix.status, StatusCode::OK);
    let cells = matrix.body["cells"].as_array().unwrap();
    assert_eq!(cells.len(), 4);
    let first = cells
        .iter()
        .find(|c| c["judge_id"] == fx.judges[0].0 && c["team_id"] == fx.team_ids[0])
        .unwrap();
    assert_eq!(first["scored"], 1);
    assert_eq!(first["total"], 2);
    assert_eq!(matrix.body["teams"][0]["name"], "Альфа");
    let judge = fx.event().await["judges"][0].clone();
    assert_eq!(judge["scored_count"], 1);
}

#[tokio::test]
async fn csv_export_quotes_and_neutralizes_formulas() {
    let fx = Fixture::new(1, false).await;
    let id = &fx.event_id;
    fx.admin(
        Method::PATCH,
        &format!("/teams/{}", fx.team_ids[0]),
        Some(json!({ "name": "=cmd|' /C calc'!A0" })),
    )
    .await;
    fx.admin(
        Method::PATCH,
        &format!("/teams/{}", fx.team_ids[1]),
        Some(json!({ "name": "a;b \"c\"" })),
    )
    .await;
    fx.admin(
        Method::PATCH,
        &format!("/criteria/{}", fx.criterion_ids[0]),
        Some(json!({ "name": "@crit" })),
    )
    .await;
    fx.transition(json!({ "to": "judging" })).await;
    fx.score_all(0, 1000, 500).await;

    let csv = fx
        .admin(Method::GET, &format!("/events/{id}/export.csv"), None)
        .await;
    assert_eq!(csv.status, StatusCode::OK);
    assert!(
        csv.headers["content-type"]
            .to_str()
            .unwrap()
            .starts_with("text/csv")
    );
    assert!(csv.bytes.starts_with(&[0xEF, 0xBB, 0xBF]));
    let text = csv.text();
    assert!(text.contains("'=cmd|' /C calc'!A0;"), "{text}");
    assert!(text.contains("\"a;b \"\"c\"\"\";"), "{text}");
    assert!(text.contains(";'@crit;"), "{text}");
    assert!(text.contains("Судья 1"));
    assert!(text.contains("100,00"));
    // Header + 2 teams.
    assert_eq!(text.trim_end().lines().count(), 3);
}
