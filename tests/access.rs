mod common;

use axum::http::{Method, StatusCode};
use common::{Auth, Fixture, send};
use serde_json::{Value, json};

async fn login(app: &axum::Router, event_id: &str, password: &str) -> String {
    let response = send(
        app,
        Method::POST,
        &format!("/api/events/{event_id}/access/login"),
        Some(json!({ "password": password })),
        Auth::None,
    )
    .await;
    assert_eq!(response.status, StatusCode::OK, "{:?}", response.body);
    response.cookie()
}

async fn create_user(
    fx: &Fixture,
    organizer_cookie: &str,
    name: &str,
    role: &str,
    team_id: Option<&str>,
) -> Value {
    let response = send(
        &fx.app,
        Method::POST,
        "/api/access/users",
        Some(json!({ "name": name, "role": role, "team_id": team_id })),
        Auth::Cookie(organizer_cookie),
    )
    .await;
    assert_eq!(response.status, StatusCode::OK, "{:?}", response.body);
    response.body
}

#[tokio::test]
async fn event_access_flow_teacher_then_student_then_jury() {
    let fx = Fixture::new(0, false).await;
    let bootstrap = fx
        .admin(
            Method::POST,
            &format!("/events/{}/access/bootstrap", fx.event_id),
            Some(json!({ "name": "Организатор" })),
        )
        .await;
    assert_eq!(bootstrap.status, StatusCode::OK, "{:?}", bootstrap.body);
    assert!(
        bootstrap.body["magic_url"]
            .as_str()
            .unwrap()
            .contains("/m/")
    );
    assert!(
        bootstrap.body["login_url"]
            .as_str()
            .unwrap()
            .ends_with(&format!("/{}/auth", fx.event_id))
    );
    let organizer_cookie = login(
        &fx.app,
        &fx.event_id,
        bootstrap.body["password"].as_str().unwrap(),
    )
    .await;

    let teacher = create_user(
        &fx,
        &organizer_cookie,
        "Педагог",
        "teacher",
        Some(&fx.team_ids[0]),
    )
    .await;
    let second_teacher = create_user(
        &fx,
        &organizer_cookie,
        "Второй педагог",
        "teacher",
        Some(&fx.team_ids[0]),
    )
    .await;
    let student = create_user(
        &fx,
        &organizer_cookie,
        "Студент",
        "student",
        Some(&fx.team_ids[0]),
    )
    .await;
    let jury = create_user(&fx, &organizer_cookie, "Жюри", "jury", None).await;

    let teacher_question = send(
        &fx.app,
        Method::POST,
        "/api/access/questions",
        Some(json!({ "audience": "teacher", "prompt": "Формат?", "options": ["Практика", "Исследование"] })),
        Auth::Cookie(&organizer_cookie),
    )
    .await;
    assert_eq!(teacher_question.status, StatusCode::OK);
    let mut extra_questions = Vec::new();
    for (kind, prompt, options, required) in [
        (
            "multiple_choice",
            "Выберите инструменты",
            json!(["Rust", "SQLite", "Axum"]),
            true,
        ),
        ("text", "Опишите решение", json!([]), true),
        ("text", "Комментарий по желанию", json!([]), false),
    ] {
        let question = send(&fx.app, Method::POST, "/api/access/questions",
            Some(json!({ "audience": "teacher", "kind": kind, "prompt": prompt, "options": options, "required": required })),
            Auth::Cookie(&organizer_cookie)).await;
        assert_eq!(question.status, StatusCode::OK, "{:?}", question.body);
        extra_questions.push(question.body);
    }
    let student_question = send(
        &fx.app,
        Method::POST,
        "/api/access/questions",
        Some(json!({ "audience": "student", "prompt": "Повторили?", "options": ["Да", "Нет"] })),
        Auth::Cookie(&organizer_cookie),
    )
    .await;
    assert_eq!(student_question.status, StatusCode::OK);

    let skipped_phase = send(
        &fx.app,
        Method::PATCH,
        "/api/access/phase",
        Some(json!({ "phase": "students" })),
        Auth::Cookie(&organizer_cookie),
    )
    .await;
    assert_eq!(skipped_phase.status, StatusCode::CONFLICT);

    let phase = send(
        &fx.app,
        Method::PATCH,
        "/api/access/phase",
        Some(json!({ "phase": "teachers" })),
        Auth::Cookie(&organizer_cookie),
    )
    .await;
    assert_eq!(phase.status, StatusCode::OK);

    let student_cookie = login(&fx.app, &fx.event_id, student["password"].as_str().unwrap()).await;
    let blocked = send(
        &fx.app,
        Method::POST,
        "/api/access/submit",
        None,
        Auth::Cookie(&student_cookie),
    )
    .await;
    assert_eq!(blocked.status, StatusCode::CONFLICT);

    let teacher_cookie = login(&fx.app, &fx.event_id, teacher["password"].as_str().unwrap()).await;
    let teacher_draft = send(
        &fx.app,
        Method::PATCH,
        "/api/access/team-draft",
        Some(json!({
            "question_id": teacher_question.body["id"],
            "option_ids": [teacher_question.body["options"][0]["id"]]
        })),
        Auth::Cookie(&teacher_cookie),
    )
    .await;
    assert_eq!(teacher_draft.status, StatusCode::NO_CONTENT);
    for invalid in [
        json!({ "question_id": teacher_question.body["id"], "option_ids": [teacher_question.body["options"][0]["id"], teacher_question.body["options"][1]["id"]] }),
        json!({ "question_id": extra_questions[0]["id"], "option_ids": [extra_questions[0]["options"][0]["id"], extra_questions[0]["options"][0]["id"]] }),
        json!({ "question_id": extra_questions[0]["id"], "option_ids": [teacher_question.body["options"][0]["id"]] }),
        json!({ "question_id": extra_questions[1]["id"], "text": "x".repeat(20_001) }),
        json!({ "question_id": extra_questions[1]["id"], "text": "Текст", "option_ids": [teacher_question.body["options"][0]["id"]] }),
    ] {
        let response = send(
            &fx.app,
            Method::PATCH,
            "/api/access/team-draft",
            Some(invalid),
            Auth::Cookie(&teacher_cookie),
        )
        .await;
        assert_eq!(
            response.status,
            StatusCode::BAD_REQUEST,
            "{:?}",
            response.body
        );
    }
    let incomplete = send(
        &fx.app,
        Method::POST,
        "/api/access/submit",
        None,
        Auth::Cookie(&teacher_cookie),
    )
    .await;
    assert_eq!(incomplete.status, StatusCode::BAD_REQUEST);
    for answer in [
        json!({ "question_id": extra_questions[0]["id"], "option_ids": [extra_questions[0]["options"][0]["id"], extra_questions[0]["options"][2]["id"]] }),
        json!({ "question_id": extra_questions[1]["id"], "text": "Наше решение\nВторой абзац" }),
    ] {
        let response = send(
            &fx.app,
            Method::PATCH,
            "/api/access/team-draft",
            Some(answer),
            Auth::Cookie(&teacher_cookie),
        )
        .await;
        assert_eq!(
            response.status,
            StatusCode::NO_CONTENT,
            "{:?}",
            response.body
        );
    }
    let second_teacher_cookie = login(
        &fx.app,
        &fx.event_id,
        second_teacher["password"].as_str().unwrap(),
    )
    .await;
    let shared_workspace = send(
        &fx.app,
        Method::GET,
        "/api/access/workspace",
        None,
        Auth::Cookie(&second_teacher_cookie),
    )
    .await;
    assert_eq!(
        shared_workspace.body["team_draft"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    assert_eq!(
        shared_workspace.body["team_draft"][0]["edited_by_name"],
        "Педагог"
    );
    let teacher_submit = send(
        &fx.app,
        Method::POST,
        "/api/access/submit",
        None,
        Auth::Cookie(&second_teacher_cookie),
    )
    .await;
    assert_eq!(
        teacher_submit.status,
        StatusCode::NO_CONTENT,
        "{:?}",
        teacher_submit.body
    );
    let locked = send(
        &fx.app,
        Method::PATCH,
        "/api/access/team-draft",
        Some(json!({ "question_id": extra_questions[1]["id"], "text": "Попытка изменить" })),
        Auth::Cookie(&teacher_cookie),
    )
    .await;
    assert_eq!(locked.status, StatusCode::CONFLICT);

    let phase = send(
        &fx.app,
        Method::PATCH,
        "/api/access/phase",
        Some(json!({ "phase": "students" })),
        Auth::Cookie(&organizer_cookie),
    )
    .await;
    assert_eq!(phase.status, StatusCode::OK);
    let student_draft = send(
        &fx.app,
        Method::PATCH,
        "/api/access/team-draft",
        Some(json!({
            "question_id": student_question.body["id"],
            "option_ids": [student_question.body["options"][0]["id"]]
        })),
        Auth::Cookie(&student_cookie),
    )
    .await;
    assert_eq!(student_draft.status, StatusCode::NO_CONTENT);
    let student_submit = send(
        &fx.app,
        Method::POST,
        "/api/access/submit",
        None,
        Auth::Cookie(&student_cookie),
    )
    .await;
    assert_eq!(
        student_submit.status,
        StatusCode::NO_CONTENT,
        "{:?}",
        student_submit.body
    );

    let jury_cookie = login(&fx.app, &fx.event_id, jury["password"].as_str().unwrap()).await;
    let workspace = send(
        &fx.app,
        Method::GET,
        "/api/access/workspace",
        None,
        Auth::Cookie(&jury_cookie),
    )
    .await;
    assert_eq!(workspace.status, StatusCode::OK);
    assert_eq!(workspace.body["event"]["phase"], "students");
    let submitted = workspace.body["users"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|user| user["submitted"] == true)
        .count();
    assert_eq!(submitted, 3);
    let drafts = workspace.body["team_draft"].as_array().unwrap();
    assert_eq!(drafts.len(), 4);
    assert!(
        drafts
            .iter()
            .any(|answer| answer["option_ids"].as_array().unwrap().len() == 2)
    );
    assert!(
        drafts
            .iter()
            .any(|answer| answer["text"] == "Наше решение\nВторой абзац")
    );
    assert_eq!(workspace.body["questions"].as_array().unwrap().len(), 5);
}

#[tokio::test]
async fn access_routes_reject_wrong_role_and_wrong_password() {
    let fx = Fixture::new(0, false).await;
    let wrong = send(
        &fx.app,
        Method::POST,
        &format!("/api/events/{}/access/login", fx.event_id),
        Some(json!({ "password": "wrong" })),
        Auth::None,
    )
    .await;
    assert_eq!(wrong.status, StatusCode::UNAUTHORIZED);

    let bootstrap = fx
        .admin(
            Method::POST,
            &format!("/events/{}/access/bootstrap", fx.event_id),
            Some(json!({ "name": "Организатор" })),
        )
        .await;
    let organizer_cookie = login(
        &fx.app,
        &fx.event_id,
        bootstrap.body["password"].as_str().unwrap(),
    )
    .await;
    let jury = create_user(&fx, &organizer_cookie, "Жюри", "jury", None).await;
    let jury_cookie = login(&fx.app, &fx.event_id, jury["password"].as_str().unwrap()).await;
    let forbidden = send(
        &fx.app,
        Method::POST,
        "/api/access/teams",
        Some(json!({ "name": "Нельзя" })),
        Auth::Cookie(&jury_cookie),
    )
    .await;
    assert_eq!(forbidden.status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn question_type_migration_preserves_existing_answers() {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    let migrator = sqlx::migrate!("./migrations");
    migrator.run_to(7, &pool).await.unwrap();
    for statement in [
        "INSERT INTO events (id, title, created_at, updated_at) VALUES ('event', 'Old event', 1, 1)",
        "INSERT INTO teams (id, event_id, name) VALUES ('team', 'event', 'Team')",
        "INSERT INTO event_users (id, event_id, team_id, name, role, password_hash, magic_token_hash, created_at) VALUES ('user', 'event', 'team', 'Teacher', 'teacher', 'unused', 'unused', 1)",
        "INSERT INTO form_questions (id, event_id, audience, prompt) VALUES ('question', 'event', 'teacher', 'Existing question')",
        "INSERT INTO form_options (id, question_id, label) VALUES ('option', 'question', 'Existing option')",
        "INSERT INTO team_form_answers (team_id, question_id, option_id, edited_by, updated_at) VALUES ('team', 'question', 'option', 'user', 2)",
        "INSERT INTO team_form_submissions (team_id, audience, submitted_by, submitted_at) VALUES ('team', 'teacher', 'user', 3)",
    ] {
        sqlx::query(statement).execute(&pool).await.unwrap();
    }
    migrator.run(&pool).await.unwrap();
    let answer: (String, String, String, i64) =
        sqlx::query_as("SELECT option_ids, text, edited_by, updated_at FROM team_form_answers")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(answer, ("[\"option\"]".into(), "".into(), "user".into(), 2));
    let question: (String, bool) = sqlx::query_as("SELECT kind, required FROM form_questions")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(question, ("single_choice".into(), true));
    let submitted: i64 = sqlx::query_scalar("SELECT submitted_at FROM team_form_submissions")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(submitted, 3);
    assert!(
        sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&pool)
            .await
            .unwrap()
            .is_empty()
    );
}
