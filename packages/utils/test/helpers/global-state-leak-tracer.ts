/**
 * Names the test file that leaks process-global state into the tests after it.
 *
 * Why this exists: a full `bun test` run showed about twenty failures that did
 * not reproduce when the same files ran alone, and the failing COUNT moved
 * between runs (twenty, then thirty-three). That is the signature of one earlier
 * test leaving a process global changed — `VEYYON_CONFIG_DIR`, `HOME`, the
 * working directory — so files that run later read somebody else's isolation. The
 * failures land on the victim, never on the leaker, and reading forty candidate
 * files by hand finds nothing, because a leak looks exactly like ordinary setup
 * until you compare before with after.
 *
 * The definition used here: a test leaks when the tracked process-global state
 * after it differs from the state before it. A test that mutates and restores is
 * invisible, which is the point.
 *
 * Bun exposes no current-test name to a hook (`expect.getState()` returns null),
 * so a leak is reported as `file` plus the test's ordinal within the file, and
 * `scripts/test-sandbox/find-test-leaks.ts` runs one file per process to keep `file` exact.
 * That per-file run is also what makes the result order-independent: a file that
 * leaks against its own process baseline leaks wherever it is scheduled.
 *
 * This is NOT in `bunfig.toml`. It is a diagnostic, and paying for a snapshot on
 * every hook of every suite is not worth it once the leaks are fixed.
 */
/**
 * Names excluded from the environment comparison because they move for reasons that
 * are not a test polluting the process.
 *
 * WHY A DENYLIST AND NOT AN ALLOWLIST. This was a list of INTERESTING prefixes
 * (`VEYYON_`, `PI_`, `XDG_`) plus four exact names, which is fail-OPEN: every
 * variable nobody thought of was invisible to the tracer. That is not hypothetical.
 * `test/tools/gh.test.ts` and `test/hindsight-bank.test.ts` each set five `GIT_*`
 * variables at module scope and never restored them, and the tracer reported both
 * files clean, because no `GIT_` entry was on the list. A leak detector whose miss
 * is silent is worse than none: it issues a clean bill for a file it never examined.
 * Diffing the WHOLE environment inverts the failure mode to a noisy report someone
 * triages, and a variable nobody anticipated is caught the first time it moves.
 *
 * Keep this list SHORT. A long denylist is the allowlist problem wearing a different
 * hat: every entry is a class of leak deliberately made invisible again.
 */
export const UNTRACKED_ENV_NAMES: readonly string[] = [
	// The tracer's own bookkeeping, written per traced file by `find-test-leaks.ts`.
	// Not state a test is leaking.
	"VEYYON_LEAK_FILE",
	// The natives loader's variant memo. `packages/natives/native/loader-state.js`
	// publishes its detection verdict here ON PURPOSE so child workers and
	// subprocesses inherit it instead of re-spawning `sysctl` from a context where
	// that spawn can fail (issue #3238). It appears the first time any suite loads
	// natives, which is a cache warming, not a suite polluting the process.
	"__PI_NATIVE_VARIANT_CACHE",
];
/** Set by the reporting script so a leak line can name the file being run. */
export const LEAK_FILE_ENV = "VEYYON_LEAK_FILE";

export interface GlobalSnapshot {
	env: Record<string, string | undefined>;
	cwd: string;
	/** Registered module-state probes, by name. See {@link registerLeakProbe}. */
	probes: Record<string, string | undefined>;
}

/** Reads one piece of module-global state as a comparable string. */
export type LeakProbe = () => string | undefined;

const probes = new Map<string, LeakProbe>();

/**
 * Register a piece of MODULE-global state to compare alongside the environment.
 *
 * Environment variables are only half of what a suite can leave behind. The
 * resolver in `dirs.ts` keeps the active profile, the agent dir and the project
 * dir in module state, and `setProfile("work")` with no restore leaves every later
 * file resolving under `profiles/work/` even when every variable is put back —
 * which is why `enterIsolatedConfigRoot`'s restore re-derives the profile instead
 * of only refreshing paths.
 *
 * A registry rather than direct imports here: this module is imported by
 * `scripts/test-sandbox/find-test-leaks.ts` outside a test runner, so it must not pull in the
 * packages being probed. `global-state-leak-probes.ts` registers the real ones.
 *
 * A probe that throws is recorded as `undefined` rather than crashing the hook: a
 * diagnostic that takes the suite down with it is worse than one blind spot.
 */
export function registerLeakProbe(name: string, read: LeakProbe): void {
	probes.set(name, read);
}

/** Test-only: forget every registered probe, so one test cannot affect the next. */
export function __clearLeakProbesForTests(): void {
	probes.clear();
}

/**
 * Test-only: the current registry, so a test that clears it can put the real probes back.
 *
 * The registry is itself process-global state, and `scripts/test-sandbox/find-test-leaks.test.ts` — the
 * suite that tests this tracer — cleared it and never restored it. The tracer's own
 * file-level check then read an EMPTY registry and reported every module-state probe as
 * `work -> (unset)`, so the leak detector's test suite was reported as a leaker by the
 * leak detector. Clearing and restoring around the assertion is the fix; this is the
 * primitive that makes it possible.
 */
export function __snapshotLeakProbesForTests(): Map<string, LeakProbe> {
	return new Map(probes);
}

/** Test-only: put a registry snapshot back, replacing whatever is registered now. */
export function __restoreLeakProbesForTests(snapshot: Map<string, LeakProbe>): void {
	probes.clear();
	for (const [name, read] of snapshot) probes.set(name, read);
}

