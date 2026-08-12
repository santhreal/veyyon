/**
 * Contract for `scripts/find-order-polluter.ts`.
 *
 * WHY THIS SUITE EXISTS. The script's whole value is that its answer is TRUSTED: someone reads
 * "Polluter: x.test.ts" and goes to read that file. A bisect that reports the wrong file, or
 * reports one when the premises do not hold, is worse than no tool — it sends the reader to an
 * innocent file and the real leak survives another week. So the search runs here against fixture
 * suites with a KNOWN polluter, and both refusal paths are asserted too: a target that fails on
 * its own is not an ordering problem, and an ordering that does not reproduce the failure must be
 * reported as such rather than bisected into a confident wrong answer.
 *
 * The fixtures leak through a global, which is the cheapest stand-in for the real thing (a global
 * settings singleton, an env var, a monkeypatched module). What matters is only that the leak is
 * one-directional and file-ordered, which is the shape the script searches for.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findReproducingWindow, parseArgs, parseTargetFailures, windowSizes } from "./find-order-polluter";

const SCRIPT = path.join(import.meta.dir, "find-order-polluter.ts");

/**
 * The fixtures live OUTSIDE the repository, in the system temp directory.
 *
 * Not a detail: identical fixture pairs leak a module-level global reliably from a path outside
 * the repo, and inconsistently from a path inside it, so a suite whose fixtures sat in the tree
 * would be flaky for reasons that have nothing to do with the code under test.
 */
let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-order-polluter-"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/** Write a fixture test file into the temp dir and return its absolute path. */
function fixture(name: string, body: string): string {
	const file = path.join(dir, name);
	fs.writeFileSync(file, body);
	return file;
}

/** A file that leaks a global on import, which is what makes it a polluter. */
function leaker(name: string, flag: string): string {
	return fixture(
		name,
		`import { expect, it } from "bun:test";\n` +
			`(globalThis as Record<string, unknown>)["${flag}"] = true;\n` +
			`it("passes on its own account", () => { expect(1).toBe(1); });\n`,
	);
}

/** A file that neither leaks nor reads, so it can never be the answer. */
function innocent(name: string): string {
	return fixture(
		name,
		`import { expect, it } from "bun:test";\nit("minds its own business", () => { expect(2).toBe(2); });\n`,
	);
}

/** A file that fails only when the leaked global is present. */
function victim(name: string, flag: string): string {
	return fixture(
		name,
		`import { expect, it } from "bun:test";\n` +
			`it("sees a clean global", () => {\n` +
			`\texpect((globalThis as Record<string, unknown>)["${flag}"]).toBeUndefined();\n` +
			`});\n`,
	);
}

async function runScript(target: string, extra: string[] = []): Promise<{ text: string; exitCode: number }> {
	const proc = Bun.spawn(["bun", SCRIPT, target, "--dir", dir, ...extra], {
		stdout: "pipe",
		stderr: "pipe",
		cwd: path.join(import.meta.dir, ".."),
	});
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	return { text: stdout + stderr, exitCode };
}

