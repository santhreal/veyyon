#!/usr/bin/env bun

import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
// THE OTHER DOOR, closed on purpose rather than by luck. This script SPAWNS every `bun
// test` chunk itself, so running it on the host runs the whole suite on the host. The gate
// exits the process when isolation is not proven, once, here, instead of the per-chunk
// preload refusing thousands of children one at a time.
//
// It refuses rather than wrapping each chunk the way `scripts/preflight.ts` does, and the
// difference is real: chunks run with `cwd` set to a package directory, so wrapping them
// individually would mean one sandbox per chunk, each with its own working directory, and a
// rung whose start-up cost is paid hundreds of times. Running this whole script inside one
// sandbox is cheaper AND a stronger boundary, because the children inherit it and cannot be
// spawned outside it.
//
// Imported BY NAME even though `./temp-dir-janitor` below already reaches it through
// `sandbox-home`. That transitive path is an accident of what this file happens to need
// today, and a refusal that depends on an unrelated import is one cleanup away from
// silently reopening the door.
import "../packages/utils/test/helpers/sandbox-gate";
import {
	STALE_TEMP_DIR_AGE_MS,
	sweepStaleTempDirs,
	TEST_TEMP_DIR_PREFIXES,
} from "../packages/utils/test/helpers/temp-dir-janitor";
import { ensureToolViewsGenerated } from "./ensure-tool-views";

type Mode =
	| "all"
	| "local"
	| "local-ts"
	| "workspace"
	| "scripts"
	| "native"
	| "coding-agent-singleton"
	| "coding-agent-ui"
	| "coding-agent-runtime"
	| "coding-agent-native"
	| "coding-agent-heavy";

type CodingAgentBucket = "singleton" | "ui" | "runtime" | "native";

interface TestCommand {
	label: string;
	cwd: string;
	command: string[];
}

type CodingAgentTestPartition = Record<CodingAgentBucket, string[]>;

const repoRoot = path.join(import.meta.dir, "..");

// The real veyyon data directory, captured BEFORE any child is spawned with a
// sandboxed HOME. Once HOME is redirected there is no way back to this value from
// inside a child: Bun's os.homedir() and os.userInfo().homedir both follow HOME.
// The parent resolves it once, hands it down, and the tripwire uses it to know
// exactly what to forbid.
const REAL_CONFIG_ROOT = path.join(os.homedir(), ".veyyon");

// Absolute path to the real-data tripwire preload, passed to every spawned
// `bun test`. Chunks run with their package directory as cwd, and Bun reads
// bunfig.toml from the cwd only, so the repository-root preload is invisible from
// packages/<name>. Relying on the root bunfig alone left every chunk of a real run
// unprotected, which surfaced when the tripwire's own suite wrote its probe files
// into the real config root.
const TRIPWIRE_PRELOAD = path.join(repoRoot, "packages", "utils", "test", "helpers", "real-data-tripwire.ts");
const preloadArgs = ["--preload", TRIPWIRE_PRELOAD];

// A disposable HOME handed to every test child. This is PREVENTION, and it is
// structural rather than advisory: config, credential and session paths are all
// built from os.homedir(), so a child that starts life with a temp home cannot
// name real data whatever its own isolation code forgets to do. It must be set at
// spawn time because Bun resolves os.homedir() once at process start, which is
// exactly why a suite assigning process.env.HOME in beforeEach once wrote rows
// into the real credential store while believing it was sandboxed.
export const SANDBOX_HOME = (() => {
	const sandbox = path.join(os.tmpdir(), `veyyon-test-home-${process.pid}`);
	nodeFs.mkdirSync(sandbox, { recursive: true });
	return sandbox;
})();

// Every run used to leave that sandbox behind, and a CLI spawned with a fresh HOME stages
// about 290 MB of native addon into it, so a few hundred runs filled a 915 GB disk: /tmp
// held 38,600 stranded veyyon-* directories totalling 240 GB and the root filesystem hit
// 100% full. Removing it here covers a run that finishes. The sweep below covers the runs
// that did not, on this machine and on every machine that already has the backlog.
process.on("exit", () => {
	try {
		nodeFs.rmSync(SANDBOX_HOME, { recursive: true, force: true });
	} catch {
		// A sandbox that cannot be removed is worth no noise at the very end of a run; the
		// age-bounded sweep at the start of the next one will collect it.
	}
});

{
	// Every prefix, not just `veyyon-`: the coding-agent suite names its scratch `pi-`, and
	// sweeping one prefix left 14,364 of those behind while reporting a clean reclaim.
	let reclaimed = 0;
	for (const prefix of TEST_TEMP_DIR_PREFIXES) {
		const swept = sweepStaleTempDirs({ prefix });
		reclaimed += swept.removed.length;
		for (const failure of swept.failed) {
			process.stderr.write(`could not reclaim ${failure.dir}: ${failure.reason}\n`);
		}
	}
	if (reclaimed > 0) {
		process.stderr.write(
			`reclaimed ${reclaimed} stranded test directories in ${os.tmpdir()} ` +
				`(older than ${STALE_TEMP_DIR_AGE_MS / 3_600_000} hours)\n`,
		);
	}
}
const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const requestedMode = args.find(arg => !arg.startsWith("--")) ?? "all";
// `--only-failures` is Bun's output filter — it hides passing tests within each
// chunk, keeping the log terse, and is the default here (CI and the root
// `test:ts` aggregate append it). It does NOT skip tests or share any
// cross-process cache, so chunks are safe to run concurrently. The package-level
// `test` script passes `--full` for verbose output (every test line); an explicit
// `--only-failures` still wins.
const onlyFailures = args.includes("--only-failures") || !args.includes("--full");
const onlyFailuresArgs = onlyFailures ? ["--only-failures"] : [];
// Quiet mode (the default) collapses each parallel chunk to a one-line pass/fail
// progress entry and replays full stdout/stderr only for chunks that failed, so
// the failure is never buried under thousands of passing-chunk lines. `--full`
// opts back into inline replay of every chunk. Tied to `onlyFailures` so the
// quiet path is whatever the verbose filter is not.
const quiet = onlyFailures;

const validModes: Record<Mode, true> = {
	all: true,
	local: true,
	"local-ts": true,
	workspace: true,
	scripts: true,
	native: true,
	"coding-agent-singleton": true,
	"coding-agent-ui": true,
	"coding-agent-runtime": true,
	"coding-agent-native": true,
	"coding-agent-heavy": true,
};

// `chunkSize` splits a bucket's file list into that-many-file groups, each run as a
// separate `bun test` child process. A fresh process per chunk resets Bun's
// heap and reaps any dangling spawned children between groups, keeping peak RSS
// under the CI runner's OOM ceiling (a single 170–370-file invocation gets
// SIGKILLed at 137). The singleton/global-state bucket is left whole: its suites
// co-locate in one process to exercise process-wide state, so they must not split.
//
// The UI/TUI bucket uses a smaller chunk (5) than the others: its suites build up
// native ghostty-vt cells, and bun 1.3.14's GC aborts (SIGTRAP/SIGABRT, exit
// 133/134 inside DOMGCOutputConstraint marking) once ~10 such files share a heap,
// even with the GC-marker knobs below. Bisection showed no single file is at
// fault — the crash is cumulative heap volume. Under a 256MB-forced heap, a
// 10-file chunk aborts ~50% of runs while either 5-file half is 0/20; halving the
// chunk keeps each process under the threshold.
const codingAgentBucketPlans: Record<CodingAgentBucket, { label: string; parallel: number; chunkSize?: number }> = {
	singleton: { label: "singleton/global-state bucket", parallel: 1 },
	ui: { label: "UI/TUI bucket", parallel: 1, chunkSize: 5 },
	runtime: { label: "runtime/session bucket", parallel: 1, chunkSize: 10 },
	native: { label: "native/tooling/browser/unit bucket", parallel: 1, chunkSize: 10 },
};

