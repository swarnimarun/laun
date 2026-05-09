use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{fs, process::Command};

#[derive(Debug, Clone, Serialize)]
pub struct Tool {
    #[serde(rename = "type")]
    pub tool_type: String,
    pub function: FunctionDef,
}

#[derive(Debug, Clone, Serialize)]
pub struct FunctionDef {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub call_type: String,
    pub function: ToolFunction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolFunction {
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone)]
pub struct ToolResult {
    pub tool_call_id: String,
    pub name: String,
    pub content: String,
    pub success: bool,
}

pub fn tool_definitions() -> Vec<Tool> {
    vec![
        Tool {
            tool_type: "function".into(),
            function: FunctionDef {
                name: "read_file".into(),
                description: "Read the contents of a file. Use before editing to understand current state.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "Path to the file, relative to project root"}
                    },
                    "required": ["path"]
                }),
            },
        },
        Tool {
            tool_type: "function".into(),
            function: FunctionDef {
                name: "write_file".into(),
                description: "Write content to a file, creating or overwriting it.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "Path to the file, relative to project root"},
                        "content": {"type": "string", "description": "Full file content to write"}
                    },
                    "required": ["path", "content"]
                }),
            },
        },
        Tool {
            tool_type: "function".into(),
            function: FunctionDef {
                name: "run_command".into(),
                description: "Run a shell command. Use for building, testing, linting, or inspecting the project.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "command": {"type": "string", "description": "Shell command to execute"}
                    },
                    "required": ["command"]
                }),
            },
        },
        Tool {
            tool_type: "function".into(),
            function: FunctionDef {
                name: "search".into(),
                description: "Search for a pattern in files. Returns matching lines with file paths.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "pattern": {"type": "string", "description": "Text or regex pattern to search for"},
                        "path": {"type": "string", "description": "Optional: directory or file to search in"}
                    },
                    "required": ["pattern"]
                }),
            },
        },
        Tool {
            tool_type: "function".into(),
            function: FunctionDef {
                name: "finish".into(),
                description: "Declare the goal is complete. Only call when the goal is fully achieved and validation passes.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "summary": {"type": "string", "description": "Summary of what was accomplished"}
                    },
                    "required": ["summary"]
                }),
            },
        },
    ]
}

pub fn execute(tool_call: &ToolCall) -> ToolResult {
    let result = match tool_call.function.name.as_str() {
        "read_file" => execute_read_file(&tool_call.function.arguments),
        "write_file" => execute_write_file(&tool_call.function.arguments),
        "run_command" => execute_run_command(&tool_call.function.arguments),
        "search" => execute_search(&tool_call.function.arguments),
        "finish" => execute_finish(&tool_call.function.arguments),
        other => Err(anyhow::anyhow!("unknown tool: {other}")),
    };

    match result {
        Ok(content) => ToolResult {
            tool_call_id: tool_call.id.clone(),
            name: tool_call.function.name.clone(),
            content,
            success: true,
        },
        Err(err) => ToolResult {
            tool_call_id: tool_call.id.clone(),
            name: tool_call.function.name.clone(),
            content: format!("Error: {:#}", err),
            success: false,
        },
    }
}

fn execute_read_file(args_json: &str) -> Result<String> {
    #[derive(Deserialize)]
    struct Args {
        path: String,
    }
    let args: Args = serde_json::from_str(args_json)?;
    let content = fs::read_to_string(&args.path)
        .with_context(|| format!("failed to read {}", args.path))?;
    Ok(truncate_middle(&content, 8000))
}

fn execute_write_file(args_json: &str) -> Result<String> {
    #[derive(Deserialize)]
    struct Args {
        path: String,
        content: String,
    }
    let args: Args = serde_json::from_str(args_json)?;
    if let Some(parent) = std::path::Path::new(&args.path).parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create parent dir for {}", args.path))?;
        }
    }
    fs::write(&args.path, &args.content)
        .with_context(|| format!("failed to write {}", args.path))?;
    let line_count = args.content.lines().count();
    Ok(format!("Wrote {} ({} lines)", args.path, line_count))
}

fn execute_run_command(args_json: &str) -> Result<String> {
    #[derive(Deserialize)]
    struct Args {
        command: String,
    }
    let args: Args = serde_json::from_str(args_json)?;
    let output = Command::new("sh")
        .arg("-lc")
        .arg(&args.command)
        .output()
        .with_context(|| format!("failed to execute: {}", args.command))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let hint = if output.status.success() {
        "Exit: 0".to_string()
    } else {
        format!("Exit: {}", output.status.code().unwrap_or(-1))
    };
    let combined = format!("{stdout}{stderr}");
    Ok(format!("{hint}\n{}", truncate_end(&combined, 6000)))
}

fn execute_search(args_json: &str) -> Result<String> {
    #[derive(Deserialize)]
    struct Args {
        pattern: String,
        #[serde(default)]
        path: Option<String>,
    }
    let args: Args = serde_json::from_str(args_json)?;
    let search_path = args.path.unwrap_or_else(|| ".".into());
    let output = Command::new("sh")
        .arg("-lc")
        .arg(format!(
            "rg --line-number --max-count 3 --no-heading '{}' '{}' 2>/dev/null || echo 'no matches'",
            args.pattern.replace('\'', r"'\''"),
            search_path.replace('\'', r"'\''")
        ))
        .output()
        .context("failed to run rg")?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    Ok(truncate_end(&stdout, 4000))
}

fn execute_finish(args_json: &str) -> Result<String> {
    #[derive(Deserialize)]
    struct Args {
        summary: String,
    }
    let args: Args = serde_json::from_str(args_json)?;
    Ok(format!("GOAL COMPLETE: {}", args.summary))
}

fn truncate_middle(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let half = max / 2;
    let start = &s[..half];
    let end = &s[s.len() - half..];
    format!("{start}\n\n... [{} bytes truncated] ...\n\n{end}", s.len() - max)
}

fn truncate_end(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let end = &s[s.len() - max..];
    format!("... [{} bytes truncated] ...\n{end}", s.len() - max)
}

pub fn is_finish_call(tool_call: &ToolCall) -> bool {
    tool_call.function.name == "finish"
}
