mod common;

use axum::http::{Method, StatusCode};
use common::{Auth, Fixture, Resp, ids, now_ms, send, send_bytes};
use serde_json::{Value, json};

/// Teams: Альфа (track 1), Бета (track 2), Гамма (track 1). Criteria: «Идея» for everyone,
/// «Реализация» for track 2 only.
struct Tracked {
    fx: Fixture,
    tracks: Vec<String>,
    /// [Альфа, Бета, Гамма]
    teams: Vec<String>,
}

impl Tracked {
    fn idea(&self) -> &str {
        &self.fx.criterion_ids[0]
    }

    fn implementation(&self) -> &str {
        &self.fx.criterion_ids[1]
    }

    async fn event_ok(&self, method: Method, path: &str, body: Option<Value>) -> Value {
        let resp = self.fx.admin(method, path, body).await;
        assert_eq!(resp.status, StatusCode::OK, "{path}: {:?}", resp.body);
        resp.body
    }

    async fn ranking(&self, mode: &str) -> Value {
        self.event_ok(
            Method::GET,
            &format!("/events/{}/results?mode={mode}", self.fx.event_id),
            None,
        )
        .await
    }

    /// Saves scores in bulk; every item must be accepted.
    async fn score(&self, judge: usize, items: &[(&str, &str, i64)]) {
        let at = now_ms();
        let items: Vec<Value> = items
            .iter()
            .map(|(team, criterion, value)| item(team, criterion, *value, at))
            .collect();
        let resp = self.fx.put_scores(judge, Value::Array(items)).await;
        assert_eq!(resp.status, StatusCode::OK, "{:?}", resp.body);
        for r in resp.body["results"].as_array().unwrap() {
            assert_eq!(r["status"], "ok", "{r}");
        }
    }

    /// Alpha/Gamma idea only, Beta idea + implementation.
    async fn score_everything(&self, judge: usize, idea: [i64; 3], implementation: i64) {
        self.score(
            judge,
            &[
                (&self.teams[0], self.idea(), idea[0]),
                (&self.teams[1], self.idea(), idea[1]),
                (&self.teams[1], self.implementation(), implementation),
                (&self.teams[2], self.idea(), idea[2]),
            ],
        )
        .await;
    }

    async fn finalize(&self) {
        for idx in 0..self.fx.judges.len() {
            let resp = self
                .fx
                .judge(idx, Method::POST, "/judge/submit", None)
                .await;
            assert_eq!(resp.status, StatusCode::OK, "{:?}", resp.body);
        }
        for to in ["locked", "finalized"] {
            let resp = self.fx.transition(json!({ "to": to })).await;
            assert_eq!(resp.status, StatusCode::OK, "{:?}", resp.body);
        }
    }

    async fn assign(&self, path: &str, pairs: &[(usize, usize)]) -> Resp {
        let pairs: Vec<Value> = pairs
            .iter()
            .map(|(j, t)| json!({ "judge_id": self.fx.judges[*j].0, "team_id": self.teams[*t] }))
            .collect();
        self.fx
            .admin(
                Method::PUT,
                &format!("/events/{}/{path}", self.fx.event_id),
                Some(json!({ "pairs": pairs })),
            )
            .await
    }

    async fn session(&self, judge: usize) -> Value {
        let resp = self
            .fx
            .judge(judge, Method::GET, "/judge/session", None)
            .await;
        assert_eq!(resp.status, StatusCode::OK);
        resp.body
    }

    async fn matrix_cell(&self, judge: usize, team: usize) -> Value {
        let matrix = self
            .event_ok(
                Method::GET,
                &format!("/events/{}/matrix", self.fx.event_id),
                None,
            )
            .await;
        matrix["cells"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["judge_id"] == self.fx.judges[judge].0 && c["team_id"] == self.teams[team])
            .unwrap()
            .clone()
    }
}

fn item(team: &str, criterion: &str, value: i64, at: i64) -> Value {
    json!({ "team_id": team, "criterion_id": criterion, "value_x100": value, "edited_at": at })
}