describe("find-order-polluter", () => {
	it("names the one file that leaks, out of several", async () => {
		// The core claim. Sorted order puts the leaker first, three innocents after it, and the
		// victim last, so a bisect that merely reported "the first half" would be right by
		// accident — the innocents are there to make the answer specific.
		const leak = leaker("a-leaks.test.ts", "veyyonOrderProbeA");
		innocent("b-quiet.test.ts");
		innocent("c-quiet.test.ts");
		innocent("d-quiet.test.ts");
		const target = victim("z-victim.test.ts", "veyyonOrderProbeA");

		const { text, exitCode } = await runScript(target);

		expect(exitCode, text).toBe(0);
		expect(text).toContain(`Polluter: ${leak}`);
		expect(text).toContain("premise 1 ok: the target passes alone");
		expect(text).toContain("premise 2 ok: the target fails with the last");
	});

	it("names a leaker that sorts AFTER the innocents, not just the first file it tried", async () => {
		// The twin of the test above, with the leak moved to the end of the candidate list. A
		// bisect with an inverted branch would pass the first test and fail this one.
		innocent("a-quiet.test.ts");
		innocent("b-quiet.test.ts");
		const leak = leaker("y-leaks.test.ts", "veyyonOrderProbeB");
		const target = victim("z-victim.test.ts", "veyyonOrderProbeB");

		const { text, exitCode } = await runScript(target);

		expect(exitCode, text).toBe(0);
		expect(text).toContain(`Polluter: ${leak}`);
	});

	it("prints a command that reproduces the failure with just the two files", async () => {
		// The output is a hand-off. A named polluter the reader cannot reproduce in one command
		// is a claim, not a finding.
		const leak = leaker("a-leaks.test.ts", "veyyonOrderProbeC");
		const target = victim("z-victim.test.ts", "veyyonOrderProbeC");

		const { text } = await runScript(target);

		expect(text).toContain(`bun test ${leak} ${target}`);
	});

	it("refuses when the target fails on its own, and says why", async () => {
		// Not an ordering problem. Bisecting here would name whichever file happened to be in
		// the last surviving window and send the reader to an innocent file.
		innocent("a-quiet.test.ts");
		const target = fixture(
			"z-broken.test.ts",
			`import { expect, it } from "bun:test";\nit("is simply broken", () => { expect(1).toBe(2); });\n`,
		);

		const { text, exitCode } = await runScript(target);

		expect(exitCode, text).toBe(1);
		expect(text).toContain("The target FAILS on its own");
		expect(text).not.toContain("Polluter:");
	});

	it("refuses when the ordering does not reproduce the failure, and says what to do instead", async () => {
		// The honest answer when nothing leaks: the full run's order came from the directory
		// walk, and a sorted explicit order need not reproduce it. Reporting a polluter anyway
		// is the failure mode this refusal exists to prevent.
		innocent("a-quiet.test.ts");
		innocent("b-quiet.test.ts");
		const target = victim("z-victim.test.ts", "veyyonOrderProbeNeverSet");

		const { text, exitCode } = await runScript(target);

		expect(exitCode, text).toBe(1);
		expect(text).toContain("The target PASSES with the last");
		expect(text).toContain("That is every candidate");
		expect(text).not.toContain("Polluter:");
	});

	it("narrows to the target's own test when given --name", async () => {
		// A file with one order-dependent test among many would otherwise have every run
		// polluted by its OWN other failures. The filter is what keeps the signal to the one
		// test under investigation.
		const leak = leaker("a-leaks.test.ts", "veyyonOrderProbeD");
		const target = fixture(
			"z-mixed.test.ts",
			`import { expect, it } from "bun:test";\n` +
				`it("the order dependent one", () => {\n` +
				`\texpect((globalThis as Record<string, unknown>)["veyyonOrderProbeD"]).toBeUndefined();\n` +
				`});\n` +
				`it("a neighbour that is fine", () => { expect(3).toBe(3); });\n`,
		);

		const { text, exitCode } = await runScript(target, ["--name", "the order dependent one"]);

		expect(exitCode, text).toBe(0);
		expect(text).toContain(`Polluter: ${leak}`);
	});

	it("reports the smallest reproducing set when no single file explains it", async () => {
		// Two leaks that only fail the victim together. Bisecting halves cannot isolate one
		// file here, and the honest output is the surviving set rather than an arbitrary pick.
		fixture(
			"a-half.test.ts",
			`import { expect, it } from "bun:test";\n` +
				`(globalThis as Record<string, unknown>).veyyonOrderProbeE1 = true;\n` +
				`it("sets half of it", () => { expect(1).toBe(1); });\n`,
		);
		fixture(
			"m-half.test.ts",
			`import { expect, it } from "bun:test";\n` +
				`(globalThis as Record<string, unknown>).veyyonOrderProbeE2 = true;\n` +
				`it("sets the other half", () => { expect(1).toBe(1); });\n`,
		);
		const target = fixture(
			"z-victim.test.ts",
			`import { expect, it } from "bun:test";\n` +
				`it("needs both halves to fail", () => {\n` +
				`\tconst g = globalThis as Record<string, unknown>;\n` +
				`\texpect(Boolean(g.veyyonOrderProbeE1 && g.veyyonOrderProbeE2)).toBe(false);\n` +
				`});\n`,
		);

		const { text, exitCode } = await runScript(target);

		expect(exitCode, text).toBe(0);
		expect(text).toContain("needs a combination");
		expect(text).toContain("a-half.test.ts");
		expect(text).toContain("m-half.test.ts");
		expect(text).not.toContain("Polluter:");
	});

	it("refuses when the directory holds no other test files", async () => {
		// Nothing to bisect. An empty candidate list must not read as "clean".
		const target = victim("z-victim.test.ts", "veyyonOrderProbeF");

		const { text, exitCode } = await runScript(target);

		expect(exitCode, text).toBe(2);
		expect(text).toContain("no other test files found");
	});
});

