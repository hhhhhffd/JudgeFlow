# JudgeFlow v2 — event judging platform

Organizers create events with teams, criteria and judges. Judges score via personal links (offline-first).
Public live leaderboard via SSE. The v1 implementation (FastAPI/Next.js/Postgres/Redis) lives on branch `v1`
and is a reference for domain logic only.

**Source of truth: `docs/SPEC.md`** (data model, lifecycle, ranking rules, visibility, HTTP API). Keep it in sync
with behavior changes.

## Stack
- Backend: Rust (edition 2024), Axum 0.8, Tokio, SQLx 0.9 + SQLite (WAL). One binary `judgeflow`.
- Frontend: `web/` — React 19, Vite, TypeScript (strict), Tailwind 4, shadcn/Radix, React Router, TanStack Query, `idb`.
  Built to `web/dist` and embedded into the binary with `rust-embed` (release builds bake it in; debug reads from disk).
- No Redis/Nginx/Node at runtime.

## Layout
```
src/
  cli.rs, server.rs, config.rs   CLI (serve, admin ...), startup/shutdown, env config
  db.rs                          pool + migrations; begin_write() = BEGIN IMMEDIATE (use for read-then-write)
  auth.rs                        extractors: AdminSession, OwnerSession, JudgeAuth (Bearer)
  domain.rs                      shared loaders/validators, Layout (judge coverage: tracks,
                                 assignments, conflicts), the single ranking path (per track)
  ranking.rs                     pure rubric ranking engine (exact rationals, centering, stage slicing)
  pairwise.rs                    pure Bradley–Terry ranking + deterministic pair selection
  sse.rs                         per-event broadcast hub (invalidation hints only)
  routes/                        one module per area; paths without /api prefix
migrations/                      SQLite schema (sqlx::migrate!)
tests/                           API integration tests (tests/common for helpers)
web/src/
  api/                           typed client, endpoints, fetch-based SSE
  features/control-room|judge|live|stage
  i18n/                          all UI strings (ru.ts, control-room.ts, judge.ts)
web/sw/sw.js                     service worker (app shell only, never /api)
web/e2e/                         Playwright E2E against the real binary
```

## Conventions
- Score-like numbers are integers in hundredths (`*_x100`); IDs are UUID strings; timestamps are Unix ms.
- SQL: literal queries with binds only (`sqlx::query`), no compile-time macros, no string-built SQL.
- Errors: `AppError` → `{error, message, details?}`; user-facing messages in Russian.
- Every admin mutation on an event writes `audit_log` and notifies SSE with the right `ChangeKind`.
- Ranking logic lives only in `ranking.rs`/`pairwise.rs`; every consumer (results, CSV, public, stage,
  snapshots) goes through `domain::compute_ranking`. Missing score ≠ 0.
- Applied migrations are immutable (sqlx checksums) — add a new numbered file instead.
- UI is Russian; code, comments and API are English.

## Commands
```bash
make build        # web build + cargo build --release
make test         # cargo test + vitest
make lint         # cargo fmt --check, clippy -D warnings, tsc, eslint
make e2e          # Playwright (needs: npx playwright install chromium)
cargo run         # dev server on :8080 (data in ./data); cd web && npm run dev for Vite
docker compose up -d --build
```
