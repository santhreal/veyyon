# The run engine

`src/run/` turns a suite plus an axis selection into a list of trial cells, drives those cells
through one execution backend, and writes one run record. A suite supplies task discovery, scoring
and preflight; everything on this page is supplied for it.

## A plan is computed before anything executes

`buildRunPlan(request)` (`src/run/plan.ts`) expands `selection` through the variant matrix, resolves
every variant's harness in the registry, discovers the suite's tasks, and produces the exact cell
list. A dry run and a real run of the same request see the same cells in the same order.

Cell order is task-major with variants innermost, repeated per repeat: repeat 1 of every variant of
task A, then task B, and so on. A scheduler that wants one task's variants adjacent gets that
without reordering, and a bounded worker pool loses nothing by it.

`buildRunPlan` refuses rather than running something smaller than asked:

- `InvalidRepeatsError` when `repeats` is not a positive integer.
- `UnboundHarnessBackendError` when a variant's harness declares no binding for the suite's backend.
- `EmptyTaskSelectionError` when the suite discovered no tasks, or the requested list was empty.
- `UnknownTaskError` naming every requested id the suite does not hold, and how many it does.
- A `runId` is a single path segment. It arrives from a flag, a job name or a stored record, so
  `../..` in any of them is refused instead of joined.

`describeRunPlan(plan)` renders one line per axis, for a dry run and for a real run's header.

## A run id names one plan

`planIdentity(plan)` (`src/run/plan-identity.ts`) is a 16-character digest of the suite name and
version, the dataset sha, the backend, and every variant's harness, overlay paths, model and
attachments, sorted by variant name.

A cell key is `suite::task::variant::repeat`, and a variant name carries the model only when a run
varies more than one model, and an overlay by basename. Two different runs therefore produce
identical keys, which is why the digest exists: `--model a --run-id r` followed by
`--resume --model b --run-id r` counted model a's trials as settled for model b and reported b's arm
with a's numbers. `PlanChangedError` refuses that, and refuses a rerun that appends to a journal
written by another plan.

Task selection and repeat count are absent from the digest. Resuming a narrowed task list, or a run
with more repeats, is the same plan reaching fewer or more cells.

## The journal is the record of settled trials

`src/run/journal.ts` writes `<runs-dir>/<run-id>/trials.jsonl`: a header line stating
`RUN_JOURNAL_KIND`, `RUN_JOURNAL_VERSION` and the plan digest, then one JSON record per settled
trial, appended as it settles. Artifacts are trimmed by `sanitizeArtifacts` so neither the file nor
the in-memory record retains unbounded content.

- `StaleRunJournalError`: the file states a shape this build does not read.
- `CorruptRunJournalError`: a line parses as JSON and is not a trial record, so the file is not what
  its header says.
- `ResumeWithoutJournalError`: `--resume` named a run whose journal was never written. A mistyped run
  id otherwise reads as a fresh run and pays for every task the operator believed was settled.

`readRunJournal(runsDir, runId)` returns the settled records; `requireJournalPlan` refuses a journal
belonging to another plan and says nothing when there is no journal.

## Every directory is checked before a trial starts

`requireRunDirectories` (`src/run/directories.ts`) sweeps `RUN_DIRECTORY_ROLES` — `runs-dir`,
`work-dir`, `dataset-dir` — and throws `UnusableRunDirectoryError` naming the role, the directory and
the reason. Without it the same three faults surface late and in three voices: an `fs.mkdir` ENOTDIR
after preflight said `ok`, a backend spawning into a directory that does not exist, and a raw
`ENOENT ... scandir` from a suite's discovery pass.

## The order `executeRun` refuses in

`executeRun(options)` (`src/run/execute.ts`) proceeds only through this sequence, and each step
throws rather than degrading:

1. `jobs` is a positive integer, else `InvalidConcurrencyError`.
2. `requireRunDirectories`.
3. A resume with no journal is refused, before any preflight: nothing about the invocation can be
   fixed by staging assets.
4. `requireJournalPlan` against `planIdentity(plan)`.
5. `requireVariantSupport`: an axis no backend or harness applies is refused. A dropped `--prompts`
   path otherwise runs the whole matrix and reports two identical arms as a comparison.
6. Suite preflight, then every variant's harness preflight, then backend preflight
   (`SuitePreflightError`, `HarnessPreflightError`, `BackendPreflightError`, each carrying the reason
   and the missing requirements).
7. `backend.prepare`, then the journal opens.

## One trial, one row

Each cell runs `backend.runTrial` then `suite.scoreTrial`. A trial that threw measured nothing, so it
is attempted again up to the attempt ceiling `resolveTrialAttempts` reads, with `trialRetryDelayMs`
between attempts. A graded outcome, including a trial that spent its whole deadline, is never
retried, and neither is a cancelled run. `backend.cleanup` runs after every attempt exactly once, so
a retry starts from the state a fresh trial would; a cleanup failure never discards a scored row.

A trial that ended in an error is recorded with `reward: null` and the error text, so a failed trial
and a real reward of 0 are never confused. A retried trial records its attempt count in
`score.extra.attempts`.

The worker pool is `min(jobs, cells)` workers pulling from one index. A trial that cannot be recorded
ends the run: the failure is held, every worker stops, and it is rethrown once nothing is in flight,
because `Promise.all` alone would keep the other workers paying for trials whose rows append to a
closed handle. `journal.close()` runs in `finally`. An aborted run returns the trials that finished.

The result is one `EvalRunRecord` from `createRunRecord`, holding the suite identity and provenance
sha, the variants, the task ids, the repeat count and the `results` rows.