async fn tracked(judges: usize, start: bool) -> Tracked {
    let fx = Fixture::new(judges, false).await;
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
    let gamma = fx
        .admin(
            Method::POST,
            &format!("/events/{}/teams", fx.event_id),
            Some(json!({ "name": "Гамма", "track_id": tracks[0] })),
        )
        .await;
    assert_eq!(gamma.status, StatusCode::OK, "{:?}", gamma.body);
    let teams = vec![
        fx.team_ids[0].clone(),
        fx.team_ids[1].clone(),
        gamma.body["id"].as_str().unwrap().to_string(),
    ];
    for (team, track) in [(&teams[0], &tracks[0]), (&teams[1], &tracks[1])] {
        let resp = fx
            .admin(
                Method::PATCH,
                &format!("/teams/{team}"),
                Some(json!({ "track_id": track })),
            )
            .await;
        assert_eq!(resp.status, StatusCode::OK, "{:?}", resp.body);
        assert_eq!(resp.body["track_id"], *track);
    }
    let resp = fx
        .admin(
            Method::PATCH,
            &format!("/criteria/{}", fx.criterion_ids[1]),
            Some(json!({ "track_id": tracks[1] })),
        )
        .await;
    assert_eq!(resp.status, StatusCode::OK, "{:?}", resp.body);
    if start {
        let resp = fx.transition(json!({ "to": "judging" })).await;
        assert_eq!(resp.status, StatusCode::OK, "{:?}", resp.body);
    }
    Tracked { fx, tracks, teams }
}

fn team_ids(session: &Value) -> Vec<String> {
    ids(&session["teams"])
}

#[tokio::test]
async fn ranking_is_computed_per_track_with_restarting_ranks() {
    let t = tracked(1, true).await;
    t.score_everything(0, [800, 500, 600], 500).await;

    let ranking = t.ranking("provisional").await;
    let rows: Vec<(String, Value, Value, Value)> = ranking["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["team_name"].as_str().unwrap().to_string(),
                r["rank"].clone(),
                r["score_x100"].clone(),
                r["track_id"].clone(),
            )
        })
        .collect();
    assert_eq!(
        rows,
        vec![
            ("Альфа".into(), json!(1), json!(8000), json!(t.tracks[0])),
            ("Гамма".into(), json!(2), json!(6000), json!(t.tracks[0])),
            // (1*5/10 + 3*5/5) / 4 = 87.5: the track-2 criterion counts only for track 2.
            ("Бета".into(), json!(1), json!(8750), json!(t.tracks[1])),
        ]
    );
    assert_eq!(ranking["rows"][0]["criteria"].as_array().unwrap().len(), 1);
    assert_eq!(ranking["rows"][2]["criteria"].as_array().unwrap().len(), 2);
    assert_eq!(
        ranking["tracks"],
        json!([{ "id": t.tracks[0], "name": "Веб" }, { "id": t.tracks[1], "name": "Мобайл" }])
    );

    // CSV: a track column appears and criteria columns stay aligned for every row.
    let csv =
        t.fx.admin(
            Method::GET,
            &format!("/events/{}/export.csv", t.fx.event_id),
            None,
        )
        .await
        .text();
    let lines: Vec<&str> = csv.trim_start_matches('\u{feff}').lines().collect();
    assert!(lines[0].starts_with("Место;Команда;Трек;Балл;Листов;Кворум;Идея;Реализация;"));
    assert!(lines[1].starts_with("1;Альфа;Веб;80,00;"), "{}", lines[1]);
    assert!(lines[1].contains(";8,00;;"), "{}", lines[1]);
}

#[tokio::test]
async fn event_without_tracks_has_no_track_column_and_null_track_ids() {
    let fx = Fixture::new(1, true).await;
    fx.score_all(0, 800, 400).await;
    let ranking = fx
        .admin(
            Method::GET,
            &format!("/events/{}/results", fx.event_id),
            None,
        )
        .await
        .body;
    assert_eq!(ranking["tracks"], json!([]));
    assert!(ranking["rows"][0]["track_id"].is_null());
    let csv = fx
        .admin(
            Method::GET,
            &format!("/events/{}/export.csv", fx.event_id),
            None,
        )
        .await
        .text();
    assert!(csv.contains("Место;Команда;Балл;"), "{csv}");
}

