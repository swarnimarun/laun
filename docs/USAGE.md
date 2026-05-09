# Usage

## Running

```bash
laun "Implement user auth with JWT. Stop when cargo test passes."
```

Or with a custom config path:

```bash
laun --config my-project.toml "Add pagination to the API"
```

Without a goal argument, `laun` prints its help message.

## Configuration

Create a `laun.toml` in your project root (or specify a path with `--config`). If the file doesn't exist, `laun` writes a default template and exits — edit it and re-run.

### `[api]` — API connection

```toml
[api]
base_url = "https://api.openai.com/v1"
api_key = "sk-..."                    # or "${OPENAI_API_KEY}"
model = "gpt-4o"
max_tokens = 4096
temperature = 0.2
```

Any OpenAI-compatible endpoint works. OpenRouter example:

```toml
[api]
base_url = "https://openrouter.ai/api/v1"
api_key = "${OPENROUTER_API_KEY}"
model = "google/gemma-4-31b-it:free"
```

### `[goal]` — Agent behaviour

```toml
[goal]
max_iterations = 50
validation_commands = ["cargo test", "cargo clippy -- -D warnings"]
visible_files = ["src/", "Cargo.toml", "tests/"]
system_prompt = """You are an autonomous coding agent..."""
```

- `max_iterations` — maximum turns before the agent is stopped.
- `validation_commands` — shell commands run automatically after each turn. Results are shown in the TUI and included in context for the next turn.
- `visible_files` — hints for the agent about which files are in scope (shown in the system prompt).
- `system_prompt` — custom system prompt appended to the agent's tool list and workflow instructions.

### File existence/content checks

Optional per-turn static checks on file state:

```toml
[[goal.file_checks]]
path = "src/auth.rs"
exists = true

[[goal.file_checks]]
path = "src/auth.rs"
exists = true
contains = "pub async fn login"
```

### `[progress]` — Checkpoint log

```toml
[progress]
log_file = "PROGRESS.md"
```

After each successful validation, a checkpoint is appended to this file.

## Environment variables in config

Use `${VAR_NAME}` syntax to reference environment variables:

```toml
[api]
api_key = "${OPENAI_API_KEY}"
```

This avoids committing secrets to `laun.toml`.

## Agent tools

| Tool | Parameters | Description |
|------|------------|-------------|
| `read_file` | `path` (required) | Read a file's contents (truncated at 8000 bytes, showing head + tail). |
| `write_file` | `path`, `content` (required) | Overwrite a file. Creates parent directories if needed. |
| `run_command` | `command` (required) | Execute a shell command. Returns exit code and output (truncated at 6000 chars). |
| `search` | `pattern` (required), `path` (optional) | Run `rg` to find pattern matches. Limited to 3 per file, 4000 char output. |
| `finish` | `summary` (required) | Declare the goal complete. This ends the loop. |

## Validation flow

After every turn where the agent makes tool calls:

1. Each command in `goal.validation_commands` is run via `sh -lc`.
2. Each check in `goal.file_checks` is evaluated.
3. Results are appended to the agent stream in the TUI.
4. If all pass, a checkpoint is recorded in `PROGRESS.md`.
5. If any fail, the agent sees the failure output in its next turn context.

The agent can also call `run_command` to run its own tests mid-turn before calling `finish`.

## TUI keyboard controls

| Key | Action |
|-----|--------|
| `q` | Quit (aborts the agent) |
| `p` / `space` | Toggle pause/resume |
| `j` / `↓` | Scroll agent stream down |
| `k` / `↑` | Scroll agent stream up |
| `g` | Jump to top of agent stream |
| `G` | Jump to bottom of agent stream |

The TUI has four panels:
- **Goal** — the goal text, model name, current turn, and elapsed time.
- **Progress Log** — checkpoints from successful validations.
- **Agent Stream** — live output from the agent (thinking lines, tool calls, results, validation).
- **Status Bar** — current state and keybindings.

## Example: running against a local LLM

```toml
[api]
base_url = "http://localhost:11434/v1"
api_key = "ollama"
model = "llama3.1"
max_tokens = 4096
temperature = 0.2
```

## Example: OpenRouter

```toml
[api]
base_url = "https://openrouter.ai/api/v1"
api_key = "${OPENROUTER_API_KEY}"
model = "anthropic/claude-sonnet"
max_tokens = 4096
temperature = 0.2
```

## Recommended workflow

1. Start with a small, testable goal and `max_iterations = 10`.
2. Configure `validation_commands` with at least one fast check (e.g. `cargo check`).
3. Run on a dedicated git branch so you can reset if the agent goes off course.
4. Review `PROGRESS.md` after the run to understand what the agent did.
