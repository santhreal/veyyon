# Non-interactive mode (`veyyon --print`)

> **Spec — not shipped:** a `veyyon exec` subcommand. Non-interactive mode is the **`--print`** launch
> flag (short `-p`): `veyyon -p "prompt"`. JSON output is `--json`, and resume is `--resume` /
> `--continue`. The `veyyon exec resume` / `veyyon exec review` subcommand forms and several flags
> (`--output-schema`, `--oss`) below are the target shape; run `veyyon --help` for the current flag set.
> The JSON event schema and the recipe shapes are accurate.

`veyyon --print` (short `-p`) runs Veyyon without the interactive cockpit: give it one prompt, it does
the work and exits. It is how you drive Veyyon from scripts, CI, git hooks, and other programs.

```console
$ veyyon -p "add a unit test for parse_config and run it"
$ echo "summarize the diff on this branch" | veyyon -p
$ veyyon -p - <<'EOF'
Review src/auth.rs for missing error handling.
EOF
```

The prompt can be an argument or read from stdin. If stdin is piped **and** a prompt argument is also
provided, stdin is appended as a `<stdin>` block.

Run `veyyon --help` for the generated, always-current flag set. This page documents the intended
integration surface and recipes.

## Flag reference

### Session and config

| Option | Effect |
| --- | --- |
| `--strict-config` | Error when `config.yml` contains fields this version does not recognize. |
| `--skip-git-repo-check` | Allow running outside a Git repository. |
| `--ephemeral` | Do not persist the session under `VEYYON_HOME/sessions`. |
| `--ignore-user-config` | Do not load `$VEYYON_HOME/config.yml`. Auth still uses `VEYYON_HOME`. |
| `--ignore-rules` | Do not load user or project execpolicy `.rules` files. |
| `--profile <name>` | Activate a profile: relocate the agent dir to `$VEYYON_HOME/profiles/<name>/agent/` (see [Profiles](./profiles.md)). Note: `-p` is `--print`, not `--profile`. |
| `-c key=value` | Override any config value for this run (repeatable). |
| `-C, --cd <DIR>` | Working root for the agent. |
| `--add-dir <DIR>` | Extra writable root alongside the workspace (repeatable). |
| `--system-prompt <TEXT>` | Replace the default system prompt (context files / skills still append). |
| `--append-system-prompt <TEXT>` | Append to the effective system prompt. |

### Model and local OSS

| Option | Effect |
| --- | --- |
| `-m, --model <MODEL>` | Pin the conversation model for the run. |
| `--oss` | Use the open-source / local provider path. |
| `--local-provider <ollama\|lmstudio>` | Which local provider to use with `--oss`. |

### Sandbox and trust

| Option | Effect |
| --- | --- |
| `-s, --sandbox <policy>` | Sandbox policy for model-generated shell commands (`read-only`, `workspace-write`, `danger-full-access`, …). |
| `--dangerously-bypass-approvals-and-sandbox` | Skip confirmations **and** sandboxing. Alias: `--yolo`. Only for externally sandboxed environments. |
| `--dangerously-bypass-hook-trust` | Run enabled hooks without persisted hook trust for this invocation. |

Headless exec defaults approval policy to **`never`** (no TTY to answer). The sandbox is therefore
your containment — set it explicitly in CI.

#### `--full-auto` is deprecated

`--full-auto` is a **legacy compatibility trap**. It still parses on `veyyon --print`, prints:

```text
warning: `--full-auto` is deprecated; use `--sandbox workspace-write` instead.
```

and maps onto workspace-write sandbox behavior. Do not use it in new scripts:

```console
# preferred
$ veyyon --print --sandbox workspace-write "run unit tests and fix failures"

# deprecated (warns)
$ veyyon --print --full-auto "run unit tests and fix failures"
```

### Output

