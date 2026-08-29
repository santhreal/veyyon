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

## Breadth

By default an iteration tries one change. Breadth raises that: with breadth 4,
four candidate arms are built and measured, reviewed against each other, and at
most one is kept.

```
/autoresearch breadth 4
```

The value is 1 to 8. Set it before starting and it applies when the session
opens; set it during a session and it applies from the next iteration.
`/autoresearch breadth` with no number reports the current value.

Arms share one worktree. They are built one at a time, measured, and reverted,
so breadth costs iteration time rather than disk. An arm is a different idea:
two arms that produce the same diff are counted once.

### Certification

Breadth exists to make gaming the metric harder to get away with, not only to
search wider. Before any arm is kept, every arm is triaged and the survivors
review each other.

Four rejections happen mechanically, before a reviewer sees anything:

| Rejection | What it catches |
|---|---|
| `empty` | An arm that changed nothing. |
| `scope` | An arm that edited an off-limits path. |
| `opaque` | A diff that cannot be read: a git binary patch, or a run of 512 or more base64 characters. |
| `duplicate` | An arm whose diff another arm already produced. |

`opaque` closes a specific hole. A compiled artifact encoded as a base64 string
and decoded at import time reads as an enormous speedup, passes an ASCII-only
correctness gate, and cannot be reviewed by reading it. A diff nobody can read
is rejected rather than measured.

What remains is assigned a reviewer:

| Survivors | Reviewer |
|---|---|
| 0 | none |
| 1 or 2 | the director reviews each arm |
| 3 or more | a ring, where each arm reviews the next and no pair reviews each other |

A ring needs three arms. Two arms reviewing each other is a reciprocal pair,
which is the arrangement a ring exists to avoid. When breadth is 3 or more but
fewer arms survive, review falls back to the director and the fallback is
reported rather than applied silently.

A reviewer flags an arm when the metric moved for a reason other than the work
getting faster: a hardcoded answer, a cache keyed on the benchmark's own inputs,
a narrowed input space, a weakened check, or work relocated out of the timed
region. A flagged arm cannot win, however good its number is. When every
improvement is flagged the iteration is a null round, which is a result and is
logged as one.

### Relocated cost

A change that moves work out of the timed region lowers the metric without
making anything faster. Compiling at import time instead of at call time is the
common shape.

Have the harness report what a fresh checkout pays, as a second metric:

```sh
python3 bench.py            # prints: METRIC ms=0.10
python3 cold_start.py       # prints: METRIC cold_ms=512.25
```

Growth above 25ms against the baseline's own cold metric is stated to the
reviewer as a measured fact. Without a `cold_ms` line nothing is checked, and a
0.10ms result that hides half a second of compilation is indistinguishable from
a real one.

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

These attach only in autoresearch mode.

| Tool | Purpose |
|---|---|
| `init_experiment` | Open or reconfigure the session; set metric, direction, scope, breadth. |
| `run_experiment` | Run the harness and parse its metric lines. Takes `arm` when breadth is above 1. |
| `log_experiment` | Record a run as `keep`, `discard`, `crash`, or `checks_failed`. |
| `certify_arms` | Triage one iteration's arms and assign cross-review. Attaches when breadth is above 1. |
| `update_notes` | Edit the durable session playbook, which is injected each iteration. |

## Ending a session

`/autoresearch off` leaves the mode and keeps the session. `/autoresearch clear`
resets the worktree to the baseline and closes the session; `--keep-tree` leaves
your files alone.

State is stored per repository, under the profile directory. The database is
keyed on the primary checkout, so worktrees of one repository share it.
`VEYYON_AUTORESEARCH_DB_DIR` overrides the location.
