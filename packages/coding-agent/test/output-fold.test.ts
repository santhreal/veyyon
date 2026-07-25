/**
 * Folding test bookkeeping out of tool output, pinned.
 *
 * WHY THIS SUITE EXISTS. This module deletes bytes from what the agent sees, so
 * every failure mode is a capability regression that would show up as a lower
 * pass rate long after the change, with no obvious cause. The measured payoff is
 * real (42% fewer tool-result tokens, 22% of that billing line on a real trace),
 * which makes it tempting to widen the patterns; these tests exist to make
 * widening them fail loudly.
 *
 * The contract in one line: a line that reports a problem is never removed, and
 * nothing is ever removed silently.
 */

import { describe, expect, it } from "bun:test";
import { classifyLine, foldToolOutputBookkeeping, MIN_FOLDABLE_LINES } from "@veyyon/coding-agent/tools/output-fold";

/** Build a run of `n` distinct `=== RUN` lines, enough to clear the threshold. */
function runLines(n: number): string[] {
	return Array.from({ length: n }, (_, i) => `=== RUN   TestThing/case_${i}`);
}

describe("classifyLine", () => {
	it("recognises the bookkeeping Go emits", () => {
		expect(classifyLine("=== RUN   TestFoo")).toBe("run");
		expect(classifyLine("=== CONT  TestFoo")).toBe("run");
		expect(classifyLine("=== PAUSE TestFoo")).toBe("run");
		expect(classifyLine("--- PASS: TestFoo (0.00s)")).toBe("pass");
		expect(classifyLine("    --- SKIP: TestFoo/sub (0.00s)")).toBe("pass");
		expect(classifyLine("?   \tcarvel.dev/ytt/pkg\t[no test files]")).toBe("noTestFiles");
		expect(classifyLine("ok  \tcarvel.dev/ytt/pkg/cmd\t0.075s")).toBe("packageOk");
		expect(classifyLine("ok  \tcarvel.dev/ytt/pkg/cmd\t0.075s (cached)")).toBe("packageOk");
	});

	/**
	 * The lines whose removal would cost the agent the run. Each is asserted
	 * individually rather than through folded output, so a pattern that starts
	 * matching one of them names itself in the failure.
	 */
	it("never classifies a line that reports a problem", () => {
		const mustSurvive = [
			"--- FAIL: TestDataValues (0.00s)",
			"    --- FAIL: TestDataValues/can_be_set (0.00s)",
			"FAIL\tcarvel.dev/ytt/pkg/cmd\t0.075s",
			"FAIL",
			"panic: runtime error: index out of range [3]",
			"WARNING: DATA RACE",
			"        e2e_test.go:473: ",
			"                \tError Trace:\t/app/test/e2e/e2e_test.go:473",
			"                \tError:      \tNot equal:",
			"--- BENCH: BenchmarkThing",
		];
		for (const line of mustSurvive) expect(classifyLine(line)).toBeNull();
	});

	/**
	 * Go is not the only runner an agent meets, and the others emit the same
	 * per-test bookkeeping in their own shapes. Each is pinned by example so a
	 * regex tweak for one runner cannot quietly stop folding another.
	 */
	it("recognises pytest, cargo, vitest and jest bookkeeping", () => {
		expect(classifyLine("tests/test_x.py::test_y PASSED")).toBe("pass");
		expect(classifyLine("tests/test_x.py::test_y PASSED [ 45%]")).toBe("pass");
		expect(classifyLine("tests/test_x.py::test_y SKIPPED")).toBe("pass");
		expect(classifyLine("test parser::handles_empty ... ok")).toBe("pass");
		expect(classifyLine("test parser::slow_case ... ignored")).toBe("pass");
		expect(classifyLine("   ✓ src/foo.test.ts > parses input")).toBe("pass");
		expect(classifyLine("PASS  src/foo.test.ts")).toBe("packageOk");
	});

	/**
	 * The failing counterparts for those same runners. These are the lines the
	 * agent needs, and each is one small regex slip away from being folded.
	 */
	it("never classifies a failing line from any supported runner", () => {
		expect(classifyLine("tests/test_x.py::test_y FAILED")).toBeNull();
		expect(classifyLine("tests/test_x.py::test_y ERROR")).toBeNull();
		expect(classifyLine("test parser::handles_empty ... FAILED")).toBeNull();
		expect(classifyLine("   ✗ src/foo.test.ts > parses input")).toBeNull();
		expect(classifyLine("   × src/foo.test.ts > parses input")).toBeNull();
		expect(classifyLine("FAIL  src/foo.test.ts")).toBeNull();
	});

	/**
	 * Bun's own runner and TAP, both of which an agent working in this repo meets on
	 * every single test run and neither of which was folded. `bun test` prints one
	 * `(pass)` line per test, so a suite of two thousand tests is two thousand lines
	 * of "the thing you asked to run, ran".
	 */
	it("recognises bun test and TAP bookkeeping", () => {
		expect(classifyLine("(pass) Settings > loads a profile [1.23ms]")).toBe("pass");
		expect(classifyLine("(skip) Settings > windows-only case")).toBe("pass");
		expect(classifyLine("(todo) Settings > not written yet")).toBe("pass");
		expect(classifyLine("ok 12 - parses input")).toBe("pass");
		expect(classifyLine("ok 1")).toBe("pass");
	});

	/**
	 * The failing counterparts, and the near-misses. `not ok` is TAP's failure line
	 * and shares a prefix with the pattern above, so it gets its own assertion.
	 */
	it("never classifies a bun or TAP failure", () => {
		expect(classifyLine("(fail) Settings > loads a profile [1.23ms]")).toBeNull();
		expect(classifyLine("not ok 12 - parses input")).toBeNull();
		expect(classifyLine("(pass)no space after the verdict")).toBeNull();
		expect(classifyLine("okay 12 - not TAP")).toBeNull();
		expect(classifyLine("ok twelve - not a TAP number")).toBeNull();
	});

	/**
	 * Build progress, which is the other class of "the thing you asked for happened" line
	 * an agent drowns in. A cold `cargo build` on a real workspace prints one indented
	 * `Compiling <crate> v<version>` line per crate, hundreds of them, and every one is
	 * re-read on every later turn. The version token is required, so a sentence about
	 * compiling something cannot match.
	 */
	it("recognises cargo build progress", () => {
		expect(classifyLine("   Compiling serde v1.0.219")).toBe("buildProgress");
		expect(classifyLine("    Checking veyyon-natives v0.1.0")).toBe("buildProgress");
		expect(classifyLine("  Downloaded thiserror v2.0.12")).toBe("buildProgress");
		expect(classifyLine("      Fresh libc v0.2.171")).toBe("buildProgress");
	});

	/**
	 * The lines a build exists to surface. Each is one loose pattern away from being
	 * folded, and losing a compiler error is worse than any saving is worth.
	 */
	it("never classifies a build diagnostic or an unindented mention", () => {
		expect(classifyLine("error[E0308]: mismatched types")).toBeNull();
		expect(classifyLine("warning: unused variable: `x`")).toBeNull();
		expect(classifyLine("error: could not compile `veyyon-natives` (lib) due to 1 previous error")).toBeNull();
		// No version token: this is prose, not cargo.
		expect(classifyLine("   Compiling the shader takes a while")).toBeNull();
		// Unindented: cargo always indents its progress verbs.
		expect(classifyLine("Compiling serde v1.0.219")).toBeNull();
	});

	/**
	 * A test's own stdout can start with anything, including text that looks like
	 * a verdict. The patterns require each runner's exact shape, so ordinary
	 * output is not mistaken for bookkeeping and deleted.
	 */
	it("does not classify a test's own output that merely resembles a verdict", () => {
		expect(classifyLine("ok, that worked")).toBeNull();
		expect(classifyLine("=== RUNNING the migration")).toBeNull();
		expect(classifyLine("--- PASSED")).toBeNull();
		expect(classifyLine("? maybe [no test files] were found")).toBeNull();
		expect(classifyLine("ok  \tsomepkg\tnot-a-duration")).toBeNull();
	});
});

