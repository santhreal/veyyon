# Autoswarm

Autoswarm is [autoresearch](./autoresearch.md) with breadth. An iteration builds
several candidate arms instead of one change, rejects the ones that cannot be
trusted, has the survivors review each other, and keeps at most one.

`/autoswarm` opens a setup console:

```
/autoswarm
```

```
Autoswarm setup
Each iteration builds one change per arm and keeps the best. The model derives the metric from your harness.
No autoresearch.sh yet: the first turn writes and validates one before anything is measured.

› Goal          make the tokenizer faster▌
  Breadth       3    candidate arms per iteration
  Models        one per arm, comma separated
  Attempts      1    retries before an arm is abandoned
  Certification on   arms cross-review before one is kept

3 arms × 1 attempts: up to 3 harness runs per iteration.
Each arm is reviewed by another, and no pair reviews each other.
Every arm runs on the session model.

type to edit   ↑↓ field   enter start   esc cancel
```

Up and down move between fields, left and right change the focused value, space
toggles certification, Enter starts the run and Escape leaves without starting
one. The legend lists only the keys that act on the focused field: the arrow
range on Breadth and Attempts, `type to edit` on Goal and Models.

The line under the title states what Enter does on this branch. With no
session it reads `autoresearch.sh found: enter starts measuring with it.` or
`No autoresearch.sh yet: the first turn writes and validates one before anything is measured.`
Over a live session it reads
`Resumes session <name> on <branch> (<n> runs) with the values below.` and the
legend reads `enter resume` instead of `enter start`.

The first line under the fields is the harness runs one iteration costs, breadth
multiplied by attempts. It is a ceiling: an arm that succeeds on its first
attempt uses one. The second line is the review topology for that breadth. The
third states which model each arm runs on. All three change with the fields
above them.

Enter does nothing while the goal is empty, and the legend reads `enter needs a
goal` until one is typed. With no session on the branch, text typed after the
command prefills the goal, so `/autoswarm make the tokenizer faster` opens the
console with that goal already in the field. Over a session that already has a
goal the field opens on that goal, and the typed text reaches the model as
context for the resume; the stored goal changes only through `/autoswarm goal
<text>` or a field that leaves the console different from it.

Escape leaves without starting a run and prints `Autoswarm setup cancelled.
Nothing was started.` The console is not a turn: no `Working…` loader runs under
it while it is open.

`/autoswarm resume` continues an interrupted or paused session without opening
the console: no goal, no context, the stored values. With no session on the
branch it prints `No autoswarm session on this branch to resume. /autoswarm
starts one.` and starts nothing.

The console opens on whatever the current branch is already doing, so running it
during a session shows that session's breadth rather than the default, and
starting applies the new values from the next iteration.

A bare `/autoswarm` reopens the console rather than the run screen, because the
console is where a live swarm is reconfigured. `ctrl+x` opens the run screen from
either loop.

Everything autoresearch provides is unchanged underneath: the same
`autoresearch.sh` harness, the same metric lines, the same segments, the same
scope rules, the same database. Read that page first; this one covers only what
breadth adds.

`/autoresearch` is still there and still serial. Autoswarm does not replace it.

## Breadth

Breadth is 1 to 8 and opens at 3, the fewest arms a review ring needs. The
status row states `N arms` whenever breadth is above 1, and the run screen
states it per session.

Arms share one worktree. They are built one at a time, measured, and reverted,
so breadth costs iteration time rather than disk. An arm is a different idea:
two arms that produce the same diff are counted once.

Breadth 1 is the serial loop exactly. No arms, no review, no certification cost.

## Models per arm

The Models row assigns one model to each arm, in arm order, comma separated:

```
  Models        opus, gpt-5, glm
```

`a0` runs on Opus, `a1` on GPT-5, `a2` on GLM. The line under the fields reads
the assignment back as arms, so an arm that is off by one comma is visible
before the run starts:

```
a0 opus · a1 gpt-5 · a2 glm.
```

An entry left empty runs that arm on the session model, so `, gpt-5` puts `a1`
on GPT-5 and leaves `a0` where the session already is. An arm past the end of
the list runs on the session model too, and clearing the row puts every arm
there.

