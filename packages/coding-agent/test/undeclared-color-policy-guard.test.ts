/**
 * A test that asserts a colour is ABSENT must first make colour possible.
 *
 * WHY THIS GUARD EXISTS, AND WHY IT IS NARROWER THAN IT FIRST LOOKS.
 * `theme.fg(color, text)` and `theme.bg(color, text)` return their input
 * unchanged unless the ANSI policy is `full`, and the policy is read from the
 * environment once at module load. Colour assertions therefore split into two
 * very different failure modes:
 *
 *  - The POSITIVE form (`expect(line).toContain("\x1b[31m")`) breaks loudly. It
 *    passes on a truecolor terminal and fails everywhere else, which is
 *    miserable to diagnose but is at least visible: twelve suites in this
 *    package have hit it, each fixed by declaring `useFullColor()`. Running the
 *    suite is what catches it.
 *  - The NEGATIVE form (`expect(line).not.toContain(theme.fg("error", "x"))`,
 *    or the same with a literal sequence) is the dangerous one, because NOTHING
 *    catches it. Under the identity policy the expected value collapses to bare
 *    text, or to a sequence the renderer could never emit, so the assertion is
 *    VACUOUSLY TRUE. It reads as "this row must not be painted as an error" and
 *    it proves nothing. It keeps passing while the behaviour it claims to pin
 *    rots away, and it will keep passing forever.
 *
 * So this guard checks the negative form only. The positive form is left to the
 * test run, which already reports it. `expectNotColored` in
 * `helpers/theme-assertions.ts` is the sanctioned spelling for "must not be
 * painted": it is correct under every policy. Declaring `useFullColor()` also
 * satisfies the rule, because then the expected sequence really can be emitted.
 *
 * Scope note: this reads test SOURCE, not test behaviour. That is deliberate.
 * The defect is environment-dependent by construction, so a runtime check would
 * itself pass or fail depending on the terminal it ran in, which is exactly the
 * property being eliminated.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { Glob } from "bun";

const TEST_ROOT = path.join(import.meta.dir);

/**
 * Files exempt from the rule, each for a stated reason. The list is asserted to
 * be exactly this: an exemption for a file that no longer exists is a hole
 * nobody is watching, and a new one has to be argued for here.
 */
const EXEMPT: Record<string, string> = {
	"ui/ansi-policy.test.ts":
		"Owns the policy. It calls setAnsiPolicy(detectAnsiPolicy()) itself to prove detection, so pinning `full` would erase its subject.",
	"undeclared-color-policy-guard.test.ts": "This guard. It quotes the spellings it looks for.",
	"helpers/theme-assertions.ts": "The helper module that defines the sanctioned spellings.",
};

/**
 * A raw SGR colour introducer: 24-bit (`38;2;r;g;b` / `48;2;r;g;b`), 256-colour
 * (`38;5;n` / `48;5;n`), or a basic fg/bg code. Anchored to an escape literal
 * so ordinary numbers in test data cannot trip it. Bold, reset and cursor moves
 * are deliberately excluded: they apply under every policy.
 */
const COLOR_SEQUENCE = String.raw`(?:\\x1[bB]|\\u001[bB]|\\e)?\[(?:[0-9;]*;)?(?:[34]8;[25];[0-9;]+|3[0-7]|4[0-7]|9[0-7]|10[0-7])m`;

/**
 * A negative assertion whose expected value is colour: either a literal
 * sequence, or a `theme.fg(...)` / `theme.bg(...)` / `fg(...)` / `bg(...)` call
 * that collapses to its own text argument under the identity policy.
 */
const VACUOUS_NEGATIVE = new RegExp(
	String.raw`\.not\s*\.\s*to(?:Contain|Match|Equal|Be)\s*\(\s*(?:` +
		String.raw`(?:theme\s*\.\s*)?(?:fg|bg)\s*\(` +
		"|" +
		"[\"'`][^\"'`]*" +
		COLOR_SEQUENCE +
		")",
);