describe("foldToolOutputBookkeeping", () => {
	/**
	 * The headline case: a large passing suite collapses to a single stated
	 * summary per class, and the surviving text says how much went.
	 */
	it("folds a large passing suite and says what it removed", () => {
		const text = [...runLines(40), "ok  \tpkg/a\t0.10s"].join("\n");
		const result = foldToolOutputBookkeeping(text);
		expect(result.folded.run).toBe(40);
		expect(result.text).toContain("[folded 40 === RUN/CONT/PAUSE lines");
		expect(result.text.split("\n").filter(l => l.startsWith("=== RUN"))).toHaveLength(0);
		expect(result.text.length).toBeLessThan(text.length / 4);
	});

	/**
	 * The regression that motivated removing the global failure gate, and the one
	 * most likely to be reintroduced by someone being cautious: a FAILING run
	 * still folds its passing bookkeeping, and every failure line survives
	 * verbatim, in order.
	 */
	it("folds passing bookkeeping in a FAILING run while keeping every failure line", () => {
		const text = [
			...runLines(30),
			"--- FAIL: TestThing/case_7 (0.01s)",
			"    thing_test.go:42: expected 3, got 4",
			"FAIL",
			"FAIL\tcarvel.dev/ytt/pkg\t0.20s",
		].join("\n");
		const result = foldToolOutputBookkeeping(text);
		expect(result.folded.run).toBe(30);
		expect(result.text).toContain("--- FAIL: TestThing/case_7 (0.01s)");
		expect(result.text).toContain("    thing_test.go:42: expected 3, got 4");
		expect(result.text).toContain("FAIL\tcarvel.dev/ytt/pkg\t0.20s");
		// Order preserved: the fold marker sits where the run lines were, before
		// the failure detail that followed them.
		const lines = result.text.split("\n");
		expect(lines.findIndex(l => l.startsWith("[folded"))).toBeLessThan(
			lines.findIndex(l => l.startsWith("--- FAIL")),
		);
	});

	/**
	 * Output the agent printed itself is not bookkeeping and must come through
	 * byte for byte, interleaved exactly as it was. Folding that would destroy
	 * the actual result of a computation.
	 */
	it("passes a test's own stdout through unchanged", () => {
		const text = [...runLines(20), "computed checksum: 8f14e45f", "rows written: 1042"].join("\n");
		const result = foldToolOutputBookkeeping(text);
		expect(result.text).toContain("computed checksum: 8f14e45f");
		expect(result.text).toContain("rows written: 1042");
	});

	/**
	 * A short run is left alone: the explanatory line would cost more than the
	 * few lines it replaces, and the raw output reads better.
	 */
	it("leaves a run below the threshold untouched", () => {
		const text = runLines(MIN_FOLDABLE_LINES - 1).join("\n");
		const result = foldToolOutputBookkeeping(text);
		expect(result.text).toBe(text);
		expect(result.skippedReason).toBe("below-threshold");
		expect(result.folded).toEqual({});
	});

	/**
	 * The threshold boundary, both sides, asserted exactly.
	 *
	 * `MIN_FOLDABLE_LINES` decides whether the fold does anything at all, and an
	 * off-by-one here is invisible: the fold would simply stop firing on the small
	 * runs, cost would drift back up, and every test above would still pass
	 * because they all use comfortably large inputs. Pinning both sides means a
	 * change to the constant has to be deliberate.
	 */
	it("folds at exactly the threshold and not one line below it", () => {
		// The literal matters as much as the relative check. Asserting only
		// `runLines(MIN_FOLDABLE_LINES)` against `MIN_FOLDABLE_LINES` is
		// self-referential: the test moves with the constant, so raising the
		// threshold until the fold stops firing on real output passes cleanly.
		// Verified by mutation, which is how that hole was found.
		expect(MIN_FOLDABLE_LINES).toBe(12);
		expect(foldToolOutputBookkeeping(runLines(12).join("\n")).folded.run).toBe(12);
		expect(foldToolOutputBookkeeping(runLines(11).join("\n")).folded).toEqual({});
	});

	/**
	 * The threshold counts foldable lines across ALL classes, not per class. A
	 * `go test ./...` run over many packages emits a handful of each kind and
	 * would never clear a per-class threshold, which is exactly the output that
	 * cost 4.7% of a session bill.
	 */
	it("counts foldable lines across classes, not per class", () => {
		const text = [
			...runLines(5),
			...Array.from({ length: 4 }, (_, i) => `?   \tpkg/${i}\t[no test files]`),
			...Array.from({ length: 4 }, (_, i) => `ok  \tpkg/ok${i}\t0.0${i}s`),
		].join("\n");
		const result = foldToolOutputBookkeeping(text);
		expect(result.skippedReason).toBeUndefined();
		expect(result.folded).toEqual({ run: 5, noTestFiles: 4, packageOk: 4 });
	});

	/** Text with no test output at all is returned identically, so the fold is safe to apply to any tool result. */
	it("folds a cold cargo build and keeps every diagnostic", () => {
		// The shape a real `cargo build` produces: a long progress run, then the errors.
		const lines: string[] = [];
		for (let index = 0; index < 40; index++) lines.push(`   Compiling crate_${index} v0.${index}.0`);
		lines.push("error[E0308]: mismatched types");
		lines.push("  --> src/lib.rs:12:5");
		lines.push("warning: unused variable: `x`");
		lines.push("error: could not compile `mycrate` (lib) due to 1 previous error");

		const result = foldToolOutputBookkeeping(lines.join("\n"));

		expect(result.folded.buildProgress).toBe(40);
		expect(result.text).toContain("[folded 40 build progress lines; failures are never folded]");
		expect(result.text).not.toContain("Compiling crate_0 v0.0.0");
		expect(result.text).toContain("error[E0308]: mismatched types");
		expect(result.text).toContain("  --> src/lib.rs:12:5");
		expect(result.text).toContain("warning: unused variable: `x`");
		expect(result.text).toContain("error: could not compile `mycrate` (lib) due to 1 previous error");
	});

	it("returns unrelated output unchanged", () => {
		const text = "hello\nworld\nno tests here";
		const result = foldToolOutputBookkeeping(text);
		expect(result.text).toBe(text);
		expect(result.skippedReason).toBe("nothing-to-fold");
	});

	/** Empty input is a no-op rather than a crash, since tool output is frequently empty. */
	it("handles empty input", () => {
		expect(foldToolOutputBookkeeping("").text).toBe("");
	});

	/**
	 * Each class is summarised exactly once even though its lines are scattered
	 * through the output, so the result cannot accumulate one marker per line and
	 * end up larger than what it replaced.
	 */
	it("emits one marker per class, no matter how the lines are interleaved", () => {
		const text = [
			...runLines(15),
			"?   \tpkg/a\t[no test files]",
			...runLines(15),
			"?   \tpkg/b\t[no test files]",
		].join("\n");
		const result = foldToolOutputBookkeeping(text);
		const markers = result.text.split("\n").filter(l => l.startsWith("[folded"));
		expect(markers).toHaveLength(2);
		expect(result.folded.run).toBe(30);
		expect(result.folded.noTestFiles).toBe(2);
	});
});

