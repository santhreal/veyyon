# Hooks

Veyyon supports lifecycle hooks via the **extension runner**. The shipped model is a **TypeScript
hook module**: files discovered under `.veyyon/hooks/` are imported by the Bun runtime and export a
factory that registers `pi.on(...)` handlers.

> **Spec — not shipped:** the JSON `hooks.json` file, `config.yml` `hooks:` tables, and the
> `{ "type": "command" }` external-subprocess model with the `PreToolUse` / `PostToolUse` / matcher /
> trust-level semantics documented on the rest of this page. Veyyon does not load hooks from JSON or
> run them as external subprocess commands. Those shapes are documented as the target
> compatibility surface; to write a hook that runs today, use a TypeScript module that calls
> `pi.on(...)`.

## Event Lifecycle

| Event Name | Supports Matcher | Matcher Target | Description |
| --- | --- | --- | --- |
| `PreToolUse` | Yes | Tool name | Fires before Veyyon executes a tool. |
| `PermissionRequest` | Yes | Tool name | Fires when Veyyon requests permission to run a tool. |
| `PostToolUse` | Yes | Tool name | Fires after Veyyon completes tool execution. |
| `PreCompact` | Yes | Compaction trigger | Fires before Veyyon compacts the conversation history. |
| `PostCompact` | Yes | Compaction trigger | Fires after Veyyon compacts the conversation history. |
| `SessionStart` | Yes | Startup source | Fires when a Veyyon session starts. |
| `UserPromptSubmit` | No | None | Fires when the user submits a new prompt. |
| `SubagentStart` | Yes | Subagent type | Fires when a subagent starts. |
| `SubagentStop` | Yes | Subagent type | Fires when a subagent finishes. |
| `Stop` | No | None | Fires when Veyyon exits. |

### Startup and Compaction Matchers

For `SessionStart`, the matcher filters against the startup source. The possible values are:
* `startup` (a new Veyyon session starts)
* `resume` (resuming a saved session)
* `clear` (starting a clean conversation)
* `compact` (starting a compaction turn)

For `PreCompact` and `PostCompact`, the matcher filters against the trigger name.

## Configuration

> **Spec — not shipped:** the two JSON/YAML configuration paths in this section describe the target
> model, not the shipped TS `pi.on(...)` loader. They are documented for compatibility only.

The spec model configures hooks in two ways:
1. In `config.yml` (either system-level, user-level, or project-local config) under a `hooks` section.
2. In a standalone `hooks.json` file inside the config folder (such as the project's `.veyyon/hooks.json` or the user's `$VEYYON_HOME/hooks.json`).

### Hook Handler Schema

Every hook handler configuration supports the following parameters:

| Field Name | Type | Description |
| --- | --- | --- |
| `type` | String | Must be `"command"`. (Prompt and agent hook types are reserved but not supported yet). |
| `command` | String | The command string to execute in the shell. |
| `commandWindows` | String | (Optional) A Windows-specific command override. |
| `timeout` | Integer | (Optional) The execution timeout in seconds. Defaults to 10 minutes. |
| `async` | Boolean | (Optional) Whether to execute the hook asynchronously. |
| `statusMessage` | String | (Optional) A message to show in the TUI while the hook is running. |

### Configuration Examples

#### In `config.yml` (spec model)

```yaml
hooks:
  PreToolUse:
    - matcher: "^Bash$"
      hooks:
        - type: command
          command: "echo 'Running bash command'"
          timeout: 30
```

