# Code review

> **Spec — not shipped:** a standalone `veyyon review` subcommand and the `approvals_reviewer` /
> `auto_review` / `review_model` config keys. What ships today is the interactive **`/review`** slash
> command and the passive **advisor** runtime (`--advisor`, which reviews each turn and injects notes).
> For non-interactive or CI review, drive `/review` through `veyyon --print` with a review prompt. The
> `/review` and advisor sections below are real; the `veyyon review` CLI and auto-review config are the
> target shape.

Veyyon can review code changes as a first-class task, separate from an ordinary chat
turn. A review reads a set of changes, reasons about them against review instructions,
and reports the issues it finds.

## Non-interactive review (spec: `veyyon review`)

The `veyyon review` subcommand below is the target CLI shape. It selects the
changes to review with mutually exclusive flags:

| Flag | Changes reviewed |
| --- | --- |
| `--uncommitted` | Staged, unstaged, and untracked changes in the working tree. |
| `--base <BRANCH>` | The diff of the current branch against `<BRANCH>`. |
| `--commit <SHA>` | The changes introduced by one commit. |
| `--title <TITLE>` | Optional commit title to show in the summary (only with `--commit`). |

You can also pass a positional prompt with custom review instructions; pass `-` to read
the instructions from stdin. The change-selection flags and a custom prompt are mutually
exclusive, so a run either targets a change set or follows a free-form instruction.

```console
$ veyyon review --uncommitted
$ veyyon review --base main
$ veyyon review --commit 1a2b3c4 --title "Cache the parsed config"
$ echo "focus on error handling and missing tests" | veyyon review -
```

Like [`veyyon --print`](./exec.md), review runs are scriptable and exit non-zero on failure, so
you can gate CI on them. Prefer `--sandbox workspace-write` when you need bounded
automation; `--full-auto` on exec is deprecated.

### Worked walkthrough: review uncommitted work

Suppose you are mid-change on a config parser and want a second pass before you commit.

1. Confirm the working tree has the changes you care about:

```console
$ git status -sb
## feature/config-cache
 M crates/core/src/config/mod.rs
?? crates/core/tests/suite/config_cache.rs
```

2. Run a review against that working tree:

```console
$ veyyon review --uncommitted
```

3. Veyyon loads the staged, unstaged, and untracked diffs, runs the review model, and
prints a human-readable summary. A typical successful run looks like this:

```text
Overall: the cache path is sound, but the new helper fails closed incorrectly when the
override file is missing, and the unit test never exercises a malformed TOML value.

Full review comments:

- Missing file should not fail the whole load: crates/core/src/config/mod.rs:214-228
  When `model_catalog_json` points at a path that does not exist, the loader returns a
  hard error. Prefer a clear config diagnostic that names the path and continues with the
  bundled catalog, matching the other override keys.

- Add a malformed-TOML regression: crates/core/tests/suite/config_cache.rs:1-40
  The new test covers the happy path only. Add a case with a trailing comma (or similar
  invalid value) and assert the surfaced error names the file and key.
```

What to notice:

- The summary leads with an overall explanation, then a findings block.
- Each finding has a short title and a `path:start-end` location, then a body explaining
  the risk and the smallest fix.
- Empty findings still produce a fallback message rather than silent success with no
  output; treat a clean review as an explicit "nothing to report" result when you automate.

4. Fix the named issues, then re-run the same command until the review is clean enough to
commit. For CI, capture the process exit status rather than scraping prose:

```console
$ veyyon review --uncommitted
$ echo $?
0
```

### Worked walkthrough: review a branch against `main`

Use `--base` when the interesting surface is "everything this branch introduces," not
just the dirty working tree.

1. Make sure you are on the feature branch and that `main` (or your integration branch)
is reachable:

```console
$ git switch feature/config-cache
$ git fetch origin main
```

2. Review the branch delta:

```console
$ veyyon review --base main
```

