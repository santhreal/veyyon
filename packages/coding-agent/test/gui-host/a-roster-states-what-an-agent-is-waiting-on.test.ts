/**
 * The section names what an agent is waiting on, not just whether it stopped.
 *
 * WHY THIS SUITE EXISTS. The GUI host sent `AgentRef.status`, which has two
 * states it cannot express. An agent stopped at an approval prompt is
 * `running`, because it IS mid-turn, so the window drew the one row a person
 * has to act on as a row grinding through a build. An agent that stopped to let
 * a peer answer is `idle` or `parked`, which is also what an abandoned agent
 * looks like, so a spawn waiting on a reply that may never come read as one
 * that had simply finished.
 *
 * THE CLASS. Not "two missing words": any agent state one host derives and the
 * other does not. `registry/live-roster.ts` owns the derivation and the
 * terminal dashboard reads the same function, so this suite asserts the section
 * against that owner rather than against a written list of words.
 *
 * WHAT IT DOES NOT CATCH. How the window draws each state, which is
 * `crates/veyyon-desktop-surface/tests/a-roster-states-the-state-a-surface-names.rs`,
 * and the lifecycle that writes `waitingOnPeer`, which is the task executor's
 * own suite.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { agentsSection } from "../../src/gui-host/actions/agents";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { agentDisplayState, collectLiveAgents } from "../../src/registry/live-roster";

/** A scope of this suite's own, so the rows it registers reach no other one. */
const SCOPE = "conversation-a-roster-states";

/** `id` as this suite registers it, so two suites never share a row. */
const ROWS = ["working", "blocked", "waiting", "finished"].map(id => `${id}-roster-states`);
const [WORKING, BLOCKED, WAITING, FINISHED] = ROWS;

/** The section row for `id`, or a failure naming the id that is missing. */
function rowFor(id: string) {
	const row = agentsSection(SCOPE).find(view => view.id === id);
	if (!row) throw new Error(`no section row for ${id}`);
	return row;
}

describe("a roster row states what an agent is waiting on", () => {
	let registry: AgentRegistry;

	beforeEach(() => {
		// The live global, not a fresh one: `AgentRegistry.resetGlobalForTests()`
		// swaps the instance, and every holder of the old one -- the lifecycle
		// manager among them -- keeps mutating it for the rest of the process.
		registry = AgentRegistry.global();
		for (const id of ROWS) {
			registry.register({ id, displayName: "deep", kind: "sub", session: null, scope: SCOPE });
		}
		registry.setStatus(WORKING, "running");
		registry.setStatus(BLOCKED, "running");
		registry.setPendingApproval(BLOCKED, { toolName: "bash", since: Date.now() });
		registry.setStatus(WAITING, "idle");
		registry.setWaitingOnPeer(WAITING, true);
		registry.setStatus(FINISHED, "idle");
	});

	afterEach(() => {
		for (const id of ROWS) registry.unregister(id);
	});

	test("an agent stopped at an approval prompt is blocked, not running", () => {
		expect(rowFor(BLOCKED).status).toBe("blocked");
		expect(rowFor(WORKING).status).toBe("running");
	});

	test("an agent that stopped on a peer is waiting, not finished", () => {
		expect(rowFor(WAITING).status).toBe("waiting");
		expect(rowFor(FINISHED).status).toBe("idle");
	});

	test("every row states the state the terminal dashboard names for it", () => {
		const rows = collectLiveAgents(registry.listInScope(SCOPE));

		expect(agentsSection(SCOPE).map(view => [view.id, view.status])).toEqual(
			rows.map(row => [row.id, agentDisplayState(row)]),
		);
	});

	test("answering the prompt puts the agent back to running", () => {
		registry.setPendingApproval(BLOCKED, undefined);

		expect(rowFor(BLOCKED).status).toBe("running");
	});
});