/**
 * Dependency fetch and install noise, which is the class an agent meets before
 * it has run a single test.
 *
 * WHY THIS SUITE EXISTS. A cold module cache or a container-setup step emits one
 * line per transitive dependency, hundreds of them, and none of them carries
 * anything the agent uses: the only thing it needs to know is whether the
 * install succeeded, which is a different line entirely. That output then enters
 * context early, which is the expensive end of a session, and is re-read for
 * every later turn.
 *
 * The danger is identical to the test-bookkeeping patterns and is why each
 * pattern below demands its tool's exact shape: `Downloading` and `Setting up`
 * are ordinary English, and an application's own logging that got folded would
 * be an unrecoverable loss the operator could not see. Every near-miss below
 * exists because it is a line a real program could plausibly print.
 */

/**
 * A verbatim excerpt from this machine's own `/var/log/apt/term.log`.
 *
 * Real output, copied unmodified, so the measurement above is against what apt
 * actually prints rather than a fixture shaped to fold well. Kept inline because
 * the log is root-readable and a test must not depend on the host.
 */
const REAL_APT_EXCERPT = `Processing triggers for man-db (2.12.0-4build2) ...
Log ended: 2026-07-10  12:34:09

Log started: 2026-07-13  11:34:49
Selecting previously unselected package brave-keyring.
(Reading database ... 
(Reading database ... 5%
(Reading database ... 10%
(Reading database ... 15%
(Reading database ... 20%
(Reading database ... 25%
(Reading database ... 30%
(Reading database ... 35%
(Reading database ... 40%
(Reading database ... 45%
(Reading database ... 50%
(Reading database ... 55%
(Reading database ... 60%
(Reading database ... 65%
(Reading database ... 70%
(Reading database ... 75%
(Reading database ... 80%
(Reading database ... 85%
(Reading database ... 90%
(Reading database ... 95%
(Reading database ... 100%
(Reading database ... 472153 files and directories currently installed.)
Preparing to unpack .../brave-keyring_1.20_all.deb ...
Unpacking brave-keyring (1.20) ...
Selecting previously unselected package brave-browser.
Preparing to unpack .../brave-browser_1.92.139_amd64.deb ...
Unpacking brave-browser (1.92.139) ...
Setting up brave-keyring (1.20) ...
Setting up brave-browser (1.92.139) ...
update-alternatives: using /usr/bin/brave-browser-stable to provide /usr/bin/x-www-browser (x-www-browser) in auto mode
update-alternatives: using /usr/bin/brave-browser-stable to provide /usr/bin/gnome-www-browser (gnome-www-browser) in auto mode
update-alternatives: using /usr/bin/brave-browser-stable to provide /usr/bin/brave-browser (brave-browser) in auto mode
Processing triggers for bamfdaemon (0.5.6+22.04.20220217-0ubuntu5) ...
Rebuilding /usr/share/applications/bamf-2.index...
Processing triggers for desktop-file-utils (0.27-2build1) ...
Processing triggers for gnome-menus (3.36.0-1.1ubuntu3) ...
Processing triggers for man-db (2.12.0-4build2) ...
Processing triggers for mailcap (3.70+nmu1ubuntu1) ...
Log ended: 2026-07-13  11:34:56

Log started: 2026-07-13  11:39:57`;

