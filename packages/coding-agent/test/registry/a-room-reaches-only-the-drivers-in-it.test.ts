/**
 * Room membership in the agent registry.
 *
 * WHY IT EXISTS. A room is the sideways axis of one terminal: two driving
 * sessions beside each other, each with its own conversation and spawns. The
 * conversation boundary (`AgentRef.scope`) keeps those conversations apart,
 * and `AgentRef.room` is the one exception through it. The defect class this
 * closes is a hole in either direction: a driver that cannot see the peer
 * beside it, or a spawn that can reach across into the neighbour's tree
 * because it shares a room string with its own driver.
 *
 * Swept from the `AgentKind` union at run time where a rule is per kind, so
 * a new kind fails here until its reach is recorded.
 *
 * What it does not catch: the irc tool's rendering of a peer, which
 * `irc-rooms` covers, and the terminal switch itself.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
	AGENT_STATUSES,
	type AgentKind,
	type AgentRef,
	AgentRegistry,
	MAIN_AGENT_ID,
	type RegistryEvent,
} from "@veyyon/coding-agent/registry/agent-registry";

/** Every kind the registry admits, so the per-kind sweeps below cannot go stale. */
const AGENT_KINDS: readonly AgentKind[] = ["main", "sub", "advisor"] satisfies readonly AgentKind[];

let registry: AgentRegistry;

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	registry = AgentRegistry.global();
});

function ids(refs: readonly AgentRef[]): string[] {
	return refs.map(ref => ref.id);
}

function driver(id: string, room?: string): AgentRef {
	return registry.register({
		id,
		displayName: "main",
		kind: "main",
		session: null,
		sessionFile: `/transcripts/${id}.jsonl`,
		scope: `scope-${id}`,
		room,
	});
}

function spawn(id: string, parentId: string, kind: AgentKind = "sub"): AgentRef {
	return registry.register({
		id,
		displayName: id,
		kind,
		parentId,
		session: null,
		sessionFile: `/transcripts/${parentId}/${id}.jsonl`,
	});
}

describe("isPeer", () => {
	test("two drivers sharing a room are peers of each other, in both directions", () => {
		driver("A", "room:A");
		driver("B", "room:A");
		expect(registry.isPeer("A", "B")).toBe(true);
		expect(registry.isPeer("B", "A")).toBe(true);
	});

	test("a driver is never its own peer", () => {
		driver("A", "room:A");
		expect(registry.isPeer("A", "A")).toBe(false);
	});

	/**
	 * Undefined must not match undefined. Scope is permissive that way so an
	 * unattributable ref stays visible; a room that were permissive would make
	 * every driver a host registered a peer of every other the moment none of
	 * them opened a room.
	 */
	test("two drivers in no room are strangers", () => {
		driver("A");
		driver("B");
		expect(registry.isPeer("A", "B")).toBe(false);
		expect(registry.peers("A")).toEqual([]);
	});

	test("drivers in different rooms are strangers", () => {
		driver("A", "room:A");
		driver("B", "room:B");
		expect(registry.isPeer("A", "B")).toBe(false);
	});

	/**
	 * The room string is only honoured on a driver. A spawn carrying one, or a
	 * kind that is never a peer, must not become reachable from next door.
	 */
	test("only a driver can hold a room; every other kind with the same string is not a peer", () => {
		driver("A", "room:A");
		const reach: Record<string, boolean> = {};
		for (const kind of AGENT_KINDS) {
			registry.register({
				id: `X-${kind}`,
				displayName: kind,
				kind,
				session: null,
				sessionFile: `/transcripts/X-${kind}.jsonl`,
				scope: `scope-X-${kind}`,
				room: "room:A",
			});
			reach[kind] = registry.isPeer("A", `X-${kind}`);
		}
		expect(reach).toEqual({ main: true, sub: false, advisor: false });
	});
});

