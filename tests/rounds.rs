mod common;

use axum::http::{Method, StatusCode};
use common::{Fixture, ids, now_ms};
use serde_json::{Value, json};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

/// Submits every judge, locks and finalizes the fixture's event.
async fn finalize(fx: &Fixture) {
    for idx in 0..fx.judges.len() {
        let resp = fx.judge(idx, Method::POST, "/judge/submit", None).await;
        assert_eq!(resp.status, StatusCode::OK, "{:?}", resp.body);
    }
    for to in ["locked", "finalized"] {
        let resp = fx.transition(json!({ "to": to })).await;
        assert_eq!(resp.status, StatusCode::OK, "{:?}", resp.body);
    }
}

async fn next_round(fx: &Fixture, event_id: &str, body: Value) -> common::Resp {
    fx.admin(
        Method::POST,
        &format!("/events/{event_id}/next-round"),
        Some(body),
    )
    .await
}

fn names(array: &Value) -> Vec<&str> {
    array
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["name"].as_str().unwrap())
        .collect()
}

#[tokio::test]
async fn next_round_copies_selected_teams_criteria_and_judges_with_new_tokens() {
    let fx = Fixture::new(2, true).await;
    fx.score_all(0, 800, 400).await;
    fx.score_all(1, 600, 300).await;
    finalize(&fx).await;

    let resp = next_round(
        &fx,
        &fx.event_id,
        json!({
            "title": "Финал",
            "team_ids": [fx.team_ids[1]],
            "scoring_mode": "criterion",
            "copy_criteria": true,
            "copy_judges": true,
        }),
    )
    .await;
    assert_eq!(resp.status, StatusCode::OK, "{:?}", resp.body);
    let full = &resp.body["event"];
    let event = &full["event"];
    assert_eq!(event["title"], "Финал");
    assert_eq!(event["status"], "draft");
    assert_eq!(event["scoring_mode"], "criterion");
    assert_eq!(event["parent_event_id"], fx.event_id);
    assert_eq!(event["round"], 2);
    assert_ne!(event["id"], json!(fx.event_id));
    assert_eq!(names(&full["teams"]), ["Бета"]);
    assert_eq!(full["teams"][0]["description"], "вторая");
    assert_ne!(full["teams"][0]["id"], json!(fx.team_ids[1]));
    assert_eq!(names(&full["criteria"]), ["Идея", "Реализация"]);
    assert_eq!(full["criteria"][1]["weight"], 3);
    assert_eq!(names(&full["judges"]), ["Судья 1", "Судья 2"]);
    // New events start without any scores.
    assert!(
        full["judges"]
            .as_array()
            .unwrap()
            .iter()
            .all(|j| j["scored_count"] == 0 && j["submitted_at"].is_null())
    );

    // Fresh tokens: they open the new round, not the parent, and differ from the old ones.
    let links = resp.body["links"].as_array().unwrap();
    assert_eq!(links.len(), 2);
    for (link, (_, old_token)) in links.iter().zip(&fx.judges) {
        let token = link["link"]
            .as_str()
            .unwrap()
            .strip_prefix("http://localhost:8080/j/")
            .unwrap();
        assert_ne!(token, old_token);
        let session = common::send(
            &fx.app,
            Method::GET,
            "/api/judge/session",
            None,
            common::Auth::Bearer(token),
        )
        .await;
        assert_eq!(session.status, StatusCode::OK, "{:?}", session.body);
        assert_eq!(session.body["event"]["id"], event["id"]);
        assert_eq!(session.body["judge"]["name"], link["judge"]["name"]);
    }
    // The old links still open the parent.
    let old = fx.judge(0, Method::GET, "/judge/session", None).await;
    assert_eq!(old.body["event"]["id"], fx.event_id);

    // The list exposes the linkage.
    let list = fx.admin(Method::GET, "/events", None).await;
    let items = list.body.as_array().unwrap();
    let child = items.iter().find(|e| e["id"] == event["id"]).unwrap();
    assert_eq!(child["parent_event_id"], fx.event_id);
    assert_eq!(child["round"], 2);
    let parent = items.iter().find(|e| e["id"] == fx.event_id).unwrap();
    assert!(parent["parent_event_id"].is_null());
    assert_eq!(parent["round"], 1);

    // Both events are audited.
    for id in [fx.event_id.as_str(), event["id"].as_str().unwrap()] {
        let audit = fx
            .admin(Method::GET, &format!("/events/{id}/audit"), None)
            .await;
        let actions: Vec<&str> = audit
            .body
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a["action"].as_str().unwrap())
            .collect();
        let expected = if id == fx.event_id {
            "event.next_round"
        } else {
            "event.create"
        };
        assert!(actions.contains(&expected), "{id}: {actions:?}");
    }
}

