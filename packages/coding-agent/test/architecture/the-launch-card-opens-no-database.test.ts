/**
 * Nothing the launch card draws needs a database, so nothing on its path may load one.
 *
 * WHY THIS SUITE EXISTS. `cli/launch-card.ts` paints the card before it imports the runtime, and
 * everything that paint reaches is evaluated first, on every interactive launch, while the terminal
 * is still blank. `config/settings.ts` sat on that path and imported `session/agent-storage.ts` for
 * a handle it cached and a legacy table it read once on a first run, which put `bun:sqlite` and
 * `@veyyon/ai/auth-storage-sqlite` in front of the card. Measured on the compiled binary, that
 * subtree cost 6.4 ms of module evaluation out of a 50.5 ms card, for a database the card never
 * reads: the settings store now holds no handle, `AgentStorage.forAgentDir` is the one owner of the
 * run's handle and opens it on first use, and `config/legacy-agent-db-settings.ts` owns the
 * first-run read of the legacy table.
 *
 * WHAT THIS ASSERTS AND WHY IT IS STRUCTURAL. The edge that was removed is one import line, and
 * re-adding it changes no behaviour at all — every call still works, the card is just slower again,
 * which no functional test can see. So this walks the real static graph and asserts a reachability
 * fact about it.
 *
 * THE CLASS, NOT THE INCIDENT. The defect was not "settings imported agent-storage", it was "a
 * module the card waits on opened a database". So the set of database owners is derived from the
 * workspace at run time — every source file that imports `bun:sqlite` — rather than listing the two
 * modules that happened to be involved. A new store added anywhere in the workspace joins the set
 * without an edit here, and turns this red the moment the card path reaches it.
 *
 * WHAT IT DOES NOT CATCH. A module that opens a database through a wrapper that itself does not name
 * `bun:sqlite` (a future `@veyyon/utils/sqlite`-style opener) is invisible to the derivation, and a
 * `await import("bun:sqlite")` is deliberately invisible, because deferring the load is the fix this
 * gate wants. Neither is on the card path today; both would need this derivation widened.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { moduleSpecifiersIn } from "@veyyon/utils/module-reach";
import { PACKAGES, reach, reachedNames } from "../helpers/module-reach-gate";

/** Every `.ts` file under a workspace package's `src/`, as a path relative to `packages/`. */
function workspaceSources(): string[] {
	const found: string[] = [];
	for (const member of fs.readdirSync(PACKAGES, { withFileTypes: true })) {
		if (!member.isDirectory()) continue;
		const src = path.join(PACKAGES, member.name, "src");
		if (!fs.existsSync(src)) continue;
		for (const file of fs.readdirSync(src, { recursive: true, encoding: "utf8" })) {
			if (!file.endsWith(".ts") || file.endsWith(".d.ts")) continue;
			found.push(path.join(member.name, "src", file));
		}
	}
	return found.sort();
}

/**
 * Every workspace module that instantiates SQLite at import time.
 *
 * Derived rather than listed: this is the variant space the gate below is about, and a hardcoded
 * pair of names would go stale the first time a third store is written.
 */
const DATABASE_OWNERS = workspaceSources().filter(relative => {
	const source = fs.readFileSync(path.join(PACKAGES, relative), "utf8");
	return moduleSpecifiersIn(source).includes("bun:sqlite");
});

/**
 * The one SQLite module the card path is allowed to reach, and why.
 *
 * It names `bun:sqlite`, which is a builtin already resident in the compiled binary — measured on
 * that binary, importing it is under the 0.5 ms the timing tree prints, against 6.4 ms for the
 * credential store. It reaches three leaves of its own, opens nothing at import, and its one caller
 * is the config migration, which runs only on a launch that finds no config.yml.
 *
 * Pinned by exact equality rather than by count: a second admitted member has to be argued here.
 */
const ADMITTED_ON_THE_CARD_PATH = [path.join("coding-agent", "src", "config", "legacy-agent-db-settings.ts")];

/**
 * What the card costs, measured 2026-08-30 with the workspace resolved to source, down from 311 when
 * the settings store still carried a storage handle.
 *
 * The floor is what stops a resolution table that stopped resolving from satisfying the ceiling with
 * a handful of modules while measuring nothing.
 */
const LAUNCH_CARD_CEILING = 290;
const LAUNCH_CARD_FLOOR = 150;

describe("the launch card opens no database", () => {
	/**
	 * The graph is really walked and the derivation really found something. The assertions below are
	 * all "reaches nothing but the admitted leaf", which is also what a broken walk and an empty owner
	 * list return.
	 */
	it("finds the workspace's SQLite owners and walks a real graph", () => {
		expect(DATABASE_OWNERS).toContain(path.join("coding-agent", "src", "session", "agent-storage.ts"));
		expect(DATABASE_OWNERS).toContain(path.join("ai", "src", "auth-storage-sqlite.ts"));
		expect(DATABASE_OWNERS).toContain(ADMITTED_ON_THE_CARD_PATH[0]);
		expect(reach("cli/launch-card.ts")).toBeGreaterThan(LAUNCH_CARD_FLOOR);
	});

	/**
	 * And the detector is not blind to the thing it is looking for: the module that owns the run's
	 * handle reaches the SQLite credential store, so the intersections below are real tests.
	 */
	it("sees a database on the path of a module that does open one", () => {
		const reached = new Set(reachedNames("session/agent-storage.ts"));

		expect(DATABASE_OWNERS.filter(owner => reached.has(owner))).toContain(
			path.join("ai", "src", "auth-storage-sqlite.ts"),
		);
	});

	for (const [label, entry] of [
		["the launch card", "cli/launch-card.ts"],
		["the first frame", "modes/terminal/first-frame.ts"],
		["the settings store", "config/settings.ts"],
	] as const) {
		/**
		 * One case per entry so a failure names which path regained the database, and the message
		 * lists the owners rather than a count, because the fix is to remove the edge that reached
		 * the named module.
		 */
		it(`${label} reaches no store`, () => {
			const reached = new Set(reachedNames(entry));

			expect(DATABASE_OWNERS.filter(owner => reached.has(owner))).toEqual(ADMITTED_ON_THE_CARD_PATH);
		});
	}

	/** The ordinary way the cost comes back: not a database, just a hundred more modules. */
	it("does not grow the launch card's graph", () => {
		expect(reach("cli/launch-card.ts")).toBeLessThanOrEqual(LAUNCH_CARD_CEILING);
	});
});
