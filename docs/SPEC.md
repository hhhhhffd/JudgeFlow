# JudgeFlow v2 — specification

Source of truth for the rewrite. The previous implementation lives on the `v1` branch
(`git show v1:<path>`) and is a reference for domain logic only — its frontend code is not reused.

## 1. Runtime

- One Rust binary `judgeflow` (Axum + Tokio + SQLx/SQLite). Frontend (React + Vite) is built to
  `web/dist` and embedded into the binary with `rust-embed`. No Redis, no Nginx, no Node at runtime.
- SQLite in `DATA_DIR/judgeflow.db`: WAL, `foreign_keys=ON`, `busy_timeout=5000`, short transactions.
  Migrations: `migrations/*.sql` via `sqlx::migrate!`, applied on startup. Migration `0005` runs without a
  transaction (it needs `PRAGMA foreign_keys=OFF`) and does its own `BEGIN`/`COMMIT`; a crash in the
  instant between its `COMMIT` and sqlx's bookkeeping insert leaves the schema migrated but unrecorded, and
  the next start fails on `events_new`/`comparisons` already existing. Recovery (applied checksums must not
  change, so the file is never edited): stop the server and run
  `sqlite3 DATA_DIR/judgeflow.db "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) SELECT 5, 'rounds pairwise', 1, X'<sha384 of the file>', 0"`
  or restore from a backup taken before the upgrade. Back up `DATA_DIR` before upgrading.
- Config (env, also as CLI flags of `serve`):
  - `JUDGEFLOW_ADDR` — listen address, default `0.0.0.0:8080`.
  - `JUDGEFLOW_DATA_DIR` — default `./data` (DB, uploads, `secret.key`).
  - `JUDGEFLOW_PUBLIC_URL` — optional base URL used in judge/invite links and QR codes
    (e.g. `https://judge.example.com`, `http://192.168.1.10:8080`). If unset, links are built from
    the request `Host` (+ `X-Forwarded-Proto`).
  - `JUDGEFLOW_SECRET_KEY` — optional; key material for encrypting TOTP secrets. If unset, a random
    key is generated once into `DATA_DIR/secret.key` (mode 0600) and reused.
  - `JUDGEFLOW_TRUST_PROXY` — bool, default `false`. When true, the client IP used for rate limiting
    is taken from `CF-Connecting-IP`, else the LAST `X-Forwarded-For` entry (appended by the trusted proxy;
    earlier entries are client-controlled), else the peer address. Enable only behind a proxy/tunnel
    (e.g. Cloudflare Tunnel) that sets these headers, and make sure the app port is NOT reachable directly
    (bind to `127.0.0.1` or do not publish it); otherwise clients could spoof their IP.
    When false, only the peer address is used.
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
`event: change` / `data: {"kind": "scores" | "status" | "event" | "composition" | "alert" | "judges" | "presence" | "stage"}`.
The public stream is filtered to `scores`, `status`, `event`, `composition`, `stage` (no `presence`, `judges`, `alert`).
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

## 11. Stage Mode (stage 2)

A projector/OBS screen for the award ceremony with a controlled reveal of winners. It shows only
the official ranking (latest snapshot), so it works in `finalized` and `published`. Typical flow:
finalize → ceremony on the stage screen → publish.

Event columns (migration `0003_stage.sql`):
`stage_view TEXT CHECK(IN ('waiting','leaderboard','podium')) DEFAULT 'waiting'`,
`stage_top_n INTEGER DEFAULT 3` (1..10), `stage_revealed INTEGER DEFAULT 0`.

- **Reveal unit** = a rank group (all rows sharing a rank) among rows with `rank <= stage_top_n`.
  Groups are revealed from the lowest place to the first: with top 3 → 3rd, then 2nd, then 1st.
  `stage_revealed` counts revealed groups (0..number of groups).
- **Views**:
  - `waiting` — title/background only, no results.
  - `leaderboard` — rows with `rank > stage_top_n` and unranked rows are always shown (bottom part of the
    table); top-N rows only if their group is revealed.
  - `podium` — only top-N rows of revealed groups.
- The server filters: unrevealed rows are never sent. Per-judge data is never sent to the stage.

API:
- `PATCH /api/events/:id` also accepts `stage_view`, `stage_top_n` (changing `stage_top_n` resets `stage_revealed` to 0).
- `POST /api/events/:id/stage/reveal` `{action: "next" | "prev" | "reset" | "all"}` → `EventFull`;
  only in `finalized`/`published` (`409 invalid_state` otherwise). Audited.
