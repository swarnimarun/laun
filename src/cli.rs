use crate::{
    config::AppConfig,
    runner::{LoopRunner, RunOptions},
};
use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use std::{
    fs,
    path::{Path, PathBuf},
};

const DEFAULT_CONFIG: &str = "laun.toml";

#[derive(Debug, Parser)]
#[command(
    name = "laun",
    version,
    about = "Dual-agent loop orchestrator for PRD delivery"
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Debug, Subcommand)]
enum Commands {
    Init {
        #[arg(long, default_value = DEFAULT_CONFIG)]
        config: PathBuf,
        #[arg(long, default_value = "PRD.md")]
        prd: PathBuf,
        #[arg(long)]
        force: bool,
    },
    Run {
        #[arg(long, default_value = DEFAULT_CONFIG)]
        config: PathBuf,
        #[arg(long)]
        max_iterations: Option<usize>,
        #[arg(long)]
        dry_run: bool,
    },
    Validate {
        #[arg(long, default_value = DEFAULT_CONFIG)]
        config: PathBuf,
    },
}

pub fn run() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Commands::Init { config, prd, force } => init(config.as_path(), prd.as_path(), force),
        Commands::Run {
            config,
            max_iterations,
            dry_run,
        } => run_loop(config, max_iterations, dry_run),
        Commands::Validate { config } => validate(config),
    }
}

fn init(config_path: &Path, prd_path: &Path, force: bool) -> Result<()> {
    if config_path.exists() && !force {
        bail!(
            "{} already exists. Re-run with --force to overwrite.",
            config_path.display()
        );
    }

    if let Some(parent) = config_path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create {}", parent.display()))?;
        }
    }
    if let Some(parent) = prd_path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create {}", parent.display()))?;
        }
    }

    if !prd_path.exists() || force {
        fs::write(prd_path, default_prd_contents())
            .with_context(|| format!("failed to write {}", prd_path.display()))?;
    }

    let mut cfg = AppConfig::default();
    cfg.prd.file = prd_path_for_config(config_path, prd_path);
    cfg.write(config_path)?;

    println!("Wrote {}", config_path.display());
    println!("Wrote {}", prd_path.display());
    println!("Next: laun run --config {}", config_path.display());
    Ok(())
}

fn run_loop(config_path: PathBuf, max_iterations: Option<usize>, dry_run: bool) -> Result<()> {
    let config = AppConfig::load(config_path.as_path())?;
    let runner = LoopRunner::new(config, config_path.clone());
    let summary = runner.run(&RunOptions {
        max_iterations_override: max_iterations,
        dry_run,
    })?;

    println!("\nRun complete.");
    println!("Iterations: {}", summary.iterations);
    println!("PRD items marked done: {}", summary.completed_items);
    println!("Commits created: {}", summary.commits);
    Ok(())
}

fn validate(config_path: PathBuf) -> Result<()> {
    let config = AppConfig::load(config_path.as_path())?;
    config.validate()?;
    println!("Config is valid: {}", config_path.display());
    Ok(())
}

fn default_prd_contents() -> &'static str {
    r#"# Product Requirements

## Checklist
- [ ] Define dual-agent responsibilities and handoff contract
- [ ] Implement the first CLI command surface
- [ ] Add orchestration loop for delegate -> test -> commit
- [ ] Add retry path for failing tests
"#
}

fn prd_path_for_config(config_path: &Path, prd_path: &Path) -> String {
    let config_parent = config_path.parent().unwrap_or_else(|| Path::new("."));
    let config_parent_abs = config_parent
        .canonicalize()
        .unwrap_or_else(|_| config_parent.to_path_buf());
    let prd_abs = prd_path
        .canonicalize()
        .unwrap_or_else(|_| prd_path.to_path_buf());

    if let Ok(rel) = prd_abs.strip_prefix(&config_parent_abs) {
        if !rel.as_os_str().is_empty() {
            return rel.to_string_lossy().to_string();
        }
    }

    prd_path.to_string_lossy().to_string()
}
