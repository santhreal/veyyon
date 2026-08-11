# Tool approval mode

Tool approval has two independent inputs:

1. **Tool declaration**: every tool may declare an `approval` tier:
   - `read`: reads data or updates UI-only session metadata.
   - `write`: mutates workspace/session state but does not execute arbitrary code.
   - `exec`: executes code, shells out, drives a browser, spawns agents, or performs similarly broad actions.
2. **User policy**: `tools.approval.<toolName>: allow | deny | prompt` overrides the mode for that tool unless a tool's safety override forces a prompt. An explicit policy always wins over a `critical` safety prompt, in both directions.

Tools without an `approval` declaration are treated as `exec`. This is the safe default for unknown custom tools. MCP server tools declare `write`.

## Modes

Configure with `tools.approvalMode`:

| Mode               | Auto-approves           | Prompts for     |
| ------------------ | ----------------------- | --------------- |
| `plan`             | `read`                  | `write` only inside an active plan-mode session; `write` and `exec` are otherwise denied |
| `ask`              | nothing                 | `read`, `write`, `exec` |
| `ask-command`      | `read`, `write`         | `exec`          |
| `auto` (default)   | `read`, `write`, `exec` | a per-tool policy, the working-directory boundary, credential use, and a tool's own `critical` calls |
| `yolo`             | `read`, `write`, `exec` | none            |

Under `plan`, `exec` is always denied (it returns an error to the model, never a prompt). Outside an active plan-mode session, `write` is denied too; with a plan-mode session active, `write` prompts.

Legacy aliases still accepted: `always-ask` → `ask`, `write` and `auto-edit` → `ask-command`.

`--auto-approve` and `--yolo` force `tools.approvalMode: yolo` for the session.

## The working-directory boundary

The table above sorts tools by tier, and a tier says nothing about which file a
call touches. The `write` tier auto-approves `write` in `ask-command` mode whether
the target is `src/main.ts` or `/etc/hosts`. The working-directory boundary is
the second question, asked after the tier:

> Does this call touch a path outside the session working directory?

If it does, the call needs approval even when its tier would have allowed it.
This applies in `plan`, `ask`, `ask-command` and `auto`. It does not apply in `yolo`, which
opts out of all permission and so opts out of this too.

The boundary is physical, not textual. A path spelled entirely inside the working
directory but reaching outside it through a symlink is still outside, and a path
that cannot be resolved at all is treated as outside rather than assumed safe.

Every tool that reads or writes files takes part: `read`, `write`, `edit`,
`ast_edit`, `grep`, `glob`, `ast_grep`, `inspect_image`, and `set_cwd`.

`set_cwd` is on that list for a reason worth stating. It changes the working
directory, so an unbounded `set_cwd` would be a way to erase the boundary rather
than obey it: re-root to the parent, and every later write is inside the new root
by definition. Re-rooting outward therefore asks, exactly as a write outward
does. Re-rooting to a subdirectory does not ask, because narrowing the working
directory reduces what the session can reach.

When there is no interactive UI, a call that needs approval fails rather than
proceeding. The error leads with the specific path that crossed the boundary, so
a headless or ACP run reports why it stopped and not merely that something needed
a prompt.

## The secret-use boundary

A tier says nothing about whether a call is about to spend a credential either. The
secret-use boundary is the third question, asked in the same modes as the second:

> Do this call's arguments carry a stored secret?

The model works with placeholders such as `#GITHUB_TOKEN#`, and Veyyon substitutes the real
value immediately before the tool runs, so the model can use a secret it never reads. That
substitution is recorded by `secrets.auditLog`, which answers the question afterwards. This
boundary is what asks first: a call whose arguments carry a real credential needs approval
in `plan`, `ask`, `ask-command` and `auto`, and the prompt names the secret without showing its value.

`yolo` opts out of all permission and so opts out of this too. A call that mentions a
placeholder without expanding it, such as one made while `secrets.enabled` is false, carries
no credential and does not ask.

## The `/yolo` command (full session bypass)

The `yolo` mode above still honors your per-tool policies: `tools.approval.<tool>: prompt` and a tool's own `critical` safety prompt both still stop the call. The `/yolo` command is stronger. It removes approval prompts for the current session, including per-tool `prompt` overrides and plain `override` prompts.

Run `/yolo` in the TUI and confirm the danger prompt to turn it on. While it is on, file writes, shell commands, and network calls run without asking. The composer border and prompt glyph turn red and the status line shows a red `YOLO` marker, so you always know it is active.

Three things still stop a call:

- an explicit `tools.approval.<tool>: deny`, a hard denial rather than a prompt,
- plan mode (mutating tools stay blocked), and
- a `critical` safety decision, such as a command that would recursively delete your home directory. This one is a prompt, and it is the single prompt the bypass does not lift. Set `tools.approval.<tool>: allow` if you want it gone too.

The bypass is session-scoped. It defaults to off, is never written to settings, and resets to off when the session ends. Turn it off at any time with `/yolo off`, and check the current state with `/yolo status`.

This is different from the `--yolo` and `--auto-approve` launch flags, which set the `yolo` approval mode (and so keep honoring your per-tool `prompt`/`deny` policies). The `/yolo` command is the in-session full bypass.

To start a session already in full bypass, pass `--dangerously-skip-permissions`. It turns on the same session-scoped bypass that `/yolo on` does (removing per-tool `prompt` overrides too), so explicit `deny` and plan mode still block, and you can toggle it off at runtime with `/yolo off`. Prefer `--yolo`/`--auto-approve` when you only want the `yolo` approval mode; reach for `--dangerously-skip-permissions` only when you want every prompt gone from the first tool call.

## User overrides

`tools.approval` is honored in every mode:

