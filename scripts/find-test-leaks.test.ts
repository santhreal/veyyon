/**
 * The process-global leak tracer and the script that drives it.
 *
 * Why this suite exists: a full `bun test` run showed about twenty failures that
 * did not reproduce when the same files ran alone, and the failing COUNT moved
 * between runs (twenty, then thirty-three). Every file shares one process, so a
 * suite that sets `VEYYON_CONFIG_DIR`, `HOME`, or the working directory and never
 * restores it hands its roots to every file scheduled after it. The failures land
 * on the victims, so reading the failing files finds nothing and the real cause
 * went unlocated for two days.
 *
 * A tool that reports leaks is only useful if it cannot cry wolf and cannot stay
 * quiet, so both directions are pinned here: a suite that mutates and restores
 * must produce NO finding, and a suite that leaves one variable behind must be
 * named with the variable, its before value, and its after value. The
 * end-to-end tests drive the real script over a fixture suite that leaks on
 * purpose.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	__clearLeakProbesForTests,
	__restoreLeakProbesForTests,
	__snapshotLeakProbesForTests,
	createLeakWatcher,
	diffGlobals,
	formatLeak,
	LEAK_FILE_ENV,
	LEAK_LINE_PREFIX,
	parseLeaks,
	registerLeakProbe,
	snapshotGlobals,
	UNTRACKED_ENV_NAMES,
} from "../packages/utils/test/helpers/global-state-leak-tracer";
import { testFilesUnder, traceFile } from "./find-test-leaks";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const LEAKY_FIXTURE = "packages/utils/test/fixtures/leaky-suite.fixture.ts";

describe("snapshotGlobals", () => {
	/**
	 * EVERY variable is captured, not a list of interesting ones. The allowlist this
	 * replaced (`VEYYON_`/`PI_`/`XDG_` plus four names) was fail-OPEN: five `GIT_*`
	 * variables left set by `gh.test.ts` were invisible to the tracer because nobody
	 * had thought to add `GIT_`, and the file was reported clean.
	 *
	 * `env` and `cwd` are asserted, and `probes` deliberately is not: which probes are
	 * registered depends on whether this file was loaded with the tracer preload, and an
	 * assertion on the whole snapshot object passed alone and failed under the preload —
	 * order-dependence in the suite that exists to find order-dependence.
	 */
	it("captures every variable, including ones no allowlist would have named", () => {
		const snapshot = snapshotGlobals(
			{ VEYYON_CONFIG_DIR: "/a", GIT_CONFIG_GLOBAL: "/dev/null", UNRELATED: "/d", HOME: "/h" },
			"/cwd",
		);

		expect(snapshot.cwd).toBe("/cwd");
		expect(snapshot.env).toEqual({
			VEYYON_CONFIG_DIR: "/a",
			GIT_CONFIG_GLOBAL: "/dev/null",
			UNRELATED: "/d",
			HOME: "/h",
		});
	});

	/** The denylist is the only thing excluded, and it is deliberately tiny. */
	it("excludes exactly the denylisted names", () => {
		const env: NodeJS.ProcessEnv = { KEPT: "yes" };
		for (const name of UNTRACKED_ENV_NAMES) env[name] = "moves for its own reasons";

		expect(snapshotGlobals(env, "/cwd").env).toEqual({ KEPT: "yes" });
	});

	/**
	 * A suite that EXPORTS something new has polluted the process just as surely as one
	 * that changed or deleted a variable, and the allowlist could not see it unless the
	 * new name happened to match a tracked prefix.
	 */
	it("reports a variable the file added, not only ones it changed or removed", () => {
		const diffs = diffGlobals(snapshotGlobals({}, "/cwd"), snapshotGlobals({ GIT_ASKPASS: "true" }, "/cwd"));

		expect(diffs).toEqual([{ key: "env.GIT_ASKPASS", before: undefined, after: "true" }]);
	});

	/**
	 * A deletion is visible through the key union rather than through pre-seeded keys:
	 * the name is present on the `before` side, absent on the `after` side, and reads as
	 * `value -> undefined`. This is the exact shape of leak the tool exists for — the
	 * pre-fix `gh.test.ts` deleted `XDG_CONFIG_HOME` and never put it back.
	 */
	it("reports a variable the file deleted", () => {
		const diffs = diffGlobals(snapshotGlobals({ HOME: "/h" }, "/cwd"), snapshotGlobals({}, "/cwd"));

		expect(diffs).toEqual([{ key: "env.HOME", before: "/h", after: undefined }]);
	});

	/** The tracer's own bookkeeping variable is not state under test. */
	it("does not track its own file marker", () => {
		expect(snapshotGlobals({ [LEAK_FILE_ENV]: "some/file.test.ts" }, "/cwd").env[LEAK_FILE_ENV]).toBeUndefined();
	});
});