describe("peer reach through the conversation boundary", () => {
	test("a driver can address its peer although they share no scope", () => {
		driver("A", "room:A");
		driver("B", "room:A");
		expect(registry.canAddress("A", "B")).toBe(true);
		expect(ids(registry.listAddressableBy("A"))).toContain("B");
	});

	/**
	 * The spawn's `Main` is its own driver; the driver next door is a stranger
	 * to it, and so is everything under that driver.
	 */
	test("a spawn cannot reach the peer driver or the peer's spawns", () => {
		driver("A", "room:A");
		driver("B", "room:A");
		spawn("A-worker", "A");
		spawn("B-worker", "B");
		expect(registry.canAddress("A-worker", "B")).toBe(false);
		expect(registry.canAddress("A-worker", "B-worker")).toBe(false);
		expect(registry.canAddress("B", "A-worker")).toBe(false);
		expect(ids(registry.listAddressableBy("A-worker")).sort()).toEqual(["A"]);
	});

	test("`Main` written by a spawn still resolves to its own driver, not the peer", () => {
		driver("A", "room:A");
		driver("B", "room:A");
		spawn("A-worker", "A");
		expect(registry.resolveId(MAIN_AGENT_ID, registry.scopeOf("A-worker"))?.id).toBe("A");
	});
});

describe("roomMembers and peers", () => {
	test("members are every driver of the room including self, oldest first", () => {
		const a = driver("A", "room:A");
		const b = driver("B", "room:A");
		const c = driver("C", "room:A");
		b.createdAt = 20;
		a.createdAt = 10;
		c.createdAt = 30;
		expect(ids(registry.roomMembers("B"))).toEqual(["A", "B", "C"]);
		expect(ids(registry.peers("B"))).toEqual(["A", "C"]);
	});

	test("a driver in no room is a room of one", () => {
		driver("A");
		driver("B");
		expect(ids(registry.roomMembers("A"))).toEqual(["A"]);
	});

	test("an unknown id has no members", () => {
		expect(registry.roomMembers("nobody")).toEqual([]);
		expect(registry.peers("nobody")).toEqual([]);
	});

	/**
	 * A killed peer has nothing to switch to and nothing to message. Every
	 * other status stays listed: an idle or parked peer is what the operator
	 * comes back to.
	 */
	test("an aborted peer drops out of the room; every other status stays", () => {
		driver("A", "room:A");
		for (const status of AGENT_STATUSES) {
			driver(`P-${status}`, "room:A");
			// Mirrored, not transitioned: the sweep sets each terminal state directly.
			registry.mirrorStatus(`P-${status}`, status);
		}
		const listed = ids(registry.peers("A")).sort();
		expect(listed).toEqual(
			AGENT_STATUSES.filter(status => status !== "aborted")
				.map(status => `P-${status}`)
				.sort(),
		);
		expect(listed).not.toContain("P-aborted");
	});
});

describe("ensureRoom", () => {
	test("opens a room on a driver that has none and reports it as a status change", () => {
		driver("A");
		const events: RegistryEvent[] = [];
		registry.onChange(event => events.push(event));
		const room = registry.ensureRoom("A");
		expect(room).toBe("room:A");
		expect(registry.get("A")?.room).toBe("room:A");
		expect(events.map(event => [event.type, event.ref.id])).toEqual([["status_changed", "A"]]);
	});

	test("is idempotent and returns the room the driver already holds", () => {
		driver("A", "room:existing");
		const events: RegistryEvent[] = [];
		registry.onChange(event => events.push(event));
		expect(registry.ensureRoom("A")).toBe("room:existing");
		expect(registry.ensureRoom("A")).toBe("room:existing");
		expect(events).toEqual([]);
	});

	test("a second driver registered with that room is then a peer", () => {
		driver("A");
		const room = registry.ensureRoom("A");
		driver("B", room);
		expect(ids(registry.peers("A"))).toEqual(["B"]);
	});

	test("refuses an unknown id and every non-driver kind", () => {
		driver("A", "room:A");
		const refused: Record<string, string | undefined> = { unknown: registry.ensureRoom("nobody") };
		for (const kind of AGENT_KINDS) {
			if (kind === "main") continue;
			spawn(`A-${kind}`, "A", kind);
			refused[kind] = registry.ensureRoom(`A-${kind}`);
		}
		expect(refused).toEqual({ unknown: undefined, sub: undefined, advisor: undefined });
		expect(registry.get("A-sub")?.room).toBeUndefined();
	});
});
