# Autoswarm

Autoswarm is [autoresearch](./autoresearch.md) with breadth. An iteration builds
several candidate arms instead of one change, rejects the ones that cannot be
trusted, has the survivors review each other, and keeps at most one.

```
/autoswarm make the tokenizer faster
```

It opens at breadth 3, the fewest arms a review ring needs. Everything
autoresearch provides is unchanged underneath: the same `autoresearch.sh`
harness, the same metric lines, the same segments, the same scope rules, the
same database. Read that page first; this one covers only what breadth adds.

`/autoresearch` is still there and still serial. Autoswarm does not replace it.

## Breadth

```
/autoswarm breadth 4
```

The value is 1 to 8. Set it before starting and it applies when the session
opens; set it during a session and it applies from the next iteration.
`/autoswarm breadth` with no number reports the current value. The dashboard
shows `breadth N` whenever it is above 1.

Arms share one worktree. They are built one at a time, measured, and reverted,
so breadth costs iteration time rather than disk. An arm is a different idea:
two arms that produce the same diff are counted once.

Breadth 1 is the serial loop exactly. No arms, no review, no certification cost.

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

Breadth, attempts, parallelism and certification belong to the session rather
than the installation, so they are set per investigation and not in `/settings`.
A run records which arm produced it and which reviewer certified it.
