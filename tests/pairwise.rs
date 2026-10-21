mod common;

use std::collections::HashSet;

use axum::http::{Method, StatusCode};
use common::{Auth, Fixture, Resp, now_ms, send};
use serde_json::{Value, json};

/// A pairwise event with `2 + extra` teams (Альфа, Бета, then `extra`) and `judges` judges.
async fn pairwise(judges: usize, extra: &[&str], start: bool) -> Fixture {
    let mut fx = Fixture::new(judges, false).await;
    let resp = fx
        .admin(
            Method::PATCH,
            &format!("/events/{}", fx.event_id),
            Some(json!({ "scoring_mode": "pairwise" })),
        )
        .await;
    assert_eq!(resp.status, StatusCode::OK, "{:?}", resp.body);
    for name in extra {
        let resp = fx
            .admin(
                Method::POST,
                &format!("/events/{}/teams", fx.event_id),
                Some(json!({ "name": name })),
            )
            .await;
        assert_eq!(resp.status, StatusCode::OK, "{:?}", resp.body);
        fx.team_ids
            .push(resp.body["id"].as_str().unwrap().to_string());
    }
    if start {
        let resp = fx.transition(json!({ "to": "judging" })).await;
        assert_eq!(resp.status, StatusCode::OK, "{:?}", resp.body);
    }
    fx
}

async fn reserve(fx: &Fixture, idx: usize, count: i64) -> Resp {
    fx.judge(
        idx,
        Method::POST,
        "/judge/pairs/reserve",
        Some(json!({ "count": count })),
    )
    .await
}

fn comparisons(resp: &Resp) -> Vec<Value> {
    assert_eq!(resp.status, StatusCode::OK, "{:?}", resp.body);
    resp.body["comparisons"].as_array().unwrap().clone()
}

fn comparison_ids(list: &[Value]) -> Vec<String> {
    list.iter()
        .map(|c| c["id"].as_str().unwrap().to_string())
        .collect()
}

async fn put_comparisons(fx: &Fixture, idx: usize, items: Value) -> Resp {
    fx.judge(
        idx,
        Method::PUT,
        "/judge/comparisons",
        Some(json!({ "items": items })),
    )
    .await
}

/// Decides every given comparison in favour of the team that comes first in `fx.team_ids`.
async fn decide_by_order(fx: &Fixture, idx: usize, list: &[Value]) {
    let pos = |team: &Value| fx.team_ids.iter().position(|t| t == team).unwrap();
    let at = now_ms();
    let items: Vec<Value> = list
        .iter()
        .map(|c| {
            let winner = if pos(&c["team_a"]) < pos(&c["team_b"]) {
                "a"
            } else {
                "b"
            };
            json!({ "id": c["id"], "winner": winner, "edited_at": at })
        })
        .collect();
    let resp = put_comparisons(fx, idx, Value::Array(items)).await;
    assert_eq!(resp.status, StatusCode::OK, "{:?}", resp.body);
    for r in resp.body["results"].as_array().unwrap() {
        assert_eq!(r["status"], "ok", "{r}");
    }
}

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

/// `(team_name, rank, wins, losses, ties)` per row.
fn table(ranking: &Value) -> Vec<(String, Value, Value, Value, Value)> {
    ranking["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["team_name"].as_str().unwrap().to_string(),
                r["rank"].clone(),
                r["wins"].clone(),
                r["losses"].clone(),
                r["ties"].clone(),
            )
        })
        .collect()
}

fn unordered(c: &Value) -> (String, String) {
    let (a, b) = (
        c["team_a"].as_str().unwrap().to_string(),
        c["team_b"].as_str().unwrap().to_string(),
    );
    if a <= b { (a, b) } else { (b, a) }
}