/** A suite makes colour possible either through the helper or by hand. */
const DECLARES = /\buseFullColor\s*\(|\bsetAnsiPolicy\s*\(\s*["'`]full/;

/** The sanctioned policy-independent spelling; a file using it is already correct. */
const USES_HELPER = /\bexpectNotColored\s*\(/;

function relativeTestPaths(): string[] {
	return [...new Glob("**/*.test.ts").scanSync(TEST_ROOT)].map(p => p.split(path.sep).join("/")).sort();
}

describe("vacuous colour-absence assertions", () => {
	const files = relativeTestPaths();

	it("finds the test tree, so an empty scan cannot pass as a clean one", () => {
		// Without this the whole guard goes silently vacuous the day the layout
		// moves: zero files scanned means zero violations found, which reads
		// identically to a clean tree. That is the same defect class the guard
		// exists to catch, so the guard must not have it.
		expect(files.length).toBeGreaterThan(400);
		expect(files).toContain("modes/components/ask-dialog.test.ts");
		expect(files).toContain("ui/ansi-policy.test.ts");
	});

	it("flags a colour-absence assertion in every spelling a suite might write it", () => {
		// The pattern IS the guard; a pattern that matches nothing reports a
		// clean tree. These are the shapes actually written in this package.
		expect(VACUOUS_NEGATIVE.test(String.raw`expect(line).not.toContain("\x1b[31m")`)).toBe(true);
		expect(VACUOUS_NEGATIVE.test(String.raw`expect(row).not.toContain("\x1b[48;2;0;0;0m")`)).toBe(true);
		expect(VACUOUS_NEGATIVE.test('expect(header).not.toContain(theme.fg("accent", "Search"))')).toBe(true);
		expect(VACUOUS_NEGATIVE.test('expect(row).not.toContain(bg("selected", " "))')).toBe(true);
	});

	it("leaves alone the assertions that are correct under every policy", () => {
		// Plain-text absence, and non-colour SGR, do not depend on the policy.
		// Flagging them would push suites toward declaring a dependency they do
		// not have, which is its own kind of wrong.
		expect(VACUOUS_NEGATIVE.test('expect(line).not.toContain("done task")')).toBe(false);
		expect(VACUOUS_NEGATIVE.test(String.raw`expect(line).not.toContain("\x1b[1m")`)).toBe(false);
		expect(VACUOUS_NEGATIVE.test(String.raw`expect(line).not.toContain("\n")`)).toBe(false);
		expect(VACUOUS_NEGATIVE.test('expect(line).toContain(theme.fg("accent", "x"))')).toBe(false);
		expect(VACUOUS_NEGATIVE.test('expect(stripped).not.toContain("38;2;12;34;56")')).toBe(false);
	});

	it("exempts only the files listed here, and every listed file still exists", () => {
		for (const name of Object.keys(EXEMPT)) {
			if (name.endsWith(".test.ts")) expect(files).toContain(name);
		}
		expect(Object.keys(EXEMPT).length).toBe(3);
	});

	it("no suite asserts the absence of a colour it has not made possible", () => {
		const violations: string[] = [];
		for (const rel of files) {
			if (rel in EXEMPT) continue;
			const source = readFileSync(path.join(TEST_ROOT, rel), "utf8");
			if (DECLARES.test(source) || USES_HELPER.test(source)) continue;
			const offending = source
				.split("\n")
				.map((line, n) => ({ line, n: n + 1 }))
				.filter(({ line }) => VACUOUS_NEGATIVE.test(line));
			if (offending.length === 0) continue;
			const { line, n } = offending[0]!;
			violations.push(
				`${rel}:${n} asserts a colour is absent under a policy that cannot emit it,` +
					` so it passes vacuously (${offending.length} such line${offending.length === 1 ? "" : "s"}).` +
					` Use expectNotColored(), or declare useFullColor(): ${line.trim()}`,
			);
		}
		// Named, not counted: the point of a guard is that its message tells you
		// which suite to fix and with what.
		expect(violations).toEqual([]);
	});
});