Each spec resolves the way `--model` resolves one: `provider/id`, a bare id, or
a role alias such as `@slow`. A spec that matches nothing refuses the run, and
the legend reads `enter needs a known model` until it is fixed. The row is
absent at breadth 1, where there are no arms to spread across models.

`start_arm` performs the switch. The loop calls it before the first edit of each
arm, which is also what puts the arm on the status row (`a1 on GPT-5`) while it
is being built. The session returns to its own model when the arm's result is
logged, so triage, certification and the choice of the next hypothesis run on
the model you selected rather than on whichever arm ran last. Turning the mode
off or clearing the session mid-arm restores it too.

A round configured this way compares models as much as ideas: each arm is a
different model writing a different change, measured by the same harness and
reviewed by the ring. Certification still applies, and no arm reviews itself.

Each run records the model in force when `run_experiment` measured it, and the
run screen shows it under the arm as `Built on`. The arm is the attribution the
loop declares; the model is what the session was on while the arm was built.
Read one against the other to tell a model comparison from a round that stayed
on one model. `run_experiment` states it in the result when an arm is measured
with no arm in flight, or while a different arm is: both mean the diff was
written by a model other than the one configured for that arm.

## Why arms are reviewed

Breadth searches wider, but that is the smaller half. A loop scored on a number
will find ways to move the number that have nothing to do with the work getting
faster, and a single agent measuring its own change has no one to catch it.

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

Certification can be turned off for a session, which leaves the director as the
only reviewer. It stays on by default.

## Relocated cost

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

## What certification does not do

It does not check that the code is still correct. That is the harness's job, and
a reviewer reads a diff rather than running the tests you did not write. The
correctness section of the [autoresearch page](./autoresearch.md) applies with
more force here, because breadth produces more candidates and the wrong ones are
the fast ones.

It also does not make a reviewer right. An arm is flagged by an agent reading a
diff against a hypothesis. The mechanical rejections above hold whatever the
reviewer concludes; the judgement on top of them does not.

## Session state

Breadth, attempts, certification and the per-arm models belong to the session
rather than the installation, so the setup console sets them per investigation
and `/settings` does not carry them. A run records which arm produced it and
which arm certified it, both stated on the run screen's entry for that run.

A winning arm has to beat the segment's baseline, not merely the other arms of
its iteration. An iteration where every arm regressed is a null round.

`certify_arms` and `start_arm` attach only while breadth is above 1. A serial
session has one candidate, no ring and no arm to open, so there is nothing for
either to do.

## Regenerating the setup console captures

`proof/scenes/autoswarm-setup.sh` opens the console, moves through the fields,
assigns a model per arm and types one nothing matches, toggles certification off
and back on, empties the goal and leaves with Escape.
It is a stills take that measures under 1 fps of real change, so both arms turn
the motion gate off; at the default the recorder rejects the take as a stutter:

```sh
SCENE_MOTION_FLOOR=0 proof/docker/record-x11.sh proof/scenes/autoswarm-setup.sh
SCENE_MOTION_FLOOR=0 proof/docker/record-x11-before.sh proof/scenes/autoswarm-setup.sh
```

The frame that carries the console's layout contract is `certification-off`.
`off` is three columns where every other value is one or two, so a value column
measured from the values a field currently holds is a column narrower in every
other state, and the hint beside it moves as the toggle crosses. The column is
sized from the bounds each field can reach instead, so the hints stand still.
A frame of any other state shows the column's position but not that it holds.

`proof/scenes/autoswarm-run-resume-keeps-goal.sh` opens the console over the
seeded session with resume text after the command, and leaves with Escape. The
`open` frame shows the session's goal in the field rather than the typed text;
`cancelled` shows the notice under the command:

```sh
SCENE_MOTION_FLOOR=0 proof/record.sh proof/scenes/autoswarm-run-resume-keeps-goal.sh
SCENE_MOTION_FLOOR=0 proof/record.sh --before proof/scenes/autoswarm-run-resume-keeps-goal.sh
```
