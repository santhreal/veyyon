# Tool approval mode

Tool approval has two independent inputs:

1. **Tool declaration**: every tool may declare an `approval` tier:
   - `read`: reads data or updates UI-only session metadata.
   - `write`: mutates workspace/session state but does not execute arbitrary code.
   - `exec`: executes code, shells out, drives a browser, spawns agents, or performs similarly broad actions.
2. **User policy**: `tools.approval.<toolName>: allow | deny | prompt` overrides the mode for that tool unless a non-yolo safety override forces a prompt.

Tools without an `approval` declaration are treated as `exec`. This is the safe default for unknown custom tools. MCP server tools declare `write`.

## Modes

Configure with `tools.approvalMode`:

| Mode               | Auto-approves           | Prompts for     |
| ------------------ | ----------------------- | --------------- |
| `plan`             | `read`                  | `write`, `exec` (plan-mode semantics) |
| `ask`              | `read`                  | `write`, `exec` |
| `auto-edit`        | `read`, `write`         | `exec`          |
| `yolo` (default)   | `read`, `write`, `exec` | none            |

Legacy aliases still accepted: `always-ask` → `ask`, `write` → `auto-edit`.

`--auto-approve` and `--yolo` force `tools.approvalMode: yolo` for the session.

## The `/yolo` command (full session bypass)

The `yolo` mode above still honors your per-tool policies: `tools.approval.<tool>: prompt` and a tool's own safety `override` prompt both still stop the call. The `/yolo` command is stronger. It removes every approval prompt for the current session, including per-tool `prompt` overrides and safety `override` prompts.

Run `/yolo` in the TUI and confirm the danger prompt to turn it on. While it is on, file writes, shell commands, and network calls run without asking. The composer border and prompt glyph turn red and the status line shows a red `YOLO` marker, so you always know it is active.

Two things still block a call, because they are hard denials rather than prompts:

- an explicit `tools.approval.<tool>: deny`, and
- plan mode (mutating tools stay blocked).

The bypass is session-scoped. It defaults to off, is never written to settings, and resets to off when the session ends. Turn it off at any time with `/yolo off`, and check the current state with `/yolo status`.

This is different from the `--yolo` and `--auto-approve` launch flags, which set the `yolo` approval mode (and so keep honoring your per-tool `prompt`/`deny` policies). The `/yolo` command is the in-session full bypass.

To start a session already in full bypass, pass `--dangerously-skip-permissions`. It turns on the same session-scoped bypass that `/yolo on` does (removing per-tool `prompt` overrides too), so explicit `deny` and plan mode still block, and you can toggle it off at runtime with `/yolo off`. Prefer `--yolo`/`--auto-approve` when you only want the `yolo` approval mode; reach for `--dangerously-skip-permissions` only when you want every prompt gone from the first tool call.

## User overrides

`tools.approval` is honored in every mode:

```yaml
tools:
  approvalMode: auto-edit
  approval:
    bash: prompt
    read: allow
    mcp__filesystem__delete: deny
```

Resolution per tool call:

1. Compute the tool's approval decision from `tool.approval(args)`; omitted means `exec`.
2. Normalize `tools.approval.<tool>` if present; invalid values are ignored.
3. In `yolo` mode, the user policy is used when present; otherwise the call is allowed. Safety `override` reasons do not force a prompt in `yolo`.
4. In non-yolo modes, if the tool sets `override: true`, `deny` is blocked and all other cases prompt, even if user policy says `allow`.
5. Otherwise, a valid user policy wins.
6. Otherwise, the active mode auto-approves or prompts by tier.

## Safety overrides

A tool can force a prompt with object-form approval:

```ts
approval: { tier: "exec", override: true, reason: "Critical pattern detected" }
```

`bash` uses this for critical destructive patterns such as `rm -rf /`, fork bombs, remote-fetch-then-execute, writes to `/etc/passwd`, and host shutdown commands. These surface as `reason` in the approval prompt, but in `yolo` mode they are auto-approved unless a user policy for the tool is set to `prompt` or `deny`.

## Per-tool prompt details

Tools can add approval-prompt body lines with `formatApprovalDetails(args)`. The standard prompt includes:

- `Allow tool: <name>`
- `Origin: MCP server tool` for unannotated `mcp__...` tools
- `Reason: <reason>` when the tool decision supplies one
- tool-specific details such as command, path, code, browser action, or subagent assignment

## Defining approval on tools

Built-in and custom tools share the same shape:

```ts
export type ToolTier = "read" | "write" | "exec";
export type ToolApprovalDecision = ToolTier | { tier: ToolTier; reason?: string; override?: boolean };
export type ToolApproval = ToolApprovalDecision | ((args: unknown) => ToolApprovalDecision);

approval?: ToolApproval;
formatApprovalDetails?: (args: unknown) => string | string[] | undefined;
```

Examples:

```ts
approval: "read";

approval: (args) => (LSP_READONLY_ACTIONS.has(args.action) ? "read" : "write");

approval: (args) =>
  isCritical(args.command)
    ? { tier: "exec", override: true, reason: "Critical pattern detected" }
    : "exec";
```

## ACP sessions

ACP (`veyyon acp`) uses the same settings resolver as normal Veyyon launches. Global `~/.veyyon/profiles/default/agent/config.yml` (or the active profile's agent dir) applies, project config for the ACP session `cwd` applies, and any `--config <file>` overlays passed to the ACP server process apply to sessions created by that process.

To auto-approve ACP tool calls, set the mode in global or project config:

```yaml
tools:
  approvalMode: yolo
```

Or launch the ACP server with a runtime override or a one-process config overlay:

```bash
veyyon acp --yolo
veyyon acp --auto-approve
veyyon acp --approval-mode yolo
veyyon acp --config ./acp-yolo.yml   # file contains tools.approvalMode: yolo
```

Precedence is the normal settings precedence: runtime flags (`--approval-mode`, `--auto-approve`, `--yolo`) override `--config` overlays, which override project config, which overrides global config. ACP does not currently define a `session/new`, `session/load`, or `session/resume` approval-policy field, so ACP clients that need per-session yolo should launch a separate `veyyon acp` process with one of the flags above or with a session-specific `--config` overlay.

`tools.approvalMode: yolo` fully applies to ACP when it is explicitly configured or supplied by a runtime flag. It skips Veyyon's approval prompts and also skips the ACP client permission gate for `bash`, `edit`, `delete`, and `move` unless `tools.approval.<tool>` is `prompt` or `deny`. The schema default is `yolo`, but default-config ACP sessions still keep the client permission gate; set `tools.approvalMode: yolo` explicitly when the client wants unattended execution.

When ACP approval is required, Veyyon routes it through the ACP client instead of the terminal TUI. Client-gated `bash`, `edit`, `delete`, and `move` calls use ACP `session/request_permission`; generic approval prompts use form elicitation when the client advertises `elicitation.form`. A rejected, cancelled, or unsupported prompt rejects/cancels the tool call; Veyyon does not silently allow it.

## Subagents

Subagents run headless with `tools.approvalMode: yolo` so they do not stall waiting for UI. The parent `task` approval is the authorization boundary. User `tools.approval.<tool>` settings continue to control whether a tool is allowed, prompted, or blocked.
