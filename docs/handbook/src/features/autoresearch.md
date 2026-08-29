# Autoresearch

Autoresearch runs an optimization loop. You give it a benchmark and a metric; it
changes code, measures, keeps what improves the metric, and reverts what does
not. It stops when you interrupt it or the iteration cap is reached.

Start it with `/autoresearch`, optionally with a goal:

```
/autoresearch make the tokenizer faster
```

## The harness

Autoresearch measures through one file, `autoresearch.sh`, in the repository
root. Write it before the loop starts. It must exit 0 and print at least one
metric line:

```sh
#!/usr/bin/env bash
python3 bench.py            # prints: METRIC ms=192.78
```

Two line formats are read back from its output:

| Line | Meaning |
|---|---|
| `METRIC name=value` | A number the loop compares between runs. |
| `ASI key=value` | Free-form metadata attached to the run. |

The primary metric decides whether a change is kept. Secondary metrics are
recorded and shown but do not decide anything.

Autoresearch commits `autoresearch.sh` on a dedicated `autoresearch/*` branch
before the first iteration, and that commit is the baseline every later run is
measured against. Editing the harness mid-session invalidates the comparison, so
change it only alongside a new segment.

## Segments

A segment is one baseline and the runs measured against it. Bumping the segment
starts a fresh baseline inside the same session, which is what you want after
changing the harness or the target. The agent bumps it by passing
`new_segment: true`.

## Scope

`scope_paths` lists what the loop expects to modify; `off_limits` lists what it
must not. Neither blocks an edit. Both are recorded: a run that touches an
off-limits path is logged with a scope deviation, and keeping it without a
justification is reported in the next iteration.

The harness itself belongs in `off_limits`. A loop that is allowed to edit its
own benchmark can improve the number without improving the code.

## Going wider

`/autoresearch` tries one change per iteration. [Autoswarm](./autoswarm.md) is
the same loop with several candidate arms per iteration, cross-reviewed before
one is kept. Everything on this page — the harness, segments, scope, the
correctness warning below — applies to both.

## Correctness is the harness's job

Autoresearch compares numbers. It does not know whether the code still works,
and nothing in the loop discovers that a faster implementation is wrong.

Make `autoresearch.sh` exit non-zero when the result is wrong, and cover the
inputs the optimization could break. An ASCII-only gate on a string algorithm
accepts an arm that is wrong on every non-ASCII input, because it never tries
one. Include the boundaries the change is likely to move: empty input, the block
sizes of any algorithm you expect to be reached for, non-ASCII text, and the
degenerate cases.

## Tools

These attach in autoresearch and autoswarm, and nowhere else.

| Tool | Purpose |
|---|---|
| `init_experiment` | Open or reconfigure the session; set metric, direction, scope, breadth. |
| `run_experiment` | Run the harness and parse its metric lines. Takes `arm` in autoswarm. |
| `log_experiment` | Record a run as `keep`, `discard`, `crash`, or `checks_failed`. |
| `certify_arms` | Triage one iteration's arms and assign cross-review. Attaches in autoswarm only. |
| `update_notes` | Edit the durable session playbook, which is injected each iteration. |

## Ending a session

`/autoresearch off` leaves the mode and keeps the session. `/autoresearch clear`
resets the worktree to the baseline and closes the session; `--keep-tree` leaves
your files alone. `/autoswarm` takes the same two.

State is stored per repository, under the profile directory. The database is
keyed on the primary checkout, so worktrees of one repository share it.
`VEYYON_AUTORESEARCH_DB_DIR` overrides the location.
