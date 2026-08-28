/** Fold bookkeeping out of tool output: test-runner verdicts and build progress. context is not paid once: every token in it is re-read as a cache token on */

/** A line class this module recognises and may fold. */
type FoldClass = "run" | "pass" | "noTestFiles" | "packageOk" | "buildProgress" | "dependencyFetch";

/** Per-test bookkeeping, across the runners an agent actually meets. Anchored at line start and deliberately narrow. A pattern that matched a */
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
	// python unittest -v: `test_upper (tests.test_str.Case.test_upper) ... ok`, one line per test and the whole output of a passing run. The parenthesised dotted path and
	["pass", /^\S+ \(\S+\) \.\.\. (?:ok|skipped(?: .*)?|expected failure)$/],
	// cargo build/check: one indented `Compiling <crate> v<version>` line per crate, and hundreds of them on a cold workspace build. The version token is required, so a
	["buildProgress", /^\s+(?:Compiling|Checking|Downloaded|Downloading|Installing|Fresh|Unpacking) \S+ v\S+/],
	// cmake / make progress: `[ 42%] Building C object .../mod_000.c.o`, one line per translation unit. A 40-file build is 43 lines of which 42 are these. The bracketed
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
	// go mod: one `go: downloading <module> v<version>` line per module, and a cold module cache emits hundreds before the build produces a single byte anyone
	["dependencyFetch", /^go: (?:downloading|extracting|finding) \S+ v\S+/],
	// pip: `Requirement already satisfied: numpy in /usr/lib/python3.11 (1.26.4)`. On a repo whose requirements are already installed this is the ENTIRE output
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
	// The trailing `over (<old version>)` is dpkg's UPGRADE form, and on a machine that is not being installed from scratch it is most of what `apt upgrade`
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

/** Below this many foldable lines, folding is not worth the explanatory line it costs and the reader is better served by the raw output. A short run is */
export const MIN_FOLDABLE_LINES = 12;

const CLASS_LABEL: Record<FoldClass, string> = {
	run: "=== RUN/CONT/PAUSE",
	pass: "--- PASS/SKIP",
	noTestFiles: "packages with no test files",
	packageOk: "passing package results",
	buildProgress: "build progress",
	dependencyFetch: "dependency fetch/install",
};

/** Classify one line, or return null when it is not test bookkeeping. Exported so the test suite can assert the classification directly rather than */
export function classifyLine(line: string): FoldClass | null {
	// A trailing carriage return is stripped before matching. Most of these patterns are anchored with `$`, so `ok pkg 0.01s\r` did not match `...s$`
	const candidate = line.endsWith("\r") ? line.slice(0, -1) : line;
	for (const [cls, pattern] of LINE_PATTERNS) {
		if (pattern.test(candidate)) return cls;
	}
	return null;
}

/** Fold test bookkeeping out of `text`, or return it unchanged. The folded lines are replaced in place by one summary line per class, at the */
export function foldToolOutputBookkeeping(text: string): FoldResult {
	// Deliberately NOT gated on whether the run failed. The first version bailed out whenever it saw a failure marker, on the
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
