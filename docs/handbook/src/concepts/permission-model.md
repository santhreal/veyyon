# Permission model

Every tool the model attempts to run passes one check: the approval mode. The
approval mode sets whether a tool runs on its own or waits for you to say yes. You
set it once in config, and you can change it for a single run from the command line.

One setting controls this: `tools.approvalMode`. Nothing else confines what a command
can do once it runs. Veyyon does not wrap commands in an operating-system sandbox
(Landlock, seccomp, Seatbelt, or bubblewrap), so the approval mode is the boundary. Treat
it as the boundary.

## Tool tiers

Every tool belongs to one of three tiers, ordered by how much it can change:

- **read** inspects without modifying: `read`, `search`, and directory listing.
- **write** changes files: `edit` and `write`.
- **exec** runs commands: `bash` and anything else that executes a program.

A mode approves whole tiers, not individual tools. The tier of a tool and the mode together
determine whether it runs.

## Modes

A mode is a named choice of which tiers run without a prompt. There are five:

| Mode | Auto-approves | Prompts for |
| --- | --- | --- |
| `plan` | read | write with an active plan-mode session; write and exec are otherwise denied |
| `ask` | nothing | read, write, exec |
| `ask-command` | read + write | exec |
| `auto` | all tiers | a per-tool policy, the working-directory boundary, credential use, a tool's own flagged calls |
| `yolo` | all tiers | a blatantly destructive command, and a per-tool `deny` or `prompt` |

The schema default is `auto`. Three aliases are accepted: `always-ask` for `ask`, and
`write` and `auto-edit` for `ask-command`.

Set the mode in config, or override it for one run:

```console
$ veyyon --approval-mode ask-command "run the tests and fix failures"
```

The launch flags `--yolo` and `--plan-yolo` set `yolo` and a plan-mode variant of it.

## The working-directory boundary

A tier describes what kind of thing a tool does. It does not identify which file the
tool is about to touch. In `ask-command` and `auto`, the `write` tier is approved, so
`write` runs without a prompt whether the target is `src/main.ts` or a file in your home
directory.

The working-directory boundary is a second check, applied after the tier:

> Does this call touch a path outside the session working directory?

If it does, the call requires approval even though its tier would have allowed it. This
holds in `plan`, `ask`, `ask-command` and `auto`, so the shipped default is inside it. It
does not hold in `yolo`.

Say you launched in `~/projects/api` and the model runs this:

```console
$ veyyon --approval-mode ask-command "update the config"
```

Writing `~/projects/api/config.yml` runs without a prompt, because it is inside the
working directory and `write` is an approved tier. Writing `~/.ssh/config` prompts, because
it is outside, even though the tier is the same.

The check resolves where a path leads, not how it is spelled. A path written
entirely inside the working directory that reaches outside it through a symlink counts
as outside. A path that cannot be resolved at all also counts as outside.

These tools take part: `read`, `write`, `edit`, `ast_edit`, `search`,
`inspect_image`, and `set_cwd`.

`set_cwd` is on that list because it changes the working directory itself. Without the
check, re-rooting to the parent directory would make every later write count as inside. So
re-rooting outward prompts, the same as writing outward. Re-rooting into a subdirectory does
not prompt, because that narrows what the session can reach rather than widening it.

When no interactive prompt is available, such as a headless or ACP run, a call that
needs approval fails instead of proceeding. The error states the path that crossed the
boundary, so you can see why the run stopped.

## Secrets in arguments

A tier also does not indicate whether a call is about to spend a credential. The
secret-use boundary is a third check, applied in the same modes:

> Do this call's arguments contain a stored secret?

Your secrets reach a tool as real values. The model works with placeholders such as
`#GITHUB_TOKEN#`, and Veyyon substitutes the credential immediately before the tool runs, so the
model can use a secret it never reads. `secrets.auditLog`, on by default, records which
secret each call used, never its value.

A call whose arguments contain a real credential requires approval in `plan`, `ask`,
`ask-command` and `auto`, even when its tier would have allowed it. The prompt states the
secret and never shows its value:

```text
Allow tool: bash
Reason: This call uses stored secret: GITHUB_TOKEN. Approving it runs the call with the
real credential.
```

