# syntax=docker/dockerfile:1

# --- 1. Frontend -> web/dist (architecture-independent, always built on the build host) ---
FROM --platform=$BUILDPLATFORM node:22-alpine AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
# Type checking is CI's job (`npm run build` = tsc + vite); the image only needs the bundle.
RUN npx vite build

# --- 2. Backend: static musl binary ---
# Built natively on the target platform (buildx runs it once per arch; in CI each arch runs on
# a native runner). Alpine's rust image already targets musl and bundled SQLite only needs
# gcc + musl-dev, so no cross toolchain / zig / extra targets are required.
FROM rust:1.96-alpine AS build
RUN apk add --no-cache musl-dev gcc
WORKDIR /app
# Dependency layer: compiled from stub sources so it is cached until Cargo.toml/Cargo.lock change.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && touch src/lib.rs && echo 'fn main() {}' > src/main.rs \
    && cargo build --release --locked \
    && rm -rf src target/release/judgeflow* target/release/deps/judgeflow* target/release/.fingerprint/judgeflow*
COPY migrations ./migrations
COPY src ./src
COPY --from=web /app/web/dist ./web/dist
RUN cargo build --release --locked \
    && strip target/release/judgeflow \
    && mkdir /data

# --- 3. Runtime: just the binary (no shell, no libc, no CA certs - there are no outbound calls) ---
FROM scratch
COPY --from=build /app/target/release/judgeflow /judgeflow
COPY --from=build --chown=65532:65532 /data /data
USER 65532:65532
ENV JUDGEFLOW_DATA_DIR=/data JUDGEFLOW_ADDR=0.0.0.0:8080
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["/judgeflow"]
CMD ["serve"]