#[tokio::test]
async fn next_round_without_copies_and_from_published() {
    let fx = Fixture::new(1, true).await;
    fx.score_all(0, 800, 400).await;
    finalize(&fx).await;
    let published = fx.transition(json!({ "to": "published" })).await;
    assert_eq!(published.status, StatusCode::OK);

    let resp = next_round(
        &fx,
        &fx.event_id,
        json!({ "title": "Раунд 2", "team_ids": fx.team_ids, "scoring_mode": "team",
                "copy_criteria": false, "copy_judges": false }),
    )
    .await;
    assert_eq!(resp.status, StatusCode::OK, "{:?}", resp.body);
    assert_eq!(names(&resp.body["event"]["teams"]), ["Альфа", "Бета"]);
    assert_eq!(resp.body["event"]["criteria"], json!([]));
    assert_eq!(resp.body["event"]["judges"], json!([]));
    assert_eq!(resp.body["links"], json!([]));

    // A draft round cannot be continued until it is finalized.
    let child_id = resp.body["event"]["event"]["id"].as_str().unwrap();
    let again = next_round(
        &fx,
        child_id,
        json!({ "title": "Раунд 3", "team_ids": [fx.team_ids[0]], "scoring_mode": "team" }),
    )
    .await;
    assert_eq!(again.status, StatusCode::CONFLICT);
    assert_eq!(again.body["error"], "invalid_state");
}