#[tokio::test]
async fn reserve_creates_balanced_unseen_pairs_and_is_idempotent() {
    let fx = pairwise(2, &["Вега", "Дельта"], true).await;

    // Two pairs cover four distinct teams (balanced by team comparison counts).
    let first = comparisons(&reserve(&fx, 0, 2).await);
    assert_eq!(first.len(), 2);
    // The other judge starts with pairs nobody has compared yet: not the first judge's pairs.
    let other = comparisons(&reserve(&fx, 1, 1).await);
    assert_eq!(other.len(), 1);
    assert!(first.iter().all(|c| unordered(c) != unordered(&other[0])));
    let teams: HashSet<&str> = first
        .iter()
        .flat_map(|c| [c["team_a"].as_str().unwrap(), c["team_b"].as_str().unwrap()])
        .collect();
    assert_eq!(teams.len(), 4);
    assert!(
        first
            .iter()
            .all(|c| c["winner"].is_null() && c["edited_at"].is_null())
    );

    // Idempotent: same open pairs come back, nothing new is created.
    let again = comparisons(&reserve(&fx, 0, 2).await);
    assert_eq!(comparison_ids(&again), comparison_ids(&first));
    // A smaller count never trims.
    let fewer = comparisons(&reserve(&fx, 0, 1).await);
    assert_eq!(comparison_ids(&fewer), comparison_ids(&first));

    // Topping up keeps the old ones and never repeats a pair for this judge.
    let more = comparisons(&reserve(&fx, 0, 20).await);
    assert_eq!(more.len(), 6, "C(4,2) pairs exist");
    assert_eq!(&comparison_ids(&more)[..2], &comparison_ids(&first)[..]);
    let distinct: HashSet<_> = more.iter().map(unordered).collect();
    assert_eq!(distinct.len(), 6);

    // Validation and the session payload.
    assert_eq!(reserve(&fx, 0, 0).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(reserve(&fx, 0, 21).await.status, StatusCode::BAD_REQUEST);
    let session = fx.judge(0, Method::GET, "/judge/session", None).await;
    assert_eq!(session.body["comparisons"].as_array().unwrap().len(), 6);
    let keys: HashSet<&str> = session.body["comparisons"][0]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        HashSet::from(["id", "team_a", "team_b", "winner", "edited_at"])
    );
}

#[tokio::test]
async fn reserve_is_read_only_outside_judging_and_rejects_rubric_events() {
    let fx = pairwise(1, &["Вега"], false).await;
    // Draft: nothing is created.
    assert!(comparisons(&reserve(&fx, 0, 3).await).is_empty());
    assert!(
        fx.transition(json!({ "to": "judging" }))
            .await
            .status
            .is_success()
    );
    let open = comparisons(&reserve(&fx, 0, 2).await);
    assert_eq!(open.len(), 2);

    // Locked: returns the existing open pairs, creates none.
    assert!(
        fx.transition(json!({ "to": "locked" }))
            .await
            .status
            .is_success()
    );
    let locked = comparisons(&reserve(&fx, 0, 3).await);
    assert_eq!(comparison_ids(&locked), comparison_ids(&open));

    // Rubric event: the endpoint does not apply.
    let rubric = Fixture::new(1, true).await;
    let resp = reserve(&rubric, 0, 1).await;
    assert_eq!(resp.status, StatusCode::CONFLICT, "{:?}", resp.body);
    let session = rubric.judge(0, Method::GET, "/judge/session", None).await;
    assert!(session.body.get("comparisons").is_none());
}

