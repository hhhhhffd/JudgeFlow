use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result};
use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};

/// Opens `DATA_DIR/judgeflow.db` (creating the directory), applies migrations.
pub async fn connect(data_dir: &Path) -> Result<SqlitePool> {
    std::fs::create_dir_all(data_dir)
        .with_context(|| format!("creating data dir {}", data_dir.display()))?;
    let path = data_dir.join("judgeflow.db");
    let options = SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5));
    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(options)
        .await
        .with_context(|| format!("opening database {}", path.display()))?;
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .context("running migrations")?;
    Ok(pool)
}

/// Starts a write transaction with `BEGIN IMMEDIATE`: the write lock is taken up front, so
/// read-then-write sequences cannot interleave with another writer. sqlx's `begin()` is deferred.
pub async fn begin_write(
    pool: &SqlitePool,
) -> Result<sqlx::Transaction<'static, sqlx::Sqlite>, sqlx::Error> {
    pool.begin_with("BEGIN IMMEDIATE").await
}

/// Consistent online copy of the database via `VACUUM INTO` (safe while the server writes in WAL
/// mode). Also copies `uploads/` to `<dest>.uploads/` when present. Refuses to overwrite `dest`.
pub async fn backup(pool: &SqlitePool, data_dir: &Path, dest: &Path) -> Result<()> {
    anyhow::ensure!(!dest.exists(), "{} already exists", dest.display());
    let uploads_dest = {
        let mut name = dest.as_os_str().to_owned();
        name.push(".uploads");
        std::path::PathBuf::from(name)
    };
    anyhow::ensure!(
        !uploads_dest.exists(),
        "{} already exists",
        uploads_dest.display()
    );
    let dest_str = dest.to_str().context("destination path must be UTF-8")?;
    sqlx::query("VACUUM INTO ?")
        .bind(dest_str)
        .execute(pool)
        .await
        .context("VACUUM INTO failed")?;
    let uploads = data_dir.join("uploads");
    if uploads.is_dir() {
        std::fs::create_dir(&uploads_dest)
            .with_context(|| format!("creating {}", uploads_dest.display()))?;
        for entry in std::fs::read_dir(&uploads)? {
            let entry = entry?;
            if entry.file_type()?.is_file() {
                std::fs::copy(entry.path(), uploads_dest.join(entry.file_name()))?;
            }
        }
    }
    Ok(())
}