// Smaller workspace packages stay separate from native/TUI/integration suites so
// their short TS suites can run together. CI still downloads the Linux x64 native
// addon before this bucket: shared utility barrels may load native-backed modules.
export const fastWorkspacePackages = [
	"packages/hashline",
	"packages/wire",
	"packages/utils",
	"packages/catalog",
	"packages/ai",
	"packages/agent",
	// The six below ran in NO mode at all until 2026-07-25 — not in CI's `all`, not
	// in `local-ts`. They were never removed; they were simply never added when the
	// `bun run --workspaces test` fan-out was replaced by these hand-kept lists, and
	// each reads as covered from every angle (a working `test` script, ordinary test
	// files, a comment above claiming this covers what the fan-out covered). That is
	// why `workspaceTestPackages` below is now checked against the tree by
	// `scripts/workspace-test-coverage.test.ts` instead of maintained by hand alone.
	"packages/argot",
	"packages/stats",
	"packages/tool-render",
	"packages/swarm-extension",
	"packages/deepswe-bench",
	// mnemopi ran in NO CI job until this entry existed. It sat in
	// `localOnlyWorkspacePackages` below, excluded as a whole package because "its
	// embedding suites depend on a ~270MB fastembed model absent from CI runners".
	// That was a property of a subset, recorded as a property of the package, and
	// never checked against the suites. Every one of them passes with the model
	// cache empty and the network unreachable: most never produce a vector at all,
	// the ones that do inject a fake provider or a fake initializer, and
	// `getLocalModel` returns null outright under the test runner. So the triple
	// store, the schema, the migrations, the query paths and the recall ranking
	// were all skipped for a hazard none of them run into, and 1041 tests ran
	// nowhere while the buckets reported green.
	//
	// The hazard was real, so it is refused at the download instead of by omitting
	// a package: `packages/mnemopi/test/helpers/fastembed-model-tripwire.ts` is
	// preloaded into every mnemopi test process and throws from
	// `FlagEmbedding.init`, the call that fetches the weights. A suite that starts
	// needing the real model fails by name, here and locally, rather than pulling
	// 270MB into a runner and turning this bucket slow and flaky.
	"packages/mnemopi",
	// Simulations. Offline and deterministic, but they drive a real AgentSession
	// per scenario, so they belong with the fast workspace suites rather than the
	// native bucket.
	"packages/simulations",
];

// These suites cover the native package, TUI/browser-ish behavior, local servers,
// or coding-agent-adjacent benchmark paths. Keep them low-concurrency and in jobs
// that have downloaded the Linux x64 native addon artifacts.
export const nativeAndIntegrationPackages = [
	"packages/natives",
	"packages/tui",
	"packages/typescript-edit-benchmark",
	// Same omission as above. These two belong in this bucket rather than the fast
	// one for the reason the comment gives: metaharness starts local servers and
	// collab-web is browser-ish.
	"packages/metaharness",
	"packages/collab-web",
];

// Packages the CI buckets deliberately skip but a local full run should still
// cover. One entry, and its reason is structural rather than circumstantial:
// veybot-web lives under python/veybot, outside every CI TS bucket.
//
// mnemopi was the other entry, and it is the warning this list carries. A whole
// package was skipped for something true of a handful of its suites, the reason
// read as settled, and nobody measured it again for as long as it stood. An entry
// here costs a package its entire CI run, so it has to name a property of the
// package. When only some suites cannot run in CI, exclude those suites by name
// with the reason attached to them and leave the rest of the package running.
export const localOnlyWorkspacePackages = ["python/veybot/web"];

/**
 * Every package whose test suite this runner executes, across all three buckets.
 *
 * The one list `scripts/workspace-test-coverage.test.ts` checks against the tree,
 * so a package that ships tests cannot go unrun and a bucket entry cannot outlive
 * the package it names. `packages/coding-agent` is absent on purpose: its suites
 * are discovered by walking the package (`codingAgentTestCommands`) rather than
 * by being listed, so it needs no entry here.
 */
export const workspaceTestPackages = [
	...fastWorkspacePackages,
	...nativeAndIntegrationPackages,
	...localOnlyWorkspacePackages,
];

// Repo-level script tests. This is the ONE list of them, and `scriptTestCommand`
// below is its only consumer, so it cannot be half-updated.
//
// It used to be two lists. `case "workspace"` carried its own hardcoded copy of 15
// entries, and because that bucket is the only one CI ever invoked, the other 69
// suites in this array ran nowhere. They were not skipped loudly. They were simply
// never named by a workflow, so 79 assertions sat red on main while CI reported
// green, including a stale installer contract and an every-script-has-an-owner
// gate that had been failing since the demos landed. The second list is gone and a
// dedicated `test_scripts` job now runs this one, which is the only arrangement
// where adding an entry here means it actually runs.
//
// The irony is on the record two comments below: `case "scripts"` already warned
// that two hand-maintained lists is how one goes stale, and noted the stale one
// had 7 of 32 entries. The workspace copy was that same mistake, reintroduced.
//
// (A `ci-test-ts.test.ts` entry used to sit here but the file never existed. Bun
// silently ignores unmatched filters when at least one other filter matches, so a
// typo'd path in this array is invisible rather than fatal. Check the file exists.)
export const repoScriptTests = [
	"scripts/ci-concurrency.test.ts",
	"scripts/every-workflow-pipeline-sets-pipefail.test.ts",
	"scripts/every-workflow-runs-bun-test-in-the-sandbox.test.ts",
	"scripts/gh-repo-context.test.ts",
	"scripts/ci-build-native.test.ts",
	"scripts/bun-install-action.test.ts",
	"scripts/ci-release-notes.test.ts",
	"scripts/ci-release-build-binaries.test.ts",
	"scripts/release-version.test.ts",
	"scripts/release-version-authorities.test.ts",
	"scripts/release-request.test.ts",
	"scripts/release-policy.test.ts",
	"scripts/release-ship.test.ts",
	"scripts/link-veyyon.test.ts",
	"scripts/docs-book-pin.test.ts",
	"scripts/handbook-summary-covers-every-page.test.ts",
	"scripts/internal-docs-are-tracked.test.ts",
	"scripts/install-methods-coverage.test.ts",
	"scripts/read-if-present.test.ts",
	"scripts/fuzz.test.ts",
	"scripts/fuzz-triage.test.ts",
	"scripts/a-source-file-that-reads-as-binary-is-invisible.test.ts",
	"scripts/barrel-files-are-imported.test.ts",
	"scripts/class-privacy-is-the-hash.test.ts",
	"scripts/handbook-built-pages-contain-source-contracts.test.ts",
	"scripts/prompt-formatter-checks-current-tree.test.ts",
	"scripts/workspace-typecheck-coverage.test.ts",
	"scripts/workspace-test-coverage.test.ts",
	"scripts/tool-renderer-coverage.test.ts",
	"scripts/workspace-catalog-pins.test.ts",
	"scripts/workspace-manifests.test.ts",
	"scripts/chunk-composition.test.ts",
	"scripts/package-map-coverage.test.ts",
	"scripts/root-layout.test.ts",
	"scripts/sync-root-changelog.test.ts",
	"scripts/dependency-overrides.test.ts",
	"scripts/installer-alias-parity.test.ts",
	"scripts/installer-completions-parity.test.ts",
	"scripts/installer-doctor-parity.test.ts",
	"scripts/installer-help-parity.test.ts",
	"scripts/installer-never-clones.test.ts",
	"scripts/installer-no-clobber.test.ts",
	"scripts/installer-legacy-bun-uninstall.test.ts",
	"scripts/installer-uninstall-parity.test.ts",
	// Runs the installer for real, once per environment in
	// scripts/install-tests/environments.toml, so it is slower than the parity
	// suites above and belongs in the same gate rather than a nightly.
	"scripts/posix-shell-portability.test.ts",
	"scripts/installer-environment-matrix.test.ts",
	// The same environments, updated rather than installed. Same reasoning: it
	// runs the real installer once per case and then the real binary swap over
	// it, so it is slow, and it gates the same product surface.
	"scripts/update-environment-matrix.test.ts",
	"scripts/pre-push-hook.test.ts",
	"scripts/inline-functions.test.ts",
	"scripts/differential-conformance.test.ts",
	"scripts/record-conformance.test.ts",
	"scripts/ci-test-real-data-guard.test.ts",
	"scripts/ci-test-concurrency-default.test.ts",
	"scripts/release-binaries-bytecode.test.ts",
	"scripts/fix-changelogs.test.ts",
	"scripts/require-changelog.test.ts",
	"scripts/changelog-version-headings-are-unique.test.ts",
	"scripts/run-rs-task.test.ts",
	"scripts/verify-deployed-installers.test.ts",
	"scripts/verify-deployed-changelog.test.ts",
	"scripts/installer-brand-parity.test.ts",
	"scripts/upstream-radar.test.ts",
	"scripts/release-sentinel.test.ts",
	"scripts/release-changelog.test.ts",
	"scripts/release-bump-subject.test.ts",
	"website/tools/gen-changelog.test.ts",
	"scripts/tracked-but-deleted-paths.test.ts",
	"website/tools/undocumented-release-ratchet.test.ts",
	"website/tools/gen-blog.test.ts",
	"website/tools/nav.test.ts",
	"scripts/demos/lib/png.test.ts",
	"scripts/demos/lib/ansi-grid.test.ts",
	"scripts/demos/lib/ansi-raster.test.ts",
	"scripts/every-skill-is-catalogued.test.ts",
	"scripts/every-script-has-an-owner.test.ts",
	"scripts/first-party-docs-are-indexed.test.ts",
	"scripts/script-tests-coverage.test.ts",
	"scripts/stray-output-path.test.ts",
	// The leak tracer's own contract tests. Also run by the `test-leaks` job in
	// checks.yml and by the nightly leak sweep, but listed here too because those jobs
	// gate the TRACER, and this list is what proves no script suite runs nowhere.
	"scripts/test-sandbox/find-test-leaks.test.ts",
	// The sandbox driver's own refusal contract: a pinned unavailable rung, no rung
	// at all, and the marker plus host-home proof read from inside whichever guest
	// is running this bucket.
	"scripts/test-sandbox/rung-contract.test.ts",
	"scripts/find-order-polluter.test.ts",
	// This one was in no runner. It looked covered only because the coverage lock
	// regexed the raw workflow YAML, so a path named in a COMMENT in ci.yml counted
	// as run. Scanning the parsed document instead exposes it.
	"scripts/release-train-alert-watches-the-train.test.ts",
	// The two gates on the wiring itself. Registering them here is not ceremony: the
	// first commit of them left both out, so the suites that keep every script suite
	// running were themselves running nowhere, which is the exact hole they exist to
	// close. script-tests-coverage caught it.
	"scripts/every-script-suite-actually-runs.test.ts",
	"scripts/no-install-jobs-resolve-their-imports.test.ts",
	// Landed on disk without being wired, so the gate that keeps a suite from
	// touching the operator's real home was itself running nowhere.
	"scripts/tests-never-touch-real-home.test.ts",
	// Reads manifests against shipped imports, so it catches a break that only an
	// installer outside this workspace would ever see.
	"scripts/a-published-package-declares-what-it-imports.test.ts",
	// Seven suites that were on disk, tracked, and in no runner. They are all
	// release and changelog gates, which is the worst place for a suite to be
	// silently unrun: the thing they guard is only exercised on the day a release
	// is cut, so nobody would have noticed until it mattered.
	"scripts/changelog-unreleased.test.ts",
	"scripts/changelog-version-headings-have-one-owner.test.ts",
	"scripts/write-root-changelog-refuses-to-delete-entries.test.ts",
	"scripts/release-cut-prepares-without-pushing.test.ts",
	"scripts/release-native-artifacts-match-ci.test.ts",
	"scripts/release-recut-recovery-message.test.ts",
	"scripts/session-stats/audit.test.ts",
	// Runs in whatever rung the harness picked, and asserts that rung can execute
	// a file a suite just wrote. Docker's tmpfs defaults could not.
	"scripts/test-sandbox/the-guest-tmpdir-can-execute.test.ts",
];

