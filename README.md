<div align="center">

<img src="web/public/favicon.svg" width="120" alt="JudgeFlow logo">

<h1>JudgeFlow</h1>
<hr>

**Judging platform for contests, hackathons and pitches: offline-first judge desk, exact scoring, live leaderboard**

![Rust](https://img.shields.io/badge/RUST-2024_edition-000000?style=flat-square&logo=rust&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLITE-WAL-003B57?style=flat-square&logo=sqlite&logoColor=white)
![React](https://img.shields.io/badge/REACT-19-61DAFB?style=flat-square&logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TYPESCRIPT-strict-3178C6?style=flat-square&logo=typescript&logoColor=white)
[![CI](https://img.shields.io/github/actions/workflow/status/hhhhhffd/JudgeFlow/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/hhhhhffd/JudgeFlow/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/hhhhhffd/JudgeFlow?style=flat-square)](LICENSE)

[Quick start](#quick-start) · [Technical stack](#technical-stack) · [Configuration](#configuration) · [Spec](docs/SPEC.md)

</div>

## What it is

JudgeFlow is a self-hosted platform for judging events. An organizer sets up an event, judges score teams through personal links (also without network access), and the audience follows the ranking live.

The whole product is one Rust binary (`judgeflow`) with SQLite and an embedded React interface. There is no Redis, Nginx or Node.js at runtime. The previous version (FastAPI, Next.js, PostgreSQL, Redis) is kept in the `v1` branch.

## Highlights

- **Offline-first Judge Desk:** scores are stored in IndexedDB and synced later; a Service Worker caches the app shell on HTTPS.
- **Honest scoring:** exact rational arithmetic, a missing score is never treated as 0, only submitted sheets count, ties are marked rather than split silently.
- **Two judging modes:** rubric criteria with weights, and pairwise comparison ranked with Bradley-Terry; tracks, rounds and optional judge score centering.
- **Live and Stage Mode:** public leaderboard over SSE and a projector screen with a controlled winner reveal (3rd, 2nd, 1st).
- **Access control:** TOTP-only admin login, hashed judge tokens that can be revoked and reissued, security headers, per-IP rate limiting.

## Technical stack

| Layer | Technology |
|---|---|
| Backend | Rust (edition 2024), Axum 0.8, Tokio, SQLx 0.9, rust-embed |
| Data | SQLite (WAL), SQL migrations in `migrations/` |
| Security | totp-rs, ChaCha20-Poly1305 (TOTP secrets at rest), SHA-256 (token hashes) |
| Frontend | React 19, TypeScript, Vite, Tailwind CSS 4, Radix UI, TanStack Query, `idb` |
| Tests | `cargo test` (integration tests on a real SQLite file), Vitest, Playwright with axe |
| Delivery | Docker (multi-stage, `scratch` runtime), GitHub Actions (CI, tag-triggered release) |

## Quick start

**Docker**

```bash
docker compose up -d --build
docker compose logs judgeflow   # one-time first-start password
```

**From source** (Rust stable; Node.js 22+ for the build only)

```bash
make build                      # web/dist + cargo build --release
./target/release/judgeflow      # data in ./data
```

**First start:** open `http://<host>:8080/firststart`, enter the one-time password from the log, scan the QR code with an authenticator app and confirm the code. You become the owner; other admins are invited from the Admins section.

> [!WARNING]
> With `JUDGEFLOW_TRUST_PROXY=cloudflare` or `xff`, publish the port on loopback only (`127.0.0.1:8080:8080`). Otherwise clients can spoof their IP.

## Configuration

All variables are optional (see [`.env.example`](.env.example)).

| Variable | Default | Purpose |
|---|---|---|
| `JUDGEFLOW_ADDR` | `0.0.0.0:8080` | listen address |
| `JUDGEFLOW_DATA_DIR` | `./data` | SQLite, uploads, `secret.key` |
| `JUDGEFLOW_PUBLIC_URL` | from the request `Host` | base URL for judge links and QR codes |
| `JUDGEFLOW_SECRET_KEY` | generated in `DATA_DIR/secret.key` | key for encrypting TOTP secrets |
| `JUDGEFLOW_TRUST_PROXY` | `none` | source of client IP: `none`, `cloudflare`, `xff` |
| `RUST_LOG` | `info` | log filter |

<details>
<summary>Admin CLI, backup and development commands</summary>

```bash
judgeflow admin list
judgeflow admin reset-totp <name>
judgeflow admin set-owner <name>
judgeflow backup <file>        # consistent copy via VACUUM INTO, safe on a running server
```

Copy `DATA_DIR/secret.key` separately, otherwise TOTP secrets in a backup cannot be decrypted.

```bash
cargo run                      # API on :8080
cd web && npm run dev          # Vite with /api proxy
make test                      # cargo test + vitest
make lint                      # fmt, clippy, typecheck, eslint
make e2e                       # Playwright against the real binary
```

</details>

## License

[AGPL-3.0-only](LICENSE)