/**
 * The growing window, which is what makes the search runnable at all.
 *
 * WHY IT EXISTS. The old search ran the WHOLE candidate list as its second premise, which on the
 * coding-agent package means running 1,887 test files before the search has started. The window
 * starts at the last 64 candidates and doubles instead, so a nearby polluter (which is most of
 * them, since a leak reaches the target from just before it) answers in seconds. The cap is a time
 * budget, and reaching it is a refusal rather than a clean bill of health.
 */
describe("the growing window", () => {
	/** Doubling from the first size, and stopping exactly on the limit. */
	it("doubles up to the smaller of the candidate count and the cap", () => {
		expect(windowSizes(1000, 200)).toEqual([64, 128, 200]);
		expect(windowSizes(1000, 1000)).toEqual([64, 128, 256, 512, 1000]);
	});

	/**
	 * Never more files than allowed.
	 *
	 * The cap is a memory budget, so a search that overshot it by one doubling would be the OOM
	 * this window exists to avoid.
	 */
	it("never proposes a window past the cap or past the candidates", () => {
		for (const [count, cap] of [
			[1887, 200],
			[10, 200],
			[64, 64],
			[65, 200],
			[1, 200],
		] as const) {
			const sizes = windowSizes(count, cap);
			expect(Math.max(...sizes)).toBeLessThanOrEqual(Math.min(count, cap));
			expect(sizes.at(-1)).toBe(Math.min(count, cap));
		}
	});

	/** A short list is one attempt, not a doubling sequence that overshoots it. */
	it("is a single attempt when there are fewer candidates than the first window", () => {
		expect(windowSizes(9, 200)).toEqual([9]);
		expect(windowSizes(1, 200)).toEqual([1]);
	});

	/** Sizes only grow, so each attempt strictly contains the last. */
	it("proposes strictly increasing sizes", () => {
		const sizes = windowSizes(5000, 5000);
		for (let index = 1; index < sizes.length; index++) expect(sizes[index]!).toBeGreaterThan(sizes[index - 1]!);
	});

	/** The window is the LAST N candidates, because a leak reaches the target from just before it. */
	it("searches the suffix of the candidate list", async () => {
		const candidates = Array.from({ length: 300 }, (_, i) => `f${i}.test.ts`);
		const seen: string[][] = [];
		const search = await findReproducingWindow(
			async files => {
				seen.push(files);
				return files.includes("f200.test.ts") ? "t.test.ts:\n(fail) boom\n" : "t.test.ts:\n(pass) fine\n";
			},
			candidates,
			{ target: "t.test.ts", dir: ".", maxWindow: 200 },
		);

		expect(search.tried).toEqual([64, 128]);
		expect(search.window).toHaveLength(128);
		expect(search.window?.at(0)).toBe("f172.test.ts");
		expect(search.window?.at(-1)).toBe("f299.test.ts");
		expect(seen[0]?.at(0)).toBe("f236.test.ts");
	});

	/**
	 * A search that hit the cap reports no window, so the caller can refuse.
	 *
	 * THE FAILURE THIS LOCKS OUT. Returning the last window as if it were the answer would report
	 * "no polluter in this ordering" for a suite whose polluter is simply further back than the cap,
	 * which reads as a clean bill of health for an unexamined 1,700 files.
	 */
	it("reports nothing rather than a window when the cap is reached first", async () => {
		const candidates = Array.from({ length: 1000 }, (_, i) => `f${i}.test.ts`);
		const search = await findReproducingWindow(
			async files => (files.includes("f0.test.ts") ? "t.test.ts:\n(fail) boom\n" : "t.test.ts:\n(pass) fine\n"),
			candidates,
			{ target: "t.test.ts", dir: ".", maxWindow: 200 },
		);

		expect(search.window).toBeNull();
		expect(search.tried).toEqual([64, 128, 200]);
	});
});