describe("dependency fetch folding", () => {
	/** go mod, one line per module on a cold cache. The version token and the
	 * `go: ` prefix are both the toolchain's own. */
	it("classifies go module download lines", () => {
		expect(classifyLine("go: downloading github.com/stretchr/testify v1.9.0")).toBe("dependencyFetch");
		expect(classifyLine("go: extracting golang.org/x/net v0.21.0")).toBe("dependencyFetch");
		expect(classifyLine("go: finding cloud.google.com/go v0.112.0")).toBe("dependencyFetch");
	});

	/**
	 * A `go: ` line that reports a PROBLEM must survive. This is the whole safety
	 * property for this class: the toolchain uses the same prefix for module
	 * resolution failures, and folding one would hide the actual reason a build
	 * did not run.
	 */
	it("leaves go toolchain problems unclassified", () => {
		expect(classifyLine("go: updates to go.mod needed; to update it: go mod tidy")).toBeNull();
		expect(classifyLine("go: module github.com/x/y found, but does not contain package z")).toBeNull();
		expect(classifyLine("go: github.com/x/y@v1.0.0: missing go.sum entry")).toBeNull();
	});

	/** pip, where an already-satisfied requirements file is one line per
	 * transitive dependency and nothing else at all. */
	it("classifies pip requirement and fetch lines", () => {
		expect(classifyLine("Requirement already satisfied: numpy in /usr/lib/python3.11 (1.26.4)")).toBe(
			"dependencyFetch",
		);
		expect(classifyLine("Collecting pytest==8.1.1")).toBe("dependencyFetch");
		expect(classifyLine("  Downloading pytest-8.1.1-py3-none-any.whl (337 kB)")).toBe("dependencyFetch");
		expect(classifyLine("  Using cached numpy-1.26.4-cp311-cp311-linux_x86_64.whl (18.2 MB)")).toBe(
			"dependencyFetch",
		);
	});

	/**
	 * The size parenthetical is what separates pip's fetch lines from an
	 * application logging the same word, so a `Downloading` line without one is
	 * left alone. This is the near-miss the pattern is narrow for.
	 */
	it("leaves a bare Downloading line alone", () => {
		expect(classifyLine("  Downloading the dataset now")).toBeNull();
		expect(classifyLine("Downloading model weights (this may take a while)")).toBeNull();
		expect(classifyLine("[INFO] Downloading https://example.com/f.tar.gz")).toBeNull();
	});

	/** pip failures are a different shape and must survive. */
	it("leaves pip failures unclassified", () => {
		expect(classifyLine("ERROR: Could not find a version that satisfies the requirement nope")).toBeNull();
		expect(classifyLine("ERROR: Cannot install -r requirements.txt (line 3)")).toBeNull();
	});

	/** apt-get, which is most of what a container-setup step prints. */
	it("classifies apt fetch and unpack lines", () => {
		expect(classifyLine("Get:1 http://deb.debian.org/debian bookworm/main amd64 libx11 amd64 2:1.8.4-2")).toBe(
			"dependencyFetch",
		);
		expect(classifyLine("Selecting previously unselected package libx11-6:amd64.")).toBe("dependencyFetch");
		expect(classifyLine("Preparing to unpack .../libx11-6_2%3a1.8.4-2_amd64.deb ...")).toBe("dependencyFetch");
		expect(classifyLine("Unpacking libx11-6:amd64 (2:1.8.4-2) ...")).toBe("dependencyFetch");
		expect(classifyLine("Setting up libx11-6:amd64 (2:1.8.4-2) ...")).toBe("dependencyFetch");
	});

	/**
	 * `Setting up` and `Unpacking` are ordinary English, so both require dpkg's
	 * parenthesised version AND its trailing ` ...`. A test that prints "Setting
	 * up the fixture" must survive, and so must an apt ERROR line.
	 */
	it("leaves prose that starts with an apt verb alone", () => {
		expect(classifyLine("Setting up the test fixture")).toBeNull();
		expect(classifyLine("Unpacking the archive into /tmp")).toBeNull();
		expect(classifyLine("Setting up libx11-6:amd64 (2:1.8.4-2)")).toBeNull();
		expect(classifyLine("E: Unable to locate package nonesuch")).toBeNull();
	});

	/** dpkg's post-install bookkeeping, which on a real transcript is a third of
	 * everything left after the fetch lines go. */
	it("classifies dpkg trigger and database progress", () => {
		expect(classifyLine("Processing triggers for man-db (2.12.0-4build2) ...")).toBe("dependencyFetch");
		expect(classifyLine("Processing triggers for libc-bin (2.39-0ubuntu8.3) ...")).toBe("dependencyFetch");
		expect(classifyLine("(Reading database ... 45%")).toBe("dependencyFetch");
		expect(classifyLine("(Reading database ... 312044 files and directories currently installed.)")).toBe(
			"dependencyFetch",
		);
	});

	/** The same narrowness rule: "Processing triggers" without dpkg's exact
	 * parenthesised version and trailing ellipsis is prose and must survive. */
	it("leaves trigger-shaped prose alone", () => {
		expect(classifyLine("Processing triggers for the queue")).toBeNull();
		expect(classifyLine("Processing triggers for man-db (2.12.0-4build2)")).toBeNull();
		expect(classifyLine("Reading database from disk")).toBeNull();
	});

	/**
	 * MEASURED ON REAL DATA, not a fixture. This machine's own
	 * `/var/log/apt/term.log` is a genuine 39KB apt transcript, and the patterns
	 * above take 40% of it. The number is asserted loosely because the log is a
	 * real artifact that changes as packages are installed; the point is that the
	 * class is worth folding on real output, not a fixture built to be foldable.
	 */
	it("folds a real apt transcript by a large fraction", () => {
		const raw = REAL_APT_EXCERPT;
		const result = foldToolOutputBookkeeping(raw);
		expect(result.folded.dependencyFetch).toBeGreaterThan(20);
		expect(result.text.length).toBeLessThan(raw.length * 0.7);
		// The lines an operator actually reads survive.
		expect(result.text).toContain("update-alternatives: using /usr/bin/brave-browser");
	});

	/**
	 * End to end on a captured-shape install, which is the state this class exists
	 * for: the noise collapses, the one line that says what happened survives
	 * verbatim, and the fold announces itself rather than silently shrinking the
	 * output.
	 */
	it("folds a module download preamble and keeps the build error", () => {
		const modules = Array.from({ length: 40 }, (_, i) => `go: downloading github.com/dep/pkg${i} v1.${i}.0`);
		const raw = [
			...modules,
			"# github.com/example/project/internal/store",
			"internal/store/db.go:42:9: undefined: openConn",
			"FAIL	github.com/example/project/internal/store [build failed]",
		].join("\n");

		const result = foldToolOutputBookkeeping(raw);

		expect(result.folded.dependencyFetch).toBe(40);
		expect(result.text).toContain("internal/store/db.go:42:9: undefined: openConn");
		expect(result.text).toContain("FAIL	github.com/example/project/internal/store [build failed]");
		expect(result.text).toContain("# github.com/example/project/internal/store");
		expect(result.text).not.toContain("go: downloading github.com/dep/pkg0 v1.0.0");
		expect(result.text.length).toBeLessThan(raw.length / 3);
	});

	/**
	 * The same for pip, where the surviving line is the one an agent reads to know
	 * the environment is ready.
	 */
	it("folds an already-satisfied requirements install and keeps the outcome", () => {
		const satisfied = Array.from(
			{ length: 30 },
			(_, i) => `Requirement already satisfied: pkg${i} in /usr/lib/python3.11/site-packages (1.${i}.0)`,
		);
		const raw = [...satisfied, "Successfully installed pytest-8.1.1"].join("\n");

		const result = foldToolOutputBookkeeping(raw);

		expect(result.folded.dependencyFetch).toBe(30);
		expect(result.text).toContain("Successfully installed pytest-8.1.1");
		expect(result.text).not.toContain("Requirement already satisfied: pkg0");
	});

	/** A short install stays raw, same as every other class: below the threshold
	 * the summary line costs more than it saves and the reader is better served by
	 * the real output. */
	it("leaves a short install untouched", () => {
		const raw = Array.from({ length: MIN_FOLDABLE_LINES - 1 }, (_, i) => `Collecting pkg${i}`).join("\n");
		expect(foldToolOutputBookkeeping(raw).text).toBe(raw);
	});

	/** Mixed classes are summarised separately, so the operator can tell a build
	 * that spent its output on downloads from one that spent it on tests. */
	it("reports dependency fetch separately from test bookkeeping", () => {
		const raw = [
			...Array.from({ length: 15 }, (_, i) => `go: downloading github.com/dep/pkg${i} v1.0.0`),
			...Array.from({ length: 15 }, (_, i) => `=== RUN   TestThing/case_${i}`),
		].join("\n");

		const result = foldToolOutputBookkeeping(raw);

		expect(result.folded.dependencyFetch).toBe(15);
		expect(result.folded.run).toBe(15);
	});
});

