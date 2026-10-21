#[tokio::main]
async fn main() -> anyhow::Result<()> {
    judgeflow::cli::run().await
}