/**
 * Reading bun's output, which decides every branch of the search.
 *
 * A parser that counted a CANDIDATE's failure as the target's would bisect toward whichever file is
 * broken on its own, and the reader would be sent to an innocent file.
 */
describe("reading the target's failures out of a run", () => {
	const output =
		"packages/x/test/a-candidate.test.ts:\n(fail) a candidate of its own accord\n" +
		"packages/x/test/z-victim.test.ts:\n(fail) sees a clean global\n(pass) a neighbour that is fine\n";

	/** Only the target's section counts. */
	it("ignores failures reported for other files", () => {
		expect(parseTargetFailures(output, "packages/x/test/z-victim.test.ts")).toEqual(["sees a clean global"]);
	});

	/** `--name` narrows the parsed result, never the run. */
	it("keeps only the named test when a name is given", () => {
		expect(parseTargetFailures(output, "packages/x/test/z-victim.test.ts", "clean global")).toEqual([
			"sees a clean global",
		]);
		expect(parseTargetFailures(output, "packages/x/test/z-victim.test.ts", "no such test")).toEqual([]);
	});

	/** A clean run is no failures, which is what "the target passed" means. */
	it("finds nothing in a run where the target passed", () => {
		expect(
			parseTargetFailures(
				"packages/x/test/z-victim.test.ts:\n(pass) sees a clean global\n",
				"packages/x/test/z-victim.test.ts",
			),
		).toEqual([]);
	});

	/** A leading `./` on the target is the same target. */
	it("matches a target written with a leading ./", () => {
		expect(parseTargetFailures(output, "./packages/x/test/z-victim.test.ts")).toEqual(["sees a clean global"]);
	});

	/**
	 * An absolute target against bun's cwd-relative header, which is one file written two ways.
	 *
	 * THE BUG THIS LOCKS OUT, measured 2026-08-03. The parser compared the two spellings with
	 * `endsWith`, and bun spells the header relative to the run's cwd however the caller spelled
	 * the target. That agreed only by luck: a target outside the cwd gets a header that climbs out
	 * with `../`, and `../../tmp/x/z.test.ts` still ends with `/tmp/x/z.test.ts`. Put the target
	 * UNDER the cwd (which is all `TMPDIR` inside the repo does, and CI runners set `TMPDIR`) and
	 * the header loses its leading slash, no section ever matches the target, every run parses as
	 * zero failures, and the tool reports that the ordering does not reproduce the failure. That
	 * is a clean bill of health for a suite whose polluter is sitting in the candidate list, which
	 * is the exact wrong answer this whole suite exists to prevent.
	 */
	it("matches an absolute target against a header spelled relative to the run", () => {
		const relative =
			"tmpprobe/run/a-candidate.test.ts:\n(fail) a candidate of its own accord\n" +
			"tmpprobe/run/z-victim.test.ts:\n(fail) sees a clean global\n";

		expect(parseTargetFailures(relative, "/repo/tmpprobe/run/z-victim.test.ts", undefined, "/repo")).toEqual([
			"sees a clean global",
		]);
	});

	/**
	 * A filename is not a suffix match.
	 *
	 * The other direction of the same bug. `--dir` exists so the target can be named by filename
	 * alone, and `z-victim.test.ts` IS a string suffix of `my-z-victim.test.ts`, so the parser read
	 * the neighbour's failures as the target's. The search then bisects toward whatever makes the
	 * neighbour red and names an innocent file as the polluter.
	 */
	it("does not mistake a file whose name merely ends with the target's", () => {
		const neighbour = "my-z-victim.test.ts:\n(fail) not the target at all\n";

		expect(parseTargetFailures(neighbour, "z-victim.test.ts", undefined, "/repo/run")).toEqual([]);
	});
});