#[tokio::test]
async fn reserve_respects_assignments_conflicts_and_tracks() {
    let fx = pairwise(2, &["Вега", "Дельта"], false).await;
    let t = &fx.team_ids;
    let put = |kind: &'static str, pairs: Vec<(usize, usize)>| {
        let fx = &fx;
        async move {
            let pairs: Vec<Value> = pairs
                .into_iter()
                .map(|(j, t)| json!({ "judge_id": fx.judges[j].0, "team_id": fx.team_ids[t] }))
                .collect();
            let resp = fx
                .admin(
                    Method::PUT,
                    &format!("/events/{}/{kind}", fx.event_id),
                    Some(json!({ "pairs": pairs })),
                )
                .await;
            assert_eq!(resp.status, StatusCode::OK, "{:?}", resp.body);
        }
    };
    // Judge 0: teams 0,1,2 minus a conflict with 2. Judge 1: teams 2,3.
    put("assignments", vec![(0, 0), (0, 1), (0, 2), (1, 2), (1, 3)]).await;
    put("conflicts", vec![(0, 2)]).await;
    assert!(
        fx.transition(json!({ "to": "judging" }))
            .await
            .status
            .is_success()
    );

    let judge0 = comparisons(&reserve(&fx, 0, 20).await);
    assert_eq!(judge0.len(), 1);
    assert_eq!(unordered(&judge0[0]), {
        let mut p = [t[0].clone(), t[1].clone()];
        p.sort();
        (p[0].clone(), p[1].clone())
    });
    let judge1 = comparisons(&reserve(&fx, 1, 20).await);
    assert_eq!(judge1.len(), 1);
    assert!(judge1[0]["team_a"] == json!(t[2]) || judge1[0]["team_b"] == json!(t[2]));
}

#[tokio::test]
async fn pairs_never_cross_tracks() {
    let fx = pairwise(1, &["Вега", "Дельта"], false).await;
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
    for (i, team) in fx.team_ids.iter().enumerate() {
        let resp = fx
            .admin(
                Method::PATCH,
                &format!("/teams/{team}"),
                Some(json!({ "track_id": tracks[i / 2] })),
            )
            .await;
        assert_eq!(resp.status, StatusCode::OK, "{:?}", resp.body);
    }
    assert!(
        fx.transition(json!({ "to": "judging" }))
            .await
            .status
            .is_success()
    );

    let list = comparisons(&reserve(&fx, 0, 20).await);
    assert_eq!(list.len(), 2, "one pair per track");
    for c in &list {
        let track = |team: &Value| fx.team_ids.iter().position(|t| t == team).unwrap() / 2;
        assert_eq!(track(&c["team_a"]), track(&c["team_b"]));
    }

    // Rankings are per track as well: ranks restart, rows carry track_id.
    decide_by_order(&fx, 0, &list).await;
    finalize(&fx).await;
    let ranking = results(&fx, "official").await;
    let rows = table(&ranking);
    assert_eq!(rows.len(), 4);
    assert_eq!(rows.iter().filter(|r| r.1 == json!(1)).count(), 2);
    assert!(ranking["rows"][0]["track_id"] == json!(tracks[0]));
    assert!(ranking["rows"][3]["track_id"] == json!(tracks[1]));
}