/**
 * The one command that runs every repo-level script suite. Both `local-ts` (the
 * full local run) and `scripts` (that set alone) call this, so `repoScriptTests`
 * has exactly one consumer and cannot be half-updated.
 *
 * The timeout is explicit because bun's 5 second default is a unit-test budget and
 * these are not unit tests. They shell out: repo-wide git greps, and installer
 * suites that run real installs into disposable HOMEs. Under `--parallel=4` those
 * heavy suites saturate the machine and the light ones stall behind them.
 * first-party-docs-are-indexed runs in 0.10 seconds on its own and still blew
 * through 5 seconds in the bucket, which is contention, not slowness, and it
 * failed on the clock rather than on anything it asserts.
 *
 * This buys patience, not leniency. Every assertion is unchanged, and a suite that
 * genuinely hangs still fails, 30 seconds later. Raising it further would start
 * hiding real hangs, so fix the suite rather than this number.
 */
function scriptTestCommand(): TestCommand {
	return {
		label: "scripts",
		cwd: ".",
		command: [
			"bun",
			"test",
			...preloadArgs,
			"--parallel=4",
			"--timeout",
			"30000",
			...onlyFailuresArgs,
			...repoScriptTests,
		],
	};
}

const codingAgentNativePathPatterns = [
	/(^|\/)[^/]*(bash|native|browser|cmux|mnemopi|hindsight|memory)[^/]*\.test\.ts$/i,
	/^test\/[^/]*(ask|gh|irc|task|eval|search|read|write|edit|ast|resolve|sqlite|web-search|fetch|image|ssh|tool)[^/]*\.test\.ts$/,
	/^test\/core\/python-[^/]*\.test\.ts$/,
	/^test\/core\/[^/]*executor[^/]*\.test\.ts$/,
	/^test\/tools\/[^/]*(ask|gh|irc|task|eval|search|read|edit|ast|resolve|sqlite|web-search|fetch|image|ssh)[^/]*\.test\.ts$/,
	/^test\/tools\/web-scrapers\//,
	/^test\/web\//,
	/^test\/ssh\//,
	/^test\/tools\.test\.ts$/,
];

const codingAgentSingletonPathPatterns = [
	/^test\/(settings|config|fast-mode-scope|autocomplete-max-visible)[^/]*\.test\.ts$/,
	/^test\/[^/]*(singleton|global-state|fake-timer)[^/]*\.test\.ts$/,
];

const codingAgentUiPathPatterns = [
	/^test\/modes\//,
	/^test\/(interactive-mode|main-interactive|input-controller|streaming|status-line|keybindings|editor|hook|theme|setup-wizard|job-renderer|tool-args-reveal|tool-execution)[^/]*\.test\.ts$/,
	/^src\/modes\/components\//,
];

const codingAgentRuntimePathPatterns = [
	/^test\/agent-session[^/]*\.test\.ts$/,
	/^test\/(acp|mcp|rpc|sdk)[^/]*\.test\.ts$/,
	/^test\/(session|session-manager|task|collab|internal-urls)\//,
	/^test\/session[^/]*\.test\.ts$/,
	/^test\/session-manager[^/]*\.test\.ts$/,
	/^test\/(extensions?|plugin|autolearn|skills|marketplace|oauth)[^/]*\.test\.ts$/,
	/^test\/[^/]*oauth[^/]*\.test\.ts$/,
	/^test\/(extensibility|discovery|tool-discovery|goals|marketplace)\//,
	/^test\/(model|model-|model-registry|model-resolver|compaction)[^/]*\.test\.ts$/,
];

const codingAgentNativeContentMarkers = [
	"@veyyon/natives",
	"veyyon-natives",
	"native",
	"readImageMetadata",
	"Bun.spawn",
	"Bun.spawnSync",
	"child_process",
	"Bun.serve",
	"new Worker",
	"Worker(",
	"puppeteer",
	"bun:sqlite",
	"Redis",
	"redis",
	"WebSocket",
];

const codingAgentSingletonContentMarkers = [
	"Settings.init(",
	"Settings.instance",
	"resetSettingsForTest",
	"setAgentDir(",
	"vi.useFakeTimers(",
	"vi.useRealTimers(",
	"vi.stubEnv(",
	"vi.unstubAllEnvs(",
];

const codingAgentSingletonContentPatterns = [
	/(^|[^\w$.])(process\.env|Bun\.env)\.[A-Za-z0-9_]+\s*=/,
	/(^|[^\w$.])(process\.env|Bun\.env)\[[^\]]+\]\s*=/,
	/delete\s+(process\.env|Bun\.env)(\.[A-Za-z0-9_]+|\[[^\]]+\])/,
	/Object\.assign\((process\.env|Bun\.env),/,
];

const codingAgentUiContentMarkers = [
	"@veyyon/tui",
	"InteractiveMode",
	"InputController",
	"StatusLine",
	"ToolExecutionComponent",
	"render(",
	"renderToString",
];