describe("the arguments", () => {
	/** The cap has a default, so the common invocation stays one word long. */
	it("defaults the window cap and derives the directory from the target", () => {
		const options = parseArgs(["packages/x/test/z.test.ts"]);
		// Literal 200: the default window size, not whatever DEFAULT_MAX_WINDOW says.
		expect(options.maxWindow).toBe(200);
		expect(options.dir).toBe("packages/x/test");
	});

	/** And it can be raised for a polluter that is genuinely far back. */
	it("takes an explicit window cap", () => {
		expect(parseArgs(["z.test.ts", "--dir", "d", "--max-window", "800"]).maxWindow).toBe(800);
	});
});

/**
 * The assumption the whole search rests on, pinned against bun itself.
 *
 * WHY THIS IS HERE AND NOT SOMEWHERE ELSE. `--parallel=1` reads like the flag that makes this tool
 * correct: one process, files in the order given, nothing to interleave. It does the opposite, and
 * the failure is silent -- the search runs, finds nothing, and reports the suite clean. Measured
 * 2026-07-26 and locked here so the next person to reach for the flag sees why it was not used.
 *
 * The same mechanism explains the memory kill recorded in `BACKLOG.md`: one module registry per
 * file, all of them retained, about 76 MB each over 1,887 files.
 */
describe("what bun shares between test files", () => {
	/** Two files importing one module, and a module-level counter that either crosses or does not. */
	function sharedStateFixtures(): { first: string; second: string } {
		fixture("shared-module.ts", "export const state = { loads: 0, seen: [] as string[] };\nstate.loads += 1;\n");
		const first = fixture(
			"a-first.test.ts",
			`import { expect, it } from "bun:test";\nimport { state } from "./shared-module";\nstate.seen.push("a");\n` +
				`it("ran first", () => { expect(state.seen).toContain("a"); });\n`,
		);
		const second = fixture(
			"z-second.test.ts",
			`import { expect, it } from "bun:test";\nimport { state } from "./shared-module";\n` +
				`it("sees what the first file left", () => { expect(state.seen).toEqual(["a"]); });\n`,
		);
		return { first, second };
	}

	async function runBoth(files: string[], flags: string[]): Promise<string> {
		const proc = Bun.spawn(["bun", "test", ...flags, ...files], { stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		await proc.exited;
		return stdout + stderr;
	}

	/**
	 * The default shares a realm between the files a worker runs, which is the condition an
	 * order-dependent failure needs to exist at all.
	 */
	it("shares module state between files at the default parallelism", async () => {
		const { first, second } = sharedStateFixtures();
		const text = await runBoth([first, second], []);
		expect(text).toContain(" 2 pass");
		expect(text).not.toContain("(fail) sees what the first file left");
	});

	/**
	 * `--parallel=1` gives every file a fresh module registry, so nothing leaks and the search
	 * would find nothing no matter what is wrong.
	 */
	it("gives every file a fresh module registry under --parallel=1", async () => {
		const { first, second } = sharedStateFixtures();
		const text = await runBoth([first, second], ["--parallel=1"]);
		expect(text).toContain("(fail) sees what the first file left");
	});
});