describe("registerLeakProbe", () => {
	/**
	 * The registry is process-global state like anything else. These tests clear it to
	 * assert on a known probe set, and without putting it back the tracer's own file-level
	 * check reads an empty registry and reports every module-state probe as
	 * `work -> (unset)` — the leak detector reporting its own test suite as a leaker, which
	 * is exactly what happened before this hook existed.
	 */
	const registered = __snapshotLeakProbesForTests();
	afterEach(() => {
		__restoreLeakProbesForTests(registered);
	});

	/**
	 * Module state is the half an environment snapshot cannot see. `setProfile("x")`
	 * records the active profile in module state, so a suite can put every variable
	 * back and still leave every later file resolving under `profiles/x/` — which is
	 * exactly why `enterIsolatedConfigRoot`'s restore re-derives the profile instead
	 * of only refreshing paths.
	 */
	it("includes a registered probe in the snapshot and in the diff", () => {
		__clearLeakProbesForTests();
		let profile = "default";
		registerLeakProbe("activeProfile", () => profile);
		const before = snapshotGlobals({}, "/cwd");
		profile = "work";
		const after = snapshotGlobals({}, "/cwd");

		expect(before.probes).toEqual({ activeProfile: "default" });
		expect(diffGlobals(before, after)).toEqual([{ key: "state.activeProfile", before: "default", after: "work" }]);
		__clearLeakProbesForTests();
	});

	/** A diagnostic must not take the suite down with it, so a throwing probe is one
	 *  blind spot rather than a crashed hook. */
	it("records a throwing probe as undefined instead of crashing", () => {
		__clearLeakProbesForTests();
		registerLeakProbe("explodes", () => {
			throw new Error("the resolver is mid-rebuild");
		});

		expect(snapshotGlobals({}, "/cwd").probes).toEqual({ explodes: undefined });
		__clearLeakProbesForTests();
	});
});

describe("diffGlobals", () => {
	it("reports nothing when the state is unchanged", () => {
		const state = snapshotGlobals({ VEYYON_CONFIG_DIR: "/a" }, "/cwd");

		expect(diffGlobals(state, state)).toEqual([]);
	});

	/** A suite that `process.chdir()`s and does not return breaks every relative
	 *  path in the files after it, so the working directory is tracked too. */
	it("reports a changed working directory", () => {
		const diffs = diffGlobals(snapshotGlobals({}, "/before"), snapshotGlobals({}, "/after"));

		expect(diffs).toEqual([{ key: "cwd", before: "/before", after: "/after" }]);
	});

	/** Sorted output, so a report of several leaks is comparable between runs. */
	it("sorts diffs by key", () => {
		const diffs = diffGlobals(
			snapshotGlobals({ XDG_CONFIG_HOME: "/x1", VEYYON_CONFIG_DIR: "/v1" }, "/c1"),
			snapshotGlobals({ XDG_CONFIG_HOME: "/x2", VEYYON_CONFIG_DIR: "/v2" }, "/c2"),
		);

		expect(diffs.map(diff => diff.key)).toEqual(["cwd", "env.VEYYON_CONFIG_DIR", "env.XDG_CONFIG_HOME"]);
	});
});

