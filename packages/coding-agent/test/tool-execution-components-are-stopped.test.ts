/**
 * No test file may construct a `ToolExecutionComponent` directly. They come from the helper, which
 * stops their animation when the test ends.
 *
 * WHY THIS SUITE EXISTS. A live tool block runs an 80ms interval that ticks the spinner and asks the TUI
 * to repaint, and `stopAnimation()` is the only thing that clears it. Sixteen test files constructed one
 * and never stopped it, so each left an interval firing at a dead component for the rest of the process.
 * The cost was invisible until it was not: one of those leaks turned another suite's unrestored global
 * theme into 12 failures across session-manager migration, large-session memory guards and
 * eval/idle-timeout, none of which render a tool block at all.
 *
 * Cleanup that depends on remembering does not hold across 23 files and everything added after them, so
 * the requirement is structural: construction goes through `helpers/tool-execution`, whose `afterEach`
 * stops every component it handed out. This test is what makes "forgot to use the helper" a failure in
 * the file that forgot, rather than a mystery in a suite that did nothing wrong.
 *
 * Read as source text rather than through behaviour, because there is nothing to observe at runtime: a
 * leaked interval is silent until it collides with something else.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";

const TEST_ROOT = path.resolve(import.meta.dir);
const HELPER = path.join(TEST_ROOT, "helpers", "tool-execution.ts");
const DIRECT_CONSTRUCTION = "new ToolExecutionComponent(";

/** Every `.ts` file under `test/`, so a new suite is covered the moment it is added. */
function testSources(dir: string = TEST_ROOT): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules") continue;
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) {
			found.push(...testSources(full));
			continue;
		}
		if (entry.endsWith(".ts")) found.push(full);
	}
	return found;
}

describe("tool block construction in tests", () => {
	/**
	 * The contract. The helper itself is the one allowed constructor call, since it is what performs the
	 * cleanup.
	 */
	it("goes through the helper, never a direct constructor call", () => {
		const offenders = testSources()
			// The helper is the one place allowed to call the constructor, and THIS file quotes the banned
			// string in order to search for it.
			.filter(file => file !== HELPER && file !== path.resolve(import.meta.path))
			.filter(file => readFileSync(file, "utf8").includes(DIRECT_CONSTRUCTION))
			.map(file => path.relative(TEST_ROOT, file));

		expect(offenders).toEqual([]);
	});

	/**
	 * And the helper still does the thing the ban exists for. Without this, someone could satisfy the rule
	 * above by having the helper merely forward the constructor, which would make every suite look
	 * compliant while leaking exactly as before.
	 */
	it("has a helper that stops what it hands out", () => {
		const source = readFileSync(HELPER, "utf8");

		expect(source).toContain("afterEach(");
		expect(source).toContain("stopAnimation()");
		expect(source).toContain(DIRECT_CONSTRUCTION);
	});

	/**
	 * The ban is worth nothing if nothing uses the helper: a scan that finds zero direct constructions
	 * because the suites were deleted would pass silently. Pin that the helper is genuinely in use.
	 */
	it("is used by the suites that render tool blocks", () => {
		const users = testSources().filter(file => readFileSync(file, "utf8").includes("createToolExecution("));

		expect(users.length).toBeGreaterThanOrEqual(20);
	});
});
