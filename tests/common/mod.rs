#![allow(dead_code)]

use std::time::{SystemTime, UNIX_EPOCH};

use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use http_body_util::BodyExt;
use judgeflow::state::AppState;
use serde_json::{Value, json};
use totp_rs::{Builder, Secret};
use tower::ServiceExt;

pub struct Resp {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Value,
    pub bytes: Vec<u8>,
}

impl Resp {
    pub fn cookie(&self) -> String {
        let raw = self
            .headers
            .get(header::SET_COOKIE)
            .expect("Set-Cookie")
            .to_str()
            .unwrap();
        raw.split(';').next().unwrap().to_string()
    }

    pub fn text(&self) -> String {
        String::from_utf8(self.bytes.clone()).unwrap()
    }
}

#[derive(Clone, Copy)]
pub enum Auth<'a> {
    None,
    Cookie(&'a str),
    Bearer(&'a str),
}

async fn dispatch(
    app: &Router,
    builder: axum::http::request::Builder,
    body: Body,
    auth: Auth<'_>,
) -> Resp {
    let builder = match auth {
        Auth::None => builder,
        Auth::Cookie(cookie) => builder.header(header::COOKIE, cookie),
        Auth::Bearer(token) => builder.header(header::AUTHORIZATION, format!("Bearer {token}")),
    };
    let response = app
        .clone()
        .oneshot(builder.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes()
        .to_vec();
    let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    Resp {
        status,
        headers,
        body,
        bytes,
    }
}

pub async fn send(
    app: &Router,
    method: Method,
    uri: &str,
    body: Option<Value>,
    auth: Auth<'_>,
) -> Resp {
    let builder = Request::builder().method(method).uri(uri);
    match body {
        Some(body) => {
            dispatch(
                app,
                builder.header(header::CONTENT_TYPE, "application/json"),
                Body::from(body.to_string()),
                auth,
            )
            .await
        }
        None => dispatch(app, builder, Body::empty(), auth).await,
    }
}

pub async fn send_bytes(
    app: &Router,
    method: Method,
    uri: &str,
    content_type: &str,
    bytes: Vec<u8>,
    auth: Auth<'_>,
) -> Resp {
    let builder = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::CONTENT_TYPE, content_type);
    dispatch(app, builder, Body::from(bytes), auth).await
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn code_now(secret_b32: &str) -> String {
    let secret = Secret::try_from_base32(secret_b32).unwrap();
    let totp = Builder::new()
        .with_secret(secret.as_bytes().to_vec())
        .with_account_name("test")
        .with_issuer(Some("JudgeFlow"))
        .build()
        .unwrap();
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    totp.generate(secs).to_string()
}

pub async fn setup() -> (AppState, Router) {
    let state = AppState::for_tests().await;
    let app = judgeflow::build_app(state.clone());
    (state, app)
}

/// First-start flow; returns the owner's session cookie.
pub async fn create_owner(state: &AppState, app: &Router) -> String {
    let begin = send(
        app,
        Method::POST,
        "/api/setup/first-start/begin",
        Some(json!({ "setup_password": &*state.setup_password, "name": "owner" })),
        Auth::None,
    )
    .await;
    assert_eq!(begin.status, StatusCode::OK);
    let secret = begin.body["secret"].as_str().unwrap().to_string();
    let complete = send(
        app,
        Method::POST,
        "/api/setup/first-start/complete",
        Some(json!({ "enrollment_token": begin.body["enrollment_token"], "code": code_now(&secret) })),
        Auth::None,
    )
    .await;
    assert_eq!(complete.status, StatusCode::OK);
    complete.cookie()
}

/// An event with 2 teams, 2 criteria and N judges, optionally already in `judging`.
pub struct Fixture {
    pub state: AppState,
    pub app: Router,
    pub cookie: String,
    pub event_id: String,
    pub team_ids: Vec<String>,
    pub criterion_ids: Vec<String>,
    /// (judge id, raw token)
    pub judges: Vec<(String, String)>,
}

impl Fixture {
    pub async fn new(judges: usize, start: bool) -> Self {
        let (state, app) = setup().await;
        let cookie = create_owner(&state, &app).await;
        let event = send(
            &app,
            Method::POST,
            "/api/events",
            Some(json!({ "title": "Хакатон" })),
            Auth::Cookie(&cookie),
        )
        .await;
        assert_eq!(event.status, StatusCode::OK, "{:?}", event.body);
        let event_id = event.body["event"]["id"].as_str().unwrap().to_string();

        let teams = send(
            &app,
            Method::POST,
            &format!("/api/events/{event_id}/teams/bulk"),
            Some(json!({ "teams": [{ "name": "Альфа" }, { "name": "Бета", "description": "вторая" }] })),
            Auth::Cookie(&cookie),
        )
        .await;
        assert_eq!(teams.status, StatusCode::OK, "{:?}", teams.body);
        let team_ids = ids(&teams.body);
        let criteria = send(
            &app,
            Method::POST,
            &format!("/api/events/{event_id}/criteria/bulk"),
            Some(json!({ "criteria": [
                { "name": "Идея", "max_x100": 1000, "step_x100": 100, "weight": 1 },
                { "name": "Реализация", "max_x100": 500, "step_x100": 50, "weight": 3 },
            ] })),
            Auth::Cookie(&cookie),
        )
        .await;
        assert_eq!(criteria.status, StatusCode::OK, "{:?}", criteria.body);
        let criterion_ids = ids(&criteria.body);

        let names: Vec<String> = (1..=judges).map(|i| format!("Судья {i}")).collect();
        let mut judge_list = Vec::new();
        if judges > 0 {
            let created = send(
                &app,
                Method::POST,
                &format!("/api/events/{event_id}/judges"),
                Some(json!({ "names": names })),
                Auth::Cookie(&cookie),
            )
            .await;
            assert_eq!(created.status, StatusCode::OK, "{:?}", created.body);
            for item in created.body.as_array().unwrap() {
                let link = item["link"].as_str().unwrap();
                assert!(link.starts_with("http://localhost:8080/j/"), "{link}");
                judge_list.push((
                    item["judge"]["id"].as_str().unwrap().to_string(),
                    link.rsplit('/').next().unwrap().to_string(),
                ));
            }
        }
        let fx = Self {
            state,
            app,
            cookie,
            event_id,
            team_ids,
            criterion_ids,
            judges: judge_list,
        };
        if start {
            let started = fx.transition(json!({ "to": "judging" })).await;
            assert_eq!(started.status, StatusCode::OK, "{:?}", started.body);
        }
        fx
    }

    pub async fn admin(&self, method: Method, path: &str, body: Option<Value>) -> Resp {
        send(
            &self.app,
            method,
            &format!("/api{path}"),
            body,
            Auth::Cookie(&self.cookie),
        )
        .await
    }

    pub async fn transition(&self, body: Value) -> Resp {
        self.admin(
            Method::POST,
            &format!("/events/{}/transition", self.event_id),
            Some(body),
        )
        .await
    }

    pub async fn judge(&self, idx: usize, method: Method, path: &str, body: Option<Value>) -> Resp {
        send(
            &self.app,
            method,
            &format!("/api{path}"),
            body,
            Auth::Bearer(&self.judges[idx].1),
        )
        .await
    }

    pub async fn put_scores(&self, idx: usize, items: Value) -> Resp {
        self.judge(
            idx,
            Method::PUT,
            "/judge/scores",
            Some(json!({ "items": items })),
        )
        .await
    }

    /// Saves a full sheet: criterion 0 = `c0`, criterion 1 = `c1` for every team.
    pub async fn score_all(&self, idx: usize, c0: i64, c1: i64) {
        let at = now_ms();
        let items: Vec<Value> = self
            .team_ids
            .iter()
            .flat_map(|t| {
                [
                    json!({ "team_id": t, "criterion_id": self.criterion_ids[0], "value_x100": c0, "edited_at": at }),
                    json!({ "team_id": t, "criterion_id": self.criterion_ids[1], "value_x100": c1, "edited_at": at }),
                ]
            })
            .collect();
        let resp = self.put_scores(idx, Value::Array(items)).await;
        assert_eq!(resp.status, StatusCode::OK, "{:?}", resp.body);
        for r in resp.body["results"].as_array().unwrap() {
            assert_eq!(r["status"], "ok", "{r}");
        }
    }

    pub async fn event(&self) -> Value {
        let resp = self
            .admin(Method::GET, &format!("/events/{}", self.event_id), None)
            .await;
        assert_eq!(resp.status, StatusCode::OK);
        resp.body
    }
}

pub fn ids(array: &Value) -> Vec<String> {
    array
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["id"].as_str().unwrap().to_string())
        .collect()
}