#[tokio::test]
async fn comparison_items_follow_last_writer_wins() {
    let fx = pairwise(2, &["Вега"], true).await;
    let open = comparisons(&reserve(&fx, 0, 2).await);
    let (id, id2) = (open[0]["id"].clone(), open[1]["id"].clone());
    let t = now_ms() - 10_000;

    let status = |resp: &Resp, i: usize| resp.body["results"][i]["status"].clone();
    let resp = put_comparisons(&fx, 0, json!([{ "id": id, "winner": "a", "edited_at": t }])).await;
    assert_eq!(status(&resp, 0), "ok", "{:?}", resp.body);
    assert_eq!(resp.body["results"][0]["id"], id);

    // Same edited_at overwrites (idempotent retries); older loses with the server version.
    let resp = put_comparisons(&fx, 0, json!([{ "id": id, "winner": "a", "edited_at": t }])).await;
    assert_eq!(status(&resp, 0), "ok");
    let resp = put_comparisons(
        &fx,
        0,
        json!([{ "id": id, "winner": "b", "edited_at": t - 1 }]),
    )
    .await;
    assert_eq!(status(&resp, 0), "stale");
    assert_eq!(
        resp.body["results"][0]["server"],
        json!({ "winner": "a", "edited_at": t })
    );

    // Clearing keeps the row open with its edited_at, so an older edit cannot resurrect it.
    let resp = put_comparisons(
        &fx,
        0,
        json!([{ "id": id, "winner": null, "edited_at": t + 5 }]),
    )
    .await;
    assert_eq!(status(&resp, 0), "ok");
    let resp = put_comparisons(&fx, 0, json!([{ "id": id, "winner": "b", "edited_at": t }])).await;
    assert_eq!(status(&resp, 0), "stale");
    assert!(resp.body["results"][0]["server"]["winner"].is_null());
    let session = fx.judge(0, Method::GET, "/judge/session", None).await;
    let mine = session.body["comparisons"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == id)
        .unwrap();
    assert!(mine["winner"].is_null());
    assert_eq!(mine["edited_at"], t + 5);
    assert!(
        comparison_ids(&comparisons(&reserve(&fx, 0, 2).await))
            .contains(&id.as_str().unwrap().to_string())
    );

    // Validation, foreign and unknown ids.
    let resp = put_comparisons(
        &fx,
        0,
        json!([
            { "id": id2, "winner": "x", "edited_at": t },
            { "id": id2, "winner": "tie", "edited_at": now_ms() + 3 * 24 * 3600 * 1000 },
            { "id": "nope", "winner": "a", "edited_at": t },
        ]),
    )
    .await;
    assert_eq!(resp.body["results"][0]["error"], "validation");
    assert_eq!(resp.body["results"][1]["error"], "validation");
    assert_eq!(resp.body["results"][2]["error"], "not_found");
    let resp = put_comparisons(
        &fx,
        1,
        json!([{ "id": id2, "winner": "a", "edited_at": t }]),
    )
    .await;
    assert_eq!(status(&resp, 0), "rejected");
    assert_eq!(resp.body["results"][0]["error"], "not_found");
    // Judge 0's comparison stayed untouched.
    let resp = put_comparisons(
        &fx,
        0,
        json!([{ "id": id2, "winner": "tie", "edited_at": t }]),
    )
    .await;
    assert_eq!(status(&resp, 0), "ok");

    // Requests need a judge token.
    let anon = send(
        &fx.app,
        Method::PUT,
        "/api/judge/comparisons",
        Some(json!({ "items": [] })),
        Auth::None,
    )
    .await;
    assert_eq!(anon.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn comparison_writes_honour_lock_window_and_submission() {
    let fx = pairwise(2, &["Вега"], true).await;
    let open = comparisons(&reserve(&fx, 0, 3).await);
    let ids: Vec<Value> = open.iter().map(|c| c["id"].clone()).collect();
    assert!(
        fx.transition(json!({ "to": "locked" }))
            .await
            .status
            .is_success()
    );
    let locked_at = fx.event().await["event"]["locked_at"].as_i64().unwrap();

    let resp = put_comparisons(
        &fx,
        0,
        json!([
            { "id": ids[0], "winner": "a", "edited_at": locked_at - 5 },
            { "id": ids[1], "winner": "a", "edited_at": locked_at + 1 },
        ]),
    )
    .await;
    assert_eq!(resp.body["results"][0]["status"], "ok", "{:?}", resp.body);
    assert_eq!(resp.body["results"][1]["status"], "rejected");
    assert_eq!(resp.body["results"][1]["error"], "invalid_state");

    // Back to judging, resolve the rest and submit: further writes are rejected.
    let back = fx
        .transition(json!({ "to": "judging", "reason": "ещё раз" }))
        .await;
    assert_eq!(back.status, StatusCode::OK, "{:?}", back.body);
    let resp = put_comparisons(
        &fx,
        0,
        json!([
            { "id": ids[1], "winner": "b", "edited_at": now_ms() },
            { "id": ids[2], "winner": "tie", "edited_at": now_ms() },
        ]),
    )
    .await;
    assert_eq!(resp.body["results"][0]["status"], "ok", "{:?}", resp.body);
    let submit = fx.judge(0, Method::POST, "/judge/submit", None).await;
    assert_eq!(submit.status, StatusCode::OK, "{:?}", submit.body);
    let resp = put_comparisons(
        &fx,
        0,
        json!([{ "id": ids[0], "winner": "b", "edited_at": now_ms() }]),
    )
    .await;
    assert_eq!(resp.body["results"][0]["error"], "sheet_submitted");
    // A submitted judge gets no new pairs.
    assert_eq!(comparisons(&reserve(&fx, 0, 20).await).len(), 0);
}

#[tokio::test]
async fn submit_requires_no_open_pairs_unless_released() {
    let fx = pairwise(1, &["Вега"], true).await;
    let open = comparisons(&reserve(&fx, 0, 3).await);
    decide_by_order(&fx, 0, &open[..1]).await;

    let blocked = fx.judge(0, Method::POST, "/judge/submit", None).await;
    assert_eq!(blocked.status, StatusCode::CONFLICT, "{:?}", blocked.body);
    assert_eq!(blocked.body["error"], "invalid_state");
    assert_eq!(
        blocked.body["details"]["open"],
        json!([open[1]["id"], open[2]["id"]])
    );
    let explicit_false = fx
        .judge(
            0,
            Method::POST,
            "/judge/submit",
            Some(json!({ "release_open": false })),
        )
        .await;
    assert_eq!(explicit_false.status, StatusCode::CONFLICT);

    let ok = fx
        .judge(
            0,
            Method::POST,
            "/judge/submit",
            Some(json!({ "release_open": true })),
        )
        .await;
    assert_eq!(ok.status, StatusCode::OK, "{:?}", ok.body);
    assert!(ok.body["judge"]["submitted_at"].is_i64());
    let session = fx.judge(0, Method::GET, "/judge/session", None).await;
    let kept = session.body["comparisons"].as_array().unwrap();
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0]["id"], open[0]["id"]);

    // Unsubmit is unchanged, and the judge can reserve again afterwards.
    let un = fx.judge(0, Method::POST, "/judge/unsubmit", None).await;
    assert_eq!(un.status, StatusCode::OK, "{:?}", un.body);
    assert!(un.body["judge"]["submitted_at"].is_null());
    assert_eq!(comparisons(&reserve(&fx, 0, 2).await).len(), 2);
}

