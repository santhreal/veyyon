/**
 * WHY: a hidden nudge is told apart from every other injected message by its
 * `customType` string alone, and several are scrubbed from the context later by
 * matching that string. Two kinds sharing a value means the scrub aimed at the
 * first silently deletes the second, and nothing fails: the run continues with
 * a message missing. The gates beside them name tools as bare keys, which is
 * the staleness `tools/builtin-names.ts` exists to close — a renamed tool left
 * a table entry that still compiled and stopped matching, so the nudge quietly
 * never fired again.
 *
 * The class this closes is a hidden-message kind or a gate entry that goes
 * stale without failing. The registry is swept from the module's own exports at
 * run time, so declaring a new `_TYPE` and forgetting to register it turns this
 * red rather than leaving it outside every collision check; the gate tables are
 * checked against the live tool registry rather than a copied list of names.
 *
 * Not covered: the twenty-odd `customType` values still written as inline
 * literals at their injection sites elsewhere in the package. They are not
 * exported, so no run-time sweep can reach them, and a hardcoded copy of them
 * here would go stale exactly the way this test exists to prevent. A collision
 * between one of those and a registered kind is caught only when that literal
 * moves into this module.
 */

import { describe, expect, test } from "bun:test";
import * as nudges from "../../src/session/nudges";
import { VERIFICATION_EVIDENCE_REMINDER_TYPE } from "../../src/session/verification-evidence-ledger";
import { isKnownToolName, TOOL } from "../../src/tools/builtin-names";

/** Every string export whose name marks it as a `customType` discriminator. */
const declaredTypes: Array<{ name: string; value: string }> = Object.entries(
	nudges as Readonly<Record<string, unknown>>,
)
	.flatMap(([name, value]) => (name.endsWith("_TYPE") && typeof value === "string" ? [{ name, value }] : []))
	.sort((a, b) => a.name.localeCompare(b.name));

describe("the hidden message registry", () => {
	test("holds every hidden type this module declares", () => {
		// Sweeping the exports rather than listing them means a new kind that
		// nobody registered fails here instead of escaping the collision check.
		expect(declaredTypes.map(entry => entry.value).sort()).toEqual([...nudges.HIDDEN_MESSAGE_TYPES].sort());
	});

	test("declares at least the kinds the session injects", () => {
		expect(declaredTypes.length).toBeGreaterThan(0);
	});

	test("gives every kind a distinct value, so a scrub reaches only its own", () => {
		expect(new Set(nudges.HIDDEN_MESSAGE_TYPES).size).toBe(nudges.HIDDEN_MESSAGE_TYPES.length);
	});

	test("does not collide with the hidden type another module owns", () => {
		expect(nudges.HIDDEN_MESSAGE_TYPES).not.toContain(VERIFICATION_EVIDENCE_REMINDER_TYPE);
	});

	test("cannot be extended in place by a caller", () => {
		expect(() => {
			(nudges.HIDDEN_MESSAGE_TYPES as string[]).push("smuggled");
		}).toThrow();
		expect(nudges.HIDDEN_MESSAGE_TYPES).not.toContain("smuggled");
	});
});

describe("a gate that names tools", () => {
	const tables: readonly (readonly [string, readonly string[]])[] = [
		["MID_RUN_TODO_NUDGE_MUTATING_TOOLS", Object.keys(nudges.MID_RUN_TODO_NUDGE_MUTATING_TOOLS)],
		["PREWALK_ACTION_TOOLS", Object.keys(nudges.PREWALK_ACTION_TOOLS)],
		["PLAN_DECISION_TOOLS", [...nudges.PLAN_DECISION_TOOLS]],
	];

	test.each(tables)("%s names only tools that exist", (_label, names) => {
		expect(names.filter(name => !isKnownToolName(name))).toEqual([]);
	});

	test.each(tables)("%s is not empty, or the gate it guards never opens", (_label, names) => {
		expect(names.length).toBeGreaterThan(0);
	});

	test("the mid-run nudge counts mutation, not exploration", () => {
		// A read-only tool in this table makes a long research stretch look like
		// landed work and nudges a model that has nothing to flip.
		const mutating = Object.keys(nudges.MID_RUN_TODO_NUDGE_MUTATING_TOOLS);
		for (const readOnly of [TOOL.read, TOOL.search]) {
			expect(mutating).not.toContain(readOnly);
		}
	});

	test("prewalk does not switch on exploration or on planning the work", () => {
		// bash doubles as exploration and fired turn-1 switches; todo fires at
		// init, which hands over the whole implementation with nothing started.
		const triggers = Object.keys(nudges.PREWALK_ACTION_TOOLS);
		expect(triggers).not.toContain(TOOL.bash);
		expect(triggers).not.toContain(TOOL.todo);
	});
});

describe("a nudge budget", () => {
	test("lets the mid-run nudge fire at least once per cycle", () => {
		expect(nudges.MID_RUN_TODO_NUDGE_MAX_PER_CYCLE).toBeGreaterThanOrEqual(1);
	});

	test("stays under the stop-time reminder ladder it is meant to be gentler than", () => {
		expect(nudges.MID_RUN_TODO_NUDGE_MAX_PER_CYCLE).toBeLessThan(nudges.MID_RUN_TODO_NUDGE_MUTATION_THRESHOLD);
	});

	test("waits for a run longer than an ordinary fix-verify loop", () => {
		// Three to six mutations is a normal fix and its verification; nudging
		// there interrupts every routine turn.
		expect(nudges.MID_RUN_TODO_NUDGE_MUTATION_THRESHOLD).toBeGreaterThan(6);
	});

	test("caps automatic continuations, so a stop cannot reschedule itself forever", () => {
		expect(nudges.SESSION_STOP_CONTINUATION_CAP).toBeGreaterThan(0);
		expect(Number.isFinite(nudges.SESSION_STOP_CONTINUATION_CAP)).toBe(true);
	});

	test("caps plan-mode reminders", () => {
		expect(nudges.PLAN_MODE_REMINDER_MAX).toBeGreaterThan(0);
		expect(Number.isFinite(nudges.PLAN_MODE_REMINDER_MAX)).toBe(true);
	});
});
