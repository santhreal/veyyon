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
| `plan` | read | write with an active plan-mode session; write and exec are otherwise denied |
| `ask` | read | write, exec |
| `auto-edit` | read + write | exec |
| `yolo` | all tiers | nothing (unless a per-tool override applies) |

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

## Secrets in arguments

A tier does not tell you whether a call is about to spend a credential either. The
secret-use boundary is the third question, asked the same way and in the same modes:

> Do this call's arguments carry a stored secret?

Your secrets reach a tool as real values. The model works with placeholders such as
`#GITHUB_TOKEN#`, and Veyyon substitutes the credential just before the tool runs, so the
model can use a secret it never reads. That substitution used to be recorded and never
asked about: `secrets.auditLog` could tell you afterwards which credential an agent had
spent, and nothing could ask you first.

Now a call whose arguments carry a real credential asks for approval in `plan`, `ask`, and
`auto-edit`, even when its tier would have allowed it. The prompt names the secret and
never shows its value:

```text
Allow tool: bash
Reason: This call uses stored secret: GITHUB_TOKEN. Approving it runs the call with the
real credential.
```

As with the working-directory boundary, `yolo` turns permission off entirely and turns
this off with it, so the shipped default asks nothing extra. A call that mentions a
placeholder without expanding it, such as one made while `secrets.enabled` is false, is
not carrying a credential and does not ask.

## Per-tool overrides

When you want one tool to behave differently from its tier, name it under
`tools.approval`. Each entry maps a tool to `allow`, `deny`, or `prompt`, and that choice
wins for that tool whatever the mode says, with one exception: while a plan-mode session is
active, a per-tool `allow` does not let an exec-tier tool run. Plan mode is a cap rather
than a default, so it outranks both the configured mode and the per-tool setting. A `deny`
is a hard block in every direction.

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

## Critical bash commands

Within the exec tier, a guard (`packages/coding-agent/src/tools/bash-guard.ts`) forces a prompt in
`plan`, `ask`, and `auto-edit`, even over a per-tool `allow`. It has two halves.

The first half judges what a command would DELETE, and it judges the paths after expansion rather
than the command as text. A tilde and `$HOME` are resolved, so `rm -rf ~/` and `rm -rf "$HOME"/`
are recognized as the home directory. Every target is judged, not just the first, so
`rm -rf tests/ /` is caught. Recursive deletes of the home directory, of any directory containing
it, of the system directories, and of the directories that hold your credentials all stop for
approval. So does a recursive delete whose target the guard cannot resolve, such as
`rm -rf "$dir"/*`: if `$dir` is empty that command starts at the root, and nothing in the command
text says whether it is.

The same half stops a truncating redirect into a directory that holds credentials, because
`echo x > ~/.ssh/id_ed25519` destroys a private key as thoroughly as a delete does. Appending with
`>>` is left alone, since that is how you add a key to `authorized_keys`.

Deletes inside your workspace are not affected. `rm -rf node_modules`, `rm -rf dist`, and
`rm -rf /tmp/build-1234` run without a prompt, and so does a delete inside a protected directory
that does not hold credentials, such as `rm -rf ~/.config/some-app`. Ordinary redirects, such as
`bun test > /tmp/results.txt`, are not affected either.

The second half is a pattern list (`CRITICAL_BASH_PATTERNS`, in the same file) for the shapes that
are about text rather than paths: fork bombs, disk destruction, writes to system credential files,
remote-fetch piped to a shell, and host control commands.

Both halves ship with Veyyon and cannot be narrowed. You can widen the first half with
`tools.protectedPaths`, a list of absolute paths (a leading `~` is expanded) that a recursive
delete must also stop for:

```yaml
tools:
  protectedPaths:
    - /mnt/photos
    - ~/Documents
```

That setting only adds. Nothing in the built-in judgement reads configuration, so no value you
write there can stop the guard refusing your home directory, the system roots, or your credentials.
An entry that is not an absolute or `~`-relative path is ignored, because resolving it against a
guessed working directory would protect somewhere other than what you wrote.

These commands stop for approval in `yolo` too, and the `/yolo` session bypass does not lift them.
That is the one place `yolo` is not absolute, and it is deliberate: without it, the commands the
guard considers most dangerous would be the ones most likely to run in the mode that skips the
check. To turn the floor off, set `tools.approval.bash` to `allow`, which is read as a decision you
made on purpose. Setting it to `deny` remains a hard block.

The guard reasons about what a command will do, and that reasoning can be wrong: a shell function,
an `eval`, or a script invoked by name defeats any parser. Treat it as a seatbelt, not as
containment.

## On deny

When a tool is denied, or a policy check fails, Veyyon returns an error to the model. It
does not retry with more permission. An error never escalates what the model is allowed to
do.

## Related

- [Approvals](../features/sandbox.md)
- [Safety](../using/safety.md)
- [CLI](../reference/cli.md)
