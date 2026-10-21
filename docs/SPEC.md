# JudgeFlow v2 — specification

Source of truth for the rewrite. The previous implementation lives on the `v1` branch
(`git show v1:<path>`) and is a reference for domain logic only — its frontend code is not reused.

## 1. Runtime

- One Rust binary `judgeflow` (Axum + Tokio + SQLx/SQLite). Frontend (React + Vite) is built to
  `web/dist` and embedded into the binary with `rust-embed`. No Redis, no Nginx, no Node at runtime.
- SQLite in `DATA_DIR/judgeflow.db`: WAL, `foreign_keys=ON`, `busy_timeout=5000`, short transactions.
  Migrations: `migrations/*.sql` via `sqlx::migrate!`, applied on startup.
- Config (env, also as CLI flags of `serve`):
  - `JUDGEFLOW_ADDR` — listen address, default `0.0.0.0:8080`.
  - `JUDGEFLOW_DATA_DIR` — default `./data` (DB, uploads, `secret.key`).
  - `JUDGEFLOW_PUBLIC_URL` — optional base URL used in judge/invite links and QR codes
    (e.g. `https://judge.example.com`, `http://192.168.1.10:8080`). If unset, links are built from
    the request `Host` (+ `X-Forwarded-Proto`).
  - `JUDGEFLOW_SECRET_KEY` — optional; key material for encrypting TOTP secrets. If unset, a random
    key is generated once into `DATA_DIR/secret.key` (mode 0600) and reused.
  - `JUDGEFLOW_TRUST_PROXY` — bool, default `false`. When true, the client IP used for rate limiting
    is taken from `CF-Connecting-IP`, else the first `X-Forwarded-For` entry, else the peer address.
    Enable only behind a proxy/tunnel (e.g. Cloudflare Tunnel) that sets these headers; otherwise
    clients could spoof their IP. When false, only the peer address is used.
  - `RUST_LOG` — tracing filter, default `info`.
- CLI:
  - `judgeflow serve` (default when no subcommand)
  - `judgeflow admin list`
  - `judgeflow admin reset-totp <name>` — new TOTP secret, kills that admin's sessions, prints QR
    (terminal unicode) + otpauth URI. The only way to reset the owner's TOTP.
  - `judgeflow admin set-owner <name>` — transfers the owner role.
- Routing: `/api/**` → API; everything else → embedded static files with SPA fallback to `index.html`.
- Deployment targets: plain binary, Docker (multi-stage build, runtime image just runs the binary),
  behind Cloudflare Tunnel (HTTPS), or LAN without internet (HTTP; no Service Worker there).

## 2. Conventions

- IDs: UUID v4 strings. Timestamps: integer Unix milliseconds (`*_at`).
- All score-like numbers are integers in hundredths (`*_x100`): `750` = 7.50. Weights are integers.
- Errors: HTTP status + JSON `{ "error": "<code>", "message": "<human text, Russian>", "details"?: any }`.
  Common codes: `unauthorized`, `forbidden`, `not_found`, `validation`, `conflict`, `invalid_state`,
  `rate_limited`.
- Mutating admin endpoints require the session cookie (SameSite=Strict, HttpOnly, `Secure` when
  `PUBLIC_URL` is https). Judge endpoints use `Authorization: Bearer <judge token>`.
- Every mutating admin action on an event writes to `audit_log`.

## 3. Data model (SQLite)

