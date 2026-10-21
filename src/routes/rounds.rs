//! Next round of an event (SPEC section 13): a new draft event seeded from a finalized one.

use std::collections::{HashMap, HashSet};

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::audit;
use crate::auth::AdminSession;
use crate::crypto::{hash_token, random_token};
use crate::db::begin_write;
use crate::domain::{
    self, clean_required, event_full, load_criteria, load_event, load_judge_summary, load_teams,
    load_tracks,
};
use crate::error::{AppError, AppResult};
use crate::routes::judges::judge_link;
use crate::state::AppState;
use crate::util::{new_id, now_ms};

const TITLE_MAX: usize = 200;

pub fn router() -> Router<AppState> {
    Router::new().route("/events/{id}/next-round", post(next_round))
}

#[derive(Deserialize)]
struct NextRoundRequest {
    title: String,
    team_ids: Vec<String>,
    scoring_mode: String,
    #[serde(default)]
    copy_criteria: bool,
    #[serde(default)]
    copy_judges: bool,
}

/// Creates a draft event with `parent_event_id` = the source event and `round` + 1.
/// Selected teams keep name, description and (copied) track. With `copy_criteria` all tracks and
/// criteria are copied; otherwise only the tracks the selected teams belong to. With
/// `copy_judges` active judges are copied by name and get new tokens. Assignments and conflicts
/// are not copied (they reference the old teams).
async fn next_round(
    State(state): State<AppState>,
    session: AdminSession,
    headers: HeaderMap,
    Path(parent_id): Path<String>,
    Json(req): Json<NextRoundRequest>,
) -> AppResult<Json<Value>> {
    let title = clean_required(&req.title, "Название", TITLE_MAX)?;
    if !matches!(req.scoring_mode.as_str(), "team" | "criterion" | "pairwise") {
        return Err(AppError::Validation(
            "Режим оценки: team, criterion или pairwise".into(),
        ));
    }
    if req.team_ids.is_empty() {
        return Err(AppError::Validation(
            "Выберите хотя бы одну команду для следующего раунда".into(),
        ));
    }

    let mut tx = begin_write(&state.pool).await?;
    let parent = load_event(&mut tx, &parent_id).await?;
    if !domain::is_closed(&parent.status) {
        return Err(AppError::InvalidState(
            "Следующий раунд можно создать после утверждения результатов".into(),
            None,
        ));
    }
    let parent_teams = load_teams(&mut tx, &parent_id).await?;
    let wanted: HashSet<&str> = req.team_ids.iter().map(String::as_str).collect();
    if wanted.len() != req.team_ids.len()
        || !wanted
            .iter()
            .all(|id| parent_teams.iter().any(|t| t.id == *id))
    {
        return Err(AppError::Validation(
            "Команды должны быть уникальными командами этого события".into(),
        ));
    }
    let selected: Vec<_> = parent_teams
        .iter()
        .filter(|t| wanted.contains(t.id.as_str()))
        .collect();

    let id = new_id();
    let now = now_ms();
    // Normalization is a rubric-only setting.
    let normalization = if req.scoring_mode == "pairwise" {
        "none"
    } else {
        parent.normalization.as_str()
    };
    sqlx::query(
        "INSERT INTO events (id, title, description, location, scoring_mode, notes_enabled, quorum, \
         teams_label, teams_label_enabled, criteria_label, criteria_label_enabled, overlay_enabled, \
         overlay_color, overlay_opacity, normalization, parent_event_id, round, created_by, \
         created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&title)
    .bind(&parent.description)
    .bind(&parent.location)
    .bind(&req.scoring_mode)
    .bind(parent.notes_enabled)
    .bind(parent.quorum)
    .bind(&parent.teams_label)
    .bind(parent.teams_label_enabled)
    .bind(&parent.criteria_label)
    .bind(parent.criteria_label_enabled)
    .bind(parent.overlay_enabled)
    .bind(&parent.overlay_color)
    .bind(parent.overlay_opacity)
    .bind(normalization)
    .bind(&parent_id)
    .bind(parent.round + 1)
    .bind(&session.admin.id)
    .bind(now)
    .bind(now)
    .execute(&mut *tx)
    .await?;

    let used_tracks: HashSet<&str> = selected
        .iter()
        .filter_map(|t| t.track_id.as_deref())
        .collect();
    let mut track_map: HashMap<String, String> = HashMap::new();
    for (order, track) in load_tracks(&mut tx, &parent_id).await?.iter().enumerate() {
        if !req.copy_criteria && !used_tracks.contains(track.id.as_str()) {
            continue;
        }
        let new_track = new_id();
        sqlx::query("INSERT INTO tracks (id, event_id, name, sort_order) VALUES (?, ?, ?, ?)")
            .bind(&new_track)
            .bind(&id)
            .bind(&track.name)
            .bind(order as i64)
            .execute(&mut *tx)
            .await?;
        track_map.insert(track.id.clone(), new_track);
    }

    for (order, team) in selected.iter().enumerate() {
        sqlx::query(
            "INSERT INTO teams (id, event_id, name, description, sort_order, track_id) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(new_id())
        .bind(&id)
        .bind(&team.name)
        .bind(&team.description)
        .bind(order as i64)
        .bind(team.track_id.as_ref().and_then(|t| track_map.get(t)))
        .execute(&mut *tx)
        .await?;
    }

    if req.copy_criteria {
        for criterion in load_criteria(&mut tx, &parent_id).await? {
            sqlx::query(
                "INSERT INTO criteria (id, event_id, name, description, max_x100, step_x100, \
                 weight, sort_order, track_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(new_id())
            .bind(&id)
            .bind(&criterion.name)
            .bind(&criterion.description)
            .bind(criterion.max_x100)
            .bind(criterion.step_x100)
            .bind(criterion.weight)
            .bind(criterion.sort_order)
            .bind(criterion.track_id.as_ref().and_then(|t| track_map.get(t)))
            .execute(&mut *tx)
            .await?;
        }
    }

    let mut links = Vec::new();
    if req.copy_judges {
        let names: Vec<String> = sqlx::query_scalar(
            "SELECT name FROM judges WHERE event_id = ? AND is_active = 1 ORDER BY created_at, rowid",
        )
        .bind(&parent_id)
        .fetch_all(&mut *tx)
        .await?;
        for name in names {
            let judge_id = new_id();
            let token = random_token();
            sqlx::query(
                "INSERT INTO judges (id, event_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)",
            )
            .bind(&judge_id)
            .bind(&id)
            .bind(&name)
            .bind(hash_token(&token))
            .bind(now)
            .execute(&mut *tx)
            .await?;
            let judge = load_judge_summary(&mut tx, &judge_id).await?;
            links.push(json!({ "judge": judge, "link": judge_link(&state, &headers, &token) }));
        }
    }

    audit::record(
        &mut *tx,
        Some(&parent_id),
        Some(&session.admin.id),
        "event.next_round",
        json!({ "child_id": id, "title": title, "teams": selected.len() }),
    )
    .await?;
    audit::record(
        &mut *tx,
        Some(&id),
        Some(&session.admin.id),
        "event.create",
        json!({
            "title": title,
            "parent_event_id": parent_id,
            "round": parent.round + 1,
            "copy_criteria": req.copy_criteria,
            "copy_judges": req.copy_judges,
        }),
    )
    .await?;
    let full = event_full(&mut tx, &id).await?;
    tx.commit().await?;
    Ok(Json(json!({ "event": full, "links": links })))
}
