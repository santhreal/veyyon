/**
 * Fold bookkeeping out of tool output: test-runner verdicts and build progress.
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
 *
 * WHERE IT IS APPLIED, and the one asymmetry worth knowing. In `eval` the fold
 * sits on the model-facing accumulation only, and `cellResult.output` keeps the
 * raw text, so the transcript renderer still shows the operator the full run.
 * In `bash` there is a single owner for the result text and the operator reads
 * the same string, so a folded bash run shows the operator the marker line
 * instead of the bookkeeping. That is visible rather than silent, which is why
 * it is acceptable, but it is a real difference between the two tools.
 */

/** A line class this module recognises and may fold. */
type FoldClass = "run" | "pass" | "noTestFiles" | "packageOk" | "buildProgress" | "dependencyFetch";

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
	// bun test: `(pass) suite > name [1.23ms]`, one line per test. The parenthesised
	// verdict is bun's own and cannot appear at the start of ordinary prose, and
	// `(fail)` is deliberately absent from this list.
	["pass", /^\((?:pass|skip|todo)\) \S/],
	// TAP, which node:test and several runners emit: `ok 12 - parses input`. Anchored
	// so `not ok 12 - ...` can never match.
	["pass", /^ok \d+(?: - \S| \S|$)/],
	// python unittest -v: `test_upper (tests.test_str.Case.test_upper) ... ok`, one line
	// per test and the whole output of a passing run. The parenthesised dotted path and
	// the ` ... ` separator are both unittest's own. A failing test ends in `FAIL` or
	// `ERROR` instead, so neither can reach this.
	["pass", /^\S+ \(\S+\) \.\.\. (?:ok|skipped(?: .*)?|expected failure)$/],
	// cargo build/check: one indented `Compiling <crate> v<version>` line per crate, and
	// hundreds of them on a cold workspace build. The version token is required, so a
	// sentence about compiling something cannot match. `error:` and `warning:` lines are a
	// different shape entirely and are never touched.
	["buildProgress", /^\s+(?:Compiling|Checking|Downloaded|Downloading|Installing|Fresh|Unpacking) \S+ v\S+/],
	// cmake / make progress: `[ 42%] Building C object .../mod_000.c.o`, one line per
	// translation unit. A 40-file build is 43 lines of which 42 are these. The bracketed
	// percentage is the generator's own; a compiler diagnostic (`error:`, `warning:`) and
	// make's own failure line (`make[1]: *** [...] Error 1`) are different shapes.
	["buildProgress", /^\[ *\d+%\] (?:Building|Linking|Built target|Generating|Automatic MOC) /],
	// make's recursion bookkeeping, which a recursive build prints twice per directory.
	// `make[1]: *** ... Error 1` and `make: *** No rule to make target` stay unclassified.
	["buildProgress", /^make(?:\[\d+\])?: (?:Entering|Leaving) directory /],
	// gradle: one `> Task :module:compileJava UP-TO-DATE` line per task. Only the
	// suffixed forms are folded -- they state that a task did NOT do work -- so a bare
	// `> Task :app:test` that actually ran is left in place, as is `FAILED`.
	["buildProgress", /^> Task :\S+ (?:UP-TO-DATE|SKIPPED|NO-SOURCE|FROM-CACHE)$/],
	// docker's classic builder, which prints a layer id per instruction and nothing else
	// between the steps a reader cares about.
	["buildProgress", /^ ---> (?:Running in )?[0-9a-f]{12}$/],
	// maven, whose dependency resolution is most of a cold build's output: one line per
	// artifact per repository. The `[INFO] ` prefix alone is far too broad to fold, so
	// only the two fetch verbs with their `from <repo>: <url>` shape are matched.
	["dependencyFetch", /^\[INFO\] Download(?:ing|ed) from \S+: \S+/],
	// go mod: one `go: downloading <module> v<version>` line per module, and a cold
	// module cache emits hundreds before the build produces a single byte anyone
	// reads. The `go: ` prefix is the toolchain's own and the version token is
	// required, so a sentence about downloading a module cannot match. `go: ` lines
	// that report a PROBLEM (`go: updates to go.mod needed`, `go: module ... found
	// but does not contain package`) have a different shape and stay unclassified.
	["dependencyFetch", /^go: (?:downloading|extracting|finding) \S+ v\S+/],
	// pip: `Requirement already satisfied: numpy in /usr/lib/python3.11 (1.26.4)`.
	// On a repo whose requirements are already installed this is the ENTIRE output
	// and it is one line per transitive dependency. The colon, the package, and the
	// ` in <path>` are all required.
	["dependencyFetch", /^Requirement already satisfied: \S+ in \S+/],
	// pip fetch lines. `Collecting` carries the requirement spec; `Downloading` and
	// `Using cached` are indented and always end in a parenthesised size, which is
	// what separates them from an application logging the word "Downloading".
	["dependencyFetch", /^Collecting \S+/],
	["dependencyFetch", /^\s+(?:Downloading|Using cached) \S+ \([\d.]+ ?[kKMG]?B\)$/],
	// apt-get, which is most of what a container-setup step prints. Every one of
	// these requires dpkg's exact trailing ` ...` or its parenthesised version, so
	// prose cannot reach them.
	["dependencyFetch", /^Get:\d+ \S+ /],
	["dependencyFetch", /^Selecting previously unselected package \S+\.$/],
	["dependencyFetch", /^Preparing to unpack \.\.\./],
	// The trailing `over (<old version>)` is dpkg's UPGRADE form, and on a machine
	// that is not being installed from scratch it is most of what `apt upgrade`
	// prints. Found by running this against a real transcript rather than a
	// fixture, which is exactly the shape a hand-written sample would have missed.
	["dependencyFetch", /^(?:Unpacking|Setting up|Processing triggers for) \S+ \([^)]+\)(?: over \([^)]+\))? \.\.\.$/],
	// dpkg's database-read progress, which it prints once per percent and which
	// carries no information at all. The parenthesis and the ellipsis are both
	// dpkg's own, so nothing an application prints can reach this.
	["dependencyFetch", /^\(Reading database \.\.\./],
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
	buildProgress: "build progress",
	dependencyFetch: "dependency fetch/install",
};

/**
 * Classify one line, or return null when it is not test bookkeeping.
 *
 * Exported so the test suite can assert the classification directly rather than
 * inferring it from folded output, which is what let an earlier version's
 * over-broad pattern go unnoticed.
 */
export function classifyLine(line: string): FoldClass | null {
	// A trailing carriage return is stripped before matching. Most of these
	// patterns are anchored with `$`, so `ok  pkg  0.01s\r` did not match `...s$`
	// and every class silently stopped folding on CRLF input.
	//
	// Today's callers do not hit that: `OutputSink` sanitizes each chunk and
	// `sanitizeText` already removes CR. This is here so the classifier is right
	// on its own terms, for a caller that folds text which has not been through
	// that sanitizer (a log read from disk, a Windows-produced file).
	const candidate = line.endsWith("\r") ? line.slice(0, -1) : line;
	for (const [cls, pattern] of LINE_PATTERNS) {
		if (pattern.test(candidate)) return cls;
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
export function foldToolOutputBookkeeping(text: string): FoldResult {
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