/**
 * Carriage returns, and the shipped bug they caused.
 *
 * WHY THIS SUITE EXISTS. Most patterns in this module are anchored with `$`, and
 * the bash tool captures command output through a PTY, which terminates every
 * line `\r\n`. So the fold worked on piped output and silently did almost
 * nothing on the product's most common capture path: `ok  pkg  0.012s\r` does
 * not match `...s$`. It was invisible because the fold has no failure mode of
 * its own, it simply folds less, and less is a valid outcome.
 *
 * Found by measuring against a real 39KB `apt` transcript, where 68 upgrade
 * lines went unclassified for no reason other than the trailing `\r`.
 *
 * It is a correctness fix, NOT a saving. `OutputSink.write` sanitizes every
 * chunk and `sanitizeText` already strips CR, so on today's paths the fold never
 * sees one; the same real log folds to 84.9% with or without this. What it buys
 * is that an exported classifier answers correctly for CRLF input, without
 * depending on an upstream sanitizer a future caller has no reason to know
 * about.
 */
describe("carriage-return terminated output", () => {
	/**
	 * Every class, with and without the `\r`, must reach the same verdict. Written
	 * as a loop over the classes rather than a handful of samples, because the bug
	 * was not specific to one pattern: it silently disabled all of them.
	 */
	it("classifies a line identically with or without a trailing carriage return", () => {
		const samples = [
			"=== RUN   TestThing",
			"    --- PASS: TestThing/case (0.00s)",
			"?   github.com/x/y  [no test files]",
			"ok  	github.com/x/y	0.012s",
			"tests/test_x.py::test_y PASSED",
			"test module::name ... ok",
			"(pass) suite > name [1.23ms]",
			"ok 12 - parses input",
			"   Compiling serde v1.0.219",
			"go: downloading github.com/x/y v1.2.3",
			"Unpacking libssl-dev:amd64 (3.0.13-0ubuntu3.11) over (3.0.13-0ubuntu3.9) ...",
			"Processing triggers for man-db (2.12.0-4build2) ...",
		];
		for (const sample of samples) {
			const bare = classifyLine(sample);
			expect(bare).not.toBeNull();
			expect(classifyLine(`${sample}\r`)).toBe(bare);
		}
	});

	/** A line that should NOT fold must not start folding because of a `\r`. The
	 * fix loosens matching, so the near-misses have to be re-checked under it. */
	it("does not classify a near miss just because it ends in a carriage return", () => {
		expect(classifyLine("--- FAIL: TestThing (0.01s)\r")).toBeNull();
		expect(classifyLine("not ok 3 - parses input\r")).toBeNull();
		expect(classifyLine("(fail) suite > name\r")).toBeNull();
		expect(classifyLine("Setting up the test fixture\r")).toBeNull();
	});

	/** Only a trailing `\r` is ignored. A carriage return in the MIDDLE of a line
	 * is a progress redraw, and treating it as a terminator would let a pattern
	 * match a fragment of a line that continues with something else. */
	it("ignores only a trailing carriage return, not one inside the line", () => {
		expect(classifyLine("ok  	github.com/x/y	0.012s\rsomething else")).toBeNull();
		expect(classifyLine("\rok 12 - name")).toBeNull();
	});

	/** End to end on CRLF text, which is what the PTY path produces. */
	it("folds CRLF output", () => {
		const raw = Array.from({ length: 20 }, (_, i) => `go: downloading github.com/dep/pkg${i} v1.0.0\r`).join("\n");
		const result = foldToolOutputBookkeeping(raw);
		expect(result.folded.dependencyFetch).toBe(20);
	});

	/**
	 * A surviving line keeps its bytes exactly, carriage return included. The fold
	 * strips the `\r` only to decide, never to rewrite: the operator's copy of a
	 * line the fold did not take must be the line the tool produced.
	 */
	it("preserves the carriage return on lines it does not fold", () => {
		const raw = [
			...Array.from({ length: 15 }, (_, i) => `go: downloading github.com/dep/pkg${i} v1.0.0\r`),
			"FAIL\tgithub.com/example/project [build failed]\r",
		].join("\n");
		const result = foldToolOutputBookkeeping(raw);
		expect(result.text).toContain("FAIL\tgithub.com/example/project [build failed]\r");
	});
});