/** Reads every registered probe, tolerating a probe that throws. */
function readProbes(): Record<string, string | undefined> {
	const values: Record<string, string | undefined> = {};
	for (const [name, read] of probes) {
		try {
			values[name] = read();
		} catch {
			values[name] = undefined;
		}
	}
	return values;
}

/**
 * The process-global state this tracer compares, as a plain value.
 *
 * Every environment variable is captured except {@link UNTRACKED_ENV_NAMES}, so a
 * variable that is ADDED by a test is a diff just as much as one changed or removed:
 * a suite that exports something new has polluted the process for every file after it.
 * Removal is caught by the key union in {@link diffGlobals} — a name present in the
 * `before` map and absent from `after` reads as `value -> undefined`.
 */
export function snapshotGlobals(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): GlobalSnapshot {
	const tracked: Record<string, string | undefined> = {};
	for (const name of Object.keys(env)) {
		if (UNTRACKED_ENV_NAMES.includes(name)) continue;
		tracked[name] = env[name];
	}
	return { env: tracked, cwd, probes: readProbes() };
}

export interface GlobalDiff {
	key: string;
	before: string | undefined;
	after: string | undefined;
}

/** Every tracked value that changed, sorted so a report is stable across runs. */
export function diffGlobals(before: GlobalSnapshot, after: GlobalSnapshot): GlobalDiff[] {
	const diffs: GlobalDiff[] = [];
	if (before.cwd !== after.cwd) diffs.push({ key: "cwd", before: before.cwd, after: after.cwd });
	for (const key of new Set([...Object.keys(before.env), ...Object.keys(after.env)])) {
		if (before.env[key] !== after.env[key]) {
			diffs.push({ key: `env.${key}`, before: before.env[key], after: after.env[key] });
		}
	}
	for (const key of new Set([...Object.keys(before.probes), ...Object.keys(after.probes)])) {
		if (before.probes[key] !== after.probes[key]) {
			diffs.push({ key: `state.${key}`, before: before.probes[key], after: after.probes[key] });
		}
	}
	return diffs.sort((a, b) => a.key.localeCompare(b.key));
}

/** A test that ended with the state different from how it started. */
export interface StateMove {
	/** 1-based position of the test within its file, since Bun exposes no name. */
	testIndex: number;
	diffs: GlobalDiff[];
}

/**
 * One leaking FILE: state the file left changed after all of its hooks had run.
 *
 * The verdict is deliberately per file, not per test. A suite may move a global
 * between its own tests on purpose and put it back in `afterAll` —
 * `logger-file-transport-rebind` moves the config root three times because
 * following the move IS the behaviour under test — and that suite pollutes
 * nothing. What breaks other files is state still changed when the file is done.
 *
 * `moves` is kept as localization: once a file is known dirty, the test that
 * first changed each variable is where to look.
 */
export interface LeakReport {
	file: string;
	diffs: GlobalDiff[];
	moves: StateMove[];
}

/** Marker the reporting script greps for, one line of JSON per leak. */
export const LEAK_LINE_PREFIX = "VEYYON_TEST_LEAK ";

/** Renders a leak as the single line the script parses. */
export function formatLeak(leak: LeakReport): string {
	return LEAK_LINE_PREFIX + JSON.stringify(leak);
}

/** Reads a leak back out of a runner's output, ignoring every other line. */
export function parseLeaks(output: string): LeakReport[] {
	const leaks: LeakReport[] = [];
	for (const line of output.split("\n")) {
		const at = line.indexOf(LEAK_LINE_PREFIX);
		if (at === -1) continue;
		leaks.push(JSON.parse(line.slice(at + LEAK_LINE_PREFIX.length)) as LeakReport);
	}
	return leaks;
}

/**
 * The comparison, as a reusable object so the preload stays a few lines and the
 * logic can be driven directly by a test.
 *
 * Deliberately not registering `beforeEach`/`afterEach` in this module:
 * `scripts/test-sandbox/find-test-leaks.ts` imports it to parse leak lines, and `bun:test`
 * hooks throw when the importing process is not the test runner.
 *
 * `enter`/`leave` bracket each test and record the moves; `finish` runs after the
 * file's own `afterAll` and is what decides whether the file leaked.
 */
export function createLeakWatcher(
	file: string,
	report: (line: string) => void = line => console.error(line),
): { enter(): void; leave(): void; finish(): void } {
	let testIndex = 0;
	let before: GlobalSnapshot | undefined;
	// The process baseline, taken when the preload is loaded — before the test file
	// is even imported, so the file's own module-level setup and its `beforeAll`
	// both count as the file's doing. Taking it at the first `beforeEach` instead
	// was wrong in a way that produced a confident false positive:
	// `logger-file-transport-rebind` sets its first config root in `beforeAll` and
	// restores the ORIGINAL value in `afterAll`, so the late baseline made a
	// correct restore look like the file had unset the variable.
	const baseline = snapshotGlobals();
	const moves: StateMove[] = [];
	return {
		enter() {
			testIndex += 1;
			before = snapshotGlobals();
		},
		leave() {
			if (!before) return;
			const diffs = diffGlobals(before, snapshotGlobals());
			before = undefined;
			if (diffs.length > 0) moves.push({ testIndex, diffs });
		},
		finish() {
			const diffs = diffGlobals(baseline, snapshotGlobals());
			if (diffs.length === 0) return;
			// Reported rather than thrown: a thrown error here is attributed to the file
			// as a test failure, and the runner script could no longer tell a leak from a
			// suite that fails for its own reasons.
			report(formatLeak({ file, diffs, moves }));
		},
	};
}
