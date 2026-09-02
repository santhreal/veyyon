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

Checking out another branch pauses the session. The experiment tools detach and
no autoresearch block is added to the turn, but the recorded runs stay readable:
the status row reads `paused · session on <branch>` and `ctrl+x` still opens the
run screen. Checking the branch out again lifts the pause on the next turn and
reattaches the experiment tools.

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

## Reading a run

A live loop occupies one status row:

```
autoswarm · run #5 · 1m 12s · 4 runs · 3 kept · 3 arms · best 168.40ms -12.6% · conf 3.2x · ctrl+x runs
```

`ctrl+x` opens the run screen, and so does `/autoresearch` with nothing after
it:

```
┌─ Autoswarm · tokenizer-laten…┬───────────────────────────────────────────────────┐
│   OVERVIEW ───────────────── │ Best        168.40ms · -12.6% · from 192.78ms ·   │
│ › Session                    │             run 4 · arm b                         │
│   Playbook                   │ Trend       ▅▄█▁                                  │
│   #5  running                │ Metric      duration · lower is better            │
│   SEGMENT 1 ──────────────── │                                                   │
│   #4 b  168.40ms -12.6% best │ Goal        make the tokenizer faster             │
│   #3 c  210.10ms  +9.0% drop │                                                   │
│   #2 b  188.40ms  -2.3% drop │ Segment     1 · 4 runs, 1 kept, 3 discarded       │
│   #1    192.78ms       base  │                                                   │
│                              │ Breadth     3 arms per iteration                  │
├──────────────────────────────┴───────────────────────────────────────────────────┤
│ up/down select   pgup/pgdn page   esc close                                      │
└──────────────────────────────────────────────────────────────────────────────────┘
```

The list holds the session, the playbook, the run in flight and every logged
run, newest first, grouped by segment. Each row states its own verdict: the run
number, the arm that produced it, its metric, its change against the baseline of
its own segment, and whether it is the baseline, the leader, kept, dropped,
crashed, failed or flagged.

The pane beside it shows the highlighted entry in full. The session opens with
the best measurement of the segment, its change against the measurement the
segment started from, and the count of runs logged since that best one. Below
those is one block per run of the segment, oldest on the left, scaled between
the segment's lowest and highest measurements: a series still descending and a
series that improved once and then flattened produce the same best and the same
count, and the blocks separate them. A segment past the width of the pane draws
its most recent runs, marked with a leading `…`. A run shows its metric and
percentage change against the segment baseline, secondary metrics, confidence,
the arm that produced it and the arm that certified it, the flag reason, scope
deviations, the change description, the commit and the files it touched.

`log_experiment` requires a metric on every status, so a run that crashed before
it measured anything is recorded with a zero. The screen states `no metric` for
that run rather than formatting the zero, and draws it as a `·` in the blocks
rather than as a height. A run whose harness printed its metric and then died
shows that number, and the comparison is against it.

Up and down move through the list, page up and page down move the detail pane by
a full pane, and typing filters the list. Escape clears a live filter, and closes
the screen when there is none. It is readable before the first run, where it
shows the goal, the scope and the metric the session was configured with.

On a terminal too narrow for two panes, the list is above the detail instead of
beside it, both at the full width of the card, and the footer prints the widest
hint that fits, down to `esc close`. The status row drops its segments from the
least informative end when the terminal is narrower than the row, and prints the
loop name and `ctrl+x runs` at every width. Where the best is not the newest
logged run, the row carries the gap as `2 since best`, which it gives up before
the best itself.

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

`/autoresearch off` leaves the mode and keeps the session. A bare
`/autoresearch` opens the run screen; it does not end anything.

`/autoresearch clear` resets the worktree to the segment baseline, deletes
untracked files and closes the session. It asks first, naming the commit it
resets to and how many files hold uncommitted changes. Two flags:

| Flag | Effect |
|---|---|
| `--keep-tree` | Close the session and leave every file alone. Nothing to confirm. |
| `--reset-tree` | Reset even when the branch is not an `autoresearch/*` one. |

Any other argument after `clear` is rejected and nothing is reset, so a
misspelled `--keep-tree` cannot fall through to the reset. A `clear` that cannot
read git status resets nothing and leaves the session open, since the
confirmation exists to state what the reset discards.

`/autoswarm` takes the same subcommands.

State is stored per repository, under the profile directory. The database is
keyed on the primary checkout, so worktrees of one repository share it.
`VEYYON_AUTORESEARCH_DB_DIR` overrides the location.

## Regenerating the run screen captures

`proof/scenes/autoresearch-run-screen.sh` drives the swarm run screen and
`proof/scenes/autoresearch-serial-screen.sh` the serial one. Both are stills
takes, so both lower the motion floor; at the default the recorder rejects a
take that holds still as a stuttering capture.

The run screen changes layout twice as a terminal narrows -- the sidebar is
bounded, then the panes stack -- so it is captured at three widths. `OUT_DIR` is
a bind mount and must be absolute, and each width takes its own directory,
because one directory cannot hold two takes whose frames share a mark name.

```sh
for px in 1600 640 396; do
	SCENE_WIDTH=${px} SCENE_MOTION_FLOOR=1 OUT_DIR="${PWD}/proof/captures/x11/w${px}" \
		proof/docker/record-x11.sh proof/scenes/autoresearch-run-screen.sh
	SCENE_WIDTH=${px} SCENE_MOTION_FLOOR=1 OUT_DIR="${PWD}/proof/captures/x11/before/w${px}" \
		proof/docker/record-x11-before.sh proof/scenes/autoresearch-run-screen.sh
done

SCENE_MOTION_FLOOR=1 proof/docker/record-x11.sh proof/scenes/autoresearch-serial-screen.sh
SCENE_MOTION_FLOOR=1 proof/docker/record-x11-before.sh proof/scenes/autoresearch-serial-screen.sh
```

The before arm holds every source file the branch changed at `origin/main`,
takes away every file it added and puts back every file it deleted, then
restores all three from memory and verifies the restore by checksum.
