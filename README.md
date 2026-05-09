> 🚧 **Warning**
>
> This project is experimental and **not production-ready**. Expect breaking changes and incomplete features. AND all your data and code to be compromised, if you don't know what you are doing, pls avoid for now.

# laun

`laun` is a goal-driven autonomous coding agent. Pass it a goal, and it uses an LLM (via any OpenAI-compatible API) to read your codebase, make changes, run validation commands, and iterate until the goal is achieved.

The agent has access to tools for reading/writing files, running shell commands, and searching code — it works across multiple turns with automatic validation after each turn.

## How it works

1. You provide a goal and a config file with your API credentials.
2. `laun` starts a terminal UI showing progress in real time.
3. Each turn, the agent receives context about the current state (progress checkpoints, last validation results) and decides which tool to call next.
4. After each turn, its changes are validated against your configured commands (e.g. `cargo test`, `cargo build`).
5. `laun` writes a `PROGRESS.md` checkpoint log as it goes.
6. The loop continues until the agent calls `finish()`, validation fails with no recovery, or max iterations are reached.

## Installation

```bash
cargo build --release
./target/release/laun --help
```

Or run directly:

```bash
cargo run -- "your goal here"
```

## Quick start

1. Create a config file:

```bash
# laun.toml
[api]
base_url = "https://api.openai.com/v1"
api_key = "sk-..."
model = "gpt-4o"
```

(You can use any OpenAI-compatible API — OpenRouter, Groq, local LLM servers, etc.)

2. Run with a goal:

```bash
laun "Refactor the auth module to use async/await. Stop when cargo test passes."
```

3. Watch the TUI: `q` to quit, `p`/`space` to pause/resume, `j`/`k` to scroll.

## Config reference

See `laun.toml`:

```toml
[api]
base_url = "https://api.openai.com/v1"   # OpenAI-compatible endpoint
api_key = "sk-..."                         # or ${ENV_VAR} to read from env
model = "gpt-4o"
max_tokens = 4096
temperature = 0.2

[goal]
max_iterations = 50
validation_commands = ["cargo test", "cargo clippy"]
visible_files = ["src/", "Cargo.toml"]
system_prompt = "You are a coding agent..."

[progress]
log_file = "PROGRESS.md"
```

### File checks

You can also configure static file existence/content checks per turn:

```toml
[[goal.file_checks]]
path = "src/lib.rs"
exists = true

[[goal.file_checks]]
path = "src/lib.rs"
exists = true
contains = "pub fn"
```

## Agent tools

The agent has access to these tools:

| Tool | Description |
|------|-------------|
| `read_file` | Read a file's contents |
| `write_file` | Create or overwrite a file |
| `run_command` | Run a shell command |
| `search` | Search for a pattern in files (uses `rg`) |
| `finish` | Declare the goal complete |

## Safety notes

- The agent can run arbitrary shell commands and write arbitrary files. Run in a dedicated directory or git branch.
- Start with a small, well-scoped goal and low `max_iterations` to test your setup.
- Use `${ENV_VAR}` syntax in `laun.toml` to avoid hardcoding your API key: `api_key = "${OPENAI_API_KEY}"`

## TUI keyboard controls

| Key | Action |
|-----|--------|
| `q` | Quit (marks goal as failed) |
| `p` / `space` | Pause / resume |
| `j` / `↓` | Scroll agent stream down |
| `k` / `↑` | Scroll agent stream up |
| `g` | Jump to top of stream |
| `G` | Jump to bottom of stream |
