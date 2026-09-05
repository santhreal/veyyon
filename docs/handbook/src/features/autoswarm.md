# Autoswarm

Autoswarm is [autoresearch](./autoresearch.md) with breadth. An iteration builds
several candidate arms instead of one change, rejects the ones that cannot be
trusted, has the survivors review each other, and keeps at most one.

`/autoswarm` opens the console. It takes no arguments: the goal, the breadth
and everything else are fields on the surface it opens.

```
/autoswarm
```

## The console

`/autoswarm` opens one of two surfaces, chosen by whether the current branch
has a session.

### The launcher

With no session on the branch, `/autoswarm` opens a centered card over the
transcript: the setup form, a Start button and a Save-as row.

```
┌─ Autoswarm ──────────────────────────────────────────────────────────┐
│ ▸ Goal         what to optimize                                      │
│   Preset      swarm  wide                                            │
│   Breadth     ◂ 3 arms ▸                                             │
│   Models      session model for every arm                            │
│   Attempts    1 ▸                                                    │
│   Certify     ● on                                                   │
│   Iterations  auto ▸                                                 │
│   3 arms × 1 attempt: up to 3 harness runs per iteration. Each arm   │
│   is reviewed by another, and no pair reviews each other.            │
│   Every arm runs on the session model.                               │
│   No autoresearch.sh yet: the first turn writes and validates one    │
│   before anything is measured.                                       │
│   [ Start swarm ]  needs a goal                                      │
│   Save as     preset name                                            │
├──────────────────────────────────────────────────────────────────────┤
│ type the goal · enter starts the swarm   ↑↓ field   esc close        │
└──────────────────────────────────────────────────────────────────────┘
```

The shortest path is three keys long: open, type the goal, Enter. The card
opens with the caret on the Goal row, and Enter on that row starts the swarm
once it holds text. Enter on the `Start swarm` button does the same. The
button states why it cannot start while it cannot: `needs a goal` or
`no model matches "<spec>"`.

| Field | Keys |
|---|---|
| Goal | Type to edit; a click places the caret; `ctrl+u` clears the row. Enter starts the swarm. |
| Preset | `←` `→` or space pick the next preset; a click picks the one under the pointer. The preset the fields equal is painted as in force; `delete` removes it when it is a saved one. |
| Breadth | `←` `→`, or a digit, between 2 and 8; a click on `◂` or `▸` steps. |
| Models | Type one spec per arm, comma separated; `ctrl+u` clears the row. |
| Attempts | `←` `→`, or a digit, between 1 and 5: retries before an arm is abandoned. |
| Certify | `←`, `→`, space, Enter or a click toggles cross-review. |
| Iterations | `←` `→` or typed digits, appending as typed; backspace drops the last digit; `0` is `auto`, which leaves the cap to the model. |
| Save as | Type a name; Enter saves the current shape as a preset. |

`↑` `↓`, `tab` and `shift+tab` move between fields, the wheel walks them, and
a click puts the ring on the field under the pointer. Escape closes the card.
Closing starts nothing; a field edited on the card is parked for the start, so
the next `/autoswarm` opens with it.

The notes under the fields state what one iteration costs and how the arms are
reviewed: `3 arms × 1 attempt: up to 3 harness runs per iteration.` is a
ceiling, since an arm that succeeds on its first attempt uses one, and
`Each arm is reviewed by another, and no pair reviews each other.` is the review
topology for that breadth. Both change with the fields above them. A third
note states whether `autoresearch.sh` was found: the first turn measures with
it, or writes and validates one before anything is measured.

### The dashboard

Over a session, `/autoswarm` opens the run dashboard: the ledger on the left,
the highlighted row in full on the right, and the actions the swarm's state
allows on single keys along the footer.

```
┌─ Autoswarm · tokenizer-thro… ┬───────────────────────────────────────────────────┐
│   OVERVIEW ───────────────── │ Best        41ms · -18.0% · from 50ms · run 3 ·   │
│ › Session                    │             arm a2                                │
│   Playbook                   │ Trend       █▆▁                                   │
│   SEGMENT 1 ──────────────── │ Metric      duration · lower is better            │
│   #3 a2 41ms best            │                                                   │
│   #2 a1 47ms kept            │ Goal        make the tokenizer faster             │
│   #1 a0 50ms base            │ Session     tokenizer-throughput                  │
│                              │                                                   │
│                              │ Segment     1 · 3 runs, 3 kept                    │
│                              │ ↓ 6 more                                          │
├──────────────────────────────┴───────────────────────────────────────────────────┤
│ s resume   e setup   enter detail   n new session   x stop   esc close           │
└──────────────────────────────────────────────────────────────────────────────────┘
```

The footer sheds hints from its end when the card is narrow, `esc close`
last, so the primary action, `e setup` and `enter detail` outlive the rest.

