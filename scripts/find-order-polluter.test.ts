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

		expect(exitCode).toBe(0);
		expect(text).toContain(`Polluter: ${leak}`);
		expect(text).toContain("premise 1 ok: the target passes alone");
		expect(text).toContain("premise 2 ok: the target fails with the full candidate list");
	});

	it("names a leaker that sorts AFTER the innocents, not just the first file it tried", async () => {
		// The twin of the test above, with the leak moved to the end of the candidate list. A
		// bisect with an inverted branch would pass the first test and fail this one.
		innocent("a-quiet.test.ts");
		innocent("b-quiet.test.ts");
		const leak = leaker("y-leaks.test.ts", "veyyonOrderProbeB");
		const target = victim("z-victim.test.ts", "veyyonOrderProbeB");

		const { text, exitCode } = await runScript(target);

		expect(exitCode).toBe(0);
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

		expect(exitCode).toBe(1);
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

		expect(exitCode).toBe(1);
		expect(text).toContain("The target PASSES with every candidate in front of it");
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

		expect(exitCode).toBe(0);
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

		expect(exitCode).toBe(0);
		expect(text).toContain("needs a combination");
		expect(text).toContain("a-half.test.ts");
		expect(text).toContain("m-half.test.ts");
		expect(text).not.toContain("Polluter:");
	});

	it("refuses when the directory holds no other test files", async () => {
		// Nothing to bisect. An empty candidate list must not read as "clean".
		const target = victim("z-victim.test.ts", "veyyonOrderProbeF");

		const { text, exitCode } = await runScript(target);

		expect(exitCode).toBe(2);
		expect(text).toContain("no other test files found");
	});
});
