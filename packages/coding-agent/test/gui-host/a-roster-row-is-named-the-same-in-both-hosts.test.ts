/**
 * The window and the terminal call one agent the same thing.
 *
 * WHY THIS SUITE EXISTS. The section the GUI host sends named an agent by
 * `AgentRef.displayName`, which for a spawned agent is the TYPE it was spawned
 * from. A fan-out of three `deep` subagents therefore reached the window as
 * three rows reading `deep`, indistinguishable from each other and naming
 * nothing a person can address, while the terminal dashboard listed the same
 * three as `Kestrel`, `Otter` and `Juniper`.
 *
 * THE CLASS. Not "the roster is missing a field": any agent label the two hosts
 * derive separately. The call sign has one owner, `registry/live-roster.ts`, and
 * this suite reads the section against that owner's own rows rather than against
 * a written list, so a change to how call signs are assigned moves both hosts or
 * fails here.
 *
 * WHAT IT DOES NOT CATCH. How the window draws the row, which is
 * `crates/veyyon-desktop-surface/tests/a-roster-row-is-named-by-the-call-sign-both-hosts-use.rs`,
 * and the scoping of the roster to one conversation, which is
 * `the-agent-roster-and-comms-stream-reach-the-desktop-scoped-and-live.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { agentsSection } from "../../src/gui-host/actions/agents";
import { AgentRegistry, MAIN_AGENT_ID } from "../../src/registry/agent-registry";
import { collectLiveAgents } from "../../src/registry/live-roster";

/** A scope of this suite's own, so the rows it registers reach no other one. */
const SCOPE = "conversation-a-roster-names";

const MAIN_ID = `${MAIN_AGENT_ID}-roster-names`;
const SPAWNED = ["task-9f1a", "task-2b77", "task-4cd0"];

describe("a roster row is named the same in both hosts", () => {
	let registry: AgentRegistry;

	beforeEach(() => {
		// The live global, not a fresh one: `AgentRegistry.resetGlobalForTests()`
		// swaps the instance, and every holder of the old one -- the lifecycle
		// manager among them -- keeps mutating it for the rest of the process.
		registry = AgentRegistry.global();
		registry.register({
			id: MAIN_ID,
			displayName: "main",
			kind: "main",
			session: null,
			scope: SCOPE,
		});
		// One fan-out of one agent type: the case that reached the window as three
		// identical rows.
		for (const id of SPAWNED) {
			registry.register({ id, displayName: "deep", kind: "sub", session: null, scope: SCOPE });
		}
	});

	afterEach(() => {
		for (const id of [MAIN_ID, ...SPAWNED]) registry.unregister(id);
	});

	test("the section carries the call sign the terminal dashboard prints", () => {
		const rows = collectLiveAgents(registry.listInScope(SCOPE));
		const section = agentsSection(SCOPE);

		expect(section.map(view => [view.id, view.call_sign])).toEqual(rows.map(row => [row.id, row.callSign]));
	});

	test("agents of one type are told apart", () => {
		const section = agentsSection(SCOPE);
		const spawned = section.filter(view => view.kind === "sub");

		expect(spawned.length).toBe(3);
		expect(new Set(spawned.map(view => view.call_sign)).size).toBe(spawned.length);
		for (const view of spawned) {
			expect(view.call_sign).not.toBe("");
			expect(view.call_sign).not.toBe(view.display_name);
		}
	});

	test("the type it was spawned from is still carried, beside the call sign", () => {
		const section = agentsSection(SCOPE);

		expect(section.filter(view => view.display_name === "deep").length).toBe(3);
		expect(section.find(view => view.kind === "main")?.call_sign).toBe("Main");
	});

	test("the rows arrive in the order the call signs were assigned from", () => {
		// Call signs are assigned from spawn order, so a section sorted any other
		// way would hand the window names that walk as agents finish.
		const section = agentsSection(SCOPE);

		expect(section.map(view => view.id)).toEqual(collectLiveAgents(registry.listInScope(SCOPE)).map(row => row.id));
	});
});
