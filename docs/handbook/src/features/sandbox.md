# Approvals

Approvals are how you decide which tools run without asking. One setting drives them:
`tools.approvalMode`. There is no operating-system sandbox behind it (no Landlock, seccomp,
Seatbelt, or bubblewrap). Shell commands and file writes run as your user, bounded only by
this policy, per-tool `tools.approval` overrides, and the hard-coded flagged bash patterns
below.

This page is the operator reference. For the model behind it, see
[Permission model](../concepts/permission-model.md). For the wider boundary, see
[Safety](../using/safety.md).

## Tool tiers

| Tier | Examples |
| --- | --- |
| **read** | `read`, `grep`, `glob`, listing |
| **write** | `edit`, `write` |
| **exec** | `bash` and other command execution |

## Modes

| Mode | read | write | exec |
| --- | --- | --- | --- |
| `plan` | auto | ask with an active plan-mode session, denied otherwise | denied |
| `ask` | ask | ask | ask |
| `ask-command` | auto | auto | ask |
| `auto` | auto | auto | auto, with the per-tool, working-directory, credential and flagged-command guards still asking |
| `yolo` | auto | auto | auto, except a blatantly destructive command, which still asks |

Schema default: **`auto`**. Legacy aliases: `always-ask` → `ask`, `write` and `auto-edit` → `ask-command`.

```console
$ veyyon --approval-mode ask-command
$ veyyon --yolo                    # same as --auto-approve → yolo
$ veyyon --plan-yolo               # plan now; yolo after leaving plan mode
```

```yaml
tools:
  approvalMode: ask
```

## The approval prompt

When the active mode requires approval for a tool call, the TUI shows a **Permission required**
card. The card names the tool, states that the decision applies to this call only, separates the
reason from the requested command or file operation, and waits on four options:

- **Approve**: run this call once. Nothing is remembered.
- **Approve for session**: run this and every later call to this tool, until you exit.
- **Deny**: refuse this call and return `Tool call denied by user: <name>` to the model.
- **Deny for session**: refuse this and every later call to this tool, until you exit.

The two "for session" rows are session memory, not policy: nothing is written to
`tools.approval`, and the next launch asks again. A remembered decision also covers only
the ordinary tier prompt. The three prompts that are about a call's ARGUMENTS rather than
its tool name still ask every time: a flagged bash command, a path outside the working
directory, and a call that spends a stored credential.

The selected option uses a radio marker and includes a short description. Navigate with the usual
list keys (`up`/`down`, `enter` to confirm, `esc` to cancel; cancelling counts as a denial).
Denied actions return an error to the model, and permissions are never widened.

## Headless

`veyyon --print` has no terminal to prompt in. If the mode would ask for approval, the tool call
fails with an error that explains the required setting or override (set `tools.approvalMode: yolo`,
add `tools.approval.<name>: allow`, or use an interactive UI), and the model receives that error. To
run unattended, pass `--yolo` or pick a mode that does not prompt for the tiers you need. The
process exit status follows the run.

## Critical bash commands

Some shell commands always prompt in `plan`, `ask`, `ask-command` and `auto`, even over a per-tool
`allow` override. The guard lives in `packages/coding-agent/src/tools/bash-guard.ts` and has
two halves.

The first half judges what a command would delete, after expansion rather than as text. It
resolves a leading tilde and `$HOME`, judges every target rather than only the first, and
stops a recursive delete of the home directory, of anything containing it, of a system
directory, or of a directory holding your credentials. It also stops a recursive delete whose
target it cannot resolve, such as `rm -rf "$dir"/*`, because an empty `$dir` makes that
command start at the root. It also stops a truncating redirect into a credentials directory,
such as `echo x > ~/.ssh/id_ed25519`; appending with `>>` is left alone. Deletes inside your
workspace, such as `rm -rf node_modules` or `rm -rf dist`, run without a prompt, and so do
ordinary redirects such as `bun test > /tmp/results.txt`.

The second half is a pattern list (`FLAGGED_BASH_PATTERNS`, same file) for shapes with no
path to expand, and each entry records what it would do. The **destructive** ones are `sudo rm`,
recursive `chmod`/`chown` on `/`, fork bombs, disk and filesystem destruction (`mkfs`, `dd` to a
device, writes to `/dev/sd*`), and writes to `/etc/passwd`/`shadow`/`sudoers`. The **dangerous**
ones are a remote fetch piped to a shell (`curl … | sh` and its process-substitution and `eval`
variants), host control (`shutdown`, `reboot`, `kill -9 1`), and network shells (`nc -e`): these
run code nobody read or restart the machine, without destroying anything.

Neither half can be narrowed; the guard exists because a false negative costs data loss or a
compromised host. You can widen the first half with `tools.protectedPaths`, a list of absolute
paths (a leading `~` is expanded) that a recursive delete must also stop for. It only adds:
nothing in the built-in judgement reads configuration, so no value there can stop the guard
refusing your home directory. See
[the permission model](../concepts/permission-model.md) for an example.

The destructive half, and the whole of the first half, stop for approval in `yolo` as well, and
the `/yolo` session bypass does not lift them. That floor is the one place `yolo` is not
absolute. The dangerous half stops on every rung below `yolo` and not on `yolo` itself, because
a rung whose entire promise is that it does not ask cannot be stopping an install the operator
typed. To turn the floor off, set `tools.approval.bash` to `allow`; setting it to `deny` remains
a hard block.

Separately, the bash interceptor (`bashInterceptor.enabled`, default off) blocks shell
commands that duplicate dedicated tools, so the model reaches for `read`/`grep`/`glob`
instead of `cat`/`rg`/`find`. Its rules live in `bashInterceptor.patterns`.

## Related

- [Permission model](../concepts/permission-model.md)
- [Non-interactive mode](./exec.md)
- [Safety](../using/safety.md)