```
admins(id PK, name UNIQUE NOT NULL, role CHECK(role IN ('owner','admin')),
       totp_secret_enc BLOB NOT NULL, totp_last_step INTEGER, created_at)
sessions(token_hash PK, admin_id FK→admins ON DELETE CASCADE, created_at, expires_at)   -- 14 days
enrollments(token_hash PK, kind CHECK(kind IN ('first_start','invite')), name NULL,
            secret_enc BLOB NULL, created_by FK→admins NULL, created_at, expires_at)
events(id PK, title, description, starts_at NULL, location NULL,
       status CHECK(status IN ('draft','judging','locked','finalized','published')),
       scoring_mode CHECK(IN ('team','criterion')), notes_enabled BOOL,
       visibility CHECK(IN ('hidden','live_totals','live_full')) DEFAULT 'hidden',
       quorum INTEGER DEFAULT 1,
       teams_label NULL, teams_label_enabled BOOL, criteria_label NULL, criteria_label_enabled BOOL,
       alert_enabled BOOL, alert_title, alert_text, alert_align CHECK(IN ('left','center')),
       alert_button_text, alert_version INTEGER DEFAULT 0,
       background_file NULL, overlay_enabled BOOL, overlay_color TEXT '#000000', overlay_opacity INTEGER 35 (percent),
       locked_at NULL, created_by FK→admins SET NULL, created_at, updated_at)
teams(id PK, event_id FK CASCADE, name, description NULL, sort_order)
criteria(id PK, event_id FK CASCADE, name, description NULL, max_x100 >0, step_x100 >0, weight 1..1000, sort_order)
         -- max_x100 % step_x100 == 0
judges(id PK, event_id FK CASCADE, name, token_hash UNIQUE, is_active BOOL,
       submitted_at NULL, last_seen_at NULL, pending_count INTEGER DEFAULT 0, created_at)
scores(judge_id FK CASCADE, team_id FK CASCADE, criterion_id FK CASCADE, value_x100 >=0,
       note NULL, edited_at (client clock), updated_at (server clock),
       PRIMARY KEY(judge_id, team_id, criterion_id))
result_snapshots(id PK, event_id FK CASCADE, created_at, created_by, payload TEXT /* JSON Ranking */)
audit_log(id INTEGER PK AUTOINCREMENT, event_id NULL, admin_id NULL, action, details TEXT JSON, created_at)
```

Secrets: session tokens, enrollment tokens and judge tokens are 128-bit random, base64url, stored as
SHA-256 hex. TOTP secrets are encrypted (ChaCha20-Poly1305, key = SHA-256 of the secret key material).

## 4. Event lifecycle

| From → To | Rule |
|---|---|
| draft → judging | ≥1 team, ≥1 criterion, ≥1 active judge |
| judging → locked | sets `locked_at` |
| locked → judging | `reason` required |
| locked → finalized | all active judges submitted, or `force: true` + `reason`; stores a `result_snapshots` row (official ranking) |
| finalized → locked | `reason` required (un-finalize) |
| finalized → published | — |
| published → finalized | un-publish |

- Teams/criteria and `scoring_mode`, `notes_enabled` can be edited only in `draft`.
- Judges can be added, renamed, (de)activated, rotated in any status except `finalized`/`published`.
- Score writes are accepted when status is `judging`, or `locked` and the item's `edited_at <= locked_at`
  (offline grace window; the client clock is trusted — documented limitation). Otherwise the item is
  rejected with `invalid_state`.

## 5. Ranking engine (`src/ranking.rs`, pure, no IO)

Input: teams (ordered), criteria (`max_x100`, `weight`), judges (`is_active`, `submitted`), scores,
`quorum`, `mode`.

- A judge's **sheet for a team** is complete when every criterion has a score.
- Included sheets:
  - `mode = official`: complete sheets of **active, submitted** judges.
  - `mode = provisional`: complete sheets of active judges, submitted or not.
- Judge score for a team: `J = 100 · Σ(w_c · s_c / m_c) / Σ w_c` (exact rational arithmetic).
- Team score: arithmetic mean of `J` over included sheets; `None` if there are none.
  A missing score is never treated as 0.
