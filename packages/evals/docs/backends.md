# Execution backends

A backend is the single definition of how a trial starts, stays isolated, and is torn down. Three are registered — `pier`,
`harbor`, `in-process` — and a suite states the one it needs in `EvalSuite.backend`. A run resolves
that id through `src/core/backend-registry.ts`; a suite naming an unregistered backend is rejected
before any trial starts.

`src/backends/index.ts` holds `builtinBackends` and `registerAllBackends()`. The backend trees are
not re-exported from it: Harbor and the in-process client both export a command executor and an
argument parser, so a star export would merge two different functions under one name. Import a
backend's own module (`@veyyon/evals/backends/harbor/backend`).

## The contract

```typescript
interface ExecutionBackend {
	readonly id: BackendId;
	preflight(context): Promise<PreflightVerdict>;
	prepare(context): Promise<void>;
	runTrial(cell: TrialCell, context): Promise<TrialArtifacts>;
	cleanup(context): Promise<void>;
}
```

`runTrial` returns artifacts, never a score: the suite grades them in `scoreTrial`. Large data is
returned as a path (`trialDir`, `logPaths`, `filePaths`), and `rawOutput` is a tail capped at 64 KiB,
so a run's memory does not grow with its logs. `usage` carries what the backend observed — tokens,
spend, duration — and each field is `null` when unmeasured, never `0`.

A trial that throws records `reward: null` with the error text. It is excluded from every mean and
reported as its own count, so an infrastructure failure never reads as a zero score.

## pier

Container execution through Pier, used by the DeepSWE suite. The layout under the work directory is
`runs/<runId>/{configs,jobs,assets}`. Each trial gets a job config naming one task, one agent import
path and its kwargs; the agent reads `<assetsDir>/{vey,auth-agent.db,arms/<arm>.yml,attachments.json}`.
`src/backends/pier/version.ts` rejects a Pier whose manifest version is not the supported one
(`SUPPORTED_MANIFEST_VERSION = 1`) rather than running against an incompatible schema.
`src/backends/pier/asset-staging.ts` stages the assets; `src/backends/pier/runner.ts` drives the
subprocess and cleans up containers.

## harbor

Container execution through Harbor, used by the Terminal-Bench suite. `--install source` mounts the
repository into the task container so `packages/coding-agent/src/cli.ts` runs without a rebuild;
`--install local` and `--install published` use a prebuilt binary instead. Provider `baseUrl` entries
are routed to the host authentication gateway. Per-trial status, token counts and verifier results
come from polling each trial's `result.json`. `src/backends/harbor/launch-args.ts` builds the argv and
is the only place the container agent's import path and CLI flags are assembled.

`parseFinishedTrialResult` in `src/backends/harbor/runner/results.ts` is the only reader of a
trial's `result.json`. It resolves the reward (top-level `verifier_result.rewards`, else the last
step result's; the `reward` key when present, else the highest recorded value), sums usage across
every `agent_result` while keeping an unmeasured field absent, and maps the outcome: an exception is
an error, a missing reward is an error, a reward at 1 is a pass, anything lower a fail. The manager's
snapshot reader wraps it to attach the trace path — `test/backends/harbor/one-reader-parses-a-harbor-result-and-both-callers-agree.test.ts`
drives both entry points over one fixture table and fails when they diverge.

## in-process

Drives an `AgentSession` inside this process, used by the TypeScript-edit suite. No container, no
network: the corpus is on disk and the verifier is a compile plus a diff. `src/backends/in-process/overlays.ts`
applies a variant's settings overlay to the session, so a config axis is measurable without a
container. This is the backend an offline bench uses.

## Preflight

Every backend rejects rather than degrades. Pier rejects a missing or incompatible Pier binary,
Harbor rejects a missing container runtime, and the in-process backend rejects a corpus it cannot
read. The verdict carries `missingRequirements`, so a caller reports every absent prerequisite at
once instead of one per run attempt.

## Termination

`src/core/process-tree.ts` ends a trial's process tree for every backend: `SIGTERM` to the child's
process group, then `SIGKILL` after a 5s grace, then a 500ms wait for the tree to disappear. It
returns whether the tree is gone. A tree that outlasts both signals is reported as abandoned rather
than awaited, and its pipes are not read, because a pipe a surviving descendant holds never reaches
EOF. Signalling the group reaches the container, the compose project and the agent process a child
spawned; a child that is not its own group leader falls back to the pid.

`awaitTrialProcessOutput` in the same module is the single wait the harbor and pier backends use. It
races the trial's exit and its two pipe reads against the trial's deadline and the run's
cancellation signal. A deadline and a cancel take the same path: terminate the tree, then drain the
reads already in flight through `drainTrialOutput` under a 2s bound. Each pipe is bounded separately,
so text from the pipe that closed is kept when a survivor holds the other one open, and a partial
read is stated in the trial's error text. The result states which of the three ended the wait, so a
cancelled trial reports a cancel rather than a timeout.

A trial's own teardown — the in-process backend's client, the TypeScript-edit adapter's session —
is bounded by `teardownWithin` in `src/core/trial-deadline.ts` instead, and reports the reason it
was abandoned beside the score the trial already earned.
