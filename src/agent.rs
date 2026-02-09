use crate::config::AgentConfig;
use anyhow::{Context, Result, bail};
use std::{
    fs,
    path::PathBuf,
    process::{Command, Stdio},
};
use tempfile::NamedTempFile;

#[derive(Debug, Clone)]
pub struct AgentRunResult {
    pub stdout: String,
}

#[derive(Debug, Clone)]
pub struct CliAgent {
    config: AgentConfig,
}

impl CliAgent {
    pub fn new(config: AgentConfig) -> Self {
        Self { config }
    }

    pub fn invoke(&self, prompt: &str) -> Result<AgentRunResult> {
        let prompt_file = NamedTempFile::new().context("failed to create temporary prompt file")?;
        fs::write(prompt_file.path(), prompt).context("failed to write prompt file")?;

        let prompt_file_path = normalize_path(prompt_file.path());
        let mut cmd = Command::new(&self.config.command);
        for arg in &self.config.args {
            cmd.arg(replace_template(
                arg,
                &self.config.model,
                prompt,
                &prompt_file_path,
            ));
        }
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let output = cmd.output().with_context(|| {
            format!(
                "failed to run {} for model {}",
                self.config.command, self.config.model
            )
        })?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            bail!(
                "agent command failed (status {:?})\nstdout:\n{}\nstderr:\n{}",
                output.status.code(),
                stdout.trim(),
                stderr.trim()
            );
        }

        Ok(AgentRunResult {
            stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
        })
    }
}

fn replace_template(raw: &str, model: &str, prompt: &str, prompt_file: &str) -> String {
    raw.replace("{model}", model)
        .replace("{prompt}", prompt)
        .replace("{prompt_file}", prompt_file)
}

fn normalize_path(path: &std::path::Path) -> String {
    PathBuf::from(path)
        .canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .into_owned()
}