#### In `hooks.json`

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^Bash$",
        "hooks": [
          {
            "type": "command",
            "command": "echo 'Running bash command'",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

## Security and Trust Model

Veyyon requires user-level and project-local hooks to be trusted before they can execute. Every hook handler has a calculated cryptographic hash derived from its event name, matcher, and normalized settings.

Upon discovery, Veyyon classifies hooks into one of four trust levels:

* **Managed**: Hooks loaded from administrator-enforced requirements layers (such as `/etc/veyyon/config.yml` or MDM profiles) are always trusted.
* **Trusted**: User-level or project-local hooks whose calculated hash matches a trusted hash stored under the `hooks.state` section in `$VEYYON_HOME/config.yml`.
* **Modified**: Hooks that were previously trusted, but their command or matcher settings have been modified.
* **Untrusted**: Newly discovered hooks that have no trust record.

Veyyon disables project-local configuration, hooks, and execution policies in untrusted project directories. You can bypass trust verification by running Veyyon with the `--dangerously-bypass-hook-trust` command-line flag.

## Execution Mechanics

Command hooks run as subprocesses. On Unix-like systems, Veyyon runs commands using the shell specified in the `SHELL` environment variable, falling back to `/bin/sh` with the `-lc` arguments. On Windows, Veyyon uses the shell program in the `COMSPEC` environment variable, falling back to `cmd.exe` with the `/C` argument.

### Hook Input (Standard Input)

Veyyon writes a JSON object to standard input (stdin) containing the event details. Every event payload shares these properties:

```json
{
  "sessionId": "a-unique-session-id",
  "turnId": "active-turn-id",
  "agentId": "active-subagent-id",
  "agentType": "active-subagent-type",
  "transcriptPath": "/absolute/path/to/transcript.jsonl",
  "cwd": "/absolute/path/to/cwd",
  "hookEventName": "PreToolUse",
  "model": "model-name",
  "permissionMode": "permission-mode"
}
```

Event-specific stdin properties include:
* **`PreToolUse`**: `toolName` (string), `toolInput` (JSON arguments), `toolUseId` (string)
* **`PermissionRequest`**: `toolName` (string), `toolInput` (JSON arguments)
* **`PostToolUse`**: `toolName` (string), `toolInput` (JSON arguments), `toolResponse` (JSON output), `toolUseId` (string)
* **`PreCompact` & `PostCompact`**: `trigger` (string)
* **`SessionStart`**: `source` (string)
* **`SubagentStart`**: `agentId` (string), `agentType` (string)
* **`UserPromptSubmit`**: `prompt` (string)
* **`Stop`**: `stopHookActive` (boolean), `lastAssistantMessage` (string or null)
* **`SubagentStop`**: `stopHookActive` (boolean), `agentId` (string), `agentType` (string), `lastAssistantMessage` (string or null), `agentTranscriptPath` (string or null)

### Hook Output (Standard Output)

Hooks communicate their results to Veyyon by writing to standard output (stdout):
* If stdout is empty, Veyyon proceeds normally.
* If stdout is not valid JSON, Veyyon treats it as a plain-text message and injects it into the LLM context.
* If stdout is JSON, it must conform to the hook schema.

#### Universal JSON Output Properties

```json
{
  "continue": true,
  "stopReason": "Optional explanation",
  "suppressOutput": false,
  "systemMessage": "Optional warning text to show in the TUI"
}
```

If `continue` is set to `false`, Veyyon aborts the action (this is ignored by `SubagentStart`).

#### Event-Specific JSON Output Properties

Hooks can return structured updates under the `hookSpecificOutput` key or direct properties:

* **`PreToolUse`**:
  * `decision` (string): Set to `"block"` or `"approve"`.
  * `reason` (string): Required if `decision` is `"block"`.
  * `hookSpecificOutput`:
    * `hookEventName`: `"PreToolUse"`.
    * `permissionDecision` (string): Set to `"allow"`, `"deny"`, or `"ask"`.
    * `permissionDecisionReason` (string).
    * `updatedInput` (JSON): Rewrites the arguments of the tool before Veyyon runs it.
    * `additionalContext` (string): Text to append to the LLM context.

* **`PermissionRequest`**:
  * `hookSpecificOutput`:
    * `hookEventName`: `"PermissionRequest"`.
    * `decision`:
      * `behavior` (string): Set to `"allow"` or `"deny"`.
      * `message` (string).
      (Note: `updated_input`, `updated_permissions`, or setting `interrupt` to `true` will cause the hook to fail closed).

* **`PostToolUse`**:
  * `decision` (string): Set to `"block"`.
  * `reason` (string): Required if `decision` is `"block"`.
  * `hookSpecificOutput`:
    * `hookEventName`: `"PostToolUse"`.
    * `additionalContext` (string): Text to append to the LLM context.
    * `updatedMCPToolOutput` (JSON): Rewrites the output returned by the MCP tool.

* **`SessionStart`, `SubagentStart`, `UserPromptSubmit`**:
  * `hookSpecificOutput`:
    * `hookEventName`: Match the event name.
    * `additionalContext` (string): Text to append to the LLM context.

* **`Stop`, `SubagentStop`**:
  * `decision` (string): Set to `"block"`.
  * `reason` (string): Required if `decision` is `"block"`.

## The `/hooks` TUI Command

You can view and manage lifecycle hooks using the `/hooks` slash command in the Veyyon TUI. Running `/hooks` fetches the active hooks configuration and opens the hooks browser in the bottom pane.

### Interface Navigation

Use the following keyboard shortcuts in the hooks browser:

* **Arrow Up / Down**: Navigate through the list of events or individual handlers.
* **Page Up / Down**: Scroll by page.
* **Enter (on Events page)**: Opens the handlers configured for the selected event.
* **Enter or Space (on Handlers page)**: Toggles the enabled state of the selected trusted hook.
* **t (on Handlers page)**: Trusts the selected hook.
* **t (on Events page)**: Trusts all untrusted or modified hooks discovered in the current directory.
* **Escape (on Handlers page)**: Returns to the events list.
* **Escape (on Events page)**: Closes the hooks browser.

## Related recipes

For a worked "run a check after every edit" flow that pairs hooks with non-interactive
`veyyon --print` runs, see
[Task guides](../using/task-guides.md#automate-a-check-on-every-edit-hooks).

Engineering detail: [`docs/hooks.md`](../../../hooks.md).