describe("createLeakWatcher", () => {
	/** Nothing is reported until the file is over: the verdict is per file. */
	it("says nothing about a test that restores what it changed", () => {
		const reported: string[] = [];
		const watcher = createLeakWatcher("f.test.ts", line => reported.push(line));

		watcher.enter();
		process.env.VEYYON_LEAK_WATCHER_PROBE = "changed";
		delete process.env.VEYYON_LEAK_WATCHER_PROBE;
		watcher.leave();
		watcher.finish();

		expect(reported).toEqual([]);
	});

	/**
	 * A suite that moves a global between its own tests and puts it back before the
	 * file ends pollutes nothing. Reporting it was a real false positive: the
	 * per-test rule flagged `logger-file-transport-rebind` five times for moving the
	 * config root, which is the behaviour that suite exists to test.
	 */
	it("says nothing when the file restores the state before it ends", () => {
		const reported: string[] = [];
		const watcher = createLeakWatcher("mover.test.ts", line => reported.push(line));

		watcher.enter();
		process.env.VEYYON_LEAK_WATCHER_PROBE = "first";
		watcher.leave();
		watcher.enter();
		process.env.VEYYON_LEAK_WATCHER_PROBE = "second";
		watcher.leave();
		delete process.env.VEYYON_LEAK_WATCHER_PROBE; // the file's afterAll
		watcher.finish();

		expect(reported).toEqual([]);
	});

	/** THE contract: a leak names the file, the variable and both values. */
	it("reports the file, the variable and both values", () => {
		const reported: string[] = [];
		const watcher = createLeakWatcher("leaky.test.ts", line => reported.push(line));

		watcher.enter();
		process.env.VEYYON_LEAK_WATCHER_PROBE = "left-behind";
		watcher.leave();
		watcher.finish();
		delete process.env.VEYYON_LEAK_WATCHER_PROBE;

		expect(reported).toHaveLength(1);
		expect(parseLeaks(reported[0])).toEqual([
			{
				file: "leaky.test.ts",
				diffs: [{ key: "env.VEYYON_LEAK_WATCHER_PROBE", before: undefined, after: "left-behind" }],
				moves: [
					{
						testIndex: 1,
						diffs: [{ key: "env.VEYYON_LEAK_WATCHER_PROBE", before: undefined, after: "left-behind" }],
					},
				],
			},
		]);
	});

	/**
	 * The per-test trail is how a leak is localized inside a file, since Bun exposes
	 * no current-test name to a hook. A counter that did not advance would point
	 * every move at the first test.
	 */
	it("counts tests so the trail says which one changed the variable", () => {
		const reported: string[] = [];
		const watcher = createLeakWatcher("leaky.test.ts", line => reported.push(line));

		watcher.enter();
		watcher.leave(); // clean test #1
		watcher.enter();
		process.env.VEYYON_LEAK_WATCHER_PROBE = "from-second";
		watcher.leave();
		watcher.finish();
		delete process.env.VEYYON_LEAK_WATCHER_PROBE;

		expect(parseLeaks(reported.join("\n"))[0].moves.map(move => move.testIndex)).toEqual([2]);
	});

	/** `leave()` without a matching `enter()` must not compare against a stale
	 *  snapshot and invent a move from the previous test's state. */
	it("ignores a leave with no enter", () => {
		const reported: string[] = [];
		const watcher = createLeakWatcher("f.test.ts", line => reported.push(line));

		watcher.leave();
		watcher.finish();

		expect(reported).toEqual([]);
	});
});

describe("parseLeaks", () => {
	/** Leak lines share the runner's output with everything else it prints. */
	it("picks leak lines out of surrounding runner output", () => {
		const output = [
			"bun test v1.3.14",
			formatLeak({ file: "a.test.ts", diffs: [{ key: "cwd", before: "/a", after: "/b" }], moves: [] }),
			" 12 pass",
		].join("\n");

		expect(parseLeaks(output)).toEqual([
			{ file: "a.test.ts", diffs: [{ key: "cwd", before: "/a", after: "/b" }], moves: [] },
		]);
	});

	/** A line that merely mentions the marker mid-line is still parsed, because the
	 *  runner prefixes stderr output with its own decoration. */
	it("parses a leak line that is not at the start of the line", () => {
		expect(parseLeaks(`stderr | ${formatLeak({ file: "b.test.ts", diffs: [], moves: [] })}`)[0].file).toBe(
			"b.test.ts",
		);
	});

	it("returns nothing for output with no leaks", () => {
		expect(parseLeaks("bun test v1.3.14\n 3 pass\n 0 fail")).toEqual([]);
	});

	it("uses a marker distinctive enough not to collide with ordinary output", () => {
		expect(LEAK_LINE_PREFIX).toBe("VEYYON_TEST_LEAK ");
	});
});