const codingAgentRuntimeContentMarkers = ["AgentSession", "SessionManager", "AuthStorage", "Bun.sleep", "setTimeout("];

let codingAgentTestPartitionPromise: Promise<CodingAgentTestPartition> | null = null;

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) {
		return value;
	}
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

// Per-package bun-test args applied in every mode. hashline's large-base scale
// suites (`apply-edits-past-6000-*`) do an O(range) operation per sampled anchor
// — a `DEL 1.=k` prefix delete expands to k edits — so a single `it` can run a
// few seconds on a slow CI runner, above bun's 5s per-test default. packages/ai
// carries several `numRuns: 10_000` fast-check property suites (tool-argument
// normalization/idempotence): a synchronous `fc.assert` blocks the event loop
// for the whole run, so bun's default 5s timeout is only checked after the run
// completes and cannot interrupt it — under `--parallel=8` on a loaded runner a
// 10k-run property that is ~1.5s uncontended is CPU-starved past 5s and fails
// the bucket, which skips the release publish. A larger per-test timeout gives
// those legitimately-heavy tests headroom without masking a hang: the ci-test-ts
// 600s bucket watchdog still bounds the whole run. (The single extreme outlier,
// the 10k deeply-nested-tree idempotence property that hit ~20s, carries its own
// explicit 120s per-test override in the suite; this floor covers the rest.)
const workspacePackageExtraArgs: Record<string, string[]> = {
	"packages/hashline": ["--timeout", "20000"],
	"packages/ai": ["--timeout", "20000"],
};

function workspaceTestCommand(
	pkg: string,
	parallel: number,
	options: { extraArgs?: string[]; smol?: boolean } = {},
): TestCommand {
	const { extraArgs = [], smol = false } = options;
	// `--smol` runs the test process with a smaller heap. The native/TUI/integration
	// bucket asks for it because those suites load the native addon and browser-ish
	// modules; without it a fat single invocation can OOM-kill (reported as exit 137).
	const perPackageArgs = workspacePackageExtraArgs[pkg] ?? [];
	return {
		label: pkg,
		cwd: pkg,
		command: [
			"bun",
			"test",
			...preloadArgs,
			...(smol ? ["--smol"] : []),
			`--parallel=${parallel}`,
			...perPackageArgs,
			...extraArgs,
		],
	};
}

// The Rust suite as one pooled command, so root `bun run test` reports TS and
// Rust under the same progress stream / failure report. Delegates to
// run-rs-task.ts, which self-skips when no Rust-affecting files changed locally
// (printing a one-line notice) and resolves the cargo/nextest invocation.
function rustTestCommand(): TestCommand {
	return {
		label: "rust (cargo nextest; skipped if no Rust changes)",
		cwd: ".",
		command: ["bun", "scripts/run-rs-task.ts", "test:rs"],
	};
}

async function collectTestsUnder(root: string, baseDir: string): Promise<string[]> {
	const entries = await fs.readdir(root, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		const filePath = path.join(root, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await collectTestsUnder(filePath, baseDir)));
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith(".test.ts")) {
			continue;
		}
		files.push(path.relative(baseDir, filePath).split(path.sep).join("/"));
	}
	return files;
}

function hasAnyMarker(content: string, markers: string[]): boolean {
	return markers.some(marker => content.includes(marker));
}

function matchesAnyPath(testFile: string, patterns: RegExp[]): boolean {
	return patterns.some(pattern => pattern.test(testFile));
}

function matchesAnyContentPattern(content: string, patterns: RegExp[]): boolean {
	return patterns.some(pattern => pattern.test(content));
}
// Native/tooling tests are classified first because they need the lowest
// concurrency; all coding-agent buckets run with the native addon available in CI.
function classifyCodingAgentTest(testFile: string, content: string): CodingAgentBucket {
	if (
		matchesAnyPath(testFile, codingAgentNativePathPatterns) ||
		hasAnyMarker(content, codingAgentNativeContentMarkers)
	) {
		return "native";
	}
	if (matchesAnyPath(testFile, codingAgentUiPathPatterns) || hasAnyMarker(content, codingAgentUiContentMarkers)) {
		return "ui";
	}
	if (
		matchesAnyPath(testFile, codingAgentSingletonPathPatterns) ||
		hasAnyMarker(content, codingAgentSingletonContentMarkers) ||
		matchesAnyContentPattern(content, codingAgentSingletonContentPatterns)
	) {
		return "singleton";
	}
	if (
		matchesAnyPath(testFile, codingAgentRuntimePathPatterns) ||
		hasAnyMarker(content, codingAgentRuntimeContentMarkers)
	) {
		return "runtime";
	}
	return "native";
}

async function getCodingAgentTestPartition(): Promise<CodingAgentTestPartition> {
	codingAgentTestPartitionPromise ??= (async () => {
		const codingAgentDir = path.join(repoRoot, "packages/coding-agent");
		const testFiles = [
			...(await collectTestsUnder(path.join(codingAgentDir, "test"), codingAgentDir)),
			...(await collectTestsUnder(path.join(codingAgentDir, "src"), codingAgentDir)),
		].sort();
		const partition: CodingAgentTestPartition = {
			singleton: [],
			ui: [],
			runtime: [],
			native: [],
		};

		for (const testFile of testFiles) {
			const content = await Bun.file(path.join(codingAgentDir, testFile)).text();
			partition[classifyCodingAgentTest(testFile, content)].push(testFile);
		}

		return partition;
	})();
	return codingAgentTestPartitionPromise;
}

async function codingAgentTestCommands(bucket: CodingAgentBucket): Promise<TestCommand[]> {
	const partition = await getCodingAgentTestPartition();
	const testFiles = partition[bucket];
	if (testFiles.length === 0) {
		throw new Error(`No coding-agent ${bucket} tests matched`);
	}
	const plan = codingAgentBucketPlans[bucket];
	const chunkSize = plan.chunkSize ?? testFiles.length;
	const chunkCount = Math.ceil(testFiles.length / chunkSize);
	const commands: TestCommand[] = [];
	for (let i = 0; i < testFiles.length; i += chunkSize) {
		const chunk = testFiles.slice(i, i + chunkSize);
		const chunkLabel = chunkCount > 1 ? ` chunk ${commands.length + 1}/${chunkCount}` : "";
		commands.push({
			label: `packages/coding-agent (${plan.label}; ${testFiles.length} files; parallel=${plan.parallel}${chunkLabel}; ${chunk.length} files)`,
			cwd: "packages/coding-agent",
			command: ["bun", "test", ...preloadArgs, `--parallel=${plan.parallel}`, ...onlyFailuresArgs, ...chunk],
		});
	}
	return commands;
}

async function commandsForMode(mode: Mode): Promise<TestCommand[]> {
	switch (mode) {
		// `workspace` is packages only. It used to append its own hardcoded list of 15
		// script tests, which made it the only bucket CI ran that touched scripts at all,
		// and left the other 69 in `repoScriptTests` running nowhere. The dedicated
		// `test_scripts` job runs the full list now, so this bucket no longer keeps a
		// second copy to go stale.
		case "workspace":
			return fastWorkspacePackages.map(pkg => workspaceTestCommand(pkg, 8));
		case "native":
			return nativeAndIntegrationPackages.map(pkg => workspaceTestCommand(pkg, 4, { smol: true }));
		case "coding-agent-singleton":
			return await codingAgentTestCommands("singleton");
		case "coding-agent-ui":
			return await codingAgentTestCommands("ui");
		case "coding-agent-runtime":
			return await codingAgentTestCommands("runtime");
		case "coding-agent-native":
			return await codingAgentTestCommands("native");
		case "coding-agent-heavy":
			return [
				...(await codingAgentTestCommands("singleton")),
				...(await codingAgentTestCommands("ui")),
				...(await codingAgentTestCommands("runtime")),
				...(await codingAgentTestCommands("native")),
			];
		// `all` has to mean all. It previously reached the 15 script tests only as a
		// side effect of `workspace` carrying them, so pulling that copy out would have
		// quietly emptied scripts from `all` as well. It names the bucket directly now.
		case "all":
			return [
				...(await commandsForMode("workspace")),
				...(await commandsForMode("native")),
				...(await commandsForMode("coding-agent-heavy")),
				...(await commandsForMode("scripts")),
			];
		// `local-ts` is the full local TypeScript run that root `bun run test:ts`
		// drives: every package the old `--workspaces` fan-out covered (the CI
		// `all` set PLUS veybot-web, which CI omits) and every repo
		// script test, routed through this one quiet runner so the whole suite
		// shares one progress stream and one failure report.
		// `scripts` runs only the repo-level script suites. Root `test:scripts`
		// delegates here rather than repeating the file list: two hand-maintained
		// lists of which script tests to run is how one of them goes stale, and the
		// stale one had 7 of the 32 entries.
		case "scripts":
			return [scriptTestCommand()];
		case "local-ts":
			return [
				...fastWorkspacePackages.map(pkg => workspaceTestCommand(pkg, 8, { extraArgs: onlyFailuresArgs })),
				...nativeAndIntegrationPackages.map(pkg =>
					workspaceTestCommand(pkg, 4, { extraArgs: onlyFailuresArgs, smol: true }),
				),
				...localOnlyWorkspacePackages.map(pkg => workspaceTestCommand(pkg, 4, { extraArgs: onlyFailuresArgs })),
				...(await commandsForMode("coding-agent-heavy")),
				scriptTestCommand(),
			];
		// `local` is what root `bun run test` drives: the full TS suite plus the
		// Rust task, so a single invocation reports TS and Rust together. The Rust
		// command self-skips when no Rust-affecting files changed (see run-rs-task).
		case "local":
			return [...(await commandsForMode("local-ts")), rustTestCommand()];
	}
}