As with the working-directory boundary, `yolo` skips this check. Every other rung keeps it,
the shipped `auto` included. A call that
mentions a placeholder without expanding it, such as one made while `secrets.enabled` is
false, is not a credential reference and does not prompt.

## Per-tool overrides

When you want one tool to behave differently from its tier, name it under
`tools.approval`. Each entry maps a tool to `allow`, `deny`, or `prompt`, and that choice
wins for that tool whatever the mode is, with one exception: while a plan-mode session is
active, a per-tool `allow` does not let an exec-tier tool run. Plan mode is a cap rather
than a default, so it outranks both the configured mode and the per-tool setting. A `deny`
is a hard block in every direction.

```yaml
# ~/.veyyon/profiles/default/agent/config.yml
tools:
  approvalMode: ask-command
  approval:
    bash: prompt
    read: allow
```

Here the mode is `ask-command`, so writes run without a prompt. The override then pulls `bash`
back to `prompt`, so commands still stop for your approval.

## Critical bash commands

Within the exec tier, a check (`packages/coding-agent/src/tools/shell/bash-guard.ts`) forces a prompt in
`plan`, `ask`, `ask-command` and `auto`, even over a per-tool `allow`. It has two halves.

The first half checks what a command would DELETE, and it resolves the paths after expansion
rather than reading the command as text. A tilde and `$HOME` are resolved, so `rm -rf ~/` and
`rm -rf "$HOME"/` are recognized as the home directory. Every target is checked, not only the first, so
`rm -rf tests/ /` is caught. Recursive deletes of the home directory, of any directory containing
it, of the system directories, and of the directories that hold your credentials all stop for
approval. So does a recursive delete whose target the check cannot resolve, such as
`rm -rf "$dir"/*`: if `$dir` is empty that command starts at the root, and nothing in the command
text states whether it is.

The same half stops a truncating redirect into a directory that holds credentials, because
`echo x > ~/.ssh/id_ed25519` destroys a private key as thoroughly as a delete does. Appending with
`>>` is left alone, since that is how you add a key to `authorized_keys`.

Deletes inside your workspace are not affected. `rm -rf node_modules`, `rm -rf dist`, and
`rm -rf /tmp/build-1234` run without a prompt, and so does a delete inside a protected directory
that does not hold credentials, such as `rm -rf ~/.config/some-app`. Ordinary redirects, such as
`bun test > /tmp/results.txt`, are not affected either.

The second half is a pattern list (`FLAGGED_BASH_PATTERNS`, in the same file) for the shapes that
are about text rather than paths, and each entry is recorded as one of two strengths. **Destructive**
covers fork bombs, disk destruction, and writes to system credential files. **Dangerous** covers a
remote fetch piped to a shell, host control commands such as `reboot`, and a shell wired to a
network socket: they run code nobody read, or take the machine down, without destroying data.

Both halves ship with Veyyon and cannot be narrowed. You can widen the first half with
`tools.protectedPaths`, a list of absolute paths (a leading `~` is expanded) that a recursive
delete must also stop for:

```yaml
tools:
  protectedPaths:
    - /mnt/photos
    - ~/Documents
```

That setting only adds. The built-in rules read no configuration, so no value written there
removes the prompt for your home directory, the system roots, or your credentials. An entry that
is not an absolute or `~`-relative path is ignored.

The first half and the destructive patterns stop for approval in `yolo` too, and the `/yolo` session
bypass does not lift them. Apart from an explicit per-tool `prompt`, that is the only prompt `yolo`
shows. The dangerous patterns are an
ordinary prompt instead: every rung below `yolo` stops on them, and `yolo` does not. To turn the
floor off in `yolo`, set `tools.approval.bash` to `allow`. Setting it to `deny` remains a hard block.

The check parses what a command will do, and a parse can be wrong: a shell function, an `eval`, or
a script invoked by name defeats any parser. It is not containment.

## On deny

When a tool is denied, or a policy check fails, Veyyon returns an error to the model. It
does not retry with more permission. An error never escalates what the model is allowed to
do.

## Related

- [Approvals](../features/sandbox.md)
- [Safety](../using/safety.md)
- [CLI](../reference/cli.md)
