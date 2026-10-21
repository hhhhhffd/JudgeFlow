//! Judge-team assignments, auto-assignment and conflicts of interest (SPEC section 12).
//! Editable in every status except `finalized`/`published`.

use std::collections::{HashMap, HashSet};

use axum::extract::{Path, State};
use axum::routing::{post, put};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::SqliteConnection;

use crate::audit;
use crate::auth::AdminSession;
use crate::db::begin_write;
use crate::domain::{self, Layout, event_full, load_event};
use crate::error::{AppError, AppResult};
use crate::sse::ChangeKind;
use crate::state::AppState;

/// `(judge_id, team_id)`.
type JudgeTeam = (String, String);

const PAIRS_MAX: usize = 100_000;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/events/{id}/assignments", put(set_assignments))
        .route("/events/{id}/assignments/auto", post(auto_assign))
        .route("/events/{id}/conflicts", put(set_conflicts))
}

#[derive(Deserialize)]
struct Pair {
    judge_id: String,
    team_id: String,
}

#[derive(Deserialize)]
struct PairsRequest {
    pairs: Vec<Pair>,
}

/// Loads the event and rejects closed ones.
async fn load_editable(conn: &mut SqliteConnection, event_id: &str) -> AppResult<()> {
    let event = load_event(conn, event_id).await?;
    if domain::is_closed(&event.status) {
        return Err(AppError::InvalidState(
            "Назначения и конфликты нельзя менять после завершения оценивания".into(),
            None,
        ));
    }
    Ok(())
}

/// Checks that every pair references a judge and a team of the event; drops duplicates.
async fn validate_pairs(
    conn: &mut SqliteConnection,
    event_id: &str,
    pairs: &[Pair],
) -> AppResult<Vec<(String, String)>> {
    if pairs.len() > PAIRS_MAX {
        return Err(AppError::Validation(format!(
            "Не более {PAIRS_MAX} пар за один запрос"
        )));
    }
    let judges: HashSet<String> = sqlx::query_scalar("SELECT id FROM judges WHERE event_id = ?")
        .bind(event_id)
        .fetch_all(&mut *conn)
        .await?
        .into_iter()
        .collect();
    let teams: HashSet<String> = sqlx::query_scalar("SELECT id FROM teams WHERE event_id = ?")
        .bind(event_id)
        .fetch_all(&mut *conn)
        .await?
        .into_iter()
        .collect();
    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(pairs.len());
    for pair in pairs {
        if !judges.contains(&pair.judge_id) || !teams.contains(&pair.team_id) {
            return Err(AppError::Validation(
                "Судья или команда не относятся к этому событию".into(),
            ));
        }
        if seen.insert((pair.judge_id.as_str(), pair.team_id.as_str())) {
            out.push((pair.judge_id.clone(), pair.team_id.clone()));
        }
    }
    Ok(out)
}