| Key | Action |
|---|---|
| `s` | Start, or Resume over a session. |
| `p` | Pause, offered while a turn is streaming. |
| `n` | New session: closes the session on the branch, keeps every file and every logged run, prints `Closed <name> · N runs kept in the store. Starting a new session.`, and starts a fresh one with the setup as it stands. Blocked by the same conditions as Start. |
| `x` | Stop, while the mode is on. |
| `c` | Clear session. |
| `r` | Reset worktree, when the session has a baseline commit. |
| `e` | The setup form, over the same fields as the launcher, with the primary action as its button. |
| Enter | The highlighted row at the full width of the card. |

An action runs after the dashboard closes, so a confirmation or a turn never
opens under it. An action the situation blocks is refused on the footer with
its reason. `↑` `↓` move through the ledger, `pgup` `pgdn` page the detail,
the wheel scrolls the pane under the pointer and a click selects the row under
it. Escape closes the dashboard, or returns to the ledger from the setup form
and the detail view. Closing starts nothing and stops nothing; the swarm is
exactly as it was.

A field edited on the setup form is written to the session as it is typed.
Breadth changed on a live session applies from the next iteration. Enter on
the Goal row resumes the swarm.

The dashboard opens on whatever the current branch is already doing, so opening
it during a session shows that session's setup rather than the default. A
session started with `/autoresearch <goal>` is a serial loop and is driven by
that command's subcommands; opening the dashboard over it shows it at breadth
2, and resuming from there widens it from its next iteration.

A terminal too narrow for two panes stacks the ledger over the detail at the
full width of the card.

### Presets

A preset is the shape of a swarm without its goal: breadth, attempts,
certification, per-arm models and the iteration cap. Two are built in:

| Preset | Breadth | Attempts | Certify |
|---|---|---|---|
| `swarm` | 3 | 1 | on |
| `wide` | 5 | 2 | on |

`←` `→` on the Preset row applies the next one, and a click applies the one
under the pointer. The preset the fields currently equal is painted as in
force. `Save as` takes a name and Enter saves the current shape under it; a
saved preset is offered in every repository. A built-in name cannot be saved
over. Saved presets are kept in `presets.json` beside the autoresearch
databases. A saved breadth outside 2 to 8 loads at the nearer bound.

Everything autoresearch provides is unchanged underneath: the same
`autoresearch.sh` harness, the same metric lines, the same segments, the same
scope rules, the same database. Read that page first; this one covers only what
breadth adds.

## Breadth

Breadth is 2 to 8 and opens at 3, the fewest arms a review ring needs. The
status row states `N arms`, and the run screen states it per session.

Arms share one worktree. They are built one at a time, measured, and reverted,
so breadth costs iteration time rather than disk. An arm is a different idea:
two arms that produce the same diff are counted once.

One change per iteration, with no arms and no review, is
[`/autoresearch`](./autoresearch.md).

## Models per arm

The Models row assigns one model to each arm, in arm order, comma separated:

```
  Models        opus, gpt-5, glm
```

`a0` runs on Opus, `a1` on GPT-5, `a2` on GLM. The note under the fields reads
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
a role alias such as `@slow`. A spec that matches nothing blocks the start: the
note reads `No model matches "<spec>".` and the `Start swarm` button states
`no model matches "<spec>"` until it is fixed.

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
rather than the installation, so the console sets them per investigation and
`/settings` does not carry them. A [preset](#presets) saves that shape under a
name for every repository. A run records which arm produced it and which arm
certified it, both stated on the dashboard's detail of that run.

A winning arm has to beat the segment's baseline, not merely the other arms of
its iteration. An iteration where every arm regressed is a null round.

`certify_arms` and `start_arm` attach only while breadth is above 1. A serial
`/autoresearch` session has one candidate, no ring and no arm to open, so there
is nothing for either to do.

## Regenerating the console captures

`proof/scenes/autoswarm-setup.sh` opens the launcher, moves through the fields,
raises the breadth, assigns a model per arm and types one nothing matches,
toggles certification off and back on, sets an iteration cap, switches to the
`wide` preset, and leaves with Escape. It is a stills take that measures under 1 fps of real change, so
both arms turn the motion gate off; at the default the recorder rejects the take
as a stutter:

```sh
SCENE_MOTION_FLOOR=0 proof/record.sh proof/scenes/autoswarm-setup.sh
SCENE_MOTION_FLOOR=0 proof/record.sh --before proof/scenes/autoswarm-setup.sh
```

`proof/scenes/autoswarm-run-resume-keeps-goal.sh` opens the dashboard over the
seeded session and leaves with Escape. The `open` frame shows the session's
goal in the detail pane with `s resume` on the footer; `cancelled` shows the
loop untouched under the command:

```sh
SCENE_MOTION_FLOOR=0 proof/record.sh proof/scenes/autoswarm-run-resume-keeps-goal.sh
SCENE_MOTION_FLOOR=0 proof/record.sh --before proof/scenes/autoswarm-run-resume-keeps-goal.sh
```