#[tokio::test]
async fn next_round_only_from_finalized_and_published() {
    let fx = Fixture::new(1, true).await;
    let body = json!({ "title": "Раунд 2", "team_ids": [fx.team_ids[0]], "scoring_mode": "team" });
    for to in [None, Some("locked")] {
        if let Some(to) = to {
            let resp = fx.transition(json!({ "to": to })).await;
            assert_eq!(resp.status, StatusCode::OK);
        }
        let resp = next_round(&fx, &fx.event_id, body.clone()).await;
        assert_eq!(resp.status, StatusCode::CONFLICT, "{:?}", resp.body);
        assert_eq!(resp.body["error"], "invalid_state");
    }
    // Nothing was created.
    let list = fx.admin(Method::GET, "/events", None).await;
    assert_eq!(list.body.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn next_round_validates_input() {
    let fx = Fixture::new(1, true).await;
    fx.score_all(0, 800, 400).await;
    finalize(&fx).await;
    let team = &fx.team_ids[0];
    for body in [
        json!({ "title": " ", "team_ids": [team], "scoring_mode": "team" }),
        json!({ "title": "X", "team_ids": [], "scoring_mode": "team" }),
        json!({ "title": "X", "team_ids": [team, team], "scoring_mode": "team" }),
        json!({ "title": "X", "team_ids": ["nope"], "scoring_mode": "team" }),
        json!({ "title": "X", "team_ids": [team], "scoring_mode": "weird" }),
    ] {
        let resp = next_round(&fx, &fx.event_id, body.clone()).await;
        assert_eq!(
            resp.status,
            StatusCode::BAD_REQUEST,
            "{body}: {:?}",
            resp.body
        );
    }
    let missing = next_round(
        &fx,
        "no-such-event",
        json!({ "title": "X", "team_ids": [team], "scoring_mode": "team" }),
    )
    .await;
    assert_eq!(missing.status, StatusCode::NOT_FOUND);
    let list = fx.admin(Method::GET, "/events", None).await;
    assert_eq!(list.body.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn next_round_remaps_tracks_of_selected_teams() {
    let fx = Fixture::new(1, false).await;
    let mut tracks = Vec::new();
    for name in ["Веб", "Мобайл"] {
        let resp = fx
            .admin(
                Method::POST,
                &format!("/events/{}/tracks", fx.event_id),
                Some(json!({ "name": name })),
            )
            .await;
        assert_eq!(resp.status, StatusCode::OK, "{:?}", resp.body);
        tracks.push(resp.body["id"].as_str().unwrap().to_string());
    }
    for (team, track) in fx.team_ids.iter().zip(&tracks) {
        let resp = fx
            .admin(
                Method::PATCH,
                &format!("/teams/{team}"),
                Some(json!({ "track_id": track })),
            )
            .await;
        assert_eq!(resp.status, StatusCode::OK, "{:?}", resp.body);
    }
    let resp = fx
        .admin(
            Method::PATCH,
            &format!("/criteria/{}", fx.criterion_ids[1]),
            Some(json!({ "track_id": tracks[1] })),
        )
        .await;
    assert_eq!(resp.status, StatusCode::OK, "{:?}", resp.body);
    assert_eq!(
        fx.transition(json!({ "to": "judging" })).await.status,
        StatusCode::OK
    );
    // Team 0 has only the shared criterion, team 1 also the track-bound one.
    let at = now_ms();
    let resp = fx
        .put_scores(
            0,
            json!([
                { "team_id": fx.team_ids[0], "criterion_id": fx.criterion_ids[0], "value_x100": 800, "edited_at": at },
                { "team_id": fx.team_ids[1], "criterion_id": fx.criterion_ids[0], "value_x100": 800, "edited_at": at },
                { "team_id": fx.team_ids[1], "criterion_id": fx.criterion_ids[1], "value_x100": 400, "edited_at": at },
            ]),
        )
        .await;
    assert_eq!(resp.status, StatusCode::OK, "{:?}", resp.body);
    finalize(&fx).await;

    // Without copy_criteria only the tracks of the selected teams are carried over.
    let resp = next_round(
        &fx,
        &fx.event_id,
        json!({ "title": "Раунд 2", "team_ids": [fx.team_ids[1]], "scoring_mode": "team" }),
    )
    .await;
    assert_eq!(resp.status, StatusCode::OK, "{:?}", resp.body);
    let full = &resp.body["event"];
    assert_eq!(names(&full["tracks"]), ["Мобайл"]);
    let new_track = full["tracks"][0]["id"].as_str().unwrap();
    assert_ne!(new_track, tracks[1]);
    assert_eq!(full["teams"][0]["track_id"], new_track);

    // With copy_criteria all tracks and the track-bound criterion come along, remapped.
    let resp = next_round(
        &fx,
        &fx.event_id,
        json!({ "title": "Раунд 2б", "team_ids": fx.team_ids, "scoring_mode": "team",
                "copy_criteria": true }),
    )
    .await;
    assert_eq!(resp.status, StatusCode::OK, "{:?}", resp.body);
    let full = &resp.body["event"];
    assert_eq!(names(&full["tracks"]), ["Веб", "Мобайл"]);
    let mobile = full["tracks"][1]["id"].as_str().unwrap();
    assert_eq!(full["criteria"][0]["track_id"], Value::Null);
    assert_eq!(full["criteria"][1]["track_id"], mobile);
    assert_eq!(full["teams"][1]["track_id"], mobile);
}

// ---- migration 0005 ----

#[tokio::test]
async fn migration_0005_keeps_data_and_cascades() {
    let dir = std::env::temp_dir().join(format!("judgeflow-mig-{}", common::now_ms()));
    std::fs::create_dir_all(&dir).unwrap();
    let options = SqliteConnectOptions::new()
        .filename(dir.join("db.sqlite"))
        .create_if_missing(true)
        .foreign_keys(true);
    // One connection: the migration relies on the pragma staying on the connection it runs on.
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap();
    let migrator = sqlx::migrate!("./migrations");
    migrator.run_to(4, &pool).await.unwrap();

    for sql in [
        "INSERT INTO events (id, title, status, scoring_mode, stage_top_n, created_at, updated_at) \
         VALUES ('e1', 'Old', 'locked', 'criterion', 5, 1, 2), ('e2', 'Other', 'draft', 'team', 3, 1, 2)",
        "INSERT INTO tracks (id, event_id, name, sort_order) VALUES ('tr1', 'e1', 'T', 0)",
        "UPDATE events SET stage_track_id = 'tr1' WHERE id = 'e1'",
        "INSERT INTO teams (id, event_id, name, track_id) VALUES ('t1', 'e1', 'A', 'tr1'), ('t2', 'e2', 'B', NULL)",
        "INSERT INTO criteria (id, event_id, name, max_x100, step_x100) VALUES ('c1', 'e1', 'C', 1000, 100)",
        "INSERT INTO judges (id, event_id, name, token_hash, created_at) VALUES ('j1', 'e1', 'J', 'h1', 1)",
        "INSERT INTO scores (judge_id, team_id, criterion_id, value_x100, edited_at, updated_at) \
         VALUES ('j1', 't1', 'c1', 700, 1, 1)",
        "INSERT INTO assignments (judge_id, team_id) VALUES ('j1', 't1')",
        "INSERT INTO result_snapshots (id, event_id, created_at, payload) VALUES ('s1', 'e1', 1, '{}')",
    ] {
        sqlx::query(sql).execute(&pool).await.unwrap();
    }

    migrator.run(&pool).await.unwrap();

    // Foreign keys are back on and nothing was cascaded away by the rebuild.
    let fk: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(fk, 1);
    let violations = sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert!(violations.is_empty());
    let count = |table: &'static str| {
        let pool = pool.clone();
        async move {
            sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(format!(
                "SELECT COUNT(*) FROM {table}"
            )))
            .fetch_one(&pool)
            .await
            .unwrap()
        }
    };
    for (table, expected) in [
        ("events", 2),
        ("tracks", 1),
        ("teams", 2),
        ("criteria", 1),
        ("judges", 1),
        ("scores", 1),
        ("assignments", 1),
        ("result_snapshots", 1),
    ] {
        assert_eq!(count(table).await, expected, "{table}");
    }
    let row: (String, String, i64, Option<String>, Option<String>, i64, String) = sqlx::query_as(
        "SELECT title, scoring_mode, stage_top_n, stage_track_id, parent_event_id, round, normalization \
         FROM events WHERE id = 'e1'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        row,
        (
            "Old".into(),
            "criterion".into(),
            5,
            Some("tr1".into()),
            None,
            1,
            "none".into()
        )
    );

    // The widened CHECK accepts pairwise; the old values still work, junk does not.
    sqlx::query("UPDATE events SET scoring_mode = 'pairwise' WHERE id = 'e2'")
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        sqlx::query("UPDATE events SET scoring_mode = 'bogus' WHERE id = 'e2'")
            .execute(&pool)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("UPDATE events SET normalization = 'bogus' WHERE id = 'e2'")
            .execute(&pool)
            .await
            .is_err()
    );

    // Children reference the rebuilt table: ON DELETE CASCADE still works from every parent link.
    sqlx::query(
        "INSERT INTO comparisons (id, event_id, judge_id, team_a, team_b, created_at) \
         VALUES ('p1', 'e1', 'j1', 't1', 't1', 1)",
    )
    .execute(&pool)
    .await
    .expect_err("a team cannot be compared with itself");
    sqlx::query("INSERT INTO teams (id, event_id, name) VALUES ('t3', 'e1', 'A2')")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO comparisons (id, event_id, judge_id, team_a, team_b, created_at) \
         VALUES ('p1', 'e1', 'j1', 't1', 't3', 1)",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("DELETE FROM events WHERE id = 'e1'")
        .execute(&pool)
        .await
        .unwrap();
    for table in [
        "tracks",
        "criteria",
        "judges",
        "scores",
        "assignments",
        "result_snapshots",
        "comparisons",
    ] {
        assert_eq!(count(table).await, 0, "{table} survived the event");
    }
    assert_eq!(
        count("teams").await,
        1,
        "only the other event's team is left"
    );

    // parent_event_id is SET NULL when the parent goes away.
    sqlx::query(
        "INSERT INTO events (id, title, parent_event_id, round, created_at, updated_at) \
         VALUES ('e3', 'Child', 'e2', 2, 1, 2)",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("DELETE FROM events WHERE id = 'e2'")
        .execute(&pool)
        .await
        .unwrap();
    let parent: Option<String> =
        sqlx::query_scalar("SELECT parent_event_id FROM events WHERE id = 'e3'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(parent, None);
    std::fs::remove_dir_all(&dir).ok();
}

// ---- normalization and pairwise validation through the API ----

async fn patch_event(fx: &Fixture, body: Value) -> common::Resp {
    fx.admin(
        Method::PATCH,
        &format!("/events/{}", fx.event_id),
        Some(body),
    )
    .await
}

/// Teams a, b, c, d; the lenient judge 0 judges a and c, the strict judge 1 judges b and d.
/// Percent scores: a 80, c 90 (lenient), b 70, d 50 (strict).
async fn disjoint_judges() -> (Fixture, Vec<String>) {
    let fx = Fixture::new(2, false).await;
    let more = fx
        .admin(
            Method::POST,
            &format!("/events/{}/teams/bulk", fx.event_id),
            Some(json!({ "teams": [{ "name": "Вега" }, { "name": "Дельта" }] })),
        )
        .await;
    assert_eq!(more.status, StatusCode::OK, "{:?}", more.body);
    let teams: Vec<String> = fx.team_ids.iter().cloned().chain(ids(&more.body)).collect();
    // a = Альфа, b = Бета, c = Вега, d = Дельта
    let pairs = json!([
        { "judge_id": fx.judges[0].0, "team_id": teams[0] },
        { "judge_id": fx.judges[0].0, "team_id": teams[2] },
        { "judge_id": fx.judges[1].0, "team_id": teams[1] },
        { "judge_id": fx.judges[1].0, "team_id": teams[3] },
    ]);
    let resp = fx
        .admin(
            Method::PUT,
            &format!("/events/{}/assignments", fx.event_id),
            Some(json!({ "pairs": pairs })),
        )
        .await;
    assert_eq!(resp.status, StatusCode::OK, "{:?}", resp.body);
    let started = fx.transition(json!({ "to": "judging" })).await;
    assert_eq!(started.status, StatusCode::OK, "{:?}", started.body);
    let at = now_ms();
    for (judge, team, percent) in [(0, 0, 80), (0, 2, 90), (1, 1, 70), (1, 3, 50)] {
        let items = json!([
            { "team_id": teams[team], "criterion_id": fx.criterion_ids[0], "value_x100": percent * 10, "edited_at": at },
            { "team_id": teams[team], "criterion_id": fx.criterion_ids[1], "value_x100": percent * 5, "edited_at": at },
        ]);
        let resp = fx.put_scores(judge, items).await;
        assert_eq!(resp.status, StatusCode::OK, "{:?}", resp.body);
    }
    (fx, teams)
}

fn scores_by_name(ranking: &Value) -> Vec<(String, i64, Option<i64>)> {
    ranking["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["team_name"].as_str().unwrap().to_string(),
                r["score_x100"].as_i64().unwrap(),
                r["raw_score_x100"].as_i64(),
            )
        })
        .collect()
}

#[tokio::test]
async fn center_normalization_flips_disjoint_judges_and_is_frozen_in_the_snapshot() {
    let (fx, _) = disjoint_judges().await;
    let results = format!("/events/{}/results?mode=provisional", fx.event_id);

    // Off by default: raw order, no raw_score_x100 field at all.
    let raw = fx.admin(Method::GET, &results, None).await;
    assert_eq!(raw.status, StatusCode::OK);
    assert_eq!(
        scores_by_name(&raw.body),
        [
            ("Вега".to_string(), 9000, None),
            ("Альфа".to_string(), 8000, None),
            ("Бета".to_string(), 7000, None),
            ("Дельта".to_string(), 5000, None),
        ]
    );
    assert!(raw.body["rows"][0].get("raw_score_x100").is_none());

    // Allowed while judging; the response is the full event.
    let patched = patch_event(&fx, json!({ "normalization": "center" })).await;
    assert_eq!(patched.status, StatusCode::OK, "{:?}", patched.body);
    assert_eq!(patched.body["event"]["normalization"], "center");
    let centered = fx.admin(Method::GET, &results, None).await;
    // Lenient judge offset +12.5, strict -12.5.
    assert_eq!(
        scores_by_name(&centered.body),
        [
            ("Бета".to_string(), 8250, Some(7000)),
            ("Вега".to_string(), 7750, Some(9000)),
            ("Альфа".to_string(), 6750, Some(8000)),
            ("Дельта".to_string(), 6250, Some(5000)),
        ]
    );
    // Per-judge scores stay raw.
    assert_eq!(centered.body["rows"][0]["judges"][0]["score_x100"], 7000);

    // Also allowed when locked.
    for judge in 0..2 {
        let resp = fx.judge(judge, Method::POST, "/judge/submit", None).await;
        assert_eq!(resp.status, StatusCode::OK, "{:?}", resp.body);
    }
    assert_eq!(
        fx.transition(json!({ "to": "locked" })).await.status,
        StatusCode::OK
    );
    assert_eq!(
        patch_event(&fx, json!({ "normalization": "center" }))
            .await
            .status,
        StatusCode::OK
    );
    assert_eq!(
        fx.transition(json!({ "to": "finalized" })).await.status,
        StatusCode::OK
    );

    // The snapshot carries the normalized and the raw score.
    let official = fx
        .admin(
            Method::GET,
            &format!("/events/{}/results?mode=official", fx.event_id),
            None,
        )
        .await;
    assert!(official.body["snapshot"].is_object());
    assert_eq!(
        scores_by_name(&official.body),
        scores_by_name(&centered.body)
    );

    // Frozen once finalized: changing the method is a 409, a no-op repeat is fine.
    let resp = patch_event(&fx, json!({ "normalization": "none" })).await;
    assert_eq!(resp.status, StatusCode::CONFLICT, "{:?}", resp.body);
    assert_eq!(resp.body["error"], "invalid_state");
    assert_eq!(
        patch_event(&fx, json!({ "normalization": "center" }))
            .await
            .status,
        StatusCode::OK
    );
    assert_eq!(
        patch_event(&fx, json!({ "normalization": "bogus" }))
            .await
            .status,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn pairwise_mode_is_accepted_but_not_combined_with_normalization() {
    let fx = Fixture::new(1, false).await;
    assert_eq!(
        patch_event(&fx, json!({ "normalization": "center" }))
            .await
            .status,
        StatusCode::OK
    );
    // Switching to pairwise resets the rubric-only normalization.
    let resp = patch_event(&fx, json!({ "scoring_mode": "pairwise" })).await;
    assert_eq!(resp.status, StatusCode::OK, "{:?}", resp.body);
    assert_eq!(resp.body["event"]["scoring_mode"], "pairwise");
    assert_eq!(resp.body["event"]["normalization"], "none");
    let resp = patch_event(&fx, json!({ "normalization": "center" })).await;
    assert_eq!(resp.status, StatusCode::BAD_REQUEST, "{:?}", resp.body);
    assert_eq!(
        patch_event(&fx, json!({ "scoring_mode": "bogus" }))
            .await
            .status,
        StatusCode::BAD_REQUEST
    );

    // Pairwise needs two teams and an active judge, but no criteria.
    for id in &fx.criterion_ids {
        let resp = fx
            .admin(Method::DELETE, &format!("/criteria/{id}"), None)
            .await;
        assert_eq!(resp.status, StatusCode::NO_CONTENT);
    }
    let resp = fx
        .admin(Method::DELETE, &format!("/teams/{}", fx.team_ids[1]), None)
        .await;
    assert_eq!(resp.status, StatusCode::NO_CONTENT);
    let blocked = fx.transition(json!({ "to": "judging" })).await;
    assert_eq!(blocked.status, StatusCode::CONFLICT, "{:?}", blocked.body);
    assert_eq!(blocked.body["details"]["missing"], json!(["teams"]));

    let resp = fx
        .admin(
            Method::POST,
            &format!("/events/{}/teams", fx.event_id),
            Some(json!({ "name": "Вега" })),
        )
        .await;
    assert_eq!(resp.status, StatusCode::OK, "{:?}", resp.body);
    let started = fx.transition(json!({ "to": "judging" })).await;
    assert_eq!(started.status, StatusCode::OK, "{:?}", started.body);
}

#[tokio::test]
async fn rubric_events_still_require_criteria() {
    let fx = Fixture::new(1, false).await;
    for id in &fx.criterion_ids {
        fx.admin(Method::DELETE, &format!("/criteria/{id}"), None)
            .await;
    }
    let blocked = fx.transition(json!({ "to": "judging" })).await;
    assert_eq!(blocked.status, StatusCode::CONFLICT);
    assert_eq!(blocked.body["details"]["missing"], json!(["criteria"]));
}
