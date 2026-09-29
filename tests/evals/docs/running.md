# Running evals

The entry point is `evals.ts`, run with Bun from `tests/evals` (`bun evals.ts`, or `bun run evals`).

## Modes

- `evals --list` prints the loaded suites, backends and harnesses.
- `evals --list --suite <ids>` prints the task ids of each named suite.
- `evals --suite <ids> --model <ids>` plans and runs one run per suite.
- `evals --suite <ids> --model <ids> --dry-run` prints the plan and every preflight verdict and runs
  nothing.
- `evals --resume --run-id <id>` continues an interrupted run from its journal. A run stopped by
  SIGINT or SIGTERM finishes its trials' teardown and prints this command with the flags it was
  given.
- `evals bench [<id> [args...]]` lists the benches, or runs one with the remaining arguments.
- `evals measure [<id> [args...]]` lists the measurements, or runs one.
- `evals tool [<id> [args...]]` lists the tools, or runs one.
- `evals serve [--port 4700] [--host 0.0.0.0]` starts the manager server (REST, SSE, dashboard).

`bench`, `measure`, `tool` and `serve` are the only positional words, and each comes first. Every
other input is a flag. A flag takes its value as `--flag value` or `--flag=value`. A value flag with
no value, an empty value, an unknown flag or a stray positional argument is a usage error.

## Axes

A run is the product of its axes: every combination is one variant, and every variant runs every
selected task `--repeats` times. A list is comma-separated.

- `--suite <ids>`: the suites to run, one run record each. Required.
- `--harness <ids>`: the agents. Default `veyyon`.
- `--model <ids>`: provider-qualified model ids (`provider/model`). Required.
- `--config <paths>`: settings overlays, one variant each.
- `--prompts <paths>`: prompt overlays, one variant each.
- `--build <name=path,...>`: builds of the agent, one variant each. A path is a source tree (run
  with Bun from `packages/coding-agent/src/cli.ts`) or an executable. Only a harness that declares
  `builds` and a backend that applies the `build` axis accept it; today that is `veyyon` on
  `local-cli`.

A variant is named for what varies: `veyyon#head`, `veyyon+terse`, and so on. A backend that cannot
apply an axis the plan varies refuses the run before a trial starts, so two arms that would run the
identical trial never report a difference.

## Selection and execution

- `--tasks <ids|file>`: task ids, or a task-list file (one id per line, `#` comments). A value that
  holds a path separator or ends in `.txt`, `.jsonl`, `.list` or `.tasks` names a file, which must
  exist. `<suite>=<entry>` scopes an entry to one suite.
- `--limit <n>`: run only the first n selected tasks.
- `--repeats <n>`: trials per cell. Default 1.
- `--attempts <n>`: attempts per trial when a trial throws before it produces a result (1 to 5,
  default 2). A graded outcome, a trial that spent its deadline and a cancelled run are never retried.
- `--jobs <n>`: trials in flight at once. Default 1.
- `--runs-dir <path>`: where runs are written. Default `runs` in this package.
- `--work-dir <path>`: the working directory handed to the backend. Default the current directory.
- `--dataset-dir <path>`: a suite's dataset directory, for a single-suite run.
- `--run-id <name>`: the run's directory name. With several suites each run is `<name>-<suite>`.
- `--trial-timeout <sec>`: replace each task's own time budget.
- `--agent-timeout <sec>`: bound the agent phase alone, on a backend that grades a timed-out agent.
- `--timeout-multiplier <x>`: scale whatever budget applies. A scaled budget stops at 3600 s; a
  budget a task states for itself is honored up to 86400 s.
- `--no-gateway`: forward provider keys directly instead of through the auth gateway (local models).
- `--unsandboxed`: run local-cli trials without Landlock, on a host that has none. The agent's tools
  can then read every file the runner can, the graders included.

A harness adds flags of its own (`HarnessAdapter.flags`), such as `--vey-binary <path>` or
`--auth-db <path>`; `--help` lists them.

## Exit codes

- `0`: the run measured at least one trial and no trial ended in an infrastructure error. A run
  whose graded trials all failed exits `0`: the reward is the measurement.
- `1`: a preflight refused, a trial ended in an infrastructure error, no trial settled, or no
  settled trial reached a grade.
- `2`: a usage error.