/// Event with 3 teams and 2 judges: judge 0 decides all 3 pairs (lower index wins), judge 1
/// ties one pair; returns the tied pair.
async fn decided_event(visibility: Option<&str>) -> (Fixture, (String, String)) {
    let fx = pairwise(2, &["Вега"], false).await;
    // Teams in order: Альфа, Бета, Вега.
    if let Some(visibility) = visibility {
        let resp = fx
            .admin(
                Method::PATCH,
                &format!("/events/{}", fx.event_id),
                Some(json!({ "visibility": visibility })),
            )
            .await;
        assert_eq!(resp.status, StatusCode::OK, "{:?}", resp.body);
    }
    assert!(
        fx.transition(json!({ "to": "judging" }))
            .await
            .status
            .is_success()
    );
    let all = comparisons(&reserve(&fx, 0, 3).await);
    assert_eq!(all.len(), 3);
    decide_by_order(&fx, 0, &all).await;
    let one = comparisons(&reserve(&fx, 1, 1).await);
    let at = now_ms();
    let resp = put_comparisons(
        &fx,
        1,
        json!([{ "id": one[0]["id"], "winner": "tie", "edited_at": at }]),
    )
    .await;
    assert_eq!(resp.body["results"][0]["status"], "ok");
    (fx, unordered(&one[0]))
}