- Per-criterion average for a team: mean of `value_x100` over included sheets (`None` if none).
- `meets_quorum = sheets >= quorum`.
- Ordering: teams with a score first; then `meets_quorum` desc, score desc (exact), sheets desc.
  Teams equal on (meets_quorum, exact score, sheets) share a rank and get `tie = true`
  (standard competition ranking 1,1,3). Teams without a score get `rank = None`, ordered by team order.
  Ties are resolved by the organizer manually — the engine never breaks them silently.
- Output values are rounded half-up to hundredths only at the end (`score_x100`, `avg_x100`).
- Comparison uses the exact values, not the rounded ones.

```rust
pub enum Mode { Official, Provisional }
pub struct Ranking { pub mode: Mode, pub quorum: u32, pub rows: Vec<Row> }
pub struct Row {
    pub rank: Option<u32>, pub tie: bool, pub team_id: String,
    pub score_x100: Option<i64>, pub sheets: u32, pub meets_quorum: bool,
    pub criteria: Vec<CriterionAvg>,           // in criteria order: { criterion_id, avg_x100: Option<i64> }
    pub judges: Vec<JudgeScore>,               // included sheets: { judge_id, score_x100: i64 }
}
```
(Serde: `mode` serializes as `"official"`/`"provisional"`.)

## 6. Visibility

`events.visibility` controls the public page `/live/:eventId` before publication:

| status | hidden | live_totals | live_full |
|---|---|---|---|
| draft | 404 | 404 | 404 |
| judging/locked/finalized | no results | provisional totals | provisional totals + per-criterion |
| published | snapshot: totals + per-criterion + per-judge | same | same |

Per-judge breakdown is public only when `published` (from the latest snapshot). Admins always see everything.

## 7. Realtime (SSE)

One `tokio::sync::broadcast` channel per event (created lazily). Messages are invalidation hints, not data:
`event: change` / `data: {"kind": "scores" | "status" | "event" | "composition" | "alert" | "judges" | "presence"}`.
`presence` is sent only for judge heartbeats (last seen / pending count); judge clients ignore it
(as well as `scores`), the admin client treats it like `judges`. `judges` is for real judge changes.
Clients debounce (~500 ms) and refetch the relevant endpoint. Keep-alive comment every 15 s.
The judge stream re-checks every 30 s that the judge is still active and its token unchanged, and
ends otherwise. Request logs redact token path segments (`/j/***`, `/invite/***`, `/api/invites/***/...`).

- `GET /api/events/:id/stream` — admin (cookie).
- `GET /api/public/events/:id/stream` — public (404 for draft).
- `GET /api/judge/stream` — judge (Bearer; the frontend reads it with `fetch` streaming, not `EventSource`).

## 8. HTTP API

### Setup / auth
- `GET /api/setup/first-start` → `204` if no admin exists, else `404`.
- `POST /api/setup/first-start/begin` `{setup_password, name}` → `{enrollment_token, otpauth_uri, secret}`; 404 if an admin exists; 401 wrong password. The setup password is random, generated at startup while no admin exists, and printed to the log.
- `POST /api/setup/first-start/complete` `{enrollment_token, code}` → creates the owner, sets session cookie → `{admin}`.
- `POST /api/auth/login` `{name, code}` → sets cookie, `{admin}`; 401 generic. TOTP: SHA1, 6 digits, 30 s, window ±1, replay-protected via `totp_last_step` (in a write transaction). Rate limit: 5/min per name and 20/min per IP (in-memory).
- `POST /api/auth/logout` → 204. `GET /api/auth/me` → `{admin}` or 401.
- `admin` object: `{id, name, role, created_at}`.

### Admins (owner only for mutations)
- `GET /api/admins` → `[admin]`.
- `POST /api/admins/invites` → `{url, expires_at}` (24 h). `GET /api/admins/invites` → `[{id, created_at, expires_at}]`. `DELETE /api/admins/invites/:id` (id = token_hash prefix is fine; any stable id).
- `DELETE /api/admins/:id` (not self, not owner).
- `POST /api/admins/:id/reset-totp` (not the owner) → `{otpauth_uri, secret}`; kills that admin's sessions.
- Public invite flow: `GET /api/invites/:token` → `{expires_at}` | 404; `POST /api/invites/:token/begin` `{name}` → `{otpauth_uri, secret}`; `POST /api/invites/:token/complete` `{code}` → creates admin, sets cookie → `{admin}`.

