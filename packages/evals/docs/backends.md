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

Nothing in the runner tests the harness by name. The agent name, the container import path, the
source mount, the local tarball and the gateway all come from the harness's harbor binding, and the
progress frame's agent segment (`agentLabel`) takes that binding too: the install mode appears for a
harness this repository mounts or packs and for no other, and the agent args appear for every
harness that was given some.

`parseFinishedTrialResult` in `src/backends/harbor/runner/results.ts` is the only reader of a
trial's `result.json`. It resolves the reward (top-level `verifier_result.rewards`, else the last
step result's; the `reward` key when present, else the highest recorded value), sums usage across
every `agent_result` while keeping an unmeasured field absent, and maps the outcome: an exception is
an error, a missing reward is an error, a reward at 1 is a pass, anything lower a fail. The manager's
snapshot reader wraps it to attach the trace path — `test/backends/harbor/one-reader-parses-a-harbor-result-and-both-callers-agree.test.ts`
drives both entry points over one fixture table and fails when they diverge.

The harbor runner CLI renders a progress screen until its child exits, and stops at a ceiling of
every expected trial's own budget taken serially plus a 10-minute grace
(`src/backends/harbor/runner/run-watchdog.ts`). Harbor runs trials concurrently, so a legitimate run
cannot reach that ceiling; a run that does has stopped making progress, and the runner ends its
process tree and exits 124.

## in-process

Drives an `AgentSession` inside this process, used by the TypeScript-edit suite. No container, no
network: the corpus is on disk and the verifier is a compile plus a diff. `src/backends/in-process/overlays.ts`
applies a variant's settings overlay to the session, so a config axis is measurable without a
container. This is the backend an offline bench uses.

## A model served by this host

`src/core/local-endpoint.ts` states everything a run needs to measure a model served by the host
instead of a vendor. A provider segment in the table there (`lm-studio`, `llama.cpp`, `ollama`,
`vllm`) marks the model as locally served, and three facts follow.

The container reads the endpoint at the docker bridge address `172.17.0.1` on port 80, in the base
URL variable the agent binary already reads (`LM_STUDIO_BASE_URL` and its siblings). Publish that
address before a run:

```sh
bash packages/evals/scripts/local-endpoint-bridge.sh up   # [endpoint-port], default 1234
bash packages/evals/scripts/local-endpoint-bridge.sh down
```

The port is not a preference. A task declaring `network_mode = "no-network"` runs the agent behind a
squid proxy whose `Safe_ports` list is 80 and 443, so a model server on 1234 is refused before its
destination is matched. The forwarder is a container, so publishing port 80 needs no privileged
shell; reaching the server from it needs the host firewall to accept the docker subnets on the
server's own port.

The endpoint host is the arm's only allowed destination, so the trial keeps the task's network
policy for everything else. Declaring no destinations is not the alternative it looks like: pier
then gives the container `network_mode: none`, where nothing is reachable.

A local endpoint takes no credential, so the omp API-key requirement and the veyyon credential
probe do not apply to it, and no vendor `models.yml` is written: the endpoint reports its own
catalog, including the context window it loaded the model with.

## Preflight

Every backend rejects rather than degrades. Pier rejects a missing or incompatible Pier binary,
Harbor rejects a missing container runtime, and the in-process backend rejects a corpus it cannot
read. The verdict carries `missingRequirements`, so a caller reports every absent prerequisite at
once instead of one per run attempt.

## External commands

`src/core/external-command.ts` owns the bound on every command a backend spawns.
`runBoundedCommand` runs a cleanup or a probe asynchronously under 30s, so a `docker ps` waiting on a
restarting daemon costs one trial's cleanup rather than the thread every worker and every trial
deadline runs on. `syncCommandOptions()` carries the same bound to a launch probe that has to stay
synchronous, and `BUILD_COMMAND_TIMEOUT_MS` gives a pack, an image pull or a binary build fifteen
minutes. A command that ignores the bound is killed with SIGKILL. Cleanup is best effort: a caller
catches the rejection and continues.

## Termination

`src/core/process-tree.ts` ends a trial's process tree for every backend: `SIGTERM` to the child's
process group, then `SIGKILL` after a 5s grace, then a 500ms wait for the tree to disappear. It
returns whether the tree is gone. A tree that outlasts both signals is reported as abandoned rather
than awaited, and its pipes are not read, because a pipe a surviving descendant holds never reaches
EOF. Signalling the group reaches the container, the compose project and the agent process a child
spawned; a child that is not its own group leader falls back to the pid.

`awaitTrialProcessOutput` in the same module is the single wait the harbor and pier backends and the
deep-swe executor use. It races the trial's exit and its two pipe reads against the trial's deadline
and the run's cancellation signal. A deadline and a cancel take the same path: terminate the tree,
then drain the reads already in flight through `drainTrialOutput` under a 2s bound. Each pipe is
bounded separately, so text from the pipe that closed is kept when a survivor holds the other one
open, and a partial read is stated in the trial's error text. The result states which of the three
ended the wait, so a cancelled trial reports a cancel rather than a timeout.

A trial's exit does not close its pipes. A container or a stray background process it left behind
inherits the write end, and a read of that pipe waits for an EOF that arrives when the descendant
ends. The deadline therefore stays armed across the reads as well as the exit, and the reads are
started before the wait rather than after it.

The in-process backend has no child to signal. Its deadline and the run's cancellation signal both
reject the trial's wait and call the client's `abort()`, and the listener the trial put on that
signal is removed when the trial returns: one signal serves every trial in the run, so a listener
left behind holds that trial's client and session state until the run ends.

A trial's own teardown — the in-process backend's client, the TypeScript-edit adapter's session —
is bounded by `teardownWithin` in `src/core/trial-deadline.ts` instead, and reports the reason it
was abandoned beside the score the trial already earned.
