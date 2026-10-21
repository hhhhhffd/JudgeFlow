use std::time::{SystemTime, UNIX_EPOCH};

use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use http_body_util::BodyExt;
use judgeflow::auth::JudgeAuth;
use judgeflow::crypto::hash_token;
use judgeflow::state::AppState;
use serde_json::{Value, json};
use totp_rs::{Builder, Secret, Totp};
use tower::ServiceExt;

struct Resp {
    status: StatusCode,
    headers: HeaderMap,
    body: Value,
}

impl Resp {
    /// `name=value` part of the Set-Cookie header.
    fn cookie(&self) -> String {
        let raw = self
            .headers
            .get(header::SET_COOKIE)
            .expect("Set-Cookie")
            .to_str()
            .unwrap();
        raw.split(';').next().unwrap().to_string()
    }
}

async fn send(
    app: &Router,
    method: Method,
    uri: &str,
    body: Option<Value>,
    cookie: Option<&str>,
) -> Resp {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(cookie) = cookie {
        builder = builder.header(header::COOKIE, cookie);
    }
    let request = match body {
        Some(body) => builder
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string())),
        None => builder.body(Body::empty()),
    }
    .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    Resp {
        status,
        headers,
        body,
    }
}

fn totp_for(secret_b32: &str) -> Totp {
    let secret = Secret::try_from_base32(secret_b32).unwrap();
    Builder::new()
        .with_secret(secret.as_bytes().to_vec())
        .with_account_name("test")
        .with_issuer(Some("JudgeFlow"))
        .build()
        .unwrap()
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

/// A code for the current step (what enrollment consumes).
fn code_now(secret: &str) -> String {
    totp_for(secret).generate(now()).to_string()
}

/// A code for the next step: valid because of skew 1, and newer than the enrollment step.
fn code_next(secret: &str) -> String {
    totp_for(secret).generate(now() + 30).to_string()
}

async fn setup() -> (AppState, Router) {
    let state = AppState::for_tests().await;
    let app = judgeflow::build_app(state.clone());
    (state, app)
}

/// Runs the first-start flow; returns (session cookie, TOTP secret).
async fn create_owner(state: &AppState, app: &Router, name: &str) -> (String, String) {
    let begin = send(
        app,
        Method::POST,
        "/api/setup/first-start/begin",
        Some(json!({ "setup_password": &*state.setup_password, "name": name })),
        None,
    )
    .await;
    assert_eq!(begin.status, StatusCode::OK);
    let secret = begin.body["secret"].as_str().unwrap().to_string();
    let complete = send(
        app,
        Method::POST,
        "/api/setup/first-start/complete",
        Some(json!({ "enrollment_token": begin.body["enrollment_token"], "code": code_now(&secret) })),
        None,
    )
    .await;
    assert_eq!(complete.status, StatusCode::OK);
    (complete.cookie(), secret)
}

/// Owner creates an invite and `name` enrolls through it; returns (cookie, secret, admin id).
async fn invite_admin(app: &Router, owner_cookie: &str, name: &str) -> (String, String, String) {
    let invite = send(
        app,
        Method::POST,
        "/api/admins/invites",
        None,
        Some(owner_cookie),
    )
    .await;
    assert_eq!(invite.status, StatusCode::OK);
    let token = invite.body["url"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap()
        .to_string();
    let begin = send(
        app,
        Method::POST,
        &format!("/api/invites/{token}/begin"),
        Some(json!({ "name": name })),
        None,
    )
    .await;
    assert_eq!(begin.status, StatusCode::OK);
    let secret = begin.body["secret"].as_str().unwrap().to_string();
    let complete = send(
        app,
        Method::POST,
        &format!("/api/invites/{token}/complete"),
        Some(json!({ "code": code_now(&secret) })),
        None,
    )
    .await;
    assert_eq!(complete.status, StatusCode::OK);
    let id = complete.body["admin"]["id"].as_str().unwrap().to_string();
    (complete.cookie(), secret, id)
}

#[tokio::test]
async fn first_start_flow() {
    let (state, app) = setup().await;
    assert_eq!(
        send(&app, Method::GET, "/api/setup/first-start", None, None)
            .await
            .status,
        StatusCode::NO_CONTENT
    );

    let wrong_pw = send(
        &app,
        Method::POST,
        "/api/setup/first-start/begin",
        Some(json!({ "setup_password": "nope", "name": "Owner" })),
        None,
    )
    .await;
    assert_eq!(wrong_pw.status, StatusCode::UNAUTHORIZED);
    assert_eq!(wrong_pw.body["error"], "unauthorized");

    let begin = send(
        &app,
        Method::POST,
        "/api/setup/first-start/begin",
        Some(json!({ "setup_password": &*state.setup_password, "name": "Owner" })),
        None,
    )
    .await;
    assert_eq!(begin.status, StatusCode::OK);
    assert!(
        begin.body["otpauth_uri"]
            .as_str()
            .unwrap()
            .starts_with("otpauth://totp/")
    );
    let secret = begin.body["secret"].as_str().unwrap();

    let bad = send(
        &app,
        Method::POST,
        "/api/setup/first-start/complete",
        Some(json!({ "enrollment_token": begin.body["enrollment_token"], "code": "000000" })),
        None,
    )
    .await;
    assert_eq!(bad.status, StatusCode::UNAUTHORIZED);

    let done = send(
        &app,
        Method::POST,
        "/api/setup/first-start/complete",
        Some(
            json!({ "enrollment_token": begin.body["enrollment_token"], "code": code_now(secret) }),
        ),
        None,
    )
    .await;
    assert_eq!(done.status, StatusCode::OK);
    assert_eq!(done.body["admin"]["role"], "owner");
    let set_cookie = done
        .headers
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap();
    assert!(set_cookie.contains("HttpOnly") && set_cookie.contains("SameSite=Strict"));
    assert!(set_cookie.contains("Path=/") && !set_cookie.contains("Secure"));

    assert_eq!(
        send(&app, Method::GET, "/api/setup/first-start", None, None)
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    let again = send(
        &app,
        Method::POST,
        "/api/setup/first-start/begin",
        Some(json!({ "setup_password": &*state.setup_password, "name": "Other" })),
        None,
    )
    .await;
    assert_eq!(again.status, StatusCode::NOT_FOUND);
    let me = send(
        &app,
        Method::GET,
        "/api/auth/me",
        None,
        Some(&done.cookie()),
    )
    .await;
    assert_eq!(me.body["admin"]["name"], "Owner");
}

#[tokio::test]
async fn login_ok_wrong_and_replayed_code() {
    let (state, app) = setup().await;
    let (_, secret) = create_owner(&state, &app, "Owner").await;
    let login = |code: String| json!({ "name": "Owner", "code": code });

    // The enrollment code is already spent.
    let spent = send(
        &app,
        Method::POST,
        "/api/auth/login",
        Some(login(code_now(&secret))),
        None,
    )
    .await;
    assert_eq!(spent.status, StatusCode::UNAUTHORIZED);

    let wrong = send(
        &app,
        Method::POST,
        "/api/auth/login",
        Some(login("123456".into())),
        None,
    )
    .await;
    assert_eq!(wrong.status, StatusCode::UNAUTHORIZED);
    assert_eq!(wrong.body["error"], "unauthorized");

    let code = code_next(&secret);
    let ok = send(
        &app,
        Method::POST,
        "/api/auth/login",
        Some(login(code.clone())),
        None,
    )
    .await;
    assert_eq!(ok.status, StatusCode::OK);
    assert_eq!(ok.body["admin"]["name"], "Owner");

    let replay = send(
        &app,
        Method::POST,
        "/api/auth/login",
        Some(login(code)),
        None,
    )
    .await;
    assert_eq!(replay.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn concurrent_logins_accept_a_code_once() {
    let (state, app) = setup().await;
    let (_, secret) = create_owner(&state, &app, "Owner").await;
    let code = code_next(&secret);
    let attempts = (0..6).map(|_| {
        let app = app.clone();
        let body = json!({ "name": "Owner", "code": code });
        tokio::spawn(async move {
            send(&app, Method::POST, "/api/auth/login", Some(body), None)
                .await
                .status
        })
    });
    let statuses = futures::future::join_all(attempts).await;
    let ok = statuses
        .iter()
        .filter(|s| *s.as_ref().unwrap() == StatusCode::OK)
        .count();
    assert_eq!(ok, 1);
}

#[tokio::test]
async fn login_is_rate_limited_per_name() {
    let (_, app) = setup().await;
    let body = json!({ "name": "ghost", "code": "000000" });
    for _ in 0..5 {
        let r = send(
            &app,
            Method::POST,
            "/api/auth/login",
            Some(body.clone()),
            None,
        )
        .await;
        assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    }
    let limited = send(&app, Method::POST, "/api/auth/login", Some(body), None).await;
    assert_eq!(limited.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(limited.body["error"], "rate_limited");
}

#[tokio::test]
async fn me_logout_and_unknown_api_route() {
    let (state, app) = setup().await;
    assert_eq!(
        send(&app, Method::GET, "/api/auth/me", None, None)
            .await
            .status,
        StatusCode::UNAUTHORIZED
    );
    let (cookie, _) = create_owner(&state, &app, "Owner").await;
    assert_eq!(
        send(&app, Method::GET, "/api/auth/me", None, Some(&cookie))
            .await
            .status,
        StatusCode::OK
    );
    let out = send(&app, Method::POST, "/api/auth/logout", None, Some(&cookie)).await;
    assert_eq!(out.status, StatusCode::NO_CONTENT);
    assert_eq!(
        send(&app, Method::GET, "/api/auth/me", None, Some(&cookie))
            .await
            .status,
        StatusCode::UNAUTHORIZED
    );

    let unknown = send(&app, Method::GET, "/api/x", None, None).await;
    assert_eq!(unknown.status, StatusCode::NOT_FOUND);
    assert_eq!(unknown.body["error"], "not_found");
}

#[tokio::test]
async fn invite_flow_and_owner_rules() {
    let (state, app) = setup().await;
    let (owner, _) = create_owner(&state, &app, "Owner").await;
    let (admin_cookie, _, admin_id) = invite_admin(&app, &owner, "Helper").await;

    // Non-owner cannot mutate.
    let denied = send(
        &app,
        Method::POST,
        "/api/admins/invites",
        None,
        Some(&admin_cookie),
    )
    .await;
    assert_eq!(denied.status, StatusCode::FORBIDDEN);
    assert_eq!(
        send(&app, Method::GET, "/api/admins", None, Some(&admin_cookie))
            .await
            .body
            .as_array()
            .unwrap()
            .len(),
        2
    );

    // Invite is single-use; listing never exposes the URL; duplicate names conflict.
    let invite = send(
        &app,
        Method::POST,
        "/api/admins/invites",
        None,
        Some(&owner),
    )
    .await;
    let token = invite.body["url"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap()
        .to_string();
    let list = send(&app, Method::GET, "/api/admins/invites", None, Some(&owner)).await;
    assert_eq!(list.body.as_array().unwrap().len(), 1);
    assert!(list.body[0].get("url").is_none());
    let dup = send(
        &app,
        Method::POST,
        &format!("/api/invites/{token}/begin"),
        Some(json!({ "name": "Helper" })),
        None,
    )
    .await;
    assert_eq!(dup.status, StatusCode::CONFLICT);
    let invite_id = list.body[0]["id"].as_str().unwrap().to_string();
    let del = send(
        &app,
        Method::DELETE,
        &format!("/api/admins/invites/{invite_id}"),
        None,
        Some(&owner),
    )
    .await;
    assert_eq!(del.status, StatusCode::NO_CONTENT);
    assert_eq!(
        send(
            &app,
            Method::GET,
            &format!("/api/invites/{token}"),
            None,
            None
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );

    // Expired invites are gone.
    let invite = send(
        &app,
        Method::POST,
        "/api/admins/invites",
        None,
        Some(&owner),
    )
    .await;
    let token = invite.body["url"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap()
        .to_string();
    assert_eq!(
        send(
            &app,
            Method::GET,
            &format!("/api/invites/{token}"),
            None,
            None
        )
        .await
        .status,
        StatusCode::OK
    );
    sqlx::query("UPDATE enrollments SET expires_at = 1")
        .execute(&state.pool)
        .await
        .unwrap();
    assert_eq!(
        send(
            &app,
            Method::GET,
            &format!("/api/invites/{token}"),
            None,
            None
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );

    // Owner rules.
    let admins = send(&app, Method::GET, "/api/admins", None, Some(&owner)).await;
    let owner_id = admins
        .body
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["role"] == "owner")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    for path in [format!("/api/admins/{owner_id}")] {
        let r = send(&app, Method::DELETE, &path, None, Some(&owner)).await;
        assert_eq!(r.status, StatusCode::FORBIDDEN);
    }
    let reset_owner = send(
        &app,
        Method::POST,
        &format!("/api/admins/{owner_id}/reset-totp"),
        None,
        Some(&owner),
    )
    .await;
    assert_eq!(reset_owner.status, StatusCode::FORBIDDEN);

    // Reset kills the target's sessions and invalidates the old secret.
    let reset = send(
        &app,
        Method::POST,
        &format!("/api/admins/{admin_id}/reset-totp"),
        None,
        Some(&owner),
    )
    .await;
    assert_eq!(reset.status, StatusCode::OK);
    assert!(
        reset.body["otpauth_uri"]
            .as_str()
            .unwrap()
            .starts_with("otpauth://")
    );
    assert_eq!(
        send(&app, Method::GET, "/api/auth/me", None, Some(&admin_cookie))
            .await
            .status,
        StatusCode::UNAUTHORIZED
    );
    let new_secret = reset.body["secret"].as_str().unwrap();
    let login = send(
        &app,
        Method::POST,
        "/api/auth/login",
        Some(json!({ "name": "Helper", "code": code_now(new_secret) })),
        None,
    )
    .await;
    assert_eq!(login.status, StatusCode::OK);

    // Delete admin; audit rows exist with NULL event_id.
    let del = send(
        &app,
        Method::DELETE,
        &format!("/api/admins/{admin_id}"),
        None,
        Some(&owner),
    )
    .await;
    assert_eq!(del.status, StatusCode::NO_CONTENT);
    assert_eq!(
        send(
            &app,
            Method::GET,
            "/api/auth/me",
            None,
            Some(&login.cookie())
        )
        .await
        .status,
        StatusCode::UNAUTHORIZED
    );
    let actions: Vec<String> =
        sqlx::query_scalar("SELECT action FROM audit_log WHERE event_id IS NULL")
            .fetch_all(&state.pool)
            .await
            .unwrap();
    for expected in ["admin.invite_create", "admin.reset_totp", "admin.delete"] {
        assert!(
            actions.iter().any(|a| a == expected),
            "missing audit action {expected}"
        );
    }
}

#[tokio::test]
async fn owner_cannot_delete_self() {
    let (state, app) = setup().await;
    let (owner, _) = create_owner(&state, &app, "Owner").await;
    let me = send(&app, Method::GET, "/api/auth/me", None, Some(&owner)).await;
    let id = me.body["admin"]["id"].as_str().unwrap();
    let r = send(
        &app,
        Method::DELETE,
        &format!("/api/admins/{id}"),
        None,
        Some(&owner),
    )
    .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn judge_extractor_rejects_unknown_and_inactive() {
    let state = AppState::for_tests().await;
    async fn whoami(judge: JudgeAuth) -> String {
        format!("{}:{}", judge.name, judge.event_id)
    }
    let app = Router::new()
        .route("/who", axum::routing::get(whoami))
        .with_state(state.clone());

    sqlx::query("INSERT INTO events (id, title, created_at, updated_at) VALUES ('e1', 'E', 1, 1)")
        .execute(&state.pool)
        .await
        .unwrap();
    for (id, token, active) in [("j1", "active-token", 1), ("j2", "inactive-token", 0)] {
        sqlx::query("INSERT INTO judges (id, event_id, name, token_hash, is_active, created_at) VALUES (?, 'e1', ?, ?, ?, 1)")
            .bind(id)
            .bind(format!("judge-{id}"))
            .bind(hash_token(token))
            .bind(active)
            .execute(&state.pool)
            .await
            .unwrap();
    }

    let get = |auth: Option<&str>| {
        let mut b = Request::builder().uri("/who");
        if let Some(a) = auth {
            b = b.header(header::AUTHORIZATION, a);
        }
        app.clone().oneshot(b.body(Body::empty()).unwrap())
    };
    assert_eq!(get(None).await.unwrap().status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        get(Some("Bearer unknown")).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        get(Some("Bearer inactive-token")).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        get(Some("Basic active-token")).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    let ok = get(Some("Bearer active-token")).await.unwrap();
    assert_eq!(ok.status(), StatusCode::OK);
    let body = ok.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(&body[..], b"judge-j1:e1");
}