| Option | Effect |
| --- | --- |
| `--json` | Emit a JSONL event stream on stdout (one event per line). Alias: `--experimental-json`. **Stable integration surface.** |
| `-o, --output-last-message <FILE>` | Write just the final assistant message to a file. |
| `--output-schema <FILE>` | Constrain the final message to a JSON Schema so downstream code can parse a known shape. |
| `--color <auto\|always\|never>` | ANSI color in the human-readable stream (default `auto`). |
| `-i, --image <FILE>` | Attach an image to the prompt (repeatable / comma-separated). |

Combine them: `--json` for the full trace, `--output-schema` when you need a fixed answer shape, `-o`
when you only care about the final text.

## Subcommands

### `veyyon exec resume`

Resume a previous session by id or pick the most recent.

```console
$ veyyon exec resume <SESSION_ID> "continue from the failing test"
$ veyyon exec resume --last "try the next approach"
$ veyyon exec resume --last --all "…"        # do not filter sessions by cwd
$ veyyon exec resume --last -i shot.png "what is in this screenshot?"
```

| Option / arg | Effect |
| --- | --- |
| `SESSION_ID` | Conversation/session id (UUID) or thread name. UUIDs win if the value parses. |
| `--last` | Resume the newest recorded session without specifying an id. If `--last` is set and there is no separate prompt arg, the positional is treated as the **prompt**, not an id. |
| `--all` | Show / consider all sessions (disables cwd filtering). |
| `-i, --image <FILE>` | Images to attach to the prompt sent after resume. |
| `PROMPT` | Prompt after resume; `-` reads stdin. |

### `veyyon exec review`

Run a code review against the current repository (non-interactive).

```console
$ veyyon exec review --uncommitted
$ veyyon exec review --base main
$ veyyon exec review --commit abcdef1 --title "fix auth timeout"
$ veyyon exec review "Focus on unsafe blocks and unwrap()"
```

| Option / arg | Effect |
| --- | --- |
| `--uncommitted` | Review staged, unstaged, and untracked changes. Conflicts with `--base` / `--commit` / prompt-only modes as defined by the CLI. |
| `--base <BRANCH>` | Review changes against the given base branch. |
| `--commit <SHA>` | Review the changes introduced by a commit. |
| `--title <TITLE>` | Optional commit title for the review summary (requires `--commit`). |
| `PROMPT` | Custom review instructions; `-` reads stdin. |

For a richer interactive review workflow, see [Review](./review.md).

## `--json` event schema

Events are **JSON Lines** (`type` tag). Top-level `ThreadEvent` variants:

| `type` | When |
| --- | --- |
| `thread.started` | First event; includes `thread_id` (use with `resume`). |
| `turn.started` | A new prompt turn began. |
| `turn.completed` | Turn finished; includes `usage` token counts. |
| `turn.failed` | Turn failed; includes `error.message`. |
| `item.started` / `item.updated` / `item.completed` | Lifecycle for an item in the thread. |
| `error` | Unrecoverable stream error. |

Item payloads (`item` → `type`, snake_case) include:

| Item `type` | Meaning |
| --- | --- |
| `agent_message` | Assistant text (or JSON string when `--output-schema` constrained the final message). |
| `reasoning` | Reasoning summary text. |
| `command_execution` | Shell command, aggregated output, optional `exit_code`, `status`. |
| `file_change` | Patch apply: list of path/`kind` (`add`\|`delete`\|`update`) + `status`. |
| `mcp_tool_call` | MCP invocation lifecycle. |
| `collab_tool_call` | Collab tool lifecycle. |
| `web_search` | Web search request/results. |
| `todo_list` | Agent plan / todo updates. |
| `error` | Non-fatal item-level error. |

Example lines:

```json
{"type":"thread.started","thread_id":"01234567-89ab-cdef-0123-456789abcdef"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_3","type":"file_change","changes":[{"path":"src/lib.rs","kind":"update"}],"status":"completed"}}
{"type":"item.completed","item":{"id":"item_4","type":"agent_message","text":"Done."}}
{"type":"turn.completed","usage":{"input_tokens":1200,"cached_input_tokens":800,"output_tokens":200,"reasoning_output_tokens":0}}
```