async fn replace_assignments(
    conn: &mut SqliteConnection,
    event_id: &str,
    pairs: &[(String, String)],
) -> AppResult<()> {
    sqlx::query(
        "DELETE FROM assignments WHERE judge_id IN (SELECT id FROM judges WHERE event_id = ?)",
    )
    .bind(event_id)
    .execute(&mut *conn)
    .await?;
    for (judge_id, team_id) in pairs {
        sqlx::query("INSERT INTO assignments (judge_id, team_id) VALUES (?, ?)")
            .bind(judge_id)
            .bind(team_id)
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

/// Official results can change when the set of covered teams changes.
fn notify_changed(state: &AppState, event_id: &str) {
    state.sse.notify(event_id, ChangeKind::Judges);
    state.sse.notify(event_id, ChangeKind::Scores);
}

async fn set_assignments(
    State(state): State<AppState>,
    session: AdminSession,
    Path(event_id): Path<String>,
    Json(req): Json<PairsRequest>,
) -> AppResult<Json<Value>> {
    let mut tx = begin_write(&state.pool).await?;
    load_editable(&mut tx, &event_id).await?;
    let pairs = validate_pairs(&mut tx, &event_id, &req.pairs).await?;
    replace_assignments(&mut tx, &event_id, &pairs).await?;
    audit::record(
        &mut *tx,
        Some(&event_id),
        Some(&session.admin.id),
        "assignments.set",
        json!({ "count": pairs.len() }),
    )
    .await?;
    let full = event_full(&mut tx, &event_id).await?;
    tx.commit().await?;
    notify_changed(&state, &event_id);
    Ok(Json(full))
}

#[derive(Deserialize)]
struct AutoRequest {
    judges_per_team: i64,
    #[serde(default)]
    allow_short: bool,
}

/// Deterministic balancing: teams in order, each takes the `k` active conflict-free judges with
/// the fewest assignments so far (ties by judge creation order). Returns the pairs and the teams
/// that could not get `k` judges as `(team_id, got)`.
fn plan_assignments(
    layout: &Layout,
    active_judges: &[String],
    k: usize,
) -> (Vec<JudgeTeam>, Vec<(String, usize)>) {
    let mut load: HashMap<&str, usize> = active_judges.iter().map(|j| (j.as_str(), 0)).collect();
    let mut pairs = Vec::new();
    let mut short = Vec::new();
    for team in &layout.teams {
        let mut candidates: Vec<(usize, usize)> = active_judges
            .iter()
            .enumerate()
            .filter(|(_, judge)| !layout.has_conflict(judge, &team.id))
            .map(|(order, judge)| (load[judge.as_str()], order))
            .collect();
        candidates.sort();
        candidates.truncate(k);
        if candidates.len() < k {
            short.push((team.id.clone(), candidates.len()));
        }
        for (_, order) in candidates {
            let judge = &active_judges[order];
            *load.get_mut(judge.as_str()).expect("judge is tracked") += 1;
            pairs.push((judge.clone(), team.id.clone()));
        }
    }
    (pairs, short)
}

async fn auto_assign(
    State(state): State<AppState>,
    session: AdminSession,
    Path(event_id): Path<String>,
    Json(req): Json<AutoRequest>,
) -> AppResult<Json<Value>> {
    if req.judges_per_team < 1 {
        return Err(AppError::Validation(
            "Судей на команду: целое число от 1".into(),
        ));
    }
    let mut tx = begin_write(&state.pool).await?;
    load_editable(&mut tx, &event_id).await?;
    let layout = Layout::load(&mut tx, &event_id).await?;
    let active_judges: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM judges WHERE event_id = ? AND is_active = 1 ORDER BY created_at, rowid",
    )
    .bind(&event_id)
    .fetch_all(&mut *tx)
    .await?;
    let k = usize::try_from(req.judges_per_team).unwrap_or(usize::MAX);
    let (pairs, short) = plan_assignments(&layout, &active_judges, k);
    if !short.is_empty() && !req.allow_short {
        let details: Vec<Value> = short
            .iter()
            .map(|(team_id, got)| json!({ "team_id": team_id, "got": got }))
            .collect();
        return Err(AppError::InvalidState(
            "Не для всех команд хватает судей".into(),
            Some(json!({ "short": details })),
        ));
    }
    replace_assignments(&mut tx, &event_id, &pairs).await?;
    audit::record(
        &mut *tx,
        Some(&event_id),
        Some(&session.admin.id),
        "assignments.auto",
        json!({
            "judges_per_team": req.judges_per_team,
            "allow_short": req.allow_short,
            "count": pairs.len(),
            "short": short.len(),
        }),
    )
    .await?;
    let full = event_full(&mut tx, &event_id).await?;
    tx.commit().await?;
    notify_changed(&state, &event_id);
    Ok(Json(full))
}

async fn set_conflicts(
    State(state): State<AppState>,
    session: AdminSession,
    Path(event_id): Path<String>,
    Json(req): Json<PairsRequest>,
) -> AppResult<Json<Value>> {
    let mut tx = begin_write(&state.pool).await?;
    load_editable(&mut tx, &event_id).await?;
    let pairs = validate_pairs(&mut tx, &event_id, &req.pairs).await?;
    sqlx::query(
        "DELETE FROM conflicts WHERE judge_id IN (SELECT id FROM judges WHERE event_id = ?)",
    )
    .bind(&event_id)
    .execute(&mut *tx)
    .await?;
    for (judge_id, team_id) in &pairs {
        sqlx::query("INSERT INTO conflicts (judge_id, team_id) VALUES (?, ?)")
            .bind(judge_id)
            .bind(team_id)
            .execute(&mut *tx)
            .await?;
    }
    audit::record(
        &mut *tx,
        Some(&event_id),
        Some(&session.admin.id),
        "conflicts.set",
        json!({ "count": pairs.len() }),
    )
    .await?;
    let full = event_full(&mut tx, &event_id).await?;
    tx.commit().await?;
    notify_changed(&state, &event_id);
    Ok(Json(full))
}