- `GET /api/public/events/:id/stage` →
  `{event: {id, title, status, background_url, overlay, teams_label..., criteria: [{id,name}]},
    stage: {view, top_n, revealed, total_groups, available: bool},
    rows: [ranking rows with team_name, criteria averages, no judges]}`.
  `available = status in (finalized, published)`; when not available, `rows` is `[]`. Draft → 404.
- SSE kind `"stage"` on any stage change (also delivered on the public stream). Judge clients ignore it.

Frontend:
- `/stage/:eventId` — fullscreen projector page (lazy chunk, no admin code). `?widget=1` renders with a
  transparent background and no chrome for OBS browser sources. Reveal animation for newly revealed groups
  (respect `prefers-reduced-motion`); podium layout 2-1-3 for top 3.
- Control Room tab «Сцена»: view switch, top N, buttons «Показать следующее место» / «Назад» / «Сброс» /
  «Показать всё», a live preview of what the stage shows, link to `/stage/:id` and the OBS widget URL.
  Keyboard: `Space`/`→` next, `←` prev on the control tab.

## 12. Tracks, assignments, conflicts, templates, emergency export (stage 3)

Migration `0006_assignment_mode.sql` adds `events.assignments_enabled INTEGER NOT NULL DEFAULT 0` (initialized to 1
for events that had assignments); it is exposed in `EventFull.event`.

Migration `0004_tracks_assignments.sql`:
```
tracks(id PK, event_id FK CASCADE, name, sort_order)
teams.track_id NULL FK→tracks ON DELETE SET NULL
criteria.track_id NULL FK→tracks ON DELETE CASCADE      -- NULL = applies to every team
assignments(judge_id FK CASCADE, team_id FK CASCADE, PRIMARY KEY(judge_id, team_id))
conflicts(judge_id FK CASCADE, team_id FK CASCADE, PRIMARY KEY(judge_id, team_id))
events.stage_track_id NULL FK→tracks ON DELETE SET NULL  -- which track the stage shows
```

Rules:
- **Team criteria** = criteria with `track_id IS NULL` or `= team.track_id`.
- **Judge's teams** = all teams while `events.assignments_enabled = 0`; once it is 1, only the judge's assigned
  teams (a judge without assignments judges nothing, even if the last assignment row disappears, e.g. its judge
  was deleted); minus conflicts
  (a conflict always wins). A judge never sees, scores or is counted for teams outside this set.
- A judge's **sheet for a team** is complete when every team criterion is scored. Submit requires complete
  sheets for all of the judge's teams; `scored_count`/matrix totals use the judge's teams × team criteria.
- Score writes for a team outside the judge's set or a criterion not applicable to the team are rejected
  with `not_assigned`.
- **Ranking is computed per track**: teams grouped by track (track order; teams without a track form a last
  group, or the only group when the event has no tracks). Each group is ranked independently by the existing
  engine with that group's criteria. The resulting `Ranking.rows` are concatenated in group order; each `Row`
  gains `track_id: string | null` (serde default `null`, so older snapshots still parse) and ranks restart per
  track. Responses that return a ranking also return `tracks: [{id, name}]`.
- Stage (§11) shows the group selected by `stage_track_id` (`null` = the first group in order);
  reveal groups are counted within that track; changing `stage_track_id` resets `stage_revealed`.
- Tracks, team/criterion `track_id` are composition: editable only in `draft`. Assignments and conflicts are
  editable in any status except `finalized`/`published` (late judge, discovered conflict); audited; SSE `judges`.

API:
- Tracks: `POST /api/events/:id/tracks` `{name}`, `PATCH /api/tracks/:id`, `DELETE /api/tracks/:id`,
  `PUT /api/events/:id/tracks/order`. Teams/criteria create/patch/bulk accept `track_id`.
- `EventFull` adds `tracks`, `assignments: [{judge_id, team_id}]`, `conflicts: [{judge_id, team_id}]`;
  teams/criteria carry `track_id`.
- `PUT /api/events/:id/assignments` `{pairs: [{judge_id, team_id}]}` — replaces all and sets `assignments_enabled` = 1; `[]` sets it to 0 =
  the explicit reset to "everyone judges everything".
- `POST /api/events/:id/assignments/auto` `{judges_per_team}` — replaces all assignments deterministically:
  teams in order; for each team pick the `judges_per_team` active judges without a conflict with the fewest
  assignments so far (ties → judge creation order). `409` if some team can't get enough judges
  (`details.short: [{team_id, got}]`) unless `allow_short: true`. A plan with no pairs at all (e.g. no eligible judges) is always `409` (`details.short`),
  so it never silently resets the mode. A successful auto-assign sets `assignments_enabled` = 1.
