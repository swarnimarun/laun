use anyhow::Result;
use clap::Parser;
use crate::config::Config;
use crate::tui;

#[derive(Debug, Parser)]
#[command(
    name = "laun",
    version,
    about = "Goal-driven autonomous coding agent",
    long_about = "Set a goal with a clear stopping condition and let laün work across turns using any OpenAI-compatible API."
)]
struct Cli {
    #[arg(
        value_name = "GOAL",
        help = "The goal to work towards, e.g. \"Implement user auth with JWT. Stop when cargo test passes.\""
    )]
    goal: Option<String>,

    #[arg(long, default_value = "laun.toml", help = "Path to config file")]
    config: std::path::PathBuf,
}

pub async fn run() -> Result<()> {
    let cli = Cli::parse();

    match cli.goal {
        Some(goal) => {
            let cfg = Config::load(&cli.config)?;
            tui::start(goal, cfg).await?;
            Ok(())
        }
        None => {
            Cli::parse_from(["laun", "--help"]);
            Ok(())
        }
    }
}