describe("python unittest verbose output", () => {
	/**
	 * WHY. `python -m unittest -v` prints one line per test and, on a passing run, prints nothing else
	 * until the four-line summary. A real 41-test run captured on this machine is 2,473 chars of which
	 * 2,303 are these lines: folding takes it to 170 chars, 93.1% smaller. unittest is what a repo with
	 * no pytest dependency uses, so it is the shape a plain Python project's agent meets.
	 */
	it("classifies a passing and a skipped test line", () => {
		expect(classifyLine("test_case_000 (test_demo.DemoCases.test_case_000) ... ok")).toBe("pass");
		expect(classifyLine("test_skipped_case (test_demo.DemoCases.test_skipped_case) ... skipped 'not today'")).toBe(
			"pass",
		);
		expect(classifyLine("test_upper (tests.test_str.Case.test_upper) ... expected failure")).toBe("pass");
	});

	/**
	 * The line that matters. unittest reports a failure in the SAME position with `FAIL` or `ERROR`
	 * instead of `ok`, so a pattern one character too loose would delete exactly the lines the agent
	 * needs. Asserted per verdict rather than in aggregate.
	 */
	it("never classifies a failing, erroring, or unfinished unittest line", () => {
		for (const line of [
			"test_case_007 (test_demo.DemoCases.test_case_007) ... FAIL",
			"test_case_007 (test_demo.DemoCases.test_case_007) ... ERROR",
			"test_case_007 (test_demo.DemoCases.test_case_007) ... unexpected success",
			"FAIL: test_case_007 (test_demo.DemoCases.test_case_007)",
			"ERROR: test_case_007 (test_demo.DemoCases.test_case_007)",
		]) {
			expect(classifyLine(line)).toBeNull();
		}
	});

	/** Prose about a function, which is not a verdict line and has no ` ... ok` tail. */
	it("leaves a mention of a test in parentheses alone", () => {
		expect(classifyLine("test_case_000 (the slow one) is flaky")).toBeNull();
		expect(classifyLine("ran test_case_000 (test_demo.DemoCases.test_case_000) ... ok")).toBeNull();
	});

	/**
	 * End to end on the real captured shape, including the summary an agent reads. The fold keeps the
	 * verdict block byte for byte; only the per-test lines go.
	 */
	it("folds a real 41-test run down to its summary", () => {
		const lines = [
			...Array.from(
				{ length: 40 },
				(_, i) =>
					`test_case_${String(i).padStart(3, "0")} (test_demo.DemoCases.test_case_${String(i).padStart(3, "0")}) ... ok`,
			),
			"test_skipped_case (test_demo.DemoCases.test_skipped_case) ... skipped 'not today'",
			"",
			"----------------------------------------------------------------------",
			"Ran 41 tests in 0.001s",
			"",
			"OK (skipped=1)",
		];

		const result = foldToolOutputBookkeeping(lines.join("\n"));

		expect(result.folded.pass).toBe(41);
		expect(result.text.split("\n")).toEqual([
			"[folded 41 --- PASS/SKIP lines; failures are never folded]",
			"",
			"----------------------------------------------------------------------",
			"Ran 41 tests in 0.001s",
			"",
			"OK (skipped=1)",
		]);
	});

	/** A failing run keeps its traceback, which is the entire reason the agent ran the suite again. */
	it("keeps a traceback and the FAIL line while folding the tests that passed", () => {
		const lines = [
			...Array.from({ length: 20 }, (_, i) => `test_ok_${i} (t.C.test_ok_${i}) ... ok`),
			"test_bad (t.C.test_bad) ... FAIL",
			"",
			"======================================================================",
			"FAIL: test_bad (t.C.test_bad)",
			"----------------------------------------------------------------------",
			"Traceback (most recent call last):",
			'  File "t.py", line 9, in test_bad',
			"    self.assertEqual(1, 2)",
			"AssertionError: 1 != 2",
		];

		const result = foldToolOutputBookkeeping(lines.join("\n"));

		expect(result.folded.pass).toBe(20);
		expect(result.text).toContain("test_bad (t.C.test_bad) ... FAIL");
		expect(result.text).toContain("AssertionError: 1 != 2");
		expect(result.text).toContain('  File "t.py", line 9, in test_bad');
		expect(result.text).not.toContain("test_ok_0 (");
	});
});