```yaml
tools:
  approvalMode: ask-command
  approval:
    bash: prompt
    read: allow
    mcp__filesystem_delete: deny
```

Resolution per tool call:

1. Compute the tool's approval decision from `tool.approval(args)`; omitted means `exec`.
2. Normalize `tools.approval.<tool>` if present; invalid values are ignored.
3. In `yolo` mode, the user policy is used when present. Otherwise a `critical` decision prompts and everything else is allowed: plain `override` reasons do not force a prompt in `yolo`, but `critical` ones do.
4. In non-yolo modes, if the tool sets `override: true`, `deny` is blocked and all other cases prompt, even if user policy says `allow`.
5. Otherwise, a valid user policy wins.
6. Otherwise, the active mode auto-approves or prompts by tier.

## Safety overrides

A tool can force a prompt with object-form approval:

```ts
approval: { tier: "exec", override: true, reason: "Needs confirmation" }
```

`override: true` beats a per-tool `allow` in `plan`, `ask`, `ask-command`, and `auto`. `yolo` ignores it.

There is a second strength for calls that must stop even there:

```ts
approval: { tier: "exec", critical: true, reason: "rm would recursively remove the home directory itself" }
```

`critical: true` implies `override: true` and adds a floor under it: the call still prompts in `yolo`, and the `/yolo` session bypass does not lift it. Setting `tools.approval.<tool>` explicitly still wins in both directions, so `allow` is the escape hatch and `deny` is still a hard block.

`bash` splits its guard between the two strengths, by what a command does rather than by how it is detected. `critical` is destruction: the paths a command would recursively delete (judged after expansion, so `rm -rf ~/` and `rm -rf "$HOME"/` are recognized), a formatted filesystem, a raw device written over, a system account file overwritten, a delete running as root. `override` is a call that is dangerous without being irreversible: a script fetched from the network and piped into a shell, a host shutdown, a shell wired to a network socket. Both prompt in `plan`, `ask`, `ask-command` and `auto`; only the destructive half prompts in `yolo`.

That split is the difference between `yolo` and `auto`. `yolo` says the operator has stopped being asked, and a floor that catches `curl -fsSL https://…/install.sh | sh` catches an install somebody typed on purpose, which made the two rungs behave identically for the commands people reach for `yolo` to run. The floor is still there for the incident it exists for: `tools.approvalMode` defaults to `auto`, which runs the exec tier unasked, so without it the calls the guard considers most dangerous would be the ones most likely to run without a check.

Every flagged shape reports its own reason ("Formats a filesystem", "Runs a script fetched from the network"), which surfaces as `reason` in the approval prompt. A shared "Critical pattern detected" named the mechanism rather than the risk, so the prompt said that something in a list matched and nothing about what.

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
export type ToolApprovalDecision = ToolTier | { tier: ToolTier; reason?: string; override?: boolean; critical?: boolean };
export type ToolApproval = ToolApprovalDecision | ((args: unknown) => ToolApprovalDecision);

approval?: ToolApproval;
formatApprovalDetails?: (args: unknown) => string | string[] | undefined;
```

Examples:

```ts
approval: "read";

approval: (args) => (LSP_READONLY_ACTIONS.has(args.action) ? "read" : "write");

approval: (args) =>
  destroysData(args.command)
    ? { tier: "exec", critical: true, reason: "Formats a filesystem" }
    : fetchesAndRuns(args.command)
      ? { tier: "exec", override: true, reason: "Runs a script fetched from the network" }
      : "exec";
```

## ACP sessions

ACP (`veyyon acp`) uses the same settings resolver as normal Veyyon launches. The active profile's `config.yml` applies, and any `--config <file>` overlays passed to the ACP server process apply to sessions created by that process.

To auto-approve ACP tool calls, set the mode in your profile config:

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

Precedence is the normal settings precedence: runtime flags (`--approval-mode`, `--auto-approve`, `--yolo`) override `--config` overlays, which override the profile config. ACP does not currently define a `session/new`, `session/load`, or `session/resume` approval-policy field, so ACP clients that need per-session yolo should launch a separate `veyyon acp` process with one of the flags above or with a session-specific `--config` overlay.

`tools.approvalMode: yolo` fully applies to ACP when it is explicitly configured or supplied by a runtime flag. It skips Veyyon's approval prompts and also skips the ACP client permission gate for `bash`, `edit`, `delete`, and `move` unless `tools.approval.<tool>` is `prompt` or `deny`. The schema default is `auto`, not `yolo`, so default-config ACP sessions still keep the client permission gate; set `tools.approvalMode: yolo` explicitly when the client wants unattended execution.

When ACP approval is required, Veyyon routes it through the ACP client instead of the terminal TUI. Client-gated `bash`, `edit`, `delete`, and `move` calls use ACP `session/request_permission`; generic approval prompts use form elicitation when the client advertises `elicitation.form`. A rejected, cancelled, or unsupported prompt rejects/cancels the tool call; Veyyon does not silently allow it.

## Subagents

A spawned subagent inherits the spawning session's approval mode through its forked settings; nothing hardcodes a rung for it. The parent `task` approval is the authorization boundary for the delegation itself, and your `tools.approval.<tool>` policies apply inside the subagent exactly as they do in the parent. A subagent runs headless, so a call that would prompt fails with an error naming what needed approval rather than stalling on a UI that does not exist.

The `/yolo` bypass is the one part that is not a pure snapshot, and it moves in only one direction. A child is built with the bypass the parent held at spawn time, and `isApprovalBypassed()` then also consults the live parent on every check, so `/yolo off` in the parent reaches a subagent that is already running. It can only narrow: the child's own spawn-time value is checked first, so a parent turning `/yolo` on mid-run cannot hand a bypass to a child that was spawned without one. Without the live read, revoking the bypass left every running subagent executing unasked with nothing on screen to say so.