- `PUT /api/events/:id/conflicts` `{pairs}` — replaces all.
- Matrix cells add `assigned: bool`, `conflict: bool`; `total` = team criteria count (0 for teams outside the judge's set).
- Judge session: `teams` only the judge's teams (with `track_id`), `criteria` with `track_id`, `tracks`.
- **Emergency sheet export/import**: the Judge Desk can download a JSON file
  `{format: "judgeflow-sheet/1", event_id, judge_id, judge_name, token, exported_at, items: [score items as in PUT /judge/scores]}`.
  The organizer uploads it: `POST /api/events/:id/import-sheet` (JSON body) — the server verifies that `token`
  belongs to an active-or-inactive judge of this event, then applies `items` with exactly the same rules as
  `PUT /api/judge/scores` (LWW, grace window, `sheet_submitted`) and returns the same per-item results. Audited.
  Rejected in `finalized`/`published`.

Templates (frontend only): when creating an event or on the criteria step, presets «Хакатон», «Питч»,
«Конкурс проектов» insert a set of criteria (name, description, max, step, weight) via the bulk endpoint.

## 13. Rounds, pairwise comparisons, normalization (stage 4)

Migration `0005_rounds_pairwise.sql`:
```
events.parent_event_id NULL FK→events ON DELETE SET NULL, events.round INTEGER DEFAULT 1
events.normalization TEXT CHECK(IN ('none','center')) DEFAULT 'none'
events.scoring_mode CHECK extended with 'pairwise'
comparisons(id PK, event_id FK CASCADE, judge_id FK CASCADE, team_a FK CASCADE, team_b FK CASCADE,
            winner NULL CHECK(winner IN ('a','b','tie')), edited_at NULL, created_at)
```

### Rounds
- `POST /api/events/:id/next-round` `{title, team_ids, scoring_mode, copy_criteria, copy_judges}` → creates a new
  `draft` event with `parent_event_id = :id`, `round = parent.round + 1`, the selected teams (keeping names,
  descriptions and tracks), criteria/tracks if `copy_criteria`, judges by name with NEW tokens if `copy_judges`
  (response includes `links` like judge create). Allowed when the parent is `finalized`/`published`. Audited on both.
- Event list items include `parent_event_id` and `round`; the UI groups rounds under the first event.
- Details: `team_ids` must be unique teams of the parent (kept in the parent's order); `scoring_mode` is any of
  `team|criterion|pairwise`; `copy_criteria` copies all tracks and criteria, otherwise only the tracks the selected
  teams belong to are copied (so `track_id` stays meaningful); `copy_judges` copies active judges only. Assignments and
  conflicts are not copied. Description, location, quorum, labels, notes and overlay settings are inherited
  (normalization too, except for `pairwise`). Response: `{event: EventFull, links: [{judge, link}]}`; `409 invalid_state`
  unless the parent is `finalized`/`published`. `EventFull.event` also carries `parent_event_id`, `round`, `normalization`.

### Pairwise mode (`scoring_mode = 'pairwise'`)
- Criteria are not used (draft→judging requires ≥2 teams and ≥1 active judge, criteria optional).
  Assignments/conflicts/tracks apply: a pair is only formed from two teams of the judge's set in the same track.
- **Pair reservation (offline-friendly)**: `POST /api/judge/pairs/reserve` `{count}` (1..20) returns the judge's open
  pairs, creating new ones up to `count` open pairs. New pair selection is deterministic: among eligible pairs this judge
  has not seen, minimize (times the pair was compared overall, then the sum of both teams' comparison counts), ties by
  team order; `team_a`/`team_b` order alternates to avoid position bias (by comparison count parity).
- `PUT /api/judge/comparisons` `{items: [{id, winner: 'a'|'b'|'tie'|null, edited_at}]}` — same per-item semantics as
  scores (LWW by `edited_at`, `null` clears, grace window in `locked`, `sheet_submitted`, own comparisons only).
- Judge submit in pairwise mode: allowed when the judge has no open (undecided) reserved pairs — open pairs are
  released (deleted) on submit only if the judge confirms with `{release_open: true}`; otherwise `409` with
  `details.open`.
- Session payload adds `comparisons: [{id, team_a, team_b, winner, edited_at}]` in pairwise mode.
- **Ranking** (`src/pairwise.rs`, pure): included comparisons = decided comparisons of active judges, submitted only for
  `official`. Bradley–Terry strengths by the MM algorithm (ties count as half a win for each side), teams with no
  included comparisons are unranked; strengths normalized so the geometric mean is 1; iterate until max relative change
  < 1e-12 or 10 000 iterations; `score_x100` = p(team beats an average team) on the 0–100 scale in hundredths = 10 000·s/(s+1), rounded half-up
  (so an average team scores 50,00).
  Determinism: iterate teams in input order; ties: scores equal after rounding to 1e-9 share a rank.
  To keep BT finite, add one virtual tie against a virtual average team (strength 1) for every ranked team.
  `sheets` = number of included comparisons involving the team; `quorum` applies to it.
  Rows add `wins`, `losses`, `ties` (serde default 0) for explainability; `criteria` is `[]`; `judges` lists, per judge,
  their win rate for that team on the 0–100 scale in hundredths (ties count 0.5).

### Normalization (rubric mode only, opt-in)
- `events.normalization = 'center'`: removes per-judge leniency. Per ranking group: for each included judge,
  `offset_j = mean over the judge's included sheets of J − mean over all included sheets of J`;
  normalized `J' = J − offset_j`. Team score = mean of `J'`. Exact rational arithmetic like the rest of the engine.
- `PATCH /api/events/:id {normalization}`: allowed in `draft`/`judging`/`locked`; `409 invalid_state` once `finalized`/`published`
  (snapshots are fixed); `center` is rejected for `pairwise` events (and switching to `pairwise` resets it to `none`).
- Rows add `raw_score_x100` (score without normalization) when normalization is on; `judges[].score_x100` stays raw.
- Centered scores are unbounded: `J'` (and the team score) may fall below 0 or above the 0–100 range, and CSV/UI
  must render negatives (`-33,33`). Rubric score writes are rejected (`invalid_state`) in `pairwise` events, and the
  judge session has no `criteria` there. On reserve and submit, a judge's undecided pairs whose teams are no longer
  both covered by the judge (assignments/conflicts) or no longer share a track are deleted.
- UI must warn that centering can distort results when judges saw very different subsets of teams, and show both values.

### Pairwise backend details (implemented)
- `POST /api/judge/pairs/reserve` `{count: 1..20}` → `{comparisons: [{id, team_a, team_b, winner: null, edited_at: null|int}]}`
  (the judge's open pairs only, oldest first). `BEGIN IMMEDIATE`. New pairs are created only while the event is `judging` and the
  judge has not submitted; otherwise the call is read-only. `409 invalid_state` for non-pairwise events; `400` for a bad `count`.
  Candidate teams are the judge's covered teams per track group; `all_comparisons` = every comparison row of the event (open ones too).
  A cleared comparison (`winner: null` with `edited_at`) stays open and is returned again.
- `PUT /api/judge/comparisons` `{items: [{id, winner: 'a'|'b'|'tie'|null, edited_at}]}` → `{results: [{id, status: 'ok'|'stale'|'rejected', error?, server?: {winner, edited_at}}]}`.
  Errors: `sheet_submitted`, `invalid_state` (status/grace window), `not_found` (unknown or another judge's id), `validation`.
  Checked in that order; a fresh row (`edited_at` null) is never stale. Notifies `scores` once if anything was written.
- `POST /api/judge/submit` in pairwise mode takes an optional JSON body `{release_open?: bool}`; open pairs → `409 invalid_state`
  with `details.open: [ids]` unless `release_open` is true (they are then deleted). Rubric submit ignores the body.
- Session adds `comparisons` (all of the judge's rows, decided and open) in pairwise mode only.
- Ranking: per track group via `pairwise::compute`; only decided comparisons between two teams of the group that the judge covers
  are used. `Row` gains optional `wins`/`losses`/`ties` (omitted in rubric mode and in old snapshots). CSV adds
  «Побед;Поражений;Ничьих» after «Кворум» and omits criteria columns in pairwise events.
- Matrix: `scored` = decided comparisons involving the team by that judge, `total` = 0 (no fixed total).
- Deviation: `POST /api/events/:id/import-sheet` returns `400 validation` for pairwise events (sheet files carry scores only).

### Pairwise emergency export (amends §12 import-sheet)
The sheet file may carry `comparisons: [{id, winner, edited_at}]` (format stays `judgeflow-sheet/1`; `items` may be
empty). For a pairwise event `POST /api/events/:id/import-sheet` applies `comparisons` with exactly the same function
as `PUT /api/judge/comparisons` and returns `{results: [...]}` in that endpoint's shape; `items` must be empty there.
For rubric events `comparisons` must be absent or empty. The Judge Desk offers the backup in pairwise mode too.
