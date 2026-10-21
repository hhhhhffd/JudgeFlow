.PHONY: web build run dev test lint e2e release-musl docker

# The frontend must be built before `cargo build --release`: rust-embed bakes web/dist into the binary.
web:
	cd web && npm ci && npm run build

build: web
	cargo build --release

run: build
	JUDGEFLOW_DATA_DIR=./data ./target/release/judgeflow

dev:
	@echo "Run in two terminals:"
	@echo "  1) cargo run                  # API on :8080, data in ./data"
	@echo "  2) cd web && npm run dev      # Vite dev server (see web/vite.config.ts for the /api proxy)"

test:
	cargo test
	cd web && npm test

lint:
	cargo fmt --check
	cargo clippy --all-targets -- -D warnings
	cd web && npm run typecheck && npm run lint

# Playwright e2e against a debug binary (override with JUDGEFLOW_BIN=/path/to/judgeflow).
e2e: web
	cargo build
	cd web && npm run e2e

# Static x86_64 binary. Needs: rustup target add x86_64-unknown-linux-musl and musl-gcc (musl-tools)
# for the bundled SQLite.
release-musl: web
	CC_x86_64_unknown_linux_musl=musl-gcc cargo build --release --target x86_64-unknown-linux-musl

docker:
	docker build -t judgeflow:local .