#[tokio::test]
async fn submit_requires_only_the_criteria_of_the_teams_track() {
    let t = tracked(1, true).await;
    t.score(
        0,
        &[
            (&t.teams[0], t.idea(), 800),
            (&t.teams[1], t.idea(), 500),
            (&t.teams[2], t.idea(), 600),
        ],
    )
    .await;
    let submit = t.fx.judge(0, Method::POST, "/judge/submit", None).await;
    assert_eq!(submit.status, StatusCode::CONFLICT);
    assert_eq!(
        submit.body["details"]["missing"],
        json!([{ "team_id": t.teams[1], "criterion_id": t.implementation() }])
    );

    // A criterion of another track cannot be scored for the team.
    let resp =
        t.fx.put_scores(
            0,
            json!([item(&t.teams[0], t.implementation(), 100, now_ms())]),
        )
        .await;
    assert_eq!(resp.body["results"][0]["status"], "rejected");
    assert_eq!(resp.body["results"][0]["error"], "not_assigned");

    t.score(0, &[(&t.teams[1], t.implementation(), 250)]).await;
    let submit = t.fx.judge(0, Method::POST, "/judge/submit", None).await;
    assert_eq!(submit.status, StatusCode::OK, "{:?}", submit.body);
}

#[tokio::test]
async fn assignments_restrict_session_scores_and_matrix() {
    let t = tracked(2, true).await;
    let resp = t.assign("assignments", &[(0, 0)]).await;
    assert_eq!(resp.status, StatusCode::OK, "{:?}", resp.body);
    assert_eq!(
        resp.body["assignments"],
        json!([{ "judge_id": t.fx.judges[0].0, "team_id": t.teams[0] }])
    );

    let session = t.session(0).await;
    assert_eq!(team_ids(&session), vec![t.teams[0].clone()]);
    assert_eq!(ids(&session["criteria"]), vec![t.idea().to_string()]);
    assert_eq!(ids(&session["tracks"]), vec![t.tracks[0].clone()]);
    assert_eq!(session["teams"][0]["track_id"], t.tracks[0]);
    assert!(session["criteria"][0]["track_id"].is_null());
    // A judge without assignments still sees everything.
    assert_eq!(team_ids(&t.session(1).await).len(), 3);

    let resp =
        t.fx.put_scores(
            0,
            json!([
                item(&t.teams[1], t.idea(), 500, now_ms()),
                item(&t.teams[0], t.idea(), 700, now_ms()),
            ]),
        )
        .await;
    assert_eq!(resp.body["results"][0]["error"], "not_assigned");
    assert_eq!(resp.body["results"][1]["status"], "ok");

    let full = t
        .event_ok(Method::GET, &format!("/events/{}", t.fx.event_id), None)
        .await;
    assert_eq!(full["judges"][0]["scored_count"], 1);

    let outside = t.matrix_cell(0, 1).await;
    assert_eq!(outside["total"], 0);
    assert_eq!(outside["assigned"], false);
    assert_eq!(outside["conflict"], false);
    let inside = t.matrix_cell(0, 0).await;
    assert_eq!(
        (inside["scored"].clone(), inside["total"].clone()),
        (json!(1), json!(1))
    );
    assert_eq!(inside["assigned"], true);
    assert_eq!(t.matrix_cell(1, 1).await["total"], 2);

    // Judge 0 covers only Альфа, so judge 0's idea score for Бета is not part of any ranking.
    t.score(
        1,
        &[
            (&t.teams[1], t.idea(), 500),
            (&t.teams[1], t.implementation(), 500),
        ],
    )
    .await;
    let ranking = t.ranking("provisional").await;
    let beta = ranking["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["team_name"] == "Бета")
        .unwrap();
    assert_eq!(beta["sheets"], 1);

    // [] = everyone judges everything again.
    let resp = t.assign("assignments", &[]).await;
    assert_eq!(resp.status, StatusCode::OK);
    assert_eq!(team_ids(&t.session(0).await).len(), 3);
}

#[tokio::test]
async fn conflict_beats_assignment() {
    let t = tracked(2, true).await;
    assert_eq!(
        t.assign("assignments", &[(0, 0), (0, 1)]).await.status,
        StatusCode::OK
    );
    let resp = t.assign("conflicts", &[(0, 0)]).await;
    assert_eq!(resp.status, StatusCode::OK, "{:?}", resp.body);
    assert_eq!(
        resp.body["conflicts"],
        json!([{ "judge_id": t.fx.judges[0].0, "team_id": t.teams[0] }])
    );

    assert_eq!(team_ids(&t.session(0).await), vec![t.teams[1].clone()]);
    let resp =
        t.fx.put_scores(0, json!([item(&t.teams[0], t.idea(), 700, now_ms())]))
            .await;
    assert_eq!(resp.body["results"][0]["error"], "not_assigned");
    let cell = t.matrix_cell(0, 0).await;
    assert_eq!(cell["conflict"], true);
    assert_eq!(cell["assigned"], true);
    assert_eq!(cell["total"], 0);

    // A judge with every team in conflict has nothing to submit.
    assert_eq!(t.assign("assignments", &[]).await.status, StatusCode::OK);
    assert_eq!(
        t.assign("conflicts", &[(0, 0), (0, 1), (0, 2)])
            .await
            .status,
        StatusCode::OK
    );
    assert!(team_ids(&t.session(0).await).is_empty());
    let submit = t.fx.judge(0, Method::POST, "/judge/submit", None).await;
    assert_eq!(submit.status, StatusCode::OK, "{:?}", submit.body);
}

#[tokio::test]
async fn assignment_ids_must_belong_to_the_event() {
    let t = tracked(1, false).await;
    let other =
        t.fx.admin(Method::POST, "/events", Some(json!({ "title": "Другое" })))
            .await;
    let other_id = other.body["event"]["id"].as_str().unwrap().to_string();
    let other_team =
        t.fx.admin(
            Method::POST,
            &format!("/events/{other_id}/teams"),
            Some(json!({ "name": "Чужая" })),
        )
        .await
        .body["id"]
            .as_str()
            .unwrap()
            .to_string();
    for path in ["assignments", "conflicts"] {
        let resp =
            t.fx.admin(
                Method::PUT,
                &format!("/events/{}/{path}", t.fx.event_id),
                Some(json!({ "pairs": [{ "judge_id": t.fx.judges[0].0, "team_id": other_team }] })),
            )
            .await;
        assert_eq!(
            resp.status,
            StatusCode::BAD_REQUEST,
            "{path}: {:?}",
            resp.body
        );
    }
}

fn assignment_map(full: &Value, judges: &[(String, String)], teams: &[String]) -> Vec<Vec<usize>> {
    teams
        .iter()
        .map(|team| {
            let mut who: Vec<usize> = full["assignments"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|a| a["team_id"] == *team)
                .map(|a| judges.iter().position(|j| a["judge_id"] == j.0).unwrap())
                .collect();
            who.sort();
            who
        })
        .collect()
}

#[tokio::test]
async fn auto_assign_is_deterministic_and_balanced() {
    let t = tracked(3, false).await;
    let path = format!("/events/{}/assignments/auto", t.fx.event_id);
    let first =
        t.fx.admin(Method::POST, &path, Some(json!({ "judges_per_team": 2 })))
            .await;
    assert_eq!(first.status, StatusCode::OK, "{:?}", first.body);
    let expected = vec![vec![0, 1], vec![0, 2], vec![1, 2]];
    assert_eq!(
        assignment_map(&first.body, &t.fx.judges, &t.teams),
        expected
    );
    assert_eq!(first.body["assignments"].as_array().unwrap().len(), 6);

    // Replaces, never accumulates: the same request yields the same result.
    let second =
        t.fx.admin(Method::POST, &path, Some(json!({ "judges_per_team": 2 })))
            .await;
    assert_eq!(
        assignment_map(&second.body, &t.fx.judges, &t.teams),
        expected
    );
    assert_eq!(second.body["assignments"], first.body["assignments"]);

    // Inactive judges are skipped.
    let off =
        t.fx.admin(
            Method::PATCH,
            &format!("/judges/{}", t.fx.judges[1].0),
            Some(json!({ "is_active": false })),
        )
        .await;
    assert_eq!(off.status, StatusCode::OK);
    let third =
        t.fx.admin(Method::POST, &path, Some(json!({ "judges_per_team": 1 })))
            .await;
    assert_eq!(
        assignment_map(&third.body, &t.fx.judges, &t.teams),
        vec![vec![0], vec![2], vec![0]]
    );
}

#[tokio::test]
async fn auto_assign_reports_short_teams_unless_allowed() {
    let t = tracked(3, false).await;
    assert_eq!(
        t.assign("conflicts", &[(0, 0)]).await.status,
        StatusCode::OK
    );
    let path = format!("/events/{}/assignments/auto", t.fx.event_id);

    let short =
        t.fx.admin(Method::POST, &path, Some(json!({ "judges_per_team": 3 })))
            .await;
    assert_eq!(short.status, StatusCode::CONFLICT);
    assert_eq!(short.body["error"], "invalid_state");
    assert_eq!(
        short.body["details"]["short"],
        json!([{ "team_id": t.teams[0], "got": 2 }])
    );
    let full = t
        .event_ok(Method::GET, &format!("/events/{}", t.fx.event_id), None)
        .await;
    assert_eq!(
        full["assignments"],
        json!([]),
        "a rejected request changes nothing"
    );

    let allowed =
        t.fx.admin(
            Method::POST,
            &path,
            Some(json!({ "judges_per_team": 3, "allow_short": true })),
        )
        .await;
    assert_eq!(allowed.status, StatusCode::OK, "{:?}", allowed.body);
    assert_eq!(
        assignment_map(&allowed.body, &t.fx.judges, &t.teams),
        vec![vec![1, 2], vec![0, 1, 2], vec![0, 1, 2]]
    );

    let zero =
        t.fx.admin(Method::POST, &path, Some(json!({ "judges_per_team": 0 })))
            .await;
    assert_eq!(zero.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn tracks_are_draft_only_and_validated() {
    let t = tracked(1, false).await;
    let order =
        t.fx.admin(
            Method::PUT,
            &format!("/events/{}/tracks/order", t.fx.event_id),
            Some(json!({ "ids": [t.tracks[1], t.tracks[0]] })),
        )
        .await;
    assert_eq!(order.status, StatusCode::NO_CONTENT);
    let full = t
        .event_ok(Method::GET, &format!("/events/{}", t.fx.event_id), None)
        .await;
    assert_eq!(
        ids(&full["tracks"]),
        vec![t.tracks[1].clone(), t.tracks[0].clone()]
    );
    let bad_order =
        t.fx.admin(
            Method::PUT,
            &format!("/events/{}/tracks/order", t.fx.event_id),
            Some(json!({ "ids": [t.tracks[0]] })),
        )
        .await;
    assert_eq!(bad_order.status, StatusCode::BAD_REQUEST);

    // A track of another event is rejected for teams and criteria (create, bulk, patch).
    let other =
        t.fx.admin(Method::POST, "/events", Some(json!({ "title": "Другое" })))
            .await;
    let other_id = other.body["event"]["id"].as_str().unwrap().to_string();
    let foreign =
        t.fx.admin(
            Method::POST,
            &format!("/events/{other_id}/tracks"),
            Some(json!({ "name": "Чужой" })),
        )
        .await
        .body["id"]
            .as_str()
            .unwrap()
            .to_string();
    let attempts = [
        (
            Method::POST,
            format!("/events/{}/teams", t.fx.event_id),
            json!({ "name": "X", "track_id": foreign }),
        ),
        (
            Method::POST,
            format!("/events/{}/teams/bulk", t.fx.event_id),
            json!({ "teams": [{ "name": "X", "track_id": foreign }] }),
        ),
        (
            Method::PATCH,
            format!("/teams/{}", t.teams[0]),
            json!({ "track_id": foreign }),
        ),
        (
            Method::POST,
            format!("/events/{}/criteria", t.fx.event_id),
            json!({ "name": "X", "max_x100": 100, "step_x100": 100, "weight": 1, "track_id": foreign }),
        ),
        (
            Method::PATCH,
            format!("/criteria/{}", t.idea()),
            json!({ "track_id": foreign }),
        ),
    ];
    for (method, path, body) in attempts {
        let resp = t.fx.admin(method, &path, Some(body)).await;
        assert_eq!(
            resp.status,
            StatusCode::BAD_REQUEST,
            "{path}: {:?}",
            resp.body
        );
    }

    // `track_id: null` detaches.
    let resp =
        t.fx.admin(
            Method::PATCH,
            &format!("/teams/{}", t.teams[0]),
            Some(json!({ "track_id": null })),
        )
        .await;
    assert!(resp.body["track_id"].is_null());

    // Deleting a track detaches its teams and removes its criteria.
    let del =
        t.fx.admin(Method::DELETE, &format!("/tracks/{}", t.tracks[1]), None)
            .await;
    assert_eq!(del.status, StatusCode::NO_CONTENT);
    let full = t
        .event_ok(Method::GET, &format!("/events/{}", t.fx.event_id), None)
        .await;
    assert_eq!(full["criteria"].as_array().unwrap().len(), 1);
    let beta = full["teams"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["id"] == t.teams[1])
        .unwrap();
    assert!(beta["track_id"].is_null());

    // After the draft everything about tracks is frozen.
    let started = t.fx.transition(json!({ "to": "judging" })).await;
    assert_eq!(started.status, StatusCode::OK, "{:?}", started.body);
    let frozen = [
        (
            Method::POST,
            format!("/events/{}/tracks", t.fx.event_id),
            Some(json!({ "name": "Новый" })),
        ),
        (
            Method::PATCH,
            format!("/tracks/{}", t.tracks[0]),
            Some(json!({ "name": "Иначе" })),
        ),
        (Method::DELETE, format!("/tracks/{}", t.tracks[0]), None),
        (
            Method::PUT,
            format!("/events/{}/tracks/order", t.fx.event_id),
            Some(json!({ "ids": [t.tracks[0]] })),
        ),
        (
            Method::PATCH,
            format!("/teams/{}", t.teams[1]),
            Some(json!({ "track_id": t.tracks[0] })),
        ),
    ];
    for (method, path, body) in frozen {
        let resp = t.fx.admin(method, &path, body).await;
        assert_eq!(resp.status, StatusCode::CONFLICT, "{path}: {:?}", resp.body);
    }
    // Assignments stay editable while judging.
    assert_eq!(
        t.assign("assignments", &[(0, 0)]).await.status,
        StatusCode::OK
    );
}

async fn stage_patch(t: &Tracked, body: Value) -> Resp {
    t.fx.admin(
        Method::PATCH,
        &format!("/events/{}", t.fx.event_id),
        Some(body),
    )
    .await
}

async fn stage_reveal(t: &Tracked, action: &str) -> Resp {
    t.fx.admin(
        Method::POST,
        &format!("/events/{}/stage/reveal", t.fx.event_id),
        Some(json!({ "action": action })),
    )
    .await
}

async fn stage_get(t: &Tracked) -> Resp {
    send(
        &t.fx.app,
        Method::GET,
        &format!("/api/public/events/{}/stage", t.fx.event_id),
        None,
        Auth::None,
    )
    .await
}

#[tokio::test]
async fn stage_shows_one_track_at_a_time() {
    let t = tracked(1, true).await;
    t.score_everything(0, [800, 500, 600], 500).await;
    t.finalize().await;
    let names = |resp: &Resp| -> Vec<String> {
        resp.body["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["team_name"].as_str().unwrap().to_string())
            .collect()
    };

    assert_eq!(
        stage_patch(
            &t,
            json!({ "stage_view": "podium", "stage_track_id": t.tracks[1] })
        )
        .await
        .status,
        StatusCode::OK
    );
    let s = stage_get(&t).await;
    assert_eq!(s.body["stage"]["track_id"], t.tracks[1]);
    assert_eq!(s.body["stage"]["total_groups"], 1);
    assert_eq!(s.body["tracks"].as_array().unwrap().len(), 2);
    assert_eq!(ids(&s.body["event"]["criteria"]).len(), 2);
    assert!(names(&s).is_empty());
    assert_eq!(
        stage_reveal(&t, "next").await.body["event"]["stage_revealed"],
        1
    );
    assert_eq!(names(&stage_get(&t).await), vec!["Бета"]);

    // Changing the track resets the reveal progress; groups are counted inside the track.
    let resp = stage_patch(&t, json!({ "stage_track_id": t.tracks[0] })).await;
    assert_eq!(resp.body["event"]["stage_revealed"], 0);
    assert_eq!(resp.body["event"]["stage_track_id"], t.tracks[0]);
    let s = stage_get(&t).await;
    assert_eq!(s.body["stage"]["total_groups"], 2);
    assert_eq!(
        ids(&s.body["event"]["criteria"]),
        vec![t.idea().to_string()]
    );
    assert_eq!(
        stage_reveal(&t, "all").await.body["event"]["stage_revealed"],
        2
    );
    assert_eq!(names(&stage_get(&t).await), vec!["Альфа", "Гамма"]);

    // Same track again keeps the progress; null selects the teams without a track (none here).
    assert_eq!(
        stage_patch(&t, json!({ "stage_track_id": t.tracks[0] }))
            .await
            .body["event"]["stage_revealed"],
        2
    );
    let resp = stage_patch(&t, json!({ "stage_track_id": null })).await;
    assert_eq!(resp.body["event"]["stage_revealed"], 0);
    assert_eq!(stage_get(&t).await.body["stage"]["total_groups"], 0);

    let other =
        t.fx.admin(Method::POST, "/events", Some(json!({ "title": "Другое" })))
            .await;
    let other_id = other.body["event"]["id"].as_str().unwrap().to_string();
    let foreign =
        t.fx.admin(
            Method::POST,
            &format!("/events/{other_id}/tracks"),
            Some(json!({ "name": "Чужой" })),
        )
        .await
        .body["id"]
            .as_str()
            .unwrap()
            .to_string();
    assert_eq!(
        stage_patch(&t, json!({ "stage_track_id": foreign }))
            .await
            .status,
        StatusCode::BAD_REQUEST
    );
}

fn sheet(fx: &Fixture, idx: usize, items: Value) -> Value {
    json!({
        "format": "judgeflow-sheet/1",
        "event_id": fx.event_id,
        "judge_id": fx.judges[idx].0,
        "judge_name": "Судья",
        "token": fx.judges[idx].1,
        "exported_at": now_ms(),
        "items": items,
    })
}

async fn import(fx: &Fixture, body: Value) -> Resp {
    fx.admin(
        Method::POST,
        &format!("/events/{}/import-sheet", fx.event_id),
        Some(body),
    )
    .await
}

#[tokio::test]
async fn import_sheet_applies_items_like_put_scores() {
    let fx = Fixture::new(1, true).await;
    let (t0, c0, c1) = (&fx.team_ids[0], &fx.criterion_ids[0], &fx.criterion_ids[1]);
    let now = now_ms();
    let resp = import(
        &fx,
        sheet(
            &fx,
            0,
            json!([item(t0, c0, 700, now), item(t0, c1, 150, now)]),
        ),
    )
    .await;
    assert_eq!(resp.status, StatusCode::OK, "{:?}", resp.body);
    let statuses: Vec<&str> = resp.body["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["status"].as_str().unwrap())
        .collect();
    assert_eq!(statuses, vec!["ok", "ok"]);
    let session = fx.judge(0, Method::GET, "/judge/session", None).await;
    assert_eq!(session.body["scores"].as_array().unwrap().len(), 2);

    // Last-writer-wins: an older item is stale and reports the server version.
    let resp = import(&fx, sheet(&fx, 0, json!([item(t0, c0, 100, now - 5000)]))).await;
    assert_eq!(resp.body["results"][0]["status"], "stale");
    assert_eq!(resp.body["results"][0]["server"]["value_x100"], 700);
    // Per-item validation is shared too.
    let resp = import(&fx, sheet(&fx, 0, json!([item(t0, c0, 5, now)]))).await;
    assert_eq!(resp.body["results"][0]["error"], "validation");

    // Inactive judges can still be imported.
    let off = fx
        .admin(
            Method::PATCH,
            &format!("/judges/{}", fx.judges[0].0),
            Some(json!({ "is_active": false })),
        )
        .await;
    assert_eq!(off.status, StatusCode::OK);
    let resp = import(&fx, sheet(&fx, 0, json!([item(t0, c0, 800, now + 10)]))).await;
    assert_eq!(resp.body["results"][0]["status"], "ok");

    // The audit entry has counts only, never the token.
    let audit = fx
        .admin(Method::GET, &format!("/events/{}/audit", fx.event_id), None)
        .await;
    assert!(!audit.text().contains(&fx.judges[0].1));
    let entry = audit
        .body
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["action"] == "judge.sheet_import")
        .unwrap();
    assert_eq!(entry["details"]["items"], 1);
    assert_eq!(entry["details"]["ok"], 1);
}

#[tokio::test]
async fn import_sheet_respects_assignments_and_submission() {
    let t = tracked(1, true).await;
    t.assign("assignments", &[(0, 0)]).await;
    let resp = import(
        &t.fx,
        sheet(
            &t.fx,
            0,
            json!([item(&t.teams[1], t.idea(), 500, now_ms())]),
        ),
    )
    .await;
    assert_eq!(resp.body["results"][0]["error"], "not_assigned");

    assert_eq!(t.assign("assignments", &[]).await.status, StatusCode::OK);
    t.score_everything(0, [800, 500, 600], 500).await;
    let submit = t.fx.judge(0, Method::POST, "/judge/submit", None).await;
    assert_eq!(submit.status, StatusCode::OK);
    let resp = import(
        &t.fx,
        sheet(
            &t.fx,
            0,
            json!([item(&t.teams[0], t.idea(), 900, now_ms())]),
        ),
    )
    .await;
    assert_eq!(resp.body["results"][0]["error"], "sheet_submitted");
}

#[tokio::test]
async fn import_sheet_rejects_foreign_tokens_bad_format_and_oversize() {
    let fx = Fixture::new(1, true).await;
    let other = fx
        .admin(Method::POST, "/events", Some(json!({ "title": "Другое" })))
        .await;
    let other_id = other.body["event"]["id"].as_str().unwrap().to_string();
    let created = fx
        .admin(
            Method::POST,
            &format!("/events/{other_id}/judges"),
            Some(json!({ "names": ["Чужой судья"] })),
        )
        .await;
    let foreign_token = created.body[0]["link"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap()
        .to_string();
    let mut body = sheet(&fx, 0, json!([]));
    body["token"] = json!(foreign_token);
    let resp = import(&fx, body).await;
    assert!(resp.status.is_client_error(), "{:?}", resp.status);
    assert_eq!(resp.status, StatusCode::BAD_REQUEST);

    let mut body = sheet(&fx, 0, json!([]));
    body["token"] = json!("no-such-token");
    assert_eq!(import(&fx, body).await.status, StatusCode::BAD_REQUEST);

    let mut body = sheet(&fx, 0, json!([]));
    body["format"] = json!("judgeflow-sheet/2");
    assert_eq!(import(&fx, body).await.status, StatusCode::BAD_REQUEST);

    // Admin session is required.
    let anonymous = send(
        &fx.app,
        Method::POST,
        &format!("/api/events/{}/import-sheet", fx.event_id),
        Some(sheet(&fx, 0, json!([]))),
        Auth::None,
    )
    .await;
    assert_eq!(anonymous.status, StatusCode::UNAUTHORIZED);

    let mut huge = sheet(&fx, 0, json!([])).to_string();
    huge.truncate(huge.len() - 1);
    huge.push_str(&format!(
        ",\"pad\":\"{}\"}}",
        "a".repeat(2 * 1024 * 1024 + 10)
    ));
    let resp = send_bytes(
        &fx.app,
        Method::POST,
        &format!("/api/events/{}/import-sheet", fx.event_id),
        "application/json",
        huge.into_bytes(),
        Auth::Cookie(&fx.cookie),
    )
    .await;
    assert_eq!(resp.status, StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn finalized_events_reject_import_assignments_and_conflicts() {
    let fx = Fixture::new(1, true).await;
    fx.score_all(0, 800, 400).await;
    assert_eq!(
        fx.judge(0, Method::POST, "/judge/submit", None)
            .await
            .status,
        StatusCode::OK
    );
    for to in ["locked", "finalized"] {
        assert_eq!(
            fx.transition(json!({ "to": to })).await.status,
            StatusCode::OK
        );
    }
    let resp = import(&fx, sheet(&fx, 0, json!([]))).await;
    assert_eq!(resp.status, StatusCode::CONFLICT);
    assert_eq!(resp.body["error"], "invalid_state");
    for path in ["assignments", "conflicts"] {
        let resp = fx
            .admin(
                Method::PUT,
                &format!("/events/{}/{path}", fx.event_id),
                Some(json!({ "pairs": [] })),
            )
            .await;
        assert_eq!(resp.status, StatusCode::CONFLICT, "{path}");
    }
    let resp = fx
        .admin(
            Method::POST,
            &format!("/events/{}/assignments/auto", fx.event_id),
            Some(json!({ "judges_per_team": 1 })),
        )
        .await;
    assert_eq!(resp.status, StatusCode::CONFLICT);
}

#[tokio::test]
async fn snapshot_keeps_track_ids_and_public_results_include_tracks() {
    let t = tracked(1, true).await;
    t.score_everything(0, [800, 500, 600], 500).await;
    t.finalize().await;
    let publish = t.fx.transition(json!({ "to": "published" })).await;
    assert_eq!(publish.status, StatusCode::OK);
    let public = send(
        &t.fx.app,
        Method::GET,
        &format!("/api/public/events/{}", t.fx.event_id),
        None,
        Auth::None,
    )
    .await;
    let results = &public.body["results"];
    assert_eq!(results["tracks"].as_array().unwrap().len(), 2);
    assert_eq!(results["rows"][2]["track_id"], t.tracks[1]);
    assert_eq!(results["rows"][2]["rank"], 1);
    assert_eq!(public.body["event"]["criteria"][1]["track_id"], t.tracks[1]);
}