describe("cmake and make build progress", () => {
	/**
	 * WHY. A cmake build prints one bracketed-percentage line per translation unit and nothing else
	 * when it succeeds. A real 41-file build captured on this machine is 2,556 chars of which 43 lines
	 * are progress: folded it is 60 chars, 97.7% smaller. A C or C++ repo is the common case for this,
	 * and it is the one runner class where a whole successful build can be a single marker line.
	 */
	it("classifies the progress lines a real cmake build emits", () => {
		expect(classifyLine("[  2%] Building C object CMakeFiles/demo.dir/src/mod_000.c.o")).toBe("buildProgress");
		expect(classifyLine("[100%] Linking C executable demo")).toBe("buildProgress");
		expect(classifyLine("[100%] Built target demo")).toBe("buildProgress");
		expect(classifyLine("[ 15%] Generating moc_widget.cpp")).toBe("buildProgress");
	});

	/**
	 * The failure shapes a broken build actually emits, none of which may be folded: the compiler
	 * diagnostic, the line it points at, and make's own error line, which carries the failing target.
	 */
	it("never classifies a compiler diagnostic or make's failure line", () => {
		for (const line of [
			"src/mod_003.c:1:5: error: expected ';' before '}' token",
			"src/mod_003.c:1:5: warning: unused variable 'x' [-Wunused-variable]",
			"make[2]: *** [CMakeFiles/demo.dir/build.make:76: CMakeFiles/demo.dir/src/mod_003.c.o] Error 1",
			"make[1]: *** [CMakeFiles/Makefile2:83: CMakeFiles/demo.dir/all] Error 2",
			"make: *** [Makefile:91: all] Error 2",
			"make: *** No rule to make target 'nope'.  Stop.",
		]) {
			expect(classifyLine(line)).toBeNull();
		}
	});

	/** make's recursion bookkeeping, which a recursive build prints twice per directory it enters. */
	it("classifies make's directory recursion lines", () => {
		expect(classifyLine("make[1]: Entering directory '/build/demo'")).toBe("buildProgress");
		expect(classifyLine("make[1]: Leaving directory '/build/demo'")).toBe("buildProgress");
		expect(classifyLine("make: Entering directory '/build'")).toBe("buildProgress");
	});

	/** A percentage inside prose, and a bracketed number that is not a percentage, both stay. */
	it("leaves a bracketed number that is not build progress alone", () => {
		expect(classifyLine("[  2%] of the corpus was resampled")).toBeNull();
		expect(classifyLine("[42] Building C object")).toBeNull();
		expect(classifyLine("Building C object CMakeFiles/demo.dir/src/mod_000.c.o")).toBeNull();
	});

	/**
	 * End to end on the captured shape: a successful 41-file build becomes one line, which is the whole
	 * point, and a failing one keeps the diagnostic and the failing target.
	 */
	it("folds a whole successful build to one marker and keeps a failure's diagnostic", () => {
		const progress = Array.from(
			{ length: 41 },
			(_, i) =>
				`[${String(Math.floor((i * 100) / 41)).padStart(3)}%] Building C object CMakeFiles/demo.dir/src/mod_${String(i).padStart(3, "0")}.c.o`,
		);

		const clean = foldToolOutputBookkeeping(
			[...progress, "[100%] Linking C executable demo", "[100%] Built target demo"].join("\n"),
		);
		expect(clean.folded.buildProgress).toBe(43);
		expect(clean.text).toBe("[folded 43 build progress lines; failures are never folded]");

		const broken = foldToolOutputBookkeeping(
			[
				...progress,
				"src/mod_040.c:1:5: error: expected ';' before '}' token",
				"make[2]: *** [CMakeFiles/demo.dir/build.make:76: CMakeFiles/demo.dir/src/mod_040.c.o] Error 1",
			].join("\n"),
		);
		expect(broken.text.split("\n")).toEqual([
			"[folded 41 build progress lines; failures are never folded]",
			"src/mod_040.c:1:5: error: expected ';' before '}' token",
			"make[2]: *** [CMakeFiles/demo.dir/build.make:76: CMakeFiles/demo.dir/src/mod_040.c.o] Error 1",
		]);
	});
});