// A CI runner or dev host may carry sccache S3 credentials (`AWS_*`) and config
// (`SCCACHE_*`) in the environment, GitHub Actions injects `GITHUB_TOKEN`, and a
// host may carry provider API keys. Any of these make env-sensitive code
// non-deterministic in tests — e.g. leaked AWS creds make `amazon-bedrock` look
// authenticated and win the provider startup fallback over `anthropic`. Run the
// suites in a hermetic environment with all credential / cloud-config variables
// stripped so resolution depends only on the test's own fixtures.
const SCRUBBED_ENV_PREFIXES = ["AWS_", "SCCACHE_", "GOOGLE_CLOUD_"];
const SCRUBBED_ENV_NAMES = new Set([
	"RUSTC_WRAPPER",
	"GITHUB_TOKEN",
	"GH_TOKEN",
	"COPILOT_GITHUB_TOKEN",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"ANTHROPIC_OAUTH_TOKEN",
	"XAI_OAUTH_TOKEN",
]);

function isScrubbedEnvVar(key: string): boolean {
	if (SCRUBBED_ENV_NAMES.has(key)) {
		return true;
	}
	if (SCRUBBED_ENV_PREFIXES.some(prefix => key.startsWith(prefix))) {
		return true;
	}
	// Any provider credential, e.g. ANTHROPIC_API_KEY / XAI_OAUTH_TOKEN / bedrock bearer.
	return /_(API_KEY|OAUTH_TOKEN)$/.test(key) || key.includes("BEARER_TOKEN");
}

async function runTestCommand(testCommand: TestCommand): Promise<void> {
	const cwd = path.join(repoRoot, testCommand.cwd);
	const renderedCommand = testCommand.command.map(shellQuote).join(" ");
	console.log(`\n==> ${testCommand.label}`);
	console.log(`$ ${renderedCommand}`);

	if (isDryRun) {
		return;
	}

	const env = buildChildEnv();
	const proc = Bun.spawn(testCommand.command, {
		cwd,
		env,
		stdout: "inherit",
		stderr: "inherit",
	});
	const killTimer = setTimeout(() => proc.kill("SIGKILL"), chunkTimeoutMs());
	const exitCode = await proc.exited;
	clearTimeout(killTimer);
	if (exitCode !== 0) {
		const files = chunkTestFiles(renderedCommand);
		const composition = files.length > 1 ? `\n${files.length} files in this chunk:\n  ${files.join("\n  ")}` : "";
		throw new Error(`${testCommand.label} failed with exit code ${exitCode}: ${renderedCommand}${composition}`);
	}
}

// Child env shared by every spawned test process: the parent env with all CI
// credential / cloud-config variables scrubbed (see SCRUBBED_ENV_* above) and
// GITHUB_ACTIONS cleared so suites resolve only against their own fixtures.
//
// GC knobs (both needed — they gate different JSC mechanisms):
// - `BUN_JSC_useConcurrentGC=0` stops the collector from marking concurrently
//   with the mutator (868789972, an earlier GC crash under bun test).
// - `BUN_JSC_numberOfGCMarkers=1` removes the ParallelHelperPool marker
//   threads. Bun 1.3.14 segfaults/aborts inside parallel marking
//   (`DOMGCOutputConstraint::executeImplImpl` → `visitOutputConstraints` on a
//   dead cell; also "Pure virtual function called!") on heap-heavy
//   coding-agent chunks (~1.3GB RSS, native ghostty-vt cells). Repro: UI
//   bucket chunk crashed ~25% of runs with `BUN_JSC_forceRAMSize=256MB`,
//   0/10 with markers=1, at zero measured wall-time cost. useConcurrentGC=0
//   alone did not prevent it — the crash predates this knob.
function buildChildEnv(): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {
		...Bun.env,
		GITHUB_ACTIONS: "",
		BUN_JSC_useConcurrentGC: "0",
		BUN_JSC_numberOfGCMarkers: "1",
		HOME: SANDBOX_HOME,
		VEYYON_TEST_REAL_CONFIG_ROOT: REAL_CONFIG_ROOT,
	};
	for (const key of Object.keys(env)) {
		if (isScrubbedEnvVar(key)) {
			delete env[key];
		}
	}
	return env;
}

// Per-chunk watchdog. A bun child that wedges (e.g. the panic handler
// deadlocking after a GC crash) would otherwise stall the whole run: the
// parallel path awaits the child's stdout/stderr pipes, which stay open as
// long as the wedged process — or any grandchild that inherited them — lives.
// After this many seconds the child is SIGKILLed and reported as a failure.
// Override with VEYYON_TEST_CHUNK_TIMEOUT (seconds).
function chunkTimeoutMs(): number {
	const raw = Number(Bun.env.VEYYON_TEST_CHUNK_TIMEOUT?.trim());
	if (Number.isFinite(raw) && raw >= 1) return raw * 1000;
	return 600_000;
}

// The standard `CI` signal is authoritative. In CI each bucket is its own
// memory-capped runner job (a single fat invocation gets OOM-killed at 137), so
// chunks run sequentially within a job and parallelism happens across jobs.
// Locally we trade memory for wall-clock and fan the chunks out across cores.
function isCI(): boolean {
	const value = Bun.env.CI;
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	return normalized !== "" && normalized !== "0" && normalized !== "false";
}

// Fan-out width for the local parallel path, clamped to the command count.
// Defaults to the machine's available parallelism; `VEYYON_TEST_CONCURRENCY`
// overrides it — a positive integer to pick an exact width (dial down on a
// memory-constrained laptop), or `all`/`max` to launch every chunk at once.
export function testConcurrency(total: number): number {
	const raw = Bun.env.VEYYON_TEST_CONCURRENCY?.trim().toLowerCase();
	if (raw === "all" || raw === "max") {
		return total;
	}
	const override = Number(raw);
	if (Number.isFinite(override) && override >= 1) {
		return Math.min(Math.floor(override), total);
	}
	// Sequential by DEFAULT, including on a developer machine. This used to fan out
	// to os.availableParallelism() chunks, and each chunk is itself a `bun test`
	// process that spawns further children, so on a many-core workstation a full run
	// drove the load average past 80 and made the machine unusable while it ran.
	// Saturating every core is the wrong default for a command someone runs while
	// still working on that same machine. Opt into fanout with
	// VEYYON_TEST_CONCURRENCY=<n> (or `all`), which is what CI should set.
	return 1;
}

// ANSI styling for interactive runs only; disabled when stdout is not a TTY or
// NO_COLOR is set, so CI logs and piped/aggregated output stay plain text.
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code: string, value: string): string => (useColor ? `\x1b[${code}m${value}\x1b[0m` : value);
const style = {
	green: (s: string) => paint("32", s),
	red: (s: string) => paint("31", s),
	bold: (s: string) => paint("1", s),
	dim: (s: string) => paint("2", s),
};

