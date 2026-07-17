# Custom hooks guide

> **Spec — not shipped:** this guide documents the target hook model — subprocess command hooks
> configured in JSON/YAML and driven by `PreToolUse` / `PostToolUse` / matcher / trust-level semantics
> (the same shape as Claude Code). Veyyon loads hooks as **TypeScript modules** that call `pi.on(...)`,
> not from JSON and not as external subprocess commands. Read this page as the compatibility reference
> for the target model; to write a hook that runs today, author a TS module.

Hooks let you run logic at specific points in Veyyon's lifecycle. You can use them to guard tool calls, enrich context after a tool runs, log events, or enforce local policy.

For a full reference of events, fields, and output formats, see [Hooks](./hooks.md).

## What hooks are

A hook is a command that Veyyon runs when a lifecycle event occurs. The hook receives event details as JSON on stdin and can respond on stdout to approve, block, modify, or annotate the event. Most hooks can use a regular expression matcher so they only run when the context matches, for example only for Bash tool calls or only for compact events.

Use hooks for tasks like:

- Blocking or approving specific tools before they run.
- Adding policy warnings to the context after a tool runs.
- Injecting project-specific instructions when a session starts.
- Logging or auditing tool usage outside the TUI.

## The ten lifecycle events

Hooks can attach to ten events. Eight of them support a matcher.

| Event | Matcher target | When it fires |
| --- | --- | --- |
| `PreToolUse` | Tool name | Before Veyyon executes a tool. |
| `PermissionRequest` | Tool name | When Veyyon asks for permission to run a tool. |
| `PostToolUse` | Tool name | After a tool finishes. |
| `PreCompact` | Compaction trigger | Before compacting the conversation. |
| `PostCompact` | Compaction trigger | After compacting the conversation. |
| `SessionStart` | Startup source | When a session starts. |
| `SubagentStart` | Subagent type | When a subagent starts. |
| `SubagentStop` | Subagent type | When a subagent finishes. |
| `UserPromptSubmit` | None | When you submit a prompt. |
| `Stop` | None | When Veyyon exits. |

`UserPromptSubmit` and `Stop` do not support matchers. The other events can use a regex to decide whether the hook should run.

## Regex matchers

A matcher is a regular expression that filters the event. The hook only runs when the matcher matches the target value for that event.

| Event | Matcher target | Example values |
| --- | --- | --- |
| `PreToolUse`, `PermissionRequest`, `PostToolUse` | Tool name | `^Bash$`, `^Grep$`, `^WriteFile$` |
| `PreCompact`, `PostCompact` | Compaction trigger | `^context-limit$` |
| `SessionStart` | Startup source | `^startup$`, `^resume$`, `^clear$`, `^compact$` |
| `SubagentStart`, `SubagentStop` | Subagent type | `^security-auditor$` |

Match patterns are anchored where you want them. `^Bash$` runs only for the Bash tool, not `BashBackground` or `ReadOnlyBash`.

## Authoring a command hook

A command hook has this schema:

| Field | Type | Description |
| --- | --- | --- |
| `type` | string | Must be `"command"`. |
| `command` | string | The shell command to run. |
| `commandWindows` | string | Optional Windows override. |
| `timeout` | integer | Optional timeout in seconds, default 600. |
| `async` | boolean | Optional. Runs the hook without blocking. |
| `statusMessage` | string | Optional message shown in the TUI while the hook runs. |

### In config.yml (spec model)

```yaml
hooks:
  PreToolUse:
    - matcher: "^Bash$"
      hooks:
        - type: command
          command: "python3 ~/.veyyon/hooks/audit_bash.py"
          timeout: 30
          statusMessage: "Auditing Bash command..."
```

### In hooks.json

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^Bash$",
        "hooks": [
          {
            "type": "command",
            "command": "python3 ~/.veyyon/hooks/audit_bash.py",
            "timeout": 30,
            "statusMessage": "Auditing Bash command..."
          }
        ]
      }
    ]
  }
}
```

## Stdin and stdout payload formats

### Input

Veyyon writes a JSON object to the hook's stdin. All events share these fields:

```json
{
  "sessionId": "uuid",
  "turnId": "turn-id",
  "agentId": "agent-id",
  "agentType": "agent-type",
  "transcriptPath": "/path/to/transcript.jsonl",
  "cwd": "/path/to/cwd",
  "hookEventName": "PreToolUse",
  "model": "model-name",
  "permissionMode": "permission-mode"
}
```

Event-specific fields are added on top. For example, `PreToolUse` includes `toolName`, `toolInput`, and `toolUseId`. See the [Hooks](./hooks.md) reference for the full list.

### Output

The hook prints to stdout:

- Empty stdout: Veyyon continues as if the hook did not intervene.
- Non-JSON stdout: Veyyon treats the text as `additionalContext` and appends it to the LLM context.
- JSON stdout: Veyyon parses it as a structured response.

Shared optional fields on JSON responses:

```json
{
  "continue": true,
  "stopReason": "Optional reason",
  "suppressOutput": false,
  "systemMessage": "Optional message shown in the TUI"
}
```

**Do not use `continue: false` on `PreToolUse` or `PermissionRequest`.** Those events reject it as unsupported. Block a `PreToolUse` call with one of:

```json
{
  "decision": "block",
  "reason": "Forbidden destructive command detected."
}
```

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Forbidden destructive command detected."
  }
}
```

