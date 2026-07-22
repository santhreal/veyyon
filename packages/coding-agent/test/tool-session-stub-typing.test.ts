/**
 * Guard: test stubs of `ToolSession` stay type checked.
 *
 * 52 stubs across 46 files were forced through with
 * `as unknown as ToolSession`. A double cast makes the stub structurally
 * unrelated to the interface, which costs two things:
 *
 * 1. Members the stub DOES set stop being checked. Removing the casts found
 *    three stubs that were lying about the contract: one returned a plain
 *    object where the interface promises a `Promise`, one omitted a required
 *    field of `PlanModeState`, one supplied a settings object with no `get`.
 *    Each test passed anyway, so each was proving less than it claimed.
 * 2. The stub can never fail to keep up. That is how the print-mode suite
 *    rotted: a method was added to the consumer, the cast hid that the stub
 *    lacked it, and four tests died at runtime rather than at build time.
 *
 * These tests scan the test tree rather than assert behaviour, because the
 * defect is a source pattern and nothing at runtime can observe it.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeToolSession } from "./helpers/tool-session";

const testRoot = path.resolve(import.meta.dir);
/** The helper is the one place the un-constructible `Settings` is bridged. */
const HELPER = path.join(testRoot, "helpers", "tool-session.ts");

function testFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...testFiles(full));
		else if (entry.name.endsWith(".ts")) out.push(full);
	}
	return out;
}

describe("ToolSession test stubs are type checked", () => {
	const files = testFiles(testRoot);

	it("scans a meaningful number of test files, so a passing scan means something", () => {
		// Anti-vacuity. If the walk breaks, every scan below passes trivially.
		expect(files.length).toBeGreaterThan(500);
	});

	/**
	 * Code lines only. A comment naming the banned pattern (this file is full of
	 * them, and so is each fixed site) is documentation, not a cast.
	 */
	const isCast = (line: string): boolean => {
		const code = line.trim();
		if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return false;
		return code.includes("as unknown as ToolSession");
	};

	it("no test builds a ToolSession through `as unknown as ToolSession`", () => {
		const offenders: string[] = [];
		for (const file of files) {
			if (file === HELPER || file === path.join(testRoot, "tool-session-stub-typing.test.ts")) continue;
			const lines = fs.readFileSync(file, "utf8").split("\n");
			lines.forEach((line, i) => {
				if (isCast(line)) offenders.push(`${path.relative(testRoot, file)}:${i + 1}`);
			});
		}

		expect(offenders).toEqual([]);
	});

	it("finds the pattern it is meant to find, in every form it was written in", () => {
		// Pins the matcher, so the test above cannot pass because the check stopped
		// working rather than because the code is clean. The intersection form is
		// included because the first sweep's regex missed it, and this guard is what
		// caught the one file still using it.
		expect(isCast("\t} as unknown as ToolSession;")).toBe(true);
		expect(isCast("\t\t} as unknown as ToolSession);")).toBe(true);
		expect(isCast("\t\treturn session as unknown as ToolSession & { cwd: string };")).toBe(true);
	});

	it("does not count a comment that merely names the pattern", () => {
		// Otherwise the guard fires on its own documentation and on the comment left
		// at each fixed site explaining what the cast had been hiding.
		expect(isCast("\t\t// old `as unknown as ToolSession` cast accepted.")).toBe(false);
		expect(isCast(" * `as unknown as ToolSession`. That double cast is unnecessary.")).toBe(false);
	});
});

describe("makeToolSession", () => {
	it("supplies every member ToolSession requires", () => {
		// The five required members. A new one added to the interface fails the
		// helper's own type check first, which is the point of having one place.
		const session = makeToolSession();

		expect(session.cwd).toBe(process.cwd());
		expect(session.hasUI).toBe(false);
		expect(session.getSessionFile()).toBeNull();
		expect(session.getSessionSpawns()).toBeNull();
		expect(session.settings.get("tools.approvalMode")).toBeUndefined();
	});

	it("lets an override replace a default rather than merge with it", () => {
		const session = makeToolSession({ cwd: "/tmp/example", hasUI: true, getSessionFile: () => "/tmp/s.jsonl" });

		expect(session.cwd).toBe("/tmp/example");
		expect(session.hasUI).toBe(true);
		expect(session.getSessionFile()).toBe("/tmp/s.jsonl");
	});

	it("answers undefined for every setting by default, so each setting falls to its own default", () => {
		// A stub that returned a value for unknown keys would silently steer
		// settings the test never meant to touch.
		const session = makeToolSession();

		for (const key of ["argot.enabled", "goal.enabled", "bash.timeout", "ask.notify"]) {
			expect(session.settings.get(key as never)).toBeUndefined();
		}
	});

	it("routes a settings stub's lookups through unchanged", () => {
		const session = makeToolSession({
			settings: { get: (path: string) => (path === "bash.timeout" ? 60_000 : undefined) },
		});

		expect(session.settings.get("bash.timeout" as never) as unknown).toBe(60_000);
		expect(session.settings.get("argot.enabled")).toBeUndefined();
	});
});
