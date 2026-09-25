/**
 * `AgentRegistry.driverOf`: the driving agent of the conversation an agent
 * belongs to.
 *
 * WHY IT EXISTS. A finished background job's result goes to the conversation
 * that started it, and the job knows only its owner's id: a driver, or a spawn
 * at any depth below one. The defect class closed here is a result handed to
 * the wrong conversation: to the first driver the registry holds, to a driver
 * whose scope is unattributed and so matches everything under the permissive
 * scope rule, or to anyone at all once the owner's conversation has closed.
 *
 * Every kind is swept from `AGENT_KINDS`, and the sweep fails on a new kind
 * until its answer is recorded.
 *
 * What it does not catch: the delivery itself, which the job manager suite
 * drives through real sessions.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { AGENT_KINDS, type AgentKind, AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";

let registry: AgentRegistry;

beforeEach(() => {
	registry = new AgentRegistry();
});

function driver(id: string, scope: string | undefined): void {
	registry.register({ id, displayName: "main", kind: "main", session: null, scope });
}

function under(id: string, parentId: string, kind: AgentKind = "sub"): void {
	registry.register({ id, displayName: id, kind, parentId, session: null });
}

describe("the driver of a conversation", () => {
	test("is a driver itself, and the driver of a spawn at every depth and of every kind below it", () => {
		driver("main:a", "scope-a");
		driver("main:b", "scope-b");
		under("Scout", "main:b");
		under("Deep", "Scout");
		under("Advisor", "main:b", "advisor");
		const found = Object.fromEntries(
			["main:a", "main:b", "Scout", "Deep", "Advisor"].map(id => [id, registry.driverOf(id)?.id]),
		);
		expect(found).toEqual({
			"main:a": "main:a",
			"main:b": "main:b",
			Scout: "main:b",
			Deep: "main:b",
			Advisor: "main:b",
		});
	});

	test("every agent kind has an answer recorded here", () => {
		expect([...AGENT_KINDS].sort()).toEqual(["advisor", "main", "sub"]);
	});

	test("is nobody for an unknown id, or a spawn whose conversation's driver has left", () => {
		driver("main:a", "scope-a");
		under("Orphan", "main:a");
		registry.unregister("main:a");
		// A driver with no scope matches every conversation under the permissive
		// scope rule; it is still not this spawn's driver.
		driver("acp:unattributed", undefined);
		expect(registry.driverOf("Orphan")).toBeUndefined();
		expect(registry.driverOf("nobody")).toBeUndefined();
	});

	test("is nobody for a spawn its driver left behind when it re-rooted to another transcript", () => {
		driver("main:a", "scope-a");
		under("Scout", "main:a");
		registry.rescope("main:a", "scope-after-new");
		// Still its parent by id: the parent chain would hand the old
		// conversation's result to the new one.
		expect(registry.get("Scout")?.parentId).toBe("main:a");
		expect(registry.driverOf("Scout")).toBeUndefined();
	});

	test("of a spawn under a driver that has no scope is that driver, found through the parent chain", () => {
		driver("acp:unattributed", undefined);
		driver("main:other", "scope-other");
		under("Loose", "acp:unattributed");
		expect(registry.driverOf("Loose")?.id).toBe("acp:unattributed");
	});

	test("of a spawn whose parent left is still its conversation's driver, found by scope", () => {
		driver("main:a", "scope-a");
		driver("main:b", "scope-b");
		under("Scout", "main:a");
		under("Deep", "Scout");
		registry.unregister("Scout");
		expect(registry.driverOf("Deep")?.id).toBe("main:a");
	});

	test("ends on a parent loop, with nobody", () => {
		registry.register({ id: "Ping", displayName: "ping", kind: "sub", parentId: "Pong", session: null });
		registry.register({ id: "Pong", displayName: "pong", kind: "sub", parentId: "Ping", session: null });
		expect(registry.driverOf("Ping")).toBeUndefined();
	});
});