`PostToolUse` and other events have different fields; see [Hooks](./hooks.md) for the full matrix.

## Verification scripts

Write and test hooks outside the TUI first. A simple test harness is to run the script with a sample JSON payload:

```bash
# test_pre_hook.sh
python3 - <<'PY'
import json, sys
payload = json.load(sys.stdin)
if payload.get("toolName") == "Bash":
    tool_input = payload.get("toolInput", {})
    command = tool_input.get("command", "")
    if "rm -rf /" in command:
        print(json.dumps({
            "decision": "block",
            "reason": "Refusing destructive command.",
            "systemMessage": "Blocked a destructive Bash command."
        }))
        sys.exit(0)
print("")
PY
```

Run it manually with a sample payload:

```bash
cat <<'JSON' | bash test_pre_hook.sh
{
  "hookEventName": "PreToolUse",
  "toolName": "Bash",
  "toolInput": { "command": "rm -rf /" }
}
JSON
```

If the output is valid JSON and the behavior matches your intent, register the hook and trust it using `/hooks` or by recording its hash.

## Trust levels

Veyyon assigns each hook a trust level before it runs:

| Level | Meaning |
| --- | --- |
| **Managed** | Loaded from administrator-enforced layers like `/etc/veyyon/config.yml` or MDM profiles. Always trusted. |
| **Trusted** | User or project hooks whose hash matches a recorded trusted hash in the `hooks.state` config section. |
| **Modified** | Previously trusted, but the command or matcher changed. |
| **Untrusted** | Newly discovered hooks with no trust record. |

Untrusted hooks do not run. Veyyon also disables project-local config, hooks, and execution policies in untrusted directories. You can review and trust hooks inside the TUI with the `/hooks` command. You can bypass trust verification entirely with `--dangerously-bypass-hook-trust`, but only for local testing.

## Worked example: PreToolUse guard

This hook blocks Bash commands that contain a destructive pattern.

`.veyyon/hooks.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^Bash$",
        "hooks": [
          {
            "type": "command",
            "command": "python3 .veyyon/hooks/block_destructive.py",
            "timeout": 10,
            "statusMessage": "Checking Bash command..."
          }
        ]
      }
    ]
  }
}
```

`.veyyon/hooks/block_destructive.py`:

```python
import json, sys

payload = json.load(sys.stdin)
if payload.get("toolName") != "Bash":
    sys.exit(0)

command = payload.get("toolInput", {}).get("command", "")
forbidden = ["rm -rf /", "mkfs.", ":(){ :|:& };:", "> /dev/sda"]
if any(pattern in command for pattern in forbidden):
    print(json.dumps({
        "decision": "block",
        "reason": "Forbidden destructive command detected.",
        "systemMessage": "This Bash command was blocked by a local hook."
    }))
    sys.exit(0)
```

When a Bash command matches the forbidden list, Veyyon blocks the tool using the `decision`/`reason` pair and shows the optional `systemMessage` in the TUI.

## Worked example: PostToolUse enrichment

This hook adds a project note after the `Read` tool runs, so the model sees the note in the next turn.

`.veyyon/hooks.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "^Read$",
        "hooks": [
          {
            "type": "command",
            "command": "python3 .veyyon/hooks/read_notes.py",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

`.veyyon/hooks/read_notes.py`:

```python
import json, sys, os

payload = json.load(sys.stdin)
if payload.get("toolName") != "Read":
    sys.exit(0)

file_path = payload.get("toolInput", {}).get("path", "")
if os.path.basename(file_path) == "Cargo.toml":
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": "When editing Cargo.toml, remember to run `cargo check` afterward."
        }
    }))
```

The `additionalContext` text is appended to the model context after the Read tool completes, so it influences the next assistant response.

## Managing hooks with the `/hooks` command

Open the hook browser at any time by typing `/hooks` in the TUI. The browser shows events and their handlers, lets you enable or disable trusted hooks, and lets you trust new or modified hooks. You can also trust hooks by recording their hash in the `hooks.state` config section in your user config, but `/hooks` is the fastest way to review and approve hook changes.
