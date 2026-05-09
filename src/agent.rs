use anyhow::Result;
use crate::api::{ApiClient, ChatMessage};
use crate::config::Config;
use crate::goal::{self, GoalState, StateHandle, StreamLine};
use crate::tools;

pub async fn run_loop(state: StateHandle, config: Config) -> Result<()> {
    let api = ApiClient::new(config.api.clone())?;
    let tools = tools::tool_definitions();
    {
        let mut s = state.lock().unwrap();
        s.goal_state = GoalState::Running;
        s.push_line(StreamLine::Info(format!(
            "Goal set. Model: {}. Max iterations: {}.",
            config.api.model, config.goal.max_iterations
        )));
        s.push_line(StreamLine::Info(format!(
            "Validation commands: {:?}",
            config.goal.validation_commands
        )));
    }

    let mut messages: Vec<ChatMessage> = Vec::new();
    messages.push(build_system_message(&config, &tools));

    let max_iterations = config.goal.max_iterations;

    for iteration in 1..=max_iterations {
        while {
            let s = state.lock().unwrap();
            s.goal_state == GoalState::Paused
        } {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }

        {
            let s = state.lock().unwrap();
            if s.goal_state == GoalState::Completed || s.goal_state == GoalState::Failed {
                return Ok(());
            }
        }

        {
            let mut s = state.lock().unwrap();
            s.iteration = iteration;
            s.goal_state = GoalState::Running;
            s.push_line(StreamLine::Info(format!(
                "--- Turn {iteration}/{max_iterations} ---"
            )));
        }

        let context_msg = build_context_message(&state);
        messages.push(context_msg);

        let response = match api.chat_stream(&messages, &tools).await {
            Ok(r) => r,
            Err(err) => {
                let mut s = state.lock().unwrap();
                s.push_line(StreamLine::Error(format!("API error: {err:#}")));
                s.goal_state = GoalState::Failed;
                s.error_message = Some(format!("{err:#}"));
                return Err(err);
            }
        };

        if let Some(ref content) = response.content {
            let mut s = state.lock().unwrap();
            for line in content.lines() {
                let trimmed = line.trim();
                if !trimmed.is_empty() {
                    s.push_line(StreamLine::Thinking(trimmed.to_string()));
                }
            }
        }

        if response.tool_calls.is_empty() {
            let mut s = state.lock().unwrap();
            s.push_line(StreamLine::Info(
                "No tool calls in response. Continuing...".into(),
            ));
            messages.push(ChatMessage {
                role: "assistant".into(),
                content: response.content,
                tool_calls: None,
                tool_call_id: None,
                name: None,
            });
            continue;
        }

        let assistant_msg = ChatMessage {
            role: "assistant".into(),
            content: response.content,
            tool_calls: Some(response.tool_calls.clone()),
            tool_call_id: None,
            name: None,
        };
        messages.push(assistant_msg);

        let mut finish_detected = false;
        let mut finish_summary = String::new();

        for tc in &response.tool_calls {
            {
                let mut s = state.lock().unwrap();
                s.push_line(StreamLine::Action(format!(
                    "> {}({})",
                    tc.function.name,
                    summarize_args(&tc.function.arguments)
                )));
                s.tool_call_count += 1;
            }

            if tools::is_finish_call(tc) {
                finish_detected = true;
                if let Ok(v) =
                    serde_json::from_str::<serde_json::Value>(&tc.function.arguments)
                {
                    finish_summary = v["summary"].as_str().unwrap_or("Done").to_string();
                }
            }

            let result = tools::execute(tc);

            {
                let mut s = state.lock().unwrap();
                let label = if result.success && tc.function.name != "finish" {
                    format!("  ok: {}", summarize_result(&result.content))
                } else if tc.function.name == "finish" {
                    format!("  {}", result.content)
                } else {
                    format!("  FAIL: {}", summarize_result(&result.content))
                };
                s.push_line(StreamLine::ToolResult(label));
            }

            messages.push(ChatMessage {
                role: "tool".into(),
                content: Some(result.content),
                tool_calls: None,
                tool_call_id: Some(result.tool_call_id),
                name: Some(result.name),
            });
        }

        if finish_detected {
            let mut s = state.lock().unwrap();
            s.goal_state = GoalState::Completed;
            s.finish_summary = Some(finish_summary.clone());
            s.push_line(StreamLine::Done(finish_summary.clone()));
            s.progress_log
                .add_checkpoint(format!("Goal completed: {finish_summary}"), true);
            return Ok(());
        }

        if !config.goal.validation_commands.is_empty() || !config.goal.file_checks.is_empty() {
            let validation = goal::run_validation(&config.goal.validation_commands);
            let file_check_results = goal::check_files(&config.goal.file_checks);

            let all_pass = validation.iter().all(|v| v.success)
                && file_check_results.iter().all(|v| v.success);

            let mut s = state.lock().unwrap();
            s.last_validation = validation.clone();
            s.push_line(StreamLine::Validation("--- validation ---".into()));

            for v in &validation {
                let status = if v.success { "PASS" } else { "FAIL" };
                s.push_line(StreamLine::Validation(format!(
                    "  [{status}] {}",
                    truncate(&v.command, 60)
                )));
                if !v.success {
                    s.push_line(StreamLine::Validation(format!(
                        "    {}",
                        truncate(&v.output, 200)
                    )));
                }
            }

            for v in &file_check_results {
                let status = if v.success { "PASS" } else { "FAIL" };
                s.push_line(StreamLine::Validation(format!(
                    "  [{status}] {}",
                    truncate(&v.command, 60)
                )));
            }

            if all_pass && (!validation.is_empty() || !file_check_results.is_empty()) {
                let cp_desc = format!(
                    "Turn {iteration}: all validation passed ({}/{})",
                    validation.iter().filter(|v| v.success).count()
                        + file_check_results.iter().filter(|v| v.success).count(),
                    validation.len() + file_check_results.len()
                );
                s.progress_log.add_checkpoint(cp_desc.clone(), true);
                s.push_line(StreamLine::Info(format!("Checkpoint: {cp_desc}")));
            } else if !all_pass {
                s.progress_log
                    .add_checkpoint(format!("Turn {iteration}: validation failures"), false);
                s.push_line(StreamLine::Error(
                    "Validation failed. Agent will see results and can fix in next turn."
                        .into(),
                ));
            }
        }

        {
            let mut s = state.lock().unwrap();
            let log_md = s.progress_log.to_markdown();
            if let Err(e) = std::fs::write(&config.progress.log_file, log_md) {
                s.push_line(StreamLine::Error(format!(
                    "Failed to write progress log: {e}"
                )));
            }
            s.current_action = String::new();
        }

        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    }

    {
        let mut s = state.lock().unwrap();
        if s.goal_state != GoalState::Completed {
            s.goal_state = GoalState::Failed;
            s.push_line(StreamLine::Error(format!(
                "Max iterations ({max_iterations}) reached without finish()."
            )));
            s.error_message = Some("Max iterations reached".into());
        }
    }

    Ok(())
}

