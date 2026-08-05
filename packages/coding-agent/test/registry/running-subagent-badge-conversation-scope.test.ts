/**
 * The status-line "running subagents" badge, and the job tool's
 * running-agents section, in a process holding TWO conversations.
 *
 * WHY TWO. Both read a process-global registry. With one conversation every
 * agent in it is the caller's own, so the count and the list are right by
 * accident and stay right if the filter is removed.
 *
 * These are the two smallest leaks in the set and the most immediately
 * confusing: a session that spawned nothing showed a badge saying three spawns
 * are running, with no row anywhere in its own UI accounting for them; and the
 * job tool named foreign agents while telling the model to "coordinate via
 * irc", which for a foreign id is advice `irc send` refuses.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { countRunningSubagentBadgeAgents } from "@veyyon/coding-agent/modes/running-subagent-badge";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";

let registry: AgentRegistry;

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	registry = AgentRegistry.global();
	registry.register({ id: "acp:a", displayName: "main", kind: "main", session: null, scope: "session-a" });
	registry.register({ id: "acp:b", displayName: "main", kind: "main", session: null, scope: "session-b" });
	registry.register({
		id: "Scout-A",
		displayName: "scout",
		kind: "sub",
		parentId: "acp:a",
		session: null,
		status: "running",
	});
	for (const id of ["Scout-B", "Writer-B"]) {
		registry.register({
			id,
			displayName: "sub",
			kind: "sub",
			parentId: "acp:b",
			session: null,
			status: "running",
		});
	}
});

afterEach(() => {
	AgentRegistry.resetGlobalForTests();
});

describe("The running-subagents badge counts one conversation", () => {
	/**
	 * The exact numbers, from both sides, in one test. Asserting only "A sees 1"
	 * would also pass for a count that always returned 1; asserting both pins that
	 * the badge tracks the conversation rather than the process.
	 */
	test("reports each conversation's own running spawns", () => {
		expect(countRunningSubagentBadgeAgents(registry, "session-a")).toBe(1);
		expect(countRunningSubagentBadgeAgents(registry, "session-b")).toBe(2);
	});

	/**
	 * A caller with no conversation to name still counts everything. That is the
	 * collab guest, whose registry is a mirror of the host's single conversation
	 * and carries no local scope; a zero badge there would hide real work.
	 */
	test("counts every running spawn when no conversation is named", () => {
		expect(countRunningSubagentBadgeAgents(registry)).toBe(3);
	});
});
