use anyhow::{Result, bail};
use clap::{Parser, Subcommand};
use qrcode::QrCode;
use qrcode::render::unicode::Dense1x2;
use serde_json::json;
use tracing_subscriber::EnvFilter;

use crate::auth::{self, Admin};
use crate::config::Config;
use crate::db::begin_write;
use crate::server::{open_state, serve};
use crate::{audit, state::AppState};

#[derive(Parser)]
#[command(name = "judgeflow", version, about = "JudgeFlow judging platform")]
struct Cli {
    #[command(flatten)]
    config: Config,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Run the HTTP server (default).
    Serve,
    /// Administrator maintenance.
    #[command(subcommand)]
    Admin(AdminCommand),
}

#[derive(Subcommand)]
enum AdminCommand {
    /// List administrators.
    List,
    /// Generate a new TOTP secret for an administrator (the only way to reset the owner's) and
    /// end their sessions.
    ResetTotp { name: String },
    /// Transfer the owner role to another administrator.
    SetOwner { name: String },
}

pub async fn run() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();
    let cli = Cli::parse();
    match cli.command.unwrap_or(Command::Serve) {
        Command::Serve => serve(cli.config).await,
        Command::Admin(command) => {
            let state = open_state(cli.config).await?;
            run_admin(&state, command).await
        }
    }
}

async fn run_admin(state: &AppState, command: AdminCommand) -> Result<()> {
    match command {
        AdminCommand::List => {
            let admins = sqlx::query_as::<_, Admin>(
                "SELECT id, name, role, created_at FROM admins ORDER BY created_at, name",
            )
            .fetch_all(&state.pool)
            .await?;
            for admin in admins {
                println!("{}\t{}\t{}", admin.role, admin.name, admin.id);
            }
        }
        AdminCommand::ResetTotp { name } => {
            let admin = find_by_name(state, &name).await?;
            let (uri, secret) = auth::reset_totp(state, &admin, None)
                .await
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            let qr = QrCode::new(uri.as_bytes())?
                .render::<Dense1x2>()
                .quiet_zone(true)
                .build();
            println!("{qr}");
            println!("otpauth URI: {uri}");
            println!("Secret:      {secret}");
            println!("All sessions of {} were ended.", admin.name);
        }
        AdminCommand::SetOwner { name } => {
            let target = find_by_name(state, &name).await?;
            let mut tx = begin_write(&state.pool).await?;
            // Demote first: only one owner may exist at any time.
            sqlx::query("UPDATE admins SET role = 'admin' WHERE role = 'owner'")
                .execute(&mut *tx)
                .await?;
            sqlx::query("UPDATE admins SET role = 'owner' WHERE id = ?")
                .bind(&target.id)
                .execute(&mut *tx)
                .await?;
            audit::record(
                &mut *tx,
                None,
                None,
                "admin.set_owner",
                json!({ "admin_id": target.id, "name": target.name }),
            )
            .await
            .map_err(|e| anyhow::anyhow!("{e}"))?;
            tx.commit().await?;
            println!("{} is now the owner.", target.name);
        }
    }
    Ok(())
}

async fn find_by_name(state: &AppState, name: &str) -> Result<Admin> {
    match sqlx::query_as::<_, Admin>("SELECT id, name, role, created_at FROM admins WHERE name = ?")
        .bind(name)
        .fetch_optional(&state.pool)
        .await?
    {
        Some(admin) => Ok(admin),
        None => bail!("no administrator named {name:?}"),
    }
}