#[tokio::test]
async fn results_are_provisional_until_judges_submit() {
    let (fx, tied) = decided_event(None).await;

    let provisional = results(&fx, "provisional").await;
    let rows = table(&provisional);
    assert_eq!(rows.len(), 3);
    assert!(rows.iter().all(|r| r.1.is_u64()), "{rows:?}");
    let total = |idx: usize| -> i64 {
        rows.iter()
            .map(|r| [&r.2, &r.3, &r.4][idx].as_i64().unwrap())
            .sum()
    };
    // 3 decided wins + 1 tie: wins == losses, ties are counted on both sides.
    assert_eq!((total(0), total(1), total(2)), (3, 3, 2));
    let names: Vec<_> = provisional["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["team_id"].as_str().unwrap().to_string(),
                r["ties"].as_u64().unwrap(),
            )
        })
        .collect();
    for (team, ties) in names {
        assert_eq!(ties, u64::from(team == tied.0 || team == tied.1));
    }
    assert_eq!(provisional["rows"][0]["criteria"], json!([]));

    // Official ignores unsubmitted judges: nothing is ranked yet.
    let official = results(&fx, "official").await;
    assert!(
        official["rows"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["rank"].is_null())
    );
    assert!(official["rows"][0]["wins"] == json!(0));

    finalize(&fx).await;
    let official = results(&fx, "official").await;
    assert!(official["snapshot"].is_object());
    assert_eq!(table(&official).len(), 3);
    assert!(table(&official).iter().all(|r| r.1.is_u64()));
    assert_eq!(official["rows"][0]["rank"], 1);
    assert_eq!(official["rows"][0]["team_name"], "Альфа", "{official}");
    assert!(official["rows"][0]["sheets"].as_u64().unwrap() >= 2);
    // The snapshot is frozen, so a new provisional computation still agrees on wins.
    assert_eq!(table(&results(&fx, "provisional").await), table(&official));
}

