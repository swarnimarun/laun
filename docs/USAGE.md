# Usage

## Commands

### `laun init`

Creates:

- config file (`laun.toml` by default)
- PRD checklist file (`PRD.md` by default)

```bash
laun init
laun init --config .laun/laun.toml --prd docs/PRD.md
laun init --force
```

Options:

- `--config <PATH>` (default: `laun.toml`)
- `--prd <PATH>` (default: `PRD.md`)
- `--force` overwrite existing files

### `laun validate`

Validates that config exists, parses, and passes basic checks.

```bash
laun validate
laun validate --config .laun/laun.toml
```

Options:

- `--config <PATH>` (default: `laun.toml`)

### `laun run`

Runs orchestration loop.

```bash
laun run
laun run --max-iterations 3
laun run --dry-run
laun run --config .laun/laun.toml --dry-run
```

Options:

- `--config <PATH>` (default: `laun.toml`)
- `--max-iterations <N>` override config for current run
- `--dry-run` simulate without invoking external agents/tests/commits

## Loop agent JSON contract

`loop_agent` should return JSON:

```json
{
  "action": "delegate",
  "target_item": "Implement API pagination",
  "worker_prompt": "Update handlers and tests for cursor pagination.",
  "commit_message": "feat: add cursor pagination",
  "reason": "API item is blocking UI work"
}
```

Supported actions:

- `delegate`: run worker against selected item
- `done`: stop loop early

If output is not valid JSON, `laun` falls back to treating the output as `worker_prompt`.

## Config reference

### `prd`

- `file`: PRD markdown file path (relative to config file directory is recommended)
- `auto_mark_completed`: mark selected item from `- [ ]` to `- [x]` after successful iteration

### `workflow`

- `max_iterations`: max loop cycles
- `max_fix_attempts`: retries when tests fail
- `auto_commit`: on success, stage and commit all changes
- `execution_tests`: shell commands run after each worker turn

### `loop_agent` and `worker_agent`

- `provider`: metadata (`codex`, `opencode`, `custom`)
- `command`: executable to run
- `args`: argv template
- `model`: inserted into `{model}`
- `visible_files`: included in prompts (advisory context)
- `visible_tests`: included in prompts (advisory context)
- `system_prompt`: role instructions prepended in prompts

`args` placeholders:

- `{model}`
- `{prompt}`
- `{prompt_file}`

## Configuration examples

### OpenCode for both agents

```toml
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

### Mixed setup (Codex loop + OpenCode worker)

Update this to your installed Codex/OpenCode CLI syntax:

```toml
[loop_agent]
provider = "codex"
command = "codex"
args = ["exec", "--model", "{model}", "{prompt}"]
model = "gpt-5-mini"

[worker_agent]
provider = "opencode"
command = "opencode"
args = ["run", "--model", "{model}", "--thinking", "{prompt}"]
model = "google/gemini-3-pro-preview"
```

## Recommended workflow

1. Keep PRD items small and testable.
2. Use `--dry-run` before first live run.
3. Start with `auto_commit = false` until prompts/test commands are stable.
4. Make `execution_tests` fast and deterministic.
5. Run on a dedicated git branch.

## Troubleshooting

`agent command failed`
- Verify executable is installed and on `PATH`.
- Validate `args` against your local CLI version.
- Try replacing `{prompt}` with `{prompt_file}` if CLI expects file input.

`failed to read PRD file`
- Ensure `prd.file` path is correct relative to config location.

No PRD items are marked done
- `target_item` should closely match checklist text.
- Keep exact PRD item text in loop-agent response when possible.

Unexpected commits
- Set `workflow.auto_commit = false`.
- Review `git status` before running.