// Outcome of one finished chunk. `output` is the chunk's combined stdout+stderr,
// buffered so it can be withheld during a quiet run and replayed only on failure.
interface ChunkOutcome {
	label: string;
	command: string;
	exitCode: number;
	seconds: number;
	output: string;
}

// Human duration in bun's bracket style: `[264ms]` under a second, `[3.3s]`
// above. Used by the progress line and footer so timings read like `bun test`.
function formatDuration(seconds: number): string {
	return seconds < 1 ? `${Math.round(seconds * 1000)}ms` : `${seconds.toFixed(1)}s`;
}

// One-line live progress entry in `bun test` style: `✓ <label> [time]` for a
// pass, `✗ <label> [time]` for a failure (bold red so the eye lands on it in a
// long scroll). A failure also names the first failing test parsed from the
// captured output — `— file > test (+N more)` — so the exact break is visible
// in the stream without waiting for the end-of-run report. Emitted in completion
// order as each chunk finishes.
export function formatProgressLine(outcome: ChunkOutcome): string {
	const time = style.dim(`[${formatDuration(outcome.seconds)}]`);
	if (outcome.exitCode === 0) {
		return `${style.green("✓")} ${outcome.label} ${time}`;
	}
	const failing = extractFailingTests(outcome.output);
	const first = failing[0]?.name;
	const more = failing.length > 1 ? style.dim(` (+${failing.length - 1} more)`) : "";
	const detail = first ? ` ${style.dim("—")} ${style.red(first)}${more}` : "";
	return `${style.bold(style.red(`✗ ${outcome.label}`))} ${time}${detail}`;
}

// Closing tally in `bun test` style, but counting test *chunks* (child commands),
// not individual tests — the runner never parses child summaries. A green
// `N chunks passed` line, a `N failed` line (red when non-zero, dim when clean),
// then the total wall time. Printed after the failure report so a run always
// ends on an at-a-glance verdict.
export function formatSummaryFooter(passed: number, failed: number, totalSeconds: number): string {
	const failLine = failed > 0 ? style.red(`${failed} failed`) : style.dim("0 failed");
	return [
		"",
		` ${style.green(`${passed} chunks passed`)}`,
		` ${failLine}`,
		style.dim(`Ran ${passed + failed} test command(s) in ${formatDuration(totalSeconds)}.`),
	].join("\n");
}

// A single failing test pulled from a chunk's captured bun output: its
// `file > test` identifier and the verbatim failure block bun printed for it
// (source frame, `error:` line, received/expected) — the detail a developer
// needs to act without re-running.
export interface FailingTest {
	name: string;
	detail: string;
}

// Parse the failing tests + their detail blocks out of a chunk's captured bun
// output. Bun emits, per failure, a source code frame and `error:` block
// *followed by* its `(fail) <name> [<time>]` marker, all under the most recent
// `<relative/path>.test.ts:` header. We track the current header, buffer the
// lines since the last marker/header (that's the pending failure's frame), and
// flush them when the `(fail)` line arrives. ANSI is stripped only to classify
// lines; the detail keeps bun's original bytes (incl. color). Returns `[]` when
// the chunk died without per-test markers (e.g. a compile/import crash), so the
// caller can fall back to replaying the raw log.
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const FILE_HEADER_RE = /^(\S.*\.test\.[cm]?[jt]sx?):$/;
const FAIL_MARKER_RE = /^\(fail\)\s+(.*?)(?:\s+\[[\d.]+\s*m?s\])?$/;
export function extractFailingTests(output: string): FailingTest[] {
	const failing: FailingTest[] = [];
	let currentFile = "";
	let buffer: string[] = [];
	for (const raw of output.split("\n")) {
		const line = raw.replace(ANSI_RE, "").trim();
		const header = FILE_HEADER_RE.exec(line);
		if (header) {
			currentFile = header[1];
			buffer = [];
			continue;
		}
		const fail = FAIL_MARKER_RE.exec(line);
		if (fail) {
			failing.push({
				name: currentFile ? `${currentFile} > ${fail[1]}` : fail[1],
				detail: buffer.join("\n").trim(),
			});
			buffer = [];
			continue;
		}
		buffer.push(raw);
	}
	return failing;
}

// Final report for the chunks that failed. Each chunk lists its failing tests,
// and under each test name bun's own failure block (source frame + `error:` +
// received/expected) is reproduced verbatim — caret alignment and diffs intact —
// so it reads like a direct `bun test` failure. In quiet mode (`replayOutput`)
// the blocks are shown because the run withheld them; in verbose mode they
// already streamed inline, so only the names are listed. When a chunk crashed
// without per-test markers (no parseable failures) the raw log is replayed as a
// fallback in quiet mode. The banner repeats below so it stays visible whether
// you scroll to the top or the bottom of the failures.
/**
 * The test files a command was given, extracted from the command itself.
 *
 * A chunk is a slice of a bucket's sorted file list, and WHICH files landed in it
 * is the first thing an investigation needs: a suite that passes alone and fails
 * in chunk 109 is failing because of what else is in that process. The runner used
 * to print the whole command on one line, so recovering the composition meant
 * reconstructing the partition by hand from the runner source, which cost an hour
 * on the mupdf-warnings suite (see the PDF chunk row in BACKLOG.md). The command
 * already carries the answer; nothing needed to be threaded through, only printed.
 */
export function chunkTestFiles(command: string): string[] {
	// Two alternatives because `shellQuote` wraps a path holding a shell character:
	// quoted paths may contain spaces, bare ones may not.
	const pattern = /(?:^|\s)(?:'([^']+\.test\.tsx?)'|([\w./@-]+\.test\.tsx?))(?=\s|$)/g;
	return [...command.matchAll(pattern)].map(match => match[1] ?? match[2]);
}

export function formatChunkFailure(failure: ChunkOutcome, replayOutput: boolean): string {
	const lines: string[] = [];
	lines.push(
		"",
		style.bold(style.red(`✗ ${failure.label} (exit ${failure.exitCode})`)),
		style.dim(`$ ${failure.command}`),
	);
	const files = chunkTestFiles(failure.command);
	// The composition, not just the command: a suite that passes alone and fails here
	// is failing because of what shares its process, and that list is the whole lead.
	if (files.length > 1) {
		lines.push(style.dim(`  ${files.length} files in this chunk:`));
		for (const file of files) lines.push(style.dim(`    ${file}`));
	}
	const failing = extractFailingTests(failure.output);
	// Fully attributed only when every failure carries its own bun block;
	// otherwise (no markers, or a marker with no preceding frame — timeouts,
	// crashes) name what we can and replay the raw log so no error is lost.
	const fullyAttributed = failing.length > 0 && failing.every(test => test.detail.length > 0);
	for (const test of failing) {
		lines.push("", `  ${style.red("✗")} ${style.bold(test.name)}`);
		// Flush-left and verbatim so bun's caret/diff alignment is preserved.
		if (replayOutput && fullyAttributed) {
			lines.push(test.detail);
		}
	}
	if (replayOutput && !fullyAttributed && failure.output.trim().length > 0) {
		lines.push("", failure.output.trimEnd());
	}
	return lines.join("\n");
}

export function formatFailureReport(failures: ChunkOutcome[], total: number, replayOutput: boolean): string {
	const header = `${failures.length} of ${total} test chunk(s) FAILED`;
	const lines: string[] = ["", style.bold(style.red(`━━━ ${header} ━━━`))];
	for (const failure of failures) {
		lines.push(formatChunkFailure(failure, replayOutput));
	}
	lines.push("", style.red(header));
	return lines.join("\n");
}