### Events (admin)
- `GET /api/events` → `[{id, title, status, starts_at, location, teams_count, criteria_count, judges_count, submitted_count, created_at}]`.
- `POST /api/events` `{title, description?, starts_at?, location?}` → `EventFull`.
- `GET /api/events/:id` → `EventFull = {event, teams, criteria, judges}`, judges as `{id, name, is_active, submitted_at, last_seen_at, pending_count, scored_count}` (`scored_count` = number of saved scores; total = teams×criteria).
- `PATCH /api/events/:id` — any subset of editable event fields (title, description, starts_at, location, scoring_mode*, notes_enabled*, visibility, quorum, labels, alert_*, overlay_*) (*draft only). Saving alert content with `alert_enabled=true` increments `alert_version`. → `EventFull`.
- `DELETE /api/events/:id`.
- `POST /api/events/:id/transition` `{to, reason?, force?}` → `EventFull`; `409 invalid_state` with `details` (e.g. list of unsubmitted judges).
- Teams: `POST /api/events/:id/teams` `{name, description?}`; `POST /api/events/:id/teams/bulk` `{teams: [{name, description?}]}` (paste import); `PATCH /api/teams/:id`; `DELETE /api/teams/:id`; `PUT /api/events/:id/teams/order` `{ids}`.
- Criteria: same shape (`/criteria`, `/criteria/bulk`, `/criteria/:id`, `/criteria/order`) with `{name, description?, max_x100, step_x100, weight}`.
- Judges: `POST /api/events/:id/judges` `{names: [string]}` → `[{judge, link}]` — the link (with the raw token) is returned **only here and on rotate**. `PATCH /api/judges/:id` `{name?, is_active?}`; `DELETE /api/judges/:id`; `POST /api/judges/:id/rotate` → `{judge, link}`; `POST /api/judges/:id/reopen` `{reason}` (clears `submitted_at`).
  Judge link format: `<base>/j/<token>`.
- `PUT /api/events/:id/background` (raw body, `Content-Type: image/png|jpeg|webp`, ≤ 5 MB) → `EventFull`; `DELETE /api/events/:id/background`. Public: `GET /api/public/events/:id/background`.
- `GET /api/events/:id/matrix` → `{judges: [...as above], teams: [{id,name}], cells: [{judge_id, team_id, scored, total}]}`.
- `GET /api/events/:id/results?mode=provisional|official` → `Ranking` (+ `snapshot` if finalized/published).
- `GET /api/events/:id/export.csv` — ranking (official when finalized/published, else provisional) with per-criterion averages and per-judge scores. UTF-8 with BOM, `;` separator.
- `GET /api/events/:id/audit` → `[{id, admin_name, action, details, created_at}]`.

### Judge (Bearer token)
- `GET /api/judge/session` → `{judge: {id, name, submitted_at}, event: {id, title, description, status, scoring_mode, notes_enabled, locked_at, teams_label, teams_label_enabled, criteria_label, criteria_label_enabled, alert: {enabled, title, text, align, button_text, version}, background_url, overlay: {enabled, color, opacity}}, teams, criteria, scores: [{team_id, criterion_id, value_x100, note, edited_at}]}`. 401 for unknown/inactive judge.
- `PUT /api/judge/scores` `{items: [{team_id, criterion_id, value_x100: int|null, note: string|null, edited_at}]}` → `{results: [{team_id, criterion_id, status: "ok"|"stale"|"rejected", error?: code, server?: {value_x100, note, edited_at}}]}`. Per-item validation (team/criterion belong to the event, `0 <= value <= max`, multiple of `step`); `value_x100: null` deletes the score. Last-writer-wins by `edited_at`: an older item gets `stale` with the server version; an item with `edited_at` equal to the stored one overwrites (required so that retries of the same batch are idempotent). Writes are rejected (`sheet_submitted`) after submission. Idempotent.
- `POST /api/judge/submit` → `{judge}`; `409` with `details.missing: [{team_id, criterion_id}]` when incomplete; only in `judging`.
- `POST /api/judge/unsubmit` → `{judge}`; only in `judging`.
- `POST /api/judge/heartbeat` `{pending_count}` → 204 (updates `last_seen_at`).

