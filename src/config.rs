use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{fs, path::Path};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub api: ApiConfig,
    #[serde(default)]
    pub goal: GoalConfig,
    #[serde(default)]
    pub progress: ProgressConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ApiConfig {
    #[serde(default = "default_base_url")]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default = "default_model")]
    pub model: String,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
    #[serde(default = "default_temperature")]
    pub temperature: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GoalConfig {
    #[serde(default = "default_max_iterations")]
    pub max_iterations: usize,
    #[serde(default)]
    pub validation_commands: Vec<String>,
    #[serde(default)]
    pub file_checks: Vec<FileCheck>,
    #[serde(default)]
    pub visible_files: Vec<String>,
    #[serde(default = "default_system_prompt")]
    pub system_prompt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileCheck {
    pub path: String,
    #[serde(default = "default_true")]
    pub exists: bool,
    pub contains: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProgressConfig {
    #[serde(default = "default_log_file")]
    pub log_file: String,
}

fn default_base_url() -> String {
    "https://api.openai.com/v1".into()
}

fn default_model() -> String {
    "gpt-4o".into()
}

fn default_max_tokens() -> u32 {
    4096
}

fn default_temperature() -> f32 {
    0.2
}

fn default_max_iterations() -> usize {
    50
}

fn default_system_prompt() -> String {
    r#"You are an autonomous coding agent. Work step by step toward the goal.
After each chunk of meaningful progress, you should run validation commands to verify your work.
Call finish() only when the goal is fully achieved and validation passes.
Be thorough: read relevant files before editing, search before making assumptions, and test your changes."#
        .into()
}

fn default_log_file() -> String {
    "PROGRESS.md".into()
}

fn default_true() -> bool {
    true
}

impl Default for Config {
    fn default() -> Self {
        Self {
            api: ApiConfig {
                base_url: default_base_url(),
                api_key: String::new(),
                model: default_model(),
                max_tokens: default_max_tokens(),
                temperature: default_temperature(),
            },
            goal: GoalConfig {
                max_iterations: default_max_iterations(),
                validation_commands: Vec::new(),
                file_checks: Vec::new(),
                visible_files: vec!["src/".into(), "Cargo.toml".into()],
                system_prompt: default_system_prompt(),
            },
            progress: ProgressConfig {
                log_file: default_log_file(),
            },
        }
    }
}

impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        if !path.exists() {
            let cfg = Config::default();
            let toml_str = toml::to_string_pretty(&cfg)?;
            let header = "# laun configuration\n# Set your API key and customize the goal loop\n\n";
            fs::write(path, format!("{header}{toml_str}"))
                .with_context(|| format!("failed to write default config to {}", path.display()))?;
            eprintln!("Wrote default config to {}. Edit it, then re-run.", path.display());
            std::process::exit(0);
        }

        let raw = fs::read_to_string(path)
            .with_context(|| format!("failed to read config at {}", path.display()))?;
        let resolved = resolve_env_vars(&raw);
        let cfg: Self = toml::from_str(&resolved)
            .with_context(|| format!("failed to parse TOML from {}", path.display()))?;

        if cfg.api.api_key.is_empty() {
            anyhow::bail!("api.api_key is empty. Set it in {} or via environment variable", path.display());
        }

        Ok(cfg)
    }
}

fn resolve_env_vars(input: &str) -> String {
    let mut result = input.to_string();
    let re = regex_lite::find_iter(r"\$\{(\w+)\}", input);
    for (full, name) in re {
        if let Ok(val) = std::env::var(name) {
            result = result.replace(full, &val);
        }
    }
    result
}

mod regex_lite {
    pub fn find_iter<'a>(pattern: &str, input: &'a str) -> Vec<(&'a str, &'a str)> {
        let mut results = Vec::new();
        let bytes = input.as_bytes();
        let pat_bytes = pattern.as_bytes();
        let mut i = 0;

        while i < bytes.len() {
            if let Some(end) = find_match(bytes, pat_bytes, i) {
                let full = &input[i..end];
                let inner_start = i + 2;
                let inner_end = end - 1;
                let name = &input[inner_start..inner_end];
                results.push((full, name));
                i = end;
            } else {
                i += 1;
            }
        }
        results
    }

    fn find_match(haystack: &[u8], needle: &[u8], start: usize) -> Option<usize> {
        if start + needle.len() > haystack.len() {
            return None;
        }
        let mut variable_name_start = start + 2;
        let mut found_close = false;
        while variable_name_start < haystack.len() {
            if haystack[variable_name_start] == b'}' {
                found_close = true;
                break;
            }
            if !haystack[variable_name_start].is_ascii_alphanumeric() && haystack[variable_name_start] != b'_' {
                break;
            }
            variable_name_start += 1;
        }
        if found_close && variable_name_start > start + 2 {
            Some(variable_name_start + 1)
        } else {
            None
        }
    }
}
