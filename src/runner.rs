use crate::{
    agent::CliAgent,
    config::AppConfig,
    prd::{PrdDocument, mark_item_done},
};
use anyhow::{Context, Result};
use serde::Deserialize;
use std::{
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Debug, Clone)]
pub struct LoopRunner {
    config: AppConfig,
    config_path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct RunOptions {
    pub max_iterations_override: Option<usize>,
    pub dry_run: bool,
}

#[derive(Debug, Clone, Default)]
pub struct RunSummary {
    pub iterations: usize,
    pub completed_items: usize,
    pub commits: usize,
}

#[derive(Debug, Deserialize)]
struct LoopDecision {
    action: LoopAction,
    target_item: Option<String>,
    worker_prompt: Option<String>,
    commit_message: Option<String>,
    reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum LoopAction {
    Delegate,
    Done,
}

impl LoopRunner {
    pub fn new(config: AppConfig, config_path: PathBuf) -> Self {
        Self {
            config,
            config_path,
        }
    }

    pub fn run(&self, options: &RunOptions) -> Result<RunSummary> {
        let root = self.project_root();
        let prd_path = root.join(&self.config.prd.file);
        let loop_agent = CliAgent::new(self.config.loop_agent.clone());
        let worker_agent = CliAgent::new(self.config.worker_agent.clone());
        let max_iterations = options
            .max_iterations_override
            .unwrap_or(self.config.workflow.max_iterations);

        let mut summary = RunSummary::default();
        let mut loop_context = String::new();

        for step in 1..=max_iterations {
            let prd = PrdDocument::load(&prd_path)?;
            let unchecked = prd.unchecked_items();
            if unchecked.is_empty() {
                println!("PRD is complete. Stopping.");
                break;
            }

            println!("\n=== Iteration {step}/{max_iterations} ===");
            let decision_prompt = build_loop_prompt(
                &self.config,
                &prd_path,
                &prd,
                &loop_context,
                self.config.workflow.execution_tests.as_slice(),
            );
            let decision = if options.dry_run {
                println!(
                    "[dry-run] loop prompt preview: {}",
                    truncate(&decision_prompt, 240)
                );
                LoopDecision {
                    action: LoopAction::Delegate,
                    target_item: Some(unchecked[0].text.clone()),
                    worker_prompt: Some(format!("Implement PRD item: {}", unchecked[0].text)),
                    commit_message: None,
                    reason: Some("dry-run synthetic decision".to_string()),
                }
            } else {
                let loop_result = loop_agent.invoke(&decision_prompt)?;
                parse_loop_decision(&loop_result.stdout)
            };

            match decision.action {
                LoopAction::Done => {
                    println!(
                        "Loop agent decided to stop: {}",
                        decision.reason.unwrap_or_else(|| "no reason".to_string())
                    );
                    summary.iterations = step;
                    break;
                }
                LoopAction::Delegate => {}
            }

            let target_item = decision
                .target_item
                .unwrap_or_else(|| unchecked[0].text.clone());
            let worker_task = decision.worker_prompt.unwrap_or_else(|| {
                format!(
                    "Implement PRD item: {target_item}. Keep changes scoped and verify with tests."
                )
            });

            let worker_prompt = build_worker_prompt(
                &self.config,
                &target_item,
                &worker_task,
                None,
                self.config.workflow.execution_tests.as_slice(),
            );
            if options.dry_run {
                println!("[dry-run] worker prompt for item: {target_item}");
            } else {
                let worker_result = worker_agent.invoke(&worker_prompt)?;
                println!(
                    "Worker response (truncated): {}",
                    truncate(&worker_result.stdout, 240)
                );
            }

            let mut test_run = run_test_suite(
                self.config.workflow.execution_tests.as_slice(),
                options.dry_run,
            )?;

            if !test_run.success && !options.dry_run {
                for attempt in 1..=self.config.workflow.max_fix_attempts {
                    println!("Tests failed. Running fix attempt {attempt}.");
                    let fix_prompt = build_worker_prompt(
                        &self.config,
                        &target_item,
                        &worker_task,
                        Some(&test_run.output),
                        self.config.workflow.execution_tests.as_slice(),
                    );
                    let _ = worker_agent.invoke(&fix_prompt)?;
                    test_run = run_test_suite(
                        self.config.workflow.execution_tests.as_slice(),
                        options.dry_run,
                    )?;
                    if test_run.success {
                        break;
                    }
                }
            }

            if !test_run.success {
                println!("Tests are still failing. Handing context back to loop agent.");
                loop_context = format!(
                    "Previous attempt failed for item `{}`.\nTest output:\n{}",
                    target_item, test_run.output
                );
                summary.iterations = step;
                continue;
            }

            let mut commit_hash = None;
            if self.config.workflow.auto_commit && !options.dry_run && has_uncommitted_changes()? {
                let msg = decision
                    .commit_message
                    .unwrap_or_else(|| format!("feat: complete PRD item: {target_item}"));
                commit_hash = Some(commit_all(&msg)?);
                summary.commits += 1;
            }

            if self.config.prd.auto_mark_completed && !options.dry_run {
                if mark_item_done(&prd_path, &target_item)? {
                    println!("Marked PRD item done: {target_item}");
                    summary.completed_items += 1;
                } else {
                    println!("Could not match PRD item to auto-mark done: {target_item}");
                }
            }

            loop_context = format!(
                "Completed item `{}`. Commit: {}",
                target_item,
                commit_hash.unwrap_or_else(|| "none".to_string())
            );
            summary.iterations = step;
        }

        Ok(summary)
    }

