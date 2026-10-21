//! Embedded frontend (`web/dist`) with SPA fallback.

use axum::http::{HeaderValue, Method, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use rust_embed::RustEmbed;

/// `allow_missing` keeps the crate compiling when the frontend has not been built.
#[derive(RustEmbed)]
#[folder = "web/dist"]
#[allow_missing = true]
struct Assets;

const IMMUTABLE: &str = "public, max-age=31536000, immutable";
const NO_CACHE: &str = "no-cache";

pub async fn handler(method: Method, uri: Uri) -> Response {
    if method != Method::GET && method != Method::HEAD {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let path = uri.path().trim_start_matches('/');
    if !path.is_empty()
        && let Some(response) = file_response(path)
    {
        return response;
    }
    // A missing hashed asset must not turn into index.html.
    if path.starts_with("assets/") {
        return StatusCode::NOT_FOUND.into_response();
    }
    file_response("index.html").unwrap_or_else(|| {
        (
            StatusCode::NOT_FOUND,
            "Frontend is not built (web/dist is missing)",
        )
            .into_response()
    })
}

fn file_response(path: &str) -> Option<Response> {
    let file = Assets::get(path)?;
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    let cache = if path.starts_with("assets/") {
        IMMUTABLE
    } else {
        NO_CACHE
    };
    Some(
        (
            [
                (
                    header::CONTENT_TYPE,
                    HeaderValue::from_str(mime.as_ref())
                        .expect("mime types are valid header values"),
                ),
                (header::CACHE_CONTROL, HeaderValue::from_static(cache)),
            ],
            file.data.into_owned(),
        )
            .into_response(),
    )
}