describe("testFilesUnder", () => {
	/** A single file is a valid target, which is how a suspect gets re-checked. */
	it("returns the file itself when given a file", () => {
		expect(testFilesUnder(REPO_ROOT, LEAKY_FIXTURE)).toEqual([LEAKY_FIXTURE]);
	});

	/** Fixtures are excluded from a directory sweep: the deliberate leaker below
	 *  would otherwise fail every scan of `packages/utils/test`. */
	it("skips fixtures when walking a directory", () => {
		const files = testFilesUnder(REPO_ROOT, "packages/utils/test");

		expect(files).not.toContain(LEAKY_FIXTURE);
		expect(files.length).toBeGreaterThan(20);
		expect(files.every(file => file.endsWith(".test.ts") || file.endsWith(".test.tsx"))).toBe(true);
	});

	it("throws on a path that does not exist", () => {
		expect(() => testFilesUnder(REPO_ROOT, "packages/nope/test")).toThrow("no such path");
	});

	/**
	 * Gitignored subtrees are not ours to check. This is not a tidiness rule: the
	 * gitignored `packages/deepswe-bench/repo-cache` holds CLONED EXTERNAL REPOSITORIES
	 * with 3,332 `.test.ts` files in them, more than twice the entire veyyon suite. A walk
	 * that entered it would spend hours running other projects' tests and report their
	 * leaks as ours, and the nightly sweep would time out before reaching our own code.
	 */
	it("does not walk into gitignored directories", () => {
		const cache = path.join(REPO_ROOT, "packages/deepswe-bench/repo-cache");
		if (!existsSync(cache)) return;

		const files = testFilesUnder(REPO_ROOT, "packages/deepswe-bench");

		expect(files.some(file => file.includes("repo-cache"))).toBe(false);
	});

	/**
	 * Asking git beats a hardcoded name list: build output (`dist`, `binaries`, `.bun`) and
	 * agent worktrees (`.wt`) are all gitignored and all hold copies of test files that
	 * would be checked twice, and the next such directory is excluded the day it appears
	 * without anyone editing this script.
	 */
	it("excludes build output and worktrees without naming them", () => {
		const files = testFilesUnder(REPO_ROOT, "packages/coding-agent");

		for (const ignored of ["/dist/", "/binaries/", "/.bun/", "/.wt/"]) {
			expect(files.some(file => file.includes(ignored))).toBe(false);
		}
		// The real suite is still there: an over-broad exclusion would silently check nothing.
		expect(files.length).toBeGreaterThan(1000);
	});

	/**
	 * An explicitly named file is checked even when git ignores it. The ignore rule exists
	 * to bound a WALK, and refusing a path the caller typed would be a silent skip of the
	 * one file they asked about.
	 */
	it("still checks an ignored file when it is named directly", () => {
		const generated = path.join(REPO_ROOT, "packages/coding-agent/dist/__leak-probe.test.ts");
		if (!existsSync(path.dirname(generated))) return;
		writeFileSync(generated, 'import { expect, test } from "bun:test";\ntest("noop", () => expect(1).toBe(1));\n');
		try {
			const rel = path.relative(REPO_ROOT, generated);

			expect(testFilesUnder(REPO_ROOT, rel)).toEqual([rel]);
		} finally {
			rmSync(generated, { force: true });
		}
	});
});

