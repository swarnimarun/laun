use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::{fs, path::Path};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub prd: PrdConfig,
    pub workflow: WorkflowConfig,
    pub loop_agent: AgentConfig,
    pub worker_agent: AgentConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrdConfig {
    pub file: String,
    pub auto_mark_completed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowConfig {
    pub max_iterations: usize,
    pub max_fix_attempts: usize,
    pub auto_commit: bool,
    pub execution_tests: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    pub provider: AgentProvider,
    pub command: String,
    pub args: Vec<String>,
    pub model: String,
    pub visible_files: Vec<String>,
    pub visible_tests: Vec<String>,
    pub system_prompt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentProvider {
    Codex,
    Opencode,
    Custom,
}

impl AppConfig {
    pub fn load(path: &Path) -> Result<Self> {
        let raw = fs::read_to_string(path)
            .with_context(|| format!("failed to read config at {}", path.display()))?;
        let cfg: Self = toml::from_str(&raw)
            .with_context(|| format!("failed to parse TOML from {}", path.display()))?;
        cfg.validate()?;
        Ok(cfg)
    }

    pub fn write(&self, path: &Path) -> Result<()> {
        let value = toml::to_string_pretty(self)?;
        fs::write(path, value)
            .with_context(|| format!("failed to write config to {}", path.display()))?;
        Ok(())
    }

    pub fn validate(&self) -> Result<()> {
        if self.workflow.max_iterations == 0 {
            bail!("workflow.max_iterations must be > 0");
        }
        if self.loop_agent.command.trim().is_empty() {
            bail!("loop_agent.command cannot be empty");
        }
        if self.worker_agent.command.trim().is_empty() {
            bail!("worker_agent.command cannot be empty");
        }
        Ok(())
    }
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            prd: PrdConfig {
                file: "PRD.md".to_string(),
                auto_mark_completed: true,
            },
            workflow: WorkflowConfig {
                max_iterations: 12,
                max_fix_attempts: 2,
                auto_commit: true,
                execution_tests: vec!["cargo test".to_string()],
            },
            loop_agent: AgentConfig {
                provider: AgentProvider::Codex,
                command: "codex".to_string(),
                args: vec![
                    "exec".to_string(),
                    "--model".to_string(),
                    "{model}".to_string(),
                    "{prompt}".to_string(),
                ],
                model: "gpt-5-mini".to_string(),
                visible_files: vec!["PRD.md".to_string(), "docs/".to_string()],
                visible_tests: vec!["cargo test -p laun -- --nocapture".to_string()],
                system_prompt: "You are a fast loop manager. Keep tasks moving with small scoped worker instructions."
                    .to_string(),
            },
            worker_agent: AgentConfig {
                provider: AgentProvider::Codex,
                command: "codex".to_string(),
                args: vec![
                    "exec".to_string(),
                    "--model".to_string(),
                    "{model}".to_string(),
                    "{prompt}".to_string(),
                ],
                model: "gpt-5".to_string(),
                visible_files: vec!["src/".to_string(), "Cargo.toml".to_string()],
                visible_tests: vec!["cargo test".to_string()],
                system_prompt: "You are the implementation agent. Apply code changes, run commands, and report concise outcomes."
                    .to_string(),
            },
        }
    }
}
