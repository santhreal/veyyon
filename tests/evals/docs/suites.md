# Suites

| Suite | Measures | Backend | Graded by |
|---|---|---|---|
| `deep-swe` | software engineering tasks in real repositories | pier | the task's own test suite in the container |
| `terminal-bench` | Terminal-Bench 3.0 terminal and tool-use tasks | harbor | the task's verifier |
| `typescript-edit` | surgical edits to TypeScript source, from seeded mutations | in-process | the edited file against the expected file |
| `browser` | hard web tasks on seeded local applications | local-cli | checks over the state the applications recorded, and the answer |
| `miniwob` | MiniWoB++ synthetic web tasks | local-cli | the score each task page computes |

The `miniwob` suite serves MiniWoB++'s pages from `datasets/miniwob/html`, which is not in the
repository; `suites/miniwob/main.ts` lists the commands that link a clone there. Its preflight fails
while any task page is missing. The pages' files are part of the suite's provenance hash. A score
comes from the page's own script, so code the run executes in the page, such as the browser tool's
`tab.evaluate`, can forge it.

A suite is one member of the suite axis. It lists its tasks, describes each one (instruction, time
budget, input files), states its provenance (a version and a hash of what it read), scores a trial
from the artifacts the backend returned, and may write a report for a finished run.

Pass rates of two suites never share a table: a run is one suite, and a comparison across suites is
refused (`CrossSuiteComparisonError`).

## Adding a suite

A suite whose tasks can be performed against services this host starts is a kit suite: write a task
catalog and let `defineSuite` supply the rest ([the kit](kit.md)). It runs on the local-cli backend.

A suite that wraps an existing benchmark with its own harness (containers, verifiers) implements
`EvalSuite` directly:

1. Create `suites/<id>/main.ts` default-exporting an object with `id` equal to `<id>`, a `version`,
   a `displayName`, a `description` and the `backend` it runs on.
2. Implement `discoverTasks`, `describeTask`, `provenance`, `preflight` and `scoreTrial`. A trial
   that never reached a grade scores `reward: null` with an `error`; a trial the task's grader
   failed scores `reward: 0` with `error: null`.
3. Add the suite to `SUITE_SCORE_DRIVERS` in
   `test/suites/every-suite-scores-null-on-infrastructure-failure-and-zero-on-real-failure.test.ts`,
   and record its harness and backend pairs where the harness sweeps pin them. Those suites fail
   until the new suite is recorded.
4. Run `bun evals.ts --suite <id> --model <model> --dry-run`.