// Run every command through a fixed-width worker pool. Each child's stdout and
// stderr are drained concurrently (so a chatty test never deadlocks on a full
// pipe) and buffered. Quiet mode (the default) prints one progress line per
// finished chunk and replays full output only for failures, in a single report
// at the end; `--full` streams every chunk's output inline as it completes. All
// failures are collected and reported together instead of failing fast, so one
// run surfaces every broken chunk and exits non-zero without a runner stack trace.
export async function runTestCommandsInParallel(commands: TestCommand[], concurrency: number): Promise<void> {
	const env = buildChildEnv();
	const queue = [...commands];
	const failures: ChunkOutcome[] = [];
	let completed = 0;
	console.log(
		`Running ${commands.length} test command(s), up to ${concurrency} in parallel ` +
			`(VEYYON_TEST_CONCURRENCY=<n>|all to change).`,
	);

	// Incremental, cancellable drain into a mutable sink, so a watchdog-killed
	// chunk still reports whatever the child managed to print before it wedged.
	function drainInto(
		stream: ReadableStream<Uint8Array>,
		sink: { text: string },
	): { done: Promise<void>; cancel: () => void } {
		const decoder = new TextDecoder();
		const reader = stream.getReader();
		const done = (async () => {
			try {
				for (;;) {
					const { done: ended, value } = await reader.read();
					if (ended) break;
					sink.text += decoder.decode(value, { stream: true });
				}
			} catch {
				// cancelled or broken pipe — keep what was captured
			}
			sink.text += decoder.decode();
		})();
		return { done, cancel: () => void reader.cancel().catch(() => {}) };
	}

	// Wait for `promise` at most `ms`; resolves `true` when it settled in time.
	// Never rejects.
	async function settleWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
		const { promise: expired, resolve } = Promise.withResolvers<boolean>();
		const timer = setTimeout(() => resolve(false), ms);
		const settled = await Promise.race([
			promise.then(
				() => true,
				() => true,
			),
			expired,
		]);
		clearTimeout(timer);
		return settled;
	}

	async function worker(): Promise<void> {
		for (;;) {
			const testCommand = queue.shift();
			if (!testCommand) {
				return;
			}
			const renderedCommand = testCommand.command.map(shellQuote).join(" ");
			const startedAt = performance.now();
			const proc = Bun.spawn(testCommand.command, {
				cwd: path.join(repoRoot, testCommand.cwd),
				env,
				stdout: "pipe",
				stderr: "pipe",
			});
			const stdout = { text: "" };
			const stderr = { text: "" };
			const stdoutDrain = drainInto(proc.stdout as ReadableStream<Uint8Array>, stdout);
			const stderrDrain = drainInto(proc.stderr as ReadableStream<Uint8Array>, stderr);
			const drains = Promise.all([stdoutDrain.done, stderrDrain.done]);
			// Watchdog: a wedged child (e.g. bun's panic handler deadlocking
			// after a GC crash) would otherwise hang this worker forever.
			let timedOut = false;
			const killTimer = setTimeout(() => {
				timedOut = true;
				proc.kill("SIGKILL");
			}, chunkTimeoutMs());
			const exitCode = await proc.exited;
			clearTimeout(killTimer);
			// Cap the post-exit drain: a leaked grandchild that inherited the
			// pipes keeps them open indefinitely, and a pending read would keep
			// the runner's event loop alive — cancel the readers instead.
			if (!(await settleWithin(drains, 5000))) {
				stdoutDrain.cancel();
				stderrDrain.cancel();
				await drains;
			}
			completed += 1;
			const outcome: ChunkOutcome = {
				label: testCommand.label,
				command: renderedCommand,
				exitCode,
				seconds: (performance.now() - startedAt) / 1000,
				output: `${stdout.text}${stderr.text}${timedOut ? `\n[watchdog] chunk exceeded ${Math.round(chunkTimeoutMs() / 1000)}s; killed with SIGKILL (VEYYON_TEST_CHUNK_TIMEOUT to change)\n` : ""}`,
			};
			if (quiet) {
				let msg = `${formatProgressLine(outcome)}\n`;
				if (exitCode !== 0 || timedOut) {
					msg += `${formatChunkFailure(outcome, true)}\n`;
				}
				process.stdout.write(msg);
			} else {
				const status = exitCode === 0 ? "ok" : `FAILED exit ${exitCode}`;
				process.stdout.write(
					`\n==> [${completed}/${commands.length}] ${testCommand.label} (${status}, ${outcome.seconds.toFixed(1)}s)\n$ ${renderedCommand}\n${outcome.output}`,
				);
			}
			if (exitCode !== 0 || timedOut) {
				failures.push(outcome);
			}
		}
	}

	const runStartedAt = performance.now();
	await Promise.all(Array.from({ length: concurrency }, () => worker()));

	if (quiet) {
		const totalSeconds = (performance.now() - runStartedAt) / 1000;
		process.stdout.write(
			`${formatSummaryFooter(commands.length - failures.length, failures.length, totalSeconds)}\n`,
		);
	} else if (failures.length > 0) {
		process.stdout.write(style.bold(style.red(`\n${failures.length} of ${commands.length} test chunk(s) FAILED\n`)));
	}
	if (failures.length > 0) {
		process.exitCode = 1;
	}
}

/**
 * Paths under the real config root that a LIVE veyyon session writes to as a
 * matter of course: rotating logs, session transcripts, caches. Excluded on
 * purpose, because the developer often has veyyon running while the suite runs
 * and its ordinary logging would report a violation on every run. A guard that
 * cries wolf is a guard that gets ignored. What stays watched is the surface
 * whose loss is unrecoverable: credential stores, the global config, the install
 * id, and the per-profile databases.
 */
const LIVE_APP_CHURN = ["logs", path.join("agent", "sessions"), "cache", path.join("agent", "cache")];

export function isLiveAppChurn(target: string, root: string = REAL_CONFIG_ROOT): boolean {
	const rel = path.relative(root, target);
	const posix = rel.split(path.sep).join("/");
	if (/^profiles\/[^/]+\/run\/daemons(?:\/|$)/.test(posix)) return true;
	return LIVE_APP_CHURN.some(segment => {
		const seg = segment.split(path.sep).join("/");
		return posix === seg || posix.startsWith(`${seg}/`) || posix.includes(`/${seg}/`) || posix.endsWith(`/${seg}`);
	});
}

export interface LiveVeyyonProcessOwnership {
	pid: number;
	openRealPaths: ReadonlySet<string>;
}

export interface LiveVeyyonOwnershipSnapshot {
	supported: boolean;
	external: readonly LiveVeyyonProcessOwnership[];
	testOwned: readonly LiveVeyyonProcessOwnership[];
}

interface RealConfigDiffOptions {
	/** Boundary snapshots used to prove exact external ownership of SQLite sidecars. */
	ownership?: readonly LiveVeyyonOwnershipSnapshot[];
}

type RealConfigChange = {
	kind: "CREATED" | "DELETED" | "MODIFIED";
	target: string;
};

function sqliteDatabaseForSidecar(target: string): string | undefined {
	const match = /^(.*\.db)-(?:journal|shm|wal)$/.exec(target);
	return match?.[1];
}

function processOwnsDatabaseSidecar(process: LiveVeyyonProcessOwnership, target: string): boolean {
	const database = sqliteDatabaseForSidecar(target);
	return database !== undefined && process.openRealPaths.has(target) && process.openRealPaths.has(database);
}

/**
 * True only when an external Veyyon process held both the exact changed SQLite
 * sidecar and its primary database at a run boundary, with no test-owned process
 * holding the same pair.
 */
export function isExternallyOwnedDatabaseSidecar(
	target: string,
	ownership: readonly LiveVeyyonOwnershipSnapshot[],
): boolean {
	if (ownership.some(snapshot => snapshot.testOwned.some(process => processOwnsDatabaseSidecar(process, target)))) {
		return false;
	}
	return ownership.some(snapshot => snapshot.external.some(process => processOwnsDatabaseSidecar(process, target)));
}

function collectRealConfigChanges(
	before: Map<string, string>,
	after: Map<string, string>,
	options: RealConfigDiffOptions = {},
): RealConfigChange[] {
	const changes: RealConfigChange[] = [];
	for (const [target, fingerprint] of after) {
		const previous = before.get(target);
		if (previous === undefined) changes.push({ kind: "CREATED", target });
		else if (previous !== fingerprint) changes.push({ kind: "MODIFIED", target });
	}
	for (const target of before.keys()) {
		if (!after.has(target)) changes.push({ kind: "DELETED", target });
	}
	return changes
		.filter(change => !options.ownership || !isExternallyOwnedDatabaseSidecar(change.target, options.ownership))
		.sort((left, right) => formatRealConfigChange(left).localeCompare(formatRealConfigChange(right)));
}

function formatRealConfigChange(change: RealConfigChange): string {
	const separator = change.kind === "MODIFIED" ? " " : "  ";
	return `${change.kind}${separator}${change.target}`;
}

