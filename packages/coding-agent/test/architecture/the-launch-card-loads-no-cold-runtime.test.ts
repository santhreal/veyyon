/**
 * The launch card waits on no runtime it will not use before the first frame.
 *
 * WHY THIS SUITE EXISTS. Everything the card path imports statically is evaluated while the terminal
 * is still blank, and a platform module costs its whole initialisation there whether or not the run
 * ever calls into it. Three sat on the path for one identifier apiece, measured on compiled binaries
 * against an empty baseline: `node:inspector` at 4.3ms, reached through `postmortem.ts` for a
 * SIGUSR1 handler; `node:crypto` at 3.3ms, reached through `file-lock.ts` for `randomUUID`, which
 * the global WebCrypto object answers for free; and `node:child_process` at 2.0ms, reached through
 * `process-liveness.ts` for a subprocess fallback a Linux launch never runs. That is 9.6ms of a 45ms
 * card spent reaching cold code, and removing all three is invisible to every functional test in the
 * tree: the calls still work, the card is just slower.
 *
 * THE CLASS, NOT THE INCIDENT. The defect is not "postmortem imported the inspector", it is "a
 * module the card waits on loaded a platform runtime for a call it does not make". So this pins the
 * WHOLE platform surface of the card path by exact equality rather than listing the three that were
 * removed: every `node:` and `bun:` specifier any module on that path imports. A new one turns this
 * red until someone records what it costs and why the card needs it, and an old one that comes back
 * fails naming itself. The costs above are what makes the list a decision rather than a snapshot.
 *
 * WHAT IT DOES NOT CATCH. A cold runtime reached through `await import()` or `require()` is
 * deliberately invisible, since deferring the load is the fix this gate wants. Cost inside a module
 * that is already admitted is invisible too: `@veyyon/natives` costs 7.7ms of accessor construction
 * and is not a platform specifier, so it is held by the card's module ceiling in
 * `the-launch-card-opens-no-database.test.ts` rather than here.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { moduleSpecifiersIn } from "@veyyon/utils/module-reach";
import { PACKAGES, reachedNames } from "../helpers/module-reach-gate";

/** Every platform specifier the modules on `entry`'s static graph import, sorted and deduplicated. */
function platformSpecifiersOn(entry: string): string[] {
	const found = new Set<string>();
	for (const relative of reachedNames(entry)) {
		const source = fs.readFileSync(path.join(PACKAGES, relative), "utf8");
		for (const specifier of moduleSpecifiersIn(source)) {
			if (specifier.startsWith("node:") || specifier.startsWith("bun:")) found.add(specifier);
		}
	}
	return [...found].sort();
}

/**
 * What the card is allowed to evaluate before it paints, and why each one is here.
 *
 * `node:fs` (3.4ms) and `node:path` read settings, the theme and the recorded launch facts, which is
 * the card's own work. `node:fs/promises` (+0.4ms once `node:fs` is loaded) and `node:os` come with
 * them. `node:worker_threads` (3.2ms) decides at module scope in `postmortem.ts` whether this
 * process installs signal handlers or the worker's exit-only path, so it cannot be deferred behind
 * the decision it makes. `node:async_hooks` and `node:util/types` are the logger's span storage.
 * `node:perf_hooks` is the render loop's clock, `node:url` turns a path into a terminal hyperlink,
 * and `node:timers/promises` is the process manager's sleep. `node:module` (free) is the handle the
 * natives loader defers `node:child_process` and `node:zlib` behind. `bun:ffi` (0.15ms) and
 * `bun:sqlite` (0.19ms) are lazy handles that cost nothing until something calls through them.
 */
const ADMITTED_ON_THE_CARD_PATH = [
	"bun:ffi",
	"bun:sqlite",
	"node:async_hooks",
	"node:fs",
	"node:fs/promises",
	"node:module",
	"node:os",
	"node:path",
	"node:perf_hooks",
	"node:timers/promises",
	"node:url",
	"node:util/types",
	"node:worker_threads",
];

/** What was removed, named so a failure says which one came back rather than only that one did. */
const REMOVED_FROM_THE_CARD_PATH = [
	"node:assert/strict",
	"node:child_process",
	"node:crypto",
	"node:inspector",
	"node:zlib",
];

describe("the launch card loads no cold runtime", () => {
	/**
	 * The walk reaches a real graph and the derivation really reads it. Every assertion below is a
	 * set equality, which an empty walk would also satisfy.
	 */
	it("walks a real graph and finds its platform imports", () => {
		const reached = reachedNames("cli/launch-card.ts");

		expect(reached.length).toBeGreaterThan(150);
		expect(reached).toContain(path.join("utils", "src", "postmortem.ts"));
		expect(reached).toContain(path.join("utils", "src", "file-lock.ts"));
		expect(reached).toContain(path.join("..", "natives", "bridge", "bindings", "native", "loader-state.js"));
		expect(platformSpecifiersOn("cli/launch-card.ts")).toContain("node:fs");
	});

	/**
	 * And the detector is not blind to what it is looking for: a module that does import the cold
	 * runtimes shows up, so the absences below are measurements rather than a walk that found
	 * nothing.
	 */
	it("sees a cold runtime on the path of a module that does load one", () => {
		const onATool = platformSpecifiersOn("tools/shell/bash.ts");

		expect(onATool).toContain("node:child_process");
		expect(onATool).toContain("node:crypto");
	});

	for (const [label, entry] of [
		["the launch card", "cli/launch-card.ts"],
		["the first frame", "modes/terminal/first-frame.ts"],
	] as const) {
		/** One case per entry, so a failure names the path that regained the runtime. */
		it(`${label} evaluates nothing but the platform it uses`, () => {
			const reached = platformSpecifiersOn(entry);

			expect(reached.filter(specifier => REMOVED_FROM_THE_CARD_PATH.includes(specifier))).toEqual([]);
			expect(reached).toEqual(ADMITTED_ON_THE_CARD_PATH);
		});
	}
});
