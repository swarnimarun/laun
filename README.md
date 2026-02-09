# laun

`laun` is a Rust CLI that orchestrates a two-agent implementation loop against a PRD checklist.

- `loop_agent` (fast, cheaper): chooses the next PRD item and writes scoped instructions.
- `worker_agent` (slower, stronger): makes code changes for that item.
- Orchestrator: runs tests, retries fixes when tests fail, commits on success, and marks PRD items complete.

## Why this exists

This pattern separates planning cadence from implementation quality:

- Fast model keeps momentum and task ordering.
- Strong model handles code-heavy tasks.
- Each agent can have different visible file/test scope in prompts.

## Current capabilities

- Config-driven agent commands (works with OpenCode, Codex, or custom wrappers).
- PRD markdown checkbox parsing (`- [ ]` / `- [x]`).
- Test gate after each worker run.
- Retry loop with failure feedback to the worker.
- Optional auto-commit (`git add -A && git commit`).
- Optional auto-mark PRD item as done.

## Installation

### Run from source

```bash
cargo run -- --help
```

### Build binary

```bash
cargo build --release
./target/release/laun --help
```

## Quick start

1. Initialize config and PRD files:

```bash
laun init
```

2. Edit `laun.toml`:
- Set your agent command + args for your local CLI setup.
- Set models for loop/worker.
- Set test commands in `workflow.execution_tests`.

3. Edit `PRD.md` with checklist items:

```md
- [ ] Implement feature A
- [ ] Add tests for feature A
- [ ] Ship docs
```

4. Validate config:

```bash
laun validate
```

5. Run a dry simulation first:

```bash
laun run --dry-run --max-iterations 1
```

6. Run for real:

```bash
laun run
```

## How the loop works

For each iteration:

1. Load unchecked PRD items.
2. Ask `loop_agent` for next action (JSON contract).
3. Ask `worker_agent` to implement selected item.
4. Run `workflow.execution_tests`.
5. If tests fail, retry worker with failing output (`max_fix_attempts`).
6. If tests pass:
- optional commit (`workflow.auto_commit`)
- optional PRD item check-off (`prd.auto_mark_completed`)

## Config overview

Generated defaults currently target OpenCode CLI. You can switch either agent to Codex or any custom command.

```toml
[prd]
file = "PRD.md"
auto_mark_completed = true

[workflow]
max_iterations = 12
max_fix_attempts = 2
auto_commit = true
execution_tests = ["cargo test"]

[loop_agent]
provider = "opencode"
command = "opencode"
args = ["run", "--model", "{model}", "--thinking", "{prompt}"]
model = "google/gemini-3-flash-preview"

[worker_agent]
provider = "opencode"
command = "opencode"
args = ["run", "--model", "{model}", "--thinking", "{prompt}"]
model = "google/gemini-3-pro-preview"
```

Template placeholders supported in `args`:

- `{model}`
- `{prompt}`
- `{prompt_file}` (absolute temp file path containing the prompt)

## Safety notes

- `workflow.auto_commit = true` stages and commits all current workspace changes.
- Run with `--dry-run` first to inspect flow without calling agents/tests/commits.
- Start with a dedicated git branch.

## Usage docs

Detailed command reference and advanced examples:

- `docs/USAGE.md`