describe("driving the real runner", () => {
	/**
	 * End to end, on a suite written to leak one variable and to restore another.
	 * This is the assertion that would have caught the whole class two days
	 * earlier, and it proves the tool's two halves at once: the leak is named, and
	 * the restoring test beside it is not.
	 */
	it("names the leaking test in a fixture suite and spares the restoring one", () => {
		const result = traceFile(REPO_ROOT, LEAKY_FIXTURE);

		expect(result.runnerFailed).toBe(false);
		expect(result.leaks).toEqual([
			{
				file: LEAKY_FIXTURE,
				diffs: [{ key: "env.VEYYON_CONFIG_DIR", before: undefined, after: "/tmp/leaked-by-fixture" }],
				moves: [
					{
						testIndex: 1,
						diffs: [{ key: "env.VEYYON_CONFIG_DIR", before: undefined, after: "/tmp/leaked-by-fixture" }],
					},
				],
			},
		]);
	}, 60_000);

	/**
	 * The other direction, on a fixture that moves the config root twice and puts it
	 * back in `afterAll`: legitimate movement inside a file is not a leak. This also
	 * pins the hook ordering the verdict depends on — the preload's `afterAll` has to
	 * run AFTER the file's own, or every such suite reads as dirty.
	 */
	it("reports no leak for a suite that restores in afterAll", () => {
		const result = traceFile(REPO_ROOT, "packages/utils/test/fixtures/restoring-in-afterall.fixture.ts");

		expect({ leaks: result.leaks, runnerFailed: result.runnerFailed }).toEqual({ leaks: [], runnerFailed: false });
	}, 60_000);

	/**
	 * Module state, end to end. The fixture activates a profile and restores nothing;
	 * the interesting part is that an environment-only tracer would ALSO have caught
	 * this one through `VEYYON_PROFILE`, so the assertion is specifically that the
	 * `state.activeProfile` diff is present — that is the signal that survives a
	 * suite which puts its variables back and leaves the profile active.
	 */
	it("reports leaked module state, not only environment variables", () => {
		const result = traceFile(REPO_ROOT, "packages/utils/test/fixtures/profile-leak.fixture.ts");

		expect(result.leaks).toHaveLength(1);
		expect(result.leaks[0].diffs.map(diff => diff.key)).toContain("state.activeProfile");
		expect(result.leaks[0].diffs.find(diff => diff.key === "state.activeProfile")?.after).toBe("leaky");
	}, 60_000);
});

/**
 * The exit code, which is the only part of this script CI reads.
 *
 * `checks.yml` runs the gate on every commit and `leak-sweep.yml` runs it nightly,
 * and both decide pass or fail from the status alone. It used to return 0 whenever
 * no leak was FOUND, which is not the same as there being none: a file whose import
 * throws never produces a verdict, so a run printed "1 failed to run" and exited
 * clean. A tree whose suites stopped loading is exactly the state the sweep exists
 * to notice, and it read as green on both gates.
 */
describe("the gate's exit code", () => {
	function runGate(target: string): { exitCode: number; out: string } {
		const gate = Bun.spawnSync({
			cmd: ["bun", path.join(REPO_ROOT, "scripts/find-test-leaks.ts"), target],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		});

		return { exitCode: gate.exitCode, out: `${gate.stdout.toString()}${gate.stderr.toString()}` };
	}

	function withTempDir(files: Record<string, string>, check: (dir: string) => void): void {
		const dir = mkdtempSync(path.join(tmpdir(), "veyyon-leak-gate-"));
		try {
			for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body);
			check(dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	it("fails when a suite could not be run at all", () => {
		withTempDir({ "a.test.ts": 'import { missing } from "./nowhere";\nmissing();\n' }, dir => {
			const gate = runGate(dir);

			expect(gate.out).toContain("1 failed to run");
			expect(gate.exitCode).toBe(1);
		});
	}, 60_000);

	/** A walk that found nothing measured nothing, so it cannot report a clean tree. */
	it("fails when the walk found no test files", () => {
		withTempDir({}, dir => {
			expect(runGate(dir).exitCode).toBe(2);
		});
	}, 60_000);

	/** And it still passes when nothing is wrong, or the two above would be satisfied
	 *  by a script that failed unconditionally. */
	it("passes on a suite that runs and leaves nothing behind", () => {
		const clean = 'import { expect, test } from "bun:test";\ntest("clean", () => expect(1).toBe(1));\n';
		withTempDir({ "a.test.ts": clean }, dir => {
			const gate = runGate(dir);

			expect(gate.out).toContain("0 leaking, 0 failed to run");
			expect(gate.exitCode).toBe(0);
		});
	}, 60_000);
});
