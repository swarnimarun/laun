use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, PartialEq)]
pub enum GoalState {
    Idle,
    Running,
    Paused,
    Completed,
    Failed,
}

#[derive(Debug, Clone)]
pub struct Checkpoint {
    pub number: u32,
    pub description: String,
    pub validation_pass: bool,
}

#[derive(Debug, Clone)]
pub struct ProgressLog {
    pub goal_text: String,
    pub checkpoints: Vec<Checkpoint>,
}

impl ProgressLog {
    pub fn new(goal_text: String) -> Self {
        Self {
            goal_text,
            checkpoints: Vec::new(),
        }
    }

    pub fn add_checkpoint(&mut self, description: String, validation_pass: bool) {
        let number = (self.checkpoints.len() + 1) as u32;
        self.checkpoints.push(Checkpoint {
            number,
            description,
            validation_pass,
        });
    }

    pub fn to_markdown(&self) -> String {
        let mut md = format!("# Progress Log\n\n## Goal\n{}\n\n## Checkpoints\n\n", self.goal_text);
        for cp in &self.checkpoints {
            let status = if cp.validation_pass { "x" } else { " " };
            md.push_str(&format!("- [{status}] CP{}: {}\n", cp.number, cp.description));
        }
        if self.checkpoints.is_empty() {
            md.push_str("_(no checkpoints yet)_\n");
        }
        md.push_str(&format!(
            "\n---\n_{}/{} checkpoints passed validation_\n",
            self.checkpoints.iter().filter(|c| c.validation_pass).count(),
            self.checkpoints.len()
        ));
        md
    }
}

pub fn state_label(state: &GoalState) -> &str {
    match state {
        GoalState::Idle => "IDLE",
        GoalState::Running => "RUNNING",
        GoalState::Paused => "PAUSED",
        GoalState::Completed => "COMPLETED",
        GoalState::Failed => "FAILED",
    }
}

#[derive(Debug, Clone)]
pub struct ValidationResult {
    pub command: String,
    pub output: String,
    pub success: bool,
}

pub fn run_validation(commands: &[String]) -> Vec<ValidationResult> {
    commands
        .iter()
        .map(|cmd| {
            let output = std::process::Command::new("sh")
                .arg("-lc")
                .arg(cmd)
                .output();

            match output {
                Ok(out) => {
                    let stdout = String::from_utf8_lossy(&out.stdout);
                    let stderr = String::from_utf8_lossy(&out.stderr);
                    ValidationResult {
                        command: cmd.clone(),
                        output: format!("{stdout}{stderr}")
                            .trim()
                            .chars()
                            .take(2000)
                            .collect(),
                        success: out.status.success(),
                    }
                }
                Err(err) => ValidationResult {
                    command: cmd.clone(),
                    output: format!("Error: {err}"),
                    success: false,
                },
            }
        })
        .collect()
}

use crate::config::FileCheck;
use std::fs;

pub fn check_files(checks: &[FileCheck]) -> Vec<ValidationResult> {
    checks
        .iter()
        .map(|check| {
            if check.exists {
                match fs::metadata(&check.path) {
                    Ok(m) if m.is_file() => {
                        if let Some(ref pattern) = check.contains {
                            match fs::read_to_string(&check.path) {
                                Ok(content) => {
                                    if content.contains(pattern.as_str()) {
                                        ValidationResult {
                                            command: format!("check: {} exists and contains '{}'", check.path, pattern),
                                            output: "File exists and contains the pattern.".into(),
                                            success: true,
                                        }
                                    } else {
                                        ValidationResult {
                                            command: format!("check: {} contains '{}'", check.path, pattern),
                                            output: format!("File exists but does not contain '{}'.", pattern),
                                            success: false,
                                        }
                                    }
                                }
                                Err(e) => ValidationResult {
                                    command: format!("check: {} read", check.path),
                                    output: format!("Cannot read file: {e}"),
                                    success: false,
                                },
                            }
                        } else {
                            ValidationResult {
                                command: format!("check: {} exists", check.path),
                                output: "File exists.".into(),
                                success: true,
                            }
                        }
                    }
                    _ => ValidationResult {
                        command: format!("check: {} exists", check.path),
                        output: format!("File does not exist: {}", check.path),
                        success: false,
                    },
                }
            } else {
                ValidationResult {
                    command: format!("check: {} does not exist", check.path),
                    output: "Skipped (exists=false has no simple meaning)".into(),
                    success: true,
                }
            }
        })
        .collect()
}

#[derive(Debug, Clone)]
pub struct SharedState {
    pub goal_text: String,
    pub goal_state: GoalState,
    pub iteration: usize,
    pub max_iterations: usize,
    pub progress_log: ProgressLog,
    pub stream_lines: Vec<StreamLine>,
    pub current_action: String,
    pub last_validation: Vec<ValidationResult>,
    pub error_message: Option<String>,
    pub model: String,
    pub finish_summary: Option<String>,
    pub tool_call_count: usize,
}

#[derive(Debug, Clone)]
pub enum StreamLine {
    Thinking(String),
    Action(String),
    ToolResult(String),
    Info(String),
    Validation(String),
    Error(String),
    Done(String),
}

impl SharedState {
    pub fn new(goal_text: String, max_iterations: usize, model: String) -> Self {
        Self {
            progress_log: ProgressLog::new(goal_text.clone()),
            goal_text,
            goal_state: GoalState::Idle,
            iteration: 0,
            max_iterations,
            stream_lines: Vec::new(),
            current_action: String::new(),
            last_validation: Vec::new(),
            error_message: None,
            model,
            finish_summary: None,
            tool_call_count: 0,
        }
    }

    pub fn push_line(&mut self, line: StreamLine) {
        if self.stream_lines.len() > 500 {
            self.stream_lines.remove(0);
        }
        self.stream_lines.push(line);
    }
}

pub type StateHandle = Arc<Mutex<SharedState>>;