#[tokio::test]
async fn public_stage_snapshot_and_csv_carry_pairwise_data() {
    let (fx, tied) = decided_event(Some("live_totals")).await;
    let public = |path: String| {
        let app = fx.app.clone();
        async move {
            send(
                &app,
                Method::GET,
                &format!("/api/public{path}"),
                None,
                Auth::None,
            )
            .await
        }
    };

    // Live provisional totals expose wins/losses/ties but never per-judge data.
    let live = public(format!("/events/{}", fx.event_id)).await;
    assert_eq!(live.status, StatusCode::OK, "{:?}", live.body);
    let row = &live.body["results"]["rows"][0];
    assert!(row["wins"].is_u64() && row["losses"].is_u64() && row["ties"].is_u64());
    assert_eq!(row["judges"], json!([]));

    // Admin CSV (provisional): extra columns after the quorum column.
    let csv = fx
        .admin(
            Method::GET,
            &format!("/events/{}/export.csv", fx.event_id),
            None,
        )
        .await;
    let text = csv.text();
    let mut lines = text.trim_start_matches('\u{feff}').lines();
    let header: Vec<&str> = lines.next().unwrap().split(';').collect();
    assert_eq!(
        &header[..8],
        [
            "Место",
            "Команда",
            "Балл",
            "Листов",
            "Кворум",
            "Побед",
            "Поражений",
            "Ничьих"
        ]
    );
    assert_eq!(
        header.len(),
        8 + 2,
        "no criteria columns, per-judge columns follow"
    );
    let first: Vec<&str> = lines.next().unwrap().split(';').collect();
    assert_eq!(first[1], "Альфа");
    let ties = if fx.team_ids[0] == tied.0 || fx.team_ids[0] == tied.1 {
        "1"
    } else {
        "0"
    };
    assert_eq!(first[5..8], ["2", "0", ties]);

    finalize(&fx).await;
    // Stage: official ranking from the snapshot, rows carry the counters.
    let patch = fx
        .admin(
            Method::PATCH,
            &format!("/events/{}", fx.event_id),
            Some(json!({ "stage_view": "leaderboard" })),
        )
        .await;
    assert_eq!(patch.status, StatusCode::OK, "{:?}", patch.body);
    let reveal = fx
        .admin(
            Method::POST,
            &format!("/events/{}/stage/reveal", fx.event_id),
            Some(json!({ "action": "all" })),
        )
        .await;
    assert_eq!(reveal.status, StatusCode::OK, "{:?}", reveal.body);
    let stage = public(format!("/events/{}/stage", fx.event_id)).await;
    assert_eq!(stage.status, StatusCode::OK, "{:?}", stage.body);
    let rows = stage.body["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0]["team_name"], "Альфа");
    assert!(
        rows.iter()
            .all(|r| r["wins"].is_u64() && r.get("judges").is_none())
    );

    // Published: the snapshot including per-judge win rates.
    let published = fx.transition(json!({ "to": "published" })).await;
    assert_eq!(published.status, StatusCode::OK, "{:?}", published.body);
    let page = public(format!("/events/{}", fx.event_id)).await;
    let row = &page.body["results"]["rows"][0];
    assert_eq!(row["team_name"], "Альфа");
    assert_eq!(row["wins"], 2);
    assert_eq!(row["judges"].as_array().unwrap().len(), 2);
    assert!(row["judges"][0]["judge_name"].is_string());

    // Official CSV from the snapshot has the same columns.
    let csv = fx
        .admin(
            Method::GET,
            &format!("/events/{}/export.csv", fx.event_id),
            None,
        )
        .await;
    assert!(csv.text().contains("Побед;Поражений;Ничьих"));
}

#[tokio::test]
async fn matrix_counts_decided_comparisons_without_a_total() {
    let (fx, _) = decided_event(None).await;
    let resp = fx
        .admin(
            Method::GET,
            &format!("/events/{}/matrix", fx.event_id),
            None,
        )
        .await;
    assert_eq!(resp.status, StatusCode::OK, "{:?}", resp.body);
    let cells = resp.body["cells"].as_array().unwrap();
    assert_eq!(cells.len(), 6);
    assert!(cells.iter().all(|c| c["total"] == 0));
    let scored = |judge: usize| -> i64 {
        cells
            .iter()
            .filter(|c| c["judge_id"] == json!(fx.judges[judge].0))
            .map(|c| c["scored"].as_i64().unwrap())
            .sum()
    };
    // Each decided comparison counts for both of its teams.
    assert_eq!(scored(0), 6);
    assert_eq!(scored(1), 2);
}

#[tokio::test]
async fn sheet_import_is_not_available_for_pairwise_events() {
    let fx = pairwise(1, &[], true).await;
    let resp = fx
        .admin(
            Method::POST,
            &format!("/events/{}/import-sheet", fx.event_id),
            Some(json!({ "format": "judgeflow-sheet/1", "token": fx.judges[0].1, "items": [] })),
        )
        .await;
    assert_eq!(resp.status, StatusCode::BAD_REQUEST, "{:?}", resp.body);
}

#[tokio::test]
async fn rubric_round_hands_over_to_a_pairwise_round() {
    let fx = Fixture::new(1, true).await;
    fx.score_all(0, 800, 400).await;
    for idx in 0..fx.judges.len() {
        let resp = fx.judge(idx, Method::POST, "/judge/submit", None).await;
        assert_eq!(resp.status, StatusCode::OK, "{:?}", resp.body);
    }
    for to in ["locked", "finalized"] {
        assert!(fx.transition(json!({ "to": to })).await.status.is_success());
    }

    let resp = fx
        .admin(
            Method::POST,
            &format!("/events/{}/next-round", fx.event_id),
            Some(json!({
                "title": "Финал", "team_ids": fx.team_ids, "scoring_mode": "pairwise",
                "copy_criteria": false, "copy_judges": true,
            })),
        )
        .await;
    assert_eq!(resp.status, StatusCode::OK, "{:?}", resp.body);
    let round_id = resp.body["event"]["event"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(resp.body["event"]["event"]["scoring_mode"], "pairwise");
    let token = resp.body["links"][0]["link"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap()
        .to_string();

    let start = fx
        .admin(
            Method::POST,
            &format!("/events/{round_id}/transition"),
            Some(json!({ "to": "judging" })),
        )
        .await;
    assert_eq!(start.status, StatusCode::OK, "{:?}", start.body);
    let judge = |method: Method, path: &str, body: Option<Value>| {
        let (app, token) = (fx.app.clone(), token.clone());
        let path = format!("/api{path}");
        async move { send(&app, method, &path, body, Auth::Bearer(&token)).await }
    };
    let session = judge(Method::GET, "/judge/session", None).await;
    assert_eq!(session.body["event"]["scoring_mode"], "pairwise");
    assert_eq!(session.body["comparisons"], json!([]));
    let reserved = judge(
        Method::POST,
        "/judge/pairs/reserve",
        Some(json!({ "count": 5 })),
    )
    .await;
    let list = comparisons(&reserved);
    assert_eq!(list.len(), 1, "two teams form a single pair");
    let put = judge(
        Method::PUT,
        "/judge/comparisons",
        Some(json!({ "items": [{ "id": list[0]["id"], "winner": "a", "edited_at": now_ms() }] })),
    )
    .await;
    assert_eq!(put.body["results"][0]["status"], "ok", "{:?}", put.body);
    assert_eq!(
        judge(Method::POST, "/judge/submit", None).await.status,
        StatusCode::OK
    );
    for to in ["locked", "finalized"] {
        let resp = fx
            .admin(
                Method::POST,
                &format!("/events/{round_id}/transition"),
                Some(json!({ "to": to })),
            )
            .await;
        assert_eq!(resp.status, StatusCode::OK, "{:?}", resp.body);
    }
    let ranking = fx
        .admin(
            Method::GET,
            &format!("/events/{round_id}/results?mode=official"),
            None,
        )
        .await;
    assert_eq!(ranking.status, StatusCode::OK);
    let rows = table(&ranking.body);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].1, json!(1));
    assert_eq!((rows[0].2.clone(), rows[0].3.clone()), (json!(1), json!(0)));
    assert_eq!((rows[1].2.clone(), rows[1].3.clone()), (json!(0), json!(1)));
}

#[tokio::test]
async fn rubric_score_writes_are_rejected_in_pairwise_events() {
    let fx = pairwise(1, &[], true).await;
    let session = fx.judge(0, Method::GET, "/judge/session", None).await;
    assert_eq!(session.body["criteria"], json!([]));
    let put = fx
        .put_scores(
            0,
            json!([{ "team_id": fx.team_ids[0], "criterion_id": fx.criterion_ids[0],
                    "value_x100": 500, "edited_at": now_ms() }]),
        )
        .await;
    assert_eq!(put.status, StatusCode::OK, "{:?}", put.body);
    assert_eq!(put.body["results"][0]["status"], "rejected");
    assert_eq!(put.body["results"][0]["error"], "invalid_state");
}

async fn assign_judge(fx: &Fixture, teams: &[usize]) {
    let pairs: Vec<Value> = teams
        .iter()
        .map(|t| json!({ "judge_id": fx.judges[0].0, "team_id": fx.team_ids[*t] }))
        .collect();
    let resp = fx
        .admin(
            Method::PUT,
            &format!("/events/{}/assignments", fx.event_id),
            Some(json!({ "pairs": pairs })),
        )
        .await;
    assert_eq!(resp.status, StatusCode::OK, "{:?}", resp.body);
}

#[tokio::test]
async fn reserve_drops_open_pairs_that_are_no_longer_covered() {
    let fx = pairwise(1, &["Вега"], true).await;
    assert_eq!(comparisons(&reserve(&fx, 0, 3).await).len(), 3);
    assign_judge(&fx, &[0, 1]).await;
    let open = comparisons(&reserve(&fx, 0, 3).await);
    assert_eq!(open.len(), 1, "{open:?}");
    assert_eq!(unordered(&open[0]), {
        let mut p = [fx.team_ids[0].clone(), fx.team_ids[1].clone()];
        p.sort();
        (p[0].clone(), p[1].clone())
    });
}

#[tokio::test]
async fn submit_drops_open_pairs_that_are_no_longer_covered() {
    let fx = pairwise(1, &["Вега"], true).await;
    assert_eq!(comparisons(&reserve(&fx, 0, 3).await).len(), 3);
    // Only one team left: no pair is valid any more, so nothing blocks the submit.
    assign_judge(&fx, &[0]).await;
    let resp = fx.judge(0, Method::POST, "/judge/submit", None).await;
    assert_eq!(resp.status, StatusCode::OK, "{:?}", resp.body);
}