/**
 * A fingerprint of every FILE under the real veyyon data directory: path, size and
 * modification time. Contents are deliberately not read; the point is to detect
 * change, and reading real credential files into memory to prove they were not
 * touched would be its own small violation. Directories are not recorded, since
 * creating an empty one is not damage and recording them would flag the parent
 * chain of an ignored churn directory on every run.
 */
export function snapshotRealConfigRoot(root: string = REAL_CONFIG_ROOT): Map<string, string> {
	const snapshot = new Map<string, string>();
	const walk = (dir: string): void => {
		let entries: nodeFs.Dirent[];
		try {
			entries = nodeFs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (isLiveAppChurn(full, root)) continue;
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			try {
				const stat = nodeFs.statSync(full);
				snapshot.set(full, `${stat.size}:${stat.mtimeMs}`);
			} catch {
				snapshot.set(full, "unstattable");
			}
		}
	};
	walk(root);
	return snapshot;
}

function readProcFields(target: string): string[] | undefined {
	try {
		return nodeFs.readFileSync(target, "utf8").split("\0").filter(Boolean);
	} catch {
		return undefined;
	}
}

function isVeyyonCommand(args: readonly string[]): boolean {
	return args.some(arg => {
		const basename = path.basename(arg).toLowerCase();
		const normalized = arg.split(path.sep).join("/");
		return (
			basename === "vey" ||
			basename === "veyyon" ||
			normalized.endsWith("/coding-agent/scripts/veyyon.ts") ||
			normalized.endsWith("/coding-agent/src/cli.ts")
		);
	});
}

function openRealPaths(procDir: string, pid: number, root: string): ReadonlySet<string> {
	const paths = new Set<string>();
	let descriptors: string[];
	try {
		descriptors = nodeFs.readdirSync(path.join(procDir, String(pid), "fd"));
	} catch {
		return paths;
	}
	let cwd: string | undefined;
	try {
		cwd = nodeFs.readlinkSync(path.join(procDir, String(pid), "cwd"));
	} catch {
		cwd = undefined;
	}
	for (const descriptor of descriptors) {
		let target: string;
		try {
			target = nodeFs.readlinkSync(path.join(procDir, String(pid), "fd", descriptor));
		} catch {
			continue;
		}
		if (target.endsWith(" (deleted)")) target = target.slice(0, -" (deleted)".length);
		if (!path.isAbsolute(target)) {
			if (!cwd) continue;
			target = path.resolve(cwd, target);
		}
		const rel = path.relative(root, target);
		if (rel === "" || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`))) {
			paths.add(path.resolve(target));
		}
	}
	return paths;
}

/**
 * Capture exact real-data files held by external Veyyon and test-owned processes.
 *
 * Test ownership comes from the runner's exact environment markers, never from a
 * substring in argv. An unreadable `/proc` yields no ownership proof.
 */
export function scanLiveVeyyonOwnership(
	procDir = "/proc",
	root: string = REAL_CONFIG_ROOT,
	selfPid = process.pid,
	sandboxHome: string = SANDBOX_HOME,
): LiveVeyyonOwnershipSnapshot {
	let entries: string[];
	try {
		entries = nodeFs.readdirSync(procDir);
	} catch {
		return { supported: false, external: [], testOwned: [] };
	}
	const external: LiveVeyyonProcessOwnership[] = [];
	const testOwned: LiveVeyyonProcessOwnership[] = [];
	for (const entry of entries) {
		const pid = Number(entry);
		if (!Number.isInteger(pid) || pid === selfPid) continue;
		const args = readProcFields(path.join(procDir, entry, "cmdline"));
		const environment = readProcFields(path.join(procDir, entry, "environ")) ?? [];
		const ownedByTest =
			environment.includes(`HOME=${sandboxHome}`) || environment.includes(`VEYYON_TEST_REAL_CONFIG_ROOT=${root}`);
		if (!ownedByTest && (!args || !isVeyyonCommand(args))) continue;
		const process = { pid, openRealPaths: openRealPaths(procDir, pid, root) };
		(ownedByTest ? testOwned : external).push(process);
	}
	return { supported: true, external, testOwned };
}

/** Number of external Veyyon processes visible to the ownership scanner. */
export function liveVeyyonProcessCount(procDir = "/proc", selfPid = process.pid): number {
	const ownership = scanLiveVeyyonOwnership(procDir, REAL_CONFIG_ROOT, selfPid);
	return ownership.supported ? ownership.external.length : 1;
}

/** Every relevant path added, removed or modified between two snapshots. */
export function diffRealConfigRoot(
	before: Map<string, string>,
	after: Map<string, string>,
	options: RealConfigDiffOptions = {},
): string[] {
	return collectRealConfigChanges(before, after, options).map(formatRealConfigChange);
}

// Skipped when imported (e.g. by the runner's own unit tests), where
// `process.argv` carries test-file paths rather than a mode/flags.
if (import.meta.main) {
	if (!(requestedMode in validModes)) {
		throw new Error(
			`Unknown mode ${shellQuote(requestedMode)}. Expected one of: ${Object.keys(validModes).join(", ")}`,
		);
	}

	await ensureToolViewsGenerated();
	const testCommands = await commandsForMode(requestedMode as Mode);
	// Outside CI, fan the independent chunk processes out across cores; CI keeps the
	// sequential, fail-fast path so each memory-capped runner job stays bounded.
	// Third protection layer: PROOF. Layers one and two (a sandboxed HOME for every
	// child, and the tripwire preload) are meant to make real-data writes
	// impossible, but a safety mechanism believed to work and never checked is how
	// the original incident happened. Record the real Veyyon directory before the
	// suite and compare it afterwards. Only SQLite sidecars exactly owned by an
	// external Veyyon process at a boundary are attributable. Every other change
	// remains a failure or an explicit unattributable result.
	const ownershipBefore = scanLiveVeyyonOwnership();
	const before = snapshotRealConfigRoot();

	try {
		if (!isDryRun && !isCI() && testCommands.length > 1) {
			await runTestCommandsInParallel(testCommands, testConcurrency(testCommands.length));
		} else {
			for (const testCommand of testCommands) {
				await runTestCommand(testCommand);
			}
		}
	} finally {
		// In `finally` on purpose: a failing or interrupted run is exactly when a
		// half-finished suite is most likely to have left damage behind.
		const ownershipAfter = scanLiveVeyyonOwnership();
		const ownershipEvidenceAvailable = ownershipBefore.supported && ownershipAfter.supported;
		const liveProcessCount = Math.max(
			ownershipBefore.supported ? ownershipBefore.external.length : 1,
			ownershipAfter.supported ? ownershipAfter.external.length : 1,
		);
		const changes = diffRealConfigRoot(before, snapshotRealConfigRoot(), {
			ownership: [ownershipBefore, ownershipAfter],
		});
		if (changes.length > 0) {
			const listing = changes.map(change => `  ${change}\n`).join("");
			if (liveProcessCount > 0) {
				// Exact externally owned SQLite sidecars have already been removed.
				// Anything left cannot be attributed safely, so report it in full
				// without blaming the tests. The preload remains the enforcing layer
				// for writes attempted by a test process.
				process.stderr.write(
					`\nREAL-DATA DIFF (UNATTRIBUTABLE): ${changes.length} path(s) inside ${REAL_CONFIG_ROOT} changed ` +
						(ownershipEvidenceAvailable
							? "while another Veyyon session was running.\n"
							: "and exact process ownership is unavailable on this platform.\n") +
						`${listing}These paths were not exactly owned by an external Veyyon process. ` +
						`Close every Veyyon session and re-run to make the writer unambiguous. ` +
						`A test write through a guarded API also fails immediately in ` +
						`packages/utils/test/helpers/real-data-tripwire.ts.\n`,
				);
			} else {
				process.exitCode = 1;
				process.stderr.write(
					`\nREAL-DATA VIOLATION: the test run modified ${changes.length} path(s) inside ${REAL_CONFIG_ROOT}\n` +
						`${listing}` +
						`No other veyyon session was running, so the tests did this. ` +
						`Tests may only write to temp directories. Find the suite that resolved a real path ` +
						`(see packages/utils/test/helpers/real-data-tripwire.ts) and fix it before trusting these results.\n`,
				);
			}
		}
	}
}
