/**
 * Fold per-test bookkeeping out of test-runner output.
 *
 * WHY THIS EXISTS. Tool output is the largest block of an agent's context, and
 * context is not paid once: every token in it is re-read as a cache token on
 * every later turn, so a large result arriving early in a session is billed
 * dozens of times. On a measured 66-turn trace, three tool results were 67% of
 * all tool-result bytes and all three were verbose Go test output. One of them,
 * a `go test ./...` run that arrived at turn 13 and was re-read 52 times, cost
 * about 4.7% of the entire session bill on its own.
 *
 * Almost none of those bytes carry information. `=== RUN`, `--- PASS`,
 * `--- SKIP`, `[no test files]` and `ok <pkg> 0.05s` lines say only that things
 * the agent already asked to run did run, and did not fail. The agent acts on
 * the failures and on the final verdict.
 *
 * WHAT THIS WILL NOT DO. It never removes a line that reports a problem.
 * Safety here comes from the narrowness of the patterns, not from inspecting
 * the run as a whole: only lines that state a test ran, passed, or was skipped
 * are ever folded, so `--- FAIL`, `FAIL`, panics, data races, error traces,
 * assertion diffs and any output a test itself printed survive untouched, in
 * their original order.
 *
 * An earlier version did gate the whole fold on "did anything fail", and
 * measuring it showed that to be exactly backwards. The most expensive result
 * in the trace was a FAILING suite whose bulk was `=== RUN` lines for the tests
 * that passed; the gate protected every one of them and saved nothing on the
 * case that mattered most. Folding regardless of the verdict took the same
 * corpus from 21% to 42% fewer tool-result tokens.
 *
 * Nothing is dropped silently. Every fold is replaced by a line stating how
 * many lines went and what they were, so a reader can see that bookkeeping was
 * removed and ask for it if it matters.
 */

/** A line class this module recognises and may fold. */
type FoldClass = "run" | "pass" | "noTestFiles" | "packageOk";

/**
 * Per-test bookkeeping, across the runners an agent actually meets.
 *
 * Anchored at line start and deliberately narrow. A pattern that matched a
 * test's own stdout would delete real output, and that loss is unrecoverable,
 * so each one requires the exact shape its runner emits: a bare `ok` or a line
 * merely containing a tick mark is not enough.
 *
 * Every pattern here matches only a PASS, SKIP, or "ran" line. None of them can
 * match a failure, which is what makes folding safe without inspecting the run
 * as a whole. Adding a pattern that can match a failing line breaks that
 * property, and the suite asserts it directly for exactly that reason.
 */
const LINE_PATTERNS: ReadonlyArray<readonly [FoldClass, RegExp]> = [
	// go test
	["run", /^=== (?:RUN|CONT|PAUSE)\s+\S/],
	["pass", /^\s*--- (?:PASS|SKIP): \S/],
	["noTestFiles", /^\?\s+\S+\s+\[no test files\]$/],
	["packageOk", /^ok\s+\S+\s+[\d.]+s(?: \(cached\))?$/],
	// pytest -v: `tests/test_x.py::test_y PASSED [ 45%]`. The `::` and the
	// terminal verdict are both required, so prose mentioning PASSED is safe.
	["pass", /^\S+::\S+\s+(?:PASSED|SKIPPED|XFAIL|XPASS)(?:\s+\[\s*\d+%\])?$/],
	// cargo test: `test module::name ... ok`
	["pass", /^test \S+ \.\.\. (?:ok|ignored)$/],
	// vitest / jest per-test tick, which always carries a leading indent and a
	// space after the mark.
	["pass", /^\s+[✓√] \S/],
	// jest / vitest per-file verdict: `PASS  src/foo.test.ts`
	["packageOk", /^\s*(?:PASS|SKIP)\s+\S+\.\S+$/],
];

export interface FoldResult {
	/** The text to put in context. Identical to the input when nothing was folded. */
	readonly text: string;
	/** How many lines were folded, by class. Empty when nothing was folded. */
	readonly folded: Readonly<Partial<Record<FoldClass, number>>>;
	/** Why nothing was folded, when nothing was. Absent on a successful fold. */
	readonly skippedReason?: "nothing-to-fold" | "below-threshold";
}

/**
 * Below this many foldable lines, folding is not worth the explanatory line it
 * costs and the reader is better served by the raw output. A short run is
 * already cheap.
 */
export const MIN_FOLDABLE_LINES = 12;

const CLASS_LABEL: Record<FoldClass, string> = {
	run: "=== RUN/CONT/PAUSE",
	pass: "--- PASS/SKIP",
	noTestFiles: "packages with no test files",
	packageOk: "passing package results",
};

/**
 * Classify one line, or return null when it is not test bookkeeping.
 *
 * Exported so the test suite can assert the classification directly rather than
 * inferring it from folded output, which is what let an earlier version's
 * over-broad pattern go unnoticed.
 */
export function classifyLine(line: string): FoldClass | null {
	for (const [cls, pattern] of LINE_PATTERNS) {
		if (pattern.test(line)) return cls;
	}
	return null;
}

/**
 * Fold test bookkeeping out of `text`, or return it unchanged.
 *
 * The folded lines are replaced in place by one summary line per class, at the
 * position where that class first appeared, so the surviving output keeps its
 * original order and the reader can see where the removal happened.
 */
export function foldPassingTestOutput(text: string): FoldResult {
	// Deliberately NOT gated on whether the run failed.
	//
	// The first version bailed out whenever it saw a failure marker, on the
	// reasoning that a failing run is all signal. Measuring it showed the
	// opposite: the most expensive result in the trace was a failing suite whose
	// bulk was `=== RUN` lines for the tests that passed, and the gate protected
	// every one of them. The gate was also unnecessary, because a failure line
	// belongs to no foldable class and therefore survives by construction. What
	// makes this safe is the narrowness of the patterns, not a global veto: only
	// lines that state a test ran, passed, or was skipped are ever removed, and
	// `--- FAIL`, panics, races, error traces and diffs are all untouched.
	const lines = text.split("\n");
	const counts: Partial<Record<FoldClass, number>> = {};
	let foldable = 0;
	for (const line of lines) {
		const cls = classifyLine(line);
		if (cls) {
			counts[cls] = (counts[cls] ?? 0) + 1;
			foldable++;
		}
	}
	if (foldable === 0) return { text, folded: {}, skippedReason: "nothing-to-fold" };
	if (foldable < MIN_FOLDABLE_LINES) return { text, folded: {}, skippedReason: "below-threshold" };

	const emitted = new Set<FoldClass>();
	const out: string[] = [];
	for (const line of lines) {
		const cls = classifyLine(line);
		if (!cls) {
			out.push(line);
			continue;
		}
		if (emitted.has(cls)) continue;
		emitted.add(cls);
		out.push(`[folded ${counts[cls]} ${CLASS_LABEL[cls]} lines; failures are never folded]`);
	}
	return { text: out.join("\n"), folded: counts };
}
