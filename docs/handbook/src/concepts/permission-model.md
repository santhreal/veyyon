# Permission model

Every tool the model wants to run passes through one gate: the approval mode. The
approval mode decides whether a tool runs on its own or waits for you to say yes. You
set it once in config, and you can change it for a single run from the command line.

One setting controls this: `tools.approvalMode`. Nothing else confines what a command
can do once it runs. Veyyon does not wrap commands in an operating-system sandbox
(Landlock, seccomp, Seatbelt, or bubblewrap), so the approval mode is the boundary. Treat
it as the boundary.

## Tool tiers

Every tool belongs to one of three tiers, ordered by how much it can change:

- **read** looks but does not touch: `read`, `grep`, `glob`, and directory listing.
- **write** changes files: `edit` and `write`.
- **exec** runs commands: `bash` and anything else that executes a program.

A mode approves whole tiers, not individual tools. That is why the tiers come first: once
you know which tier a tool is in, the mode tells you whether it runs.

## Modes

A mode is a named choice of which tiers run without asking. There are four:

| Mode | Auto-approves | Prompts for |
| --- | --- | --- |
| `plan` | read | write, exec |
| `ask` | read | write, exec |
| `auto-edit` | read + write | exec |
| `yolo` | all tiers | nothing (unless a per-tool override or a bash safety rule applies) |

The schema default is `yolo`. Two older names still work: `always-ask` maps to `ask`, and
`write` maps to `auto-edit`.

Set the mode in config, or override it for one run:

```console
$ veyyon --approval-mode auto-edit "run the tests and fix failures"
```

The launch flags `--yolo` and `--plan-yolo` set `yolo` and a plan-mode variant of it.

## The working-directory boundary

A tier tells you what kind of thing a tool does. It does not tell you which file the
tool is about to touch. In `auto-edit`, the `write` tier is approved, so `write` runs
without asking whether the target is `src/main.ts` or a file in your home directory.

The working-directory boundary is the second question, asked after the tier:

> Does this call touch a path outside the session working directory?

If it does, the call asks for approval even though its tier would have allowed it. This
holds in `plan`, `ask`, and `auto-edit`. It does not hold in `yolo`, which turns off
permission entirely.

Say you launched in `~/projects/api` and the model runs this:

```console
$ veyyon --approval-mode auto-edit "update the config"
```

Writing `~/projects/api/config.yml` runs without asking, because it is inside the
working directory and `write` is an approved tier. Writing `~/.ssh/config` asks, because
it is outside, even though the tier is the same.

The check looks at where a path really leads, not at how it is spelled. A path written
entirely inside the working directory that reaches outside it through a symlink counts
as outside. A path that cannot be resolved at all also counts as outside, because
treating an unreadable path as safe is the assumption you least want to be wrong about.

These tools take part: `read`, `write`, `edit`, `ast_edit`, `grep`, `glob`, `ast_grep`,
`inspect_image`, and `set_cwd`.

`set_cwd` is on that list because it changes the working directory itself. If it were
not bound, you could move the boundary instead of obeying it: re-root to the parent
directory, and every later write counts as inside. So re-rooting outward asks, the same
as writing outward. Re-rooting into a subdirectory does not ask, because that narrows
what the session can reach rather than widening it.

When no interactive prompt is available, such as a headless or ACP run, a call that
needs approval fails instead of proceeding. The error names the path that crossed the
boundary, so you can see why the run stopped.

## Per-tool overrides

When you want one tool to behave differently from its tier, name it under
`tools.approval`. Each entry maps a tool to `allow`, `deny`, or `prompt`, and that choice
wins for that tool no matter what the mode says.

```yaml
# ~/.veyyon/profiles/default/agent/config.yml
tools:
  approvalMode: auto-edit
  approval:
    bash: prompt
    read: allow
```

Here the mode is `auto-edit`, so writes run without asking. The override then pulls `bash`
back to `prompt`, so commands still stop for your approval.

## Execpolicy

Within the exec tier, `.rules` files refine which shell commands may auto-run. You keep
them at the user level and per project. A project directory you have not trusted yet is
treated as untrusted: its project-local rules, config, and hooks stay disabled until you
trust the directory.

## On deny

When a tool is denied, or a policy check fails, Veyyon returns an error to the model. It
does not retry with more permission. An error never escalates what the model is allowed to
do.

## Related

- [Approvals](../features/sandbox.md)
- [Safety](../using/safety.md)
- [CLI](../reference/cli.md)
