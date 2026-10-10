# Run output

A run writes `<runs-dir>/<run-id>/`:

```
runs/<run-id>/
  trials.jsonl   the journal: a header, then one settled trial per line, appended as trials settle
  run.json       the run record, written when the run ends
  report.md      the suite's report, when the suite writes one
  summary.json   the numbers behind a kit suite's report
  <variant>/<task>/repeat-<n>/   a trial's own files, on backends that file trials this way
```

A trial a cancelled run cut short settled nothing and has no line in `trials.jsonl`; a resumed run
runs it. A line a killed process left incomplete is dropped when the journal is next opened.

The Pier and Harbor backends also write `assets/` (staged binaries, credential stores, container
programs), `configs/` (one job configuration per trial) and `jobs/` (one directory per trial with the
container's logs, the verifier's output and the agent's patch). The local-cli backend's trial files
are listed in [backends](backends.md).

## Records

`engine/run/record.ts` holds the shapes.

- `TrialResultRecord`: one settled trial. `cell` (variant, suite, task, repeat), `score` (`reward`,
  `partial`, `error`, `usage`, `extra`), `artifacts` (`trialDir`, `logPaths`, `filePaths`,
  `rawOutput`, `usage`, `extra`), and its start, finish and duration.
- `TrialUsage`: `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `costUsd`,
  `durationSec`. A field nobody measured is `null` or absent, never `0`; a provider that prices
  nothing reports no cost rather than a free trial.
- `EvalRunRecord`: the run: suite name, version and provenance hash, variants, tasks, repeats,
  results, timestamps.
- `RunVerdict`: whether the run succeeded, which sets the exit code ([running](running.md)).

A trial that never reached a grade has `reward: null` and an `error`; it is excluded from pass rates
and counted as an error. A trial that reached a grade and failed has `reward: 0`. A trial that spent
its deadline is graded, and counted as a failure.

## The run store

`evals serve` indexes runs into `<runs-dir>/_manager/evals.sqlite` and serves them to the dashboard
over REST and Server-Sent Events.