3. Sample output for a branch that still needs tightening:

```text
Overall: the branch improves cold-start latency, but the cache key ignores the active
profile, so two profiles can silently share stale catalog data.

Full review comments:

- Include profile in the cache key: crates/core/src/config/mod.rs:88-101
  `load_catalog_cached` hashes cwd and catalog path only. Two profiles with different
  `model_catalog_json` overrides can collide. Fold the active profile name (or the
  resolved override path) into the key.

- Document the invalidation rule: docs/handbook/src/using/models.md:40-52
  Operators need to know that changing the active profile busts the cache. Add one
  sentence next to the catalog override docs.
```

Compared with `--uncommitted`:

| Goal | Flag |
| --- | --- |
| Review what you are about to commit or amend | `--uncommitted` |
| Review the whole PR / branch delta | `--base <BRANCH>` |
| Review a single landed or local commit | `--commit <SHA>` |

For pull-request bots, `--base origin/main` (or your repo's default branch) is usually
the right choice. Keep the working tree clean or stash local noise first if you want the
review to match the pushed commits exactly; otherwise dirty files are not included unless
you also use `--uncommitted`.

### Custom instructions

When the default review rubric is too broad, pass a prompt instead of a change-selection
flag:

```console
$ veyyon review "focus on authz boundaries and secret handling in the diff against main"
$ echo "ignore style nits; report only correctness and missing tests" | veyyon review -
```

The prompt form is mutually exclusive with `--uncommitted`, `--base`, and `--commit`. If
you need both a change set and custom instructions, prefer `/review …` in the cockpit, or
phrase the prompt so it names the change set explicitly.

## Interactive review (`/review`)

Inside the cockpit, `/review` reviews your current changes and surfaces the issues it
finds without leaving the session. You can pass inline instructions to focus the review,
for example `/review look at the auth changes for missing input validation`. The findings
are reported in the conversation so you can act on them immediately.

`/review` is the right tool when you are already mid-session and want findings in context.
`veyyon review` is the right tool for scripts, git hooks, and CI.

## Auto-review guardian (Spec — not shipped)

> **Spec — not shipped:** everything in this section is the target shape, not shipped
> behavior. There is no `approvals_reviewer` / `auto_review` / `review_model` config key, no
> continuous auto-review approval path, and no `/auto-review` or `/approve` command in the
> shipped registry today. Approvals are governed by `tools.approvalMode`
> (`always-ask` / `write` / `yolo`) and per-tool policy overrides; see
> [Safety](../using/safety.md).

The target design would turn review into a continuous guardian. Instead of you approving
each sensitive action, an auto-reviewer would inspect the agent's proposed actions against
a policy and approve or deny them, selected by setting the approvals reviewer to
`auto_review`.

| `approvals_reviewer` (target) | Who reviews approvals |
| --- | --- |
| `user` | You approve prompts interactively (default; shipped today via `tools.approvalMode`). |
| `auto_review` | The guardian would review proposed actions automatically (not shipped). |

Target config shape (not read by Veyyon today):

```yaml
# TARGET SHAPE — not implemented. Route approval decisions to the guardian
# instead of prompting the user.
approvals_reviewer: auto_review

# Extra policy instructions inserted into the guardian's prompt.
auto_review:
  policy: "Deny any command that deletes files outside the workspace."
```

The model used for auto-review would be configurable through `review_model`, defaulting to
a dedicated review model rather than the main session model so the guardian's judgment is
independent of the agent it is reviewing.

When the guardian denies an action, the design calls for a retry path rather than silently
dropping it: a `/auto-review` command (also `/approve`) would let the action proceed once
without changing the standing policy. None of this exists in the shipped command
registry.

See also: [Safety](../using/safety.md) for how review fits the shipped approval model
(`tools.approvalMode`), [Connectors and Apps](./connectors.md) for tool approval tiers, and
[Slash commands](../reference/slash-commands.md) for the full command list.