    fn project_root(&self) -> &Path {
        self.config_path.parent().unwrap_or_else(|| Path::new("."))
    }
}

fn parse_loop_decision(raw: &str) -> LoopDecision {
    if let Ok(parsed) = serde_json::from_str::<LoopDecision>(raw) {
        return parsed;
    }

    if let Some(parsed) =
        extract_json_object(raw).and_then(|json| serde_json::from_str::<LoopDecision>(&json).ok())
    {
        return parsed;
    }

    LoopDecision {
        action: LoopAction::Delegate,
        target_item: None,
        worker_prompt: Some(raw.trim().to_string()),
        commit_message: None,
        reason: None,
    }
}

fn extract_json_object(raw: &str) -> Option<String> {
    let start = raw.find('{')?;
    let end = raw.rfind('}')?;
    if end <= start {
        return None;
    }
    Some(raw[start..=end].to_string())
}

fn build_loop_prompt(
    cfg: &AppConfig,
    prd_path: &Path,
    prd: &PrdDocument,
    loop_context: &str,
    execution_tests: &[String],
) -> String {
    let remaining = prd
        .unchecked_items()
        .into_iter()
        .map(|i| format!("- {}", i.text))
        .collect::<Vec<_>>()
        .join("\n");
    let completed = prd
        .items
        .iter()
        .filter(|i| i.checked)
        .map(|i| format!("- {}", i.text))
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        r#"{system}

Role: Loop manager (fast model). Decide the next task for the implementation agent.
PRD file: {prd_file}

Visible files for you:
{loop_files}

Visible tests for you:
{loop_tests}

Execution tests run by orchestrator:
{exec_tests}

Completed PRD items:
{completed}

Remaining PRD items:
{remaining}

Prior orchestration context:
{context}

Respond with JSON only:
{{
  "action": "delegate" | "done",
  "target_item": "exact PRD item text to execute",
  "worker_prompt": "concrete implementation instructions",
  "commit_message": "optional commit message",
  "reason": "optional short rationale"
}}
"#,
        system = cfg.loop_agent.system_prompt,
        prd_file = prd_path.display(),
        loop_files = format_lines(cfg.loop_agent.visible_files.as_slice()),
        loop_tests = format_lines(cfg.loop_agent.visible_tests.as_slice()),
        exec_tests = format_lines(execution_tests),
        completed = if completed.is_empty() {
            "(none)".to_string()
        } else {
            completed
        },
        remaining = remaining,
        context = if loop_context.is_empty() {
            "(none)".to_string()
        } else {
            loop_context.to_string()
        }
    )
}

fn build_worker_prompt(
    cfg: &AppConfig,
    target_item: &str,
    worker_task: &str,
    failure_output: Option<&str>,
    execution_tests: &[String],
) -> String {
    let failure_block = failure_output
        .map(|output| {
            format!(
                "Previous test failures to fix first:\n{}\n",
                truncate(output, 3000)
            )
        })
        .unwrap_or_default();
    format!(
        r#"{system}

Role: Implementation agent (slower, stronger model).
Current PRD item:
{target_item}

Task:
{worker_task}

You may focus on these files:
{files}

You should internally validate against these tests:
{tests}

The orchestrator will run this test suite after your turn:
{exec_tests}

{failure_block}
Keep output concise. Include:
1) What changed
2) What remains risky
3) Suggested commit message
"#,
        system = cfg.worker_agent.system_prompt,
        target_item = target_item,
        worker_task = worker_task,
        files = format_lines(cfg.worker_agent.visible_files.as_slice()),
        tests = format_lines(cfg.worker_agent.visible_tests.as_slice()),
        exec_tests = format_lines(execution_tests),
        failure_block = failure_block,
    )
}

#[derive(Debug, Clone)]
struct TestRun {
    success: bool,
    output: String,
}

fn run_test_suite(commands: &[String], dry_run: bool) -> Result<TestRun> {
    if commands.is_empty() {
        return Ok(TestRun {
            success: true,
            output: "No tests configured.".to_string(),
        });
    }

    let mut all_output = String::new();
    for cmd in commands {
        if dry_run {
            all_output.push_str(&format!("[dry-run] {cmd}\n"));
            continue;
        }
        let result =
            run_shell(cmd).with_context(|| format!("failed to run test command: {cmd}"))?;
        all_output.push_str(&format!("$ {cmd}\n{}\n", result.output));
        if !result.success {
            return Ok(TestRun {
                success: false,
                output: all_output,
            });
        }
    }

    Ok(TestRun {
        success: true,
        output: all_output,
    })
}

fn has_uncommitted_changes() -> Result<bool> {
    let out = run_shell("git status --porcelain")?;
    Ok(!out.output.trim().is_empty())
}

fn commit_all(message: &str) -> Result<String> {
    run_shell("git add -A")?;
    run_shell(&format!("git commit -m {}", shell_quote(message)))?;
    let hash = run_shell("git rev-parse --short HEAD")?;
    Ok(hash.output.trim().to_string())
}

#[derive(Debug)]
struct ShellRun {
    success: bool,
    output: String,
}

fn run_shell(command: &str) -> Result<ShellRun> {
    let output = Command::new("sh")
        .arg("-lc")
        .arg(command)
        .output()
        .with_context(|| format!("failed to spawn shell for `{command}`"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let merged = format!("{}{}", stdout, stderr);
    Ok(ShellRun {
        success: output.status.success(),
        output: merged.trim().to_string(),
    })
}

fn format_lines(lines: &[String]) -> String {
    if lines.is_empty() {
        return "(none)".to_string();
    }
    lines
        .iter()
        .map(|line| format!("- {line}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn truncate(input: &str, max: usize) -> String {
    if input.len() <= max {
        return input.to_string();
    }
    format!("{}...", &input[..max])
}

fn shell_quote(input: &str) -> String {
    format!("'{}'", input.replace('\'', r"'\''"))
}