### Public
- `GET /api/public/events/:id` → `{event: {id, title, description, status, teams_label..., background_url, overlay}, results: Ranking | null}` — filtered by §6 (`judges` stripped unless published; `criteria` stripped for `live_totals`). Team names included in rows (`team_name`).

## 9. Frontend (`web/`)

React 19 + Vite + TypeScript + Tailwind + shadcn/Radix, React Router, TanStack Query. Russian UI,
all strings in `web/src/i18n/ru.ts`. Light/dark by `prefers-color-scheme`.

Routes: `/firststart`, `/login`, `/invite/:token`, `/` (events), `/events/:id/*` (Control Room),
`/admins`, `/j/:token` (stores token, redirects to `/judge`), `/judge` (Judge Desk), `/live/:eventId`.

- **Judge Desk**: desktop = 3 columns (queue with progress/statuses · current item with criteria · notes/criterion help), mobile = single column with a fixed bottom bar (Back / Save & Next). Both `team` and `criterion` modes. Score input = segmented buttons for small scales, numeric input + stepper for large ones. Hotkeys: `1–9`/`0` select value, `←/→` navigate, `Ctrl+Enter` submit sheet. Sync indicator (saved locally / syncing / synced / error with message). Explicit "Сдать лист" with confirmation. Alert modal by `alert_version` (seen version stored locally).
- **Offline**: IndexedDB keyed by judge; every edit is stored locally first with `edited_at`, outbox synced with 1.5 s debounce, on `online`, and on SSE reconnect; per-item results applied (`stale` → take server value and tell the user; `rejected` → visible error). Session payload cached for offline reload. Heartbeat every 30 s with `pending_count`. Service Worker only when `window.isSecureContext`.
- **Control Room**: event list; event page with sections: setup (wizard: basics → teams (paste from clipboard, one per line, optional `name<TAB>description`) → criteria → judges (links + QR, printable sheet) → settings), monitoring (KPIs + judges × teams matrix: green submitted, yellow partial/unsubmitted, grey not started, red inactive/pending sync), results (provisional/official, tie markers), lifecycle controls with confirmations and reasons, alert editor, appearance (background/overlay), audit log.
- **Live page**: leaderboard with background/overlay, realtime via SSE.
- Heavy code (Control Room, QR) is lazy-loaded; the judge bundle stays small.

## 10. Resolved details

- Every ranking row returned by any API (admin and public) carries `team_name`.
- `GET /api/events/:id/results?mode=…` → `Ranking` (rows with `team_name`) plus `snapshot?: {id, created_at, created_by}`.
  When the event is `finalized`/`published` and `mode=official`, the ranking is the latest snapshot's payload, not a recomputation.
- `GET /api/public/events/:id` includes `event.criteria: [{id, name}]` whenever per-criterion data is visible.
- Mutation responses: create/update of a team, criterion or judge returns that object; `bulk` returns the created array;
  `PUT …/order` and `DELETE` return `204`. Judge `PATCH`/`reopen` return the judge summary.
- Status codes: wrong TOTP code → `401 unauthorized`; rate limit → `429 rate_limited`; duplicate admin name → `409 conflict`.
- Invite list items never contain the URL — it is shown once on creation.