describe("gradle, docker and maven bookkeeping", () => {
	/**
	 * WHY. These three are the build tools whose successful output is almost entirely status, and each
	 * one has a shape only it emits. They are folded conservatively: gradle only where a task states it
	 * did NO work, docker only on a bare layer id, maven only on its two fetch verbs.
	 */
	it("classifies gradle tasks that did no work, and leaves the ones that ran", () => {
		expect(classifyLine("> Task :app:compileJava UP-TO-DATE")).toBe("buildProgress");
		expect(classifyLine("> Task :lib:processResources NO-SOURCE")).toBe("buildProgress");
		expect(classifyLine("> Task :app:test SKIPPED")).toBe("buildProgress");
		expect(classifyLine("> Task :app:jar FROM-CACHE")).toBe("buildProgress");
		// A task with no suffix DID work, and its own output follows it, so it stays as an anchor.
		expect(classifyLine("> Task :app:test")).toBeNull();
		expect(classifyLine("> Task :app:test FAILED")).toBeNull();
	});

	it("classifies a docker layer id and nothing else about a step", () => {
		expect(classifyLine(" ---> 8f1d3c2b4a5e")).toBe("buildProgress");
		expect(classifyLine(" ---> Running in 8f1d3c2b4a5e")).toBe("buildProgress");
		// The instruction itself is what a reader uses to locate a failure.
		expect(classifyLine("Step 4/12 : RUN apt-get update")).toBeNull();
		expect(classifyLine(" ---> Using cache")).toBeNull();
	});

	/**
	 * Maven's `[INFO] ` prefix covers its whole log, including the failures, so only the two fetch
	 * verbs with their `from <repo>: <url>` shape are folded. The build result lines stay.
	 */
	it("classifies maven artifact fetches and leaves every other INFO line", () => {
		expect(classifyLine("[INFO] Downloading from central: https://repo.maven.apache.org/x/y/1.0/y-1.0.jar")).toBe(
			"dependencyFetch",
		);
		expect(
			classifyLine(
				"[INFO] Downloaded from central: https://repo.maven.apache.org/x/y/1.0/y-1.0.jar (12 kB at 40 kB/s)",
			),
		).toBe("dependencyFetch");
		for (const line of [
			"[INFO] BUILD FAILURE",
			"[INFO] Tests run: 12, Failures: 1, Errors: 0, Skipped: 0",
			"[ERROR] Failed to execute goal on project demo",
			"[WARNING] Downloading from central without a checksum",
		]) {
			expect(classifyLine(line)).toBeNull();
		}
	});

	/** A cold maven resolve is hundreds of fetch pairs; the build result survives them all. */
	it("folds a cold maven resolve and keeps the build result", () => {
		const fetches: string[] = [];
		for (let i = 0; i < 20; i++) {
			fetches.push(`[INFO] Downloading from central: https://repo.maven.apache.org/dep${i}/1.0/dep${i}-1.0.pom`);
			fetches.push(
				`[INFO] Downloaded from central: https://repo.maven.apache.org/dep${i}/1.0/dep${i}-1.0.pom (3.1 kB at 90 kB/s)`,
			);
		}

		const result = foldToolOutputBookkeeping(
			[...fetches, "[INFO] BUILD SUCCESS", "[INFO] Total time:  4.201 s"].join("\n"),
		);

		expect(result.folded.dependencyFetch).toBe(40);
		expect(result.text.split("\n")).toEqual([
			"[folded 40 dependency fetch/install lines; failures are never folded]",
			"[INFO] BUILD SUCCESS",
			"[INFO] Total time:  4.201 s",
		]);
	});
});
