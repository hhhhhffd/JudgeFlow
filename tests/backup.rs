use judgeflow::db;
use judgeflow::state::AppState;
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Row, SqlitePool};

#[tokio::test]
async fn backup_copies_rows_and_uploads_and_refuses_overwrite() {
    let state = AppState::for_tests().await;
    let data_dir = state.config.data_dir.clone();
    sqlx::query(
        "INSERT INTO admins (id, name, role, totp_secret_enc, created_at) VALUES ('a1', 'Alice', 'owner', X'00', 1)",
    )
    .execute(&state.pool)
    .await
    .unwrap();
    std::fs::create_dir_all(data_dir.join("uploads")).unwrap();
    std::fs::write(data_dir.join("uploads/bg.png"), b"png").unwrap();

    let dest = data_dir.join("copy.db");
    db::backup(&state.pool, &data_dir, &dest).await.unwrap();

    let copy =
        SqlitePool::connect_with(SqliteConnectOptions::new().filename(&dest).read_only(true))
            .await
            .unwrap();
    let row = sqlx::query("SELECT name FROM admins WHERE id = 'a1'")
        .fetch_one(&copy)
        .await
        .unwrap();
    assert_eq!(row.get::<String, _>("name"), "Alice");
    assert_eq!(
        std::fs::read(data_dir.join("copy.db.uploads/bg.png")).unwrap(),
        b"png"
    );

    let err = db::backup(&state.pool, &data_dir, &dest).await.unwrap_err();
    assert!(err.to_string().contains("already exists"));
}