Pipe into `jq`:

```console
$ veyyon --print --json "…" | tee run.jsonl \
    | jq -r 'select(.type=="item.completed" and .item.type=="agent_message") | .item.text'
```

## Exit codes

`veyyon --print` follows the handbook [exit code contract](../reference/exit-codes.md):

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | Veyyon error (config, auth, missing session, unrecoverable runtime) — or fallback when a child ended without a reportable status. |
| `2` | Usage / clap parse error. |
| `N` | Child process exit code passed through when applicable. |
| `128 + signal` | Child killed by signal (POSIX shell convention). |

A failure is **never** reported as `0`, so `veyyon --print … && next-step` is safe in a pipeline.

## CI and automation recipes

### 1. Hermetic unit-test fix loop

```console
$ veyyon --print --sandbox workspace-write \
    --ignore-user-config \
    --ephemeral \
    --skip-git-repo-check \
    -m gpt-5-mini \
    "Run cargo test -p mycrate. Fix compile and test failures only. Stop when green."
```

### 2. PR review bot with JSON artifact

```console
$ veyyon exec review --base origin/main --json \
    | tee review.jsonl

$ jq -r 'select(.type=="item.completed" and .item.type=="agent_message") | .item.text' \
    review.jsonl > review.md
```

Or constrain the final message:

```console
$ cat > /tmp/review-schema.json <<'EOF'
{
  "type": "object",
  "required": ["findings", "verdict"],
  "properties": {
    "verdict": { "enum": ["approve", "request_changes", "comment"] },
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["severity", "path", "summary"],
        "properties": {
          "severity": { "enum": ["P0", "P1", "P2"] },
          "path": { "type": "string" },
          "summary": { "type": "string" }
        }
      }
    }
  }
}
EOF

$ veyyon --print --sandbox read-only --json \
    --output-schema /tmp/review-schema.json \
    -o review-out.json \
    "Review the staged diff; return JSON matching the schema."
```

### 3. Pre-commit hook (staged diff only)

```bash
#!/usr/bin/env bash
set -euo pipefail
veyyon --print --sandbox workspace-write --ephemeral --json \
  "Review the staged diff. Fail the turn if you find a P0 bug; otherwise summarize." \
  | tee /tmp/veyyon-pre-commit.jsonl \
  | jq -e 'select(.type=="turn.failed") | length == 0' >/dev/null
```

### 4. Batch refactor across a path

```console
$ veyyon --print --sandbox workspace-write -C "$REPO" \
    --add-dir /tmp/veyyon-scratch \
    "Rename FooConfig -> AppConfig under src/config/. Update call sites. Run cargo check."
```

### 5. Resume a long CI job

```console
$ THREAD=$(veyyon --print --json --ephemeral "start the migration plan" \
    | jq -r 'select(.type=="thread.started") | .thread_id')
# … later …
$ veyyon exec resume "$THREAD" "continue; finish applying the plan"
```

(Omit `--ephemeral` if you need the session on disk for `resume`.)

## Safety notes for automation

- Prefer `--sandbox workspace-write` or `read-only` over bypass flags.
- Use `--ignore-user-config` / `--ignore-rules` when the runner's home directory must not affect the job.
- `--dangerously-bypass-approvals-and-sandbox` is for outer jails only — prefer
  `external-sandbox` when you can express that cleanly ([Sandbox](./sandbox.md)).
- Never commit API keys into CI logs; use the runner secret store and `env_key`.

## See also

- [Sessions](../using/sessions.md) — resuming and branching.
- [Sandbox and approvals](./sandbox.md) — policies for CI.
- [Exit codes](../reference/exit-codes.md)
- [ACP / SDK](../../../sdk.md) for programmatic control.
- [CLI reference](../reference/cli.md)