fn build_system_message(config: &Config, tools: &[tools::Tool]) -> ChatMessage {
    let mut prompt = config.goal.system_prompt.clone();
    prompt.push_str("\n\n## Available Tools\n\n");
    for tool in tools {
        prompt.push_str(&format!(
            "- **{}**: {}\n",
            tool.function.name, tool.function.description
        ));
    }

    let vc = if config.goal.validation_commands.is_empty() {
        "  (none configured)".to_string()
    } else {
        config
            .goal
            .validation_commands
            .iter()
            .map(|c| format!("  - `{c}`"))
            .collect::<Vec<_>>()
            .join("\n")
    };

    let vf = if config.goal.visible_files.is_empty() {
        "  (all files)".to_string()
    } else {
        config
            .goal
            .visible_files
            .iter()
            .map(|f| format!("  - {f}"))
            .collect::<Vec<_>>()
            .join("\n")
    };

    prompt.push_str(&format!(
        r#"

## Workflow

1. Read relevant files to understand the current state.
2. Make targeted changes using write_file.
3. Run validation commands (tests, lints, builds) to verify.
4. Create checkpoints after validation passes.
5. Call finish() only when the goal is fully achieved.

Validation commands that run automatically after each turn:
{vc}

Visible project files:
{vf}

Work step by step. Each turn, do one logical chunk of work, then validate.
"#
    ));

    ChatMessage {
        role: "system".into(),
        content: Some(prompt),
        tool_calls: None,
        tool_call_id: None,
        name: None,
    }
}

fn build_context_message(state: &StateHandle) -> ChatMessage {
    let s = state.lock().unwrap();

    let mut context = format!(
        "## Goal\n{}\n\n## Status\nTurn: {}/{}\n",
        s.goal_text, s.iteration, s.max_iterations
    );

    if !s.progress_log.checkpoints.is_empty() {
        context.push_str("## Progress\n");
        for cp in &s.progress_log.checkpoints {
            let status = if cp.validation_pass { "PASS" } else { "FAIL" };
            context.push_str(&format!("- [{}] {}\n", status, cp.description));
        }
    }

    if !s.last_validation.is_empty() {
        context.push_str("\n## Last Validation Results\n");
        for v in &s.last_validation {
            let status = if v.success { "PASS" } else { "FAIL" };
            context.push_str(&format!(
                "- [{status}] `{cmd}`: {output}\n",
                cmd = v.command,
                output = truncate(&v.output, 150)
            ));
        }
    }

    ChatMessage {
        role: "user".into(),
        content: Some(context),
        tool_calls: None,
        tool_call_id: None,
        name: None,
    }
}

fn summarize_args(args: &str) -> String {
    let s: String = args.chars().take(120).collect();
    if args.len() > 120 {
        format!("{s}...")
    } else {
        s
    }
}

fn summarize_result(content: &str) -> String {
    let first_line = content.lines().next().unwrap_or("");
    truncate(first_line, 100)
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}...", &s[..max])
    }
}
