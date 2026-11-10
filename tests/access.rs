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
        Some(json!({ "answers": [] })),
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
            "option_id": teacher_question.body["options"][0]["id"]
        })),
        Auth::Cookie(&teacher_cookie),
    )
    .await;
    assert_eq!(teacher_draft.status, StatusCode::NO_CONTENT);
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
        1
    );
    assert_eq!(
        shared_workspace.body["team_draft"][0]["edited_by_name"],
        "Педагог"
    );
    let teacher_submit = send(
        &fx.app,
        Method::POST,
        "/api/access/submit",
        Some(json!({ "answers": [{
            "question_id": teacher_question.body["id"],
            "option_id": teacher_question.body["options"][0]["id"]
        }] })),
        Auth::Cookie(&second_teacher_cookie),
    )
    .await;
    assert_eq!(
        teacher_submit.status,
        StatusCode::NO_CONTENT,
        "{:?}",
        teacher_submit.body
    );

    let phase = send(
        &fx.app,
        Method::PATCH,
        "/api/access/phase",
        Some(json!({ "phase": "students" })),
        Auth::Cookie(&organizer_cookie),
    )
    .await;
    assert_eq!(phase.status, StatusCode::OK);
    let student_submit = send(
        &fx.app,
        Method::POST,
        "/api/access/submit",
        Some(json!({ "answers": [{
            "question_id": student_question.body["id"],
            "option_id": student_question.body["options"][0]["id"]
        }] })),
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
    assert_eq!(workspace.body["team_draft"].as_array().unwrap().len(), 2);
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
