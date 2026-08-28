// WHY: `commands/launch.ts` used to await `import("../main")` before anything
// reached the terminal. That import evaluates the whole agent runtime (~0.7s in
// the compiled binary), so the operator watched a blank screen and the launch
// card arrived at ~760ms. The prologue now runs ahead of that import and ends
// AT the paint, which puts a typable card on screen at ~310ms.
//
// The class this closes is "the paint drifted back behind the runtime import".
// An earlier attempt moved cwd, settings and stdin early but left
// `paintFirstFrame` in `main.ts`, and measured as a wash: moving part of the
// prologue buys nothing, because the card is what the operator is waiting for.
// So the tests below pin the two properties that keep the ordering true rather
// than the timing, which no unit test can observe:
//
//   1. The decision to prepaint is made from argv alone, before settings or a
//      theme exist. A run that exits early or speaks a protocol must not pay
//      for them, and must not paint.
//   2. The handoff is single-use. A process-wide cache would hand a second
//      `runRootCommand` the first caller's settings, theme and painted screen.
//
// NOT COVERED: the wall-clock time to card, and the bundler's chunking. Both
// are measured against the compiled binary, not here. A change that keeps these
// invariants and still loads the runtime graph first would pass this suite.

import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/cli/args";
import { runStartupPrologue, shouldPrepaintLaunchCard } from "../src/cli/launch-card";
import { takeStartupPrologue } from "../src/cli/prologue-handoff";

/** Swap the TTY flags for one case; both are read as plain properties. */
function withTty<T>(stdin: boolean, stdout: boolean, body: () => T): T {
	const inDesc = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
	const outDesc = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
	Object.defineProperty(process.stdin, "isTTY", { value: stdin, configurable: true });
	Object.defineProperty(process.stdout, "isTTY", { value: stdout, configurable: true });
	try {
		return body();
	} finally {
		if (inDesc) Object.defineProperty(process.stdin, "isTTY", inDesc);
		if (outDesc) Object.defineProperty(process.stdout, "isTTY", outDesc);
	}
}

describe("deciding to paint the launch card before the runtime graph loads", () => {
	test("a bare interactive launch on a terminal paints", () => {
		expect(withTty(true, true, () => shouldPrepaintLaunchCard(parseArgs([])))).toBe(true);
	});

	// Every argv below reaches `runRootCommand` and produces no home screen, so
	// paying for settings and a theme ahead of the runtime import buys nothing.
	// Table-driven so a new early-exit or protocol mode is added in one place.
	const noPaint: ReadonlyArray<readonly [string, string[]]> = [
		["--version exits before any screen", ["--version"]],
		["--export writes a file and exits", ["--export", "/nonexistent/session.jsonl"]],
		["--print is single-shot output", ["--print", "hello"]],
		["rpc speaks a protocol on stdout", ["--mode", "rpc"]],
		["rpc-ui speaks a protocol on stdout", ["--mode", "rpc-ui"]],
		["acp speaks a protocol on stdout", ["--mode", "acp"]],
	];
	for (const [why, argv] of noPaint) {
		test(`does not paint: ${why}`, () => {
			expect(withTty(true, true, () => shouldPrepaintLaunchCard(parseArgs(argv)))).toBe(false);
		});
	}

	// The TUI reads keystrokes from stdin and draws to stdout. Without both, the
	// card has nowhere to go and `paintFirstFrame` would put escape codes into a
	// pipe or a log file.
	test("does not paint when stdin is not a terminal", () => {
		expect(withTty(false, true, () => shouldPrepaintLaunchCard(parseArgs([])))).toBe(false);
	});

	test("does not paint when stdout is not a terminal", () => {
		expect(withTty(true, false, () => shouldPrepaintLaunchCard(parseArgs([])))).toBe(false);
	});
});

describe("handing the prologue to runRootCommand", () => {
	test("nothing to take when no prologue ran", () => {
		expect(takeStartupPrologue()).toBeUndefined();
	});

	// The load-bearing one. A second interactive run in one process (a test
	// harness, a `/profile` relaunch that got as far as constructing one) must
	// settle its own cwd, settings and screen; a cache would hand it the first
	// caller's, including a painted frame that is no longer on the terminal.
	//
	// This has to run the real prologue to be able to fail: asserting that an
	// empty slot reads empty passes just as well against a cache, because
	// nothing ever filled it. stdin/stdout are not terminals under the runner,
	// so `shouldPaintFirstFrame` declines and no TUI is constructed -- the cwd,
	// settings and theme work still runs, which is what fills the slot.
	test("the handoff is consumed by the first taker, not cached for the next", async () => {
		const prologue = await runStartupPrologue(parseArgs([]));
		expect(prologue.settings).toBeDefined();

		expect(takeStartupPrologue()).toBe(prologue);
		expect(takeStartupPrologue()).toBeUndefined();
	});
});
