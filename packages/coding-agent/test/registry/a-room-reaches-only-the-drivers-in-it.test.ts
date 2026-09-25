/**
 * Room membership in the agent registry.
 *
 * WHY IT EXISTS. A room is the sideways axis of one terminal: two driving
 * sessions beside each other, each with its own conversation and spawns. The
 * conversation boundary (`AgentRef.scope`) keeps those conversations apart,
 * and `AgentRef.room` is the one exception through it. The defect class this
 * closes is a hole in either direction: a driver that cannot see the peer
 * beside it, a spawn that can reach across into the neighbour's tree because
 * it shares a room string with its own driver, or a driver that walks into a
 * room nobody opened for it — by guessing the id from a driver id, by naming
 * a string no member holds, or by naming the room of a driver that was killed.
 *
 * Rooms here come only from `ensureRoom`, the one way a room is opened; a
 * registration that states a room string nobody holds is the failure path.
 * Swept from `AGENT_KINDS` and `AGENT_STATUSES` at run time where a rule is per
 * kind or per status, and each sweep is pinned by exact equality, so a new kind
 * or status fails here until its reach is recorded.
 *
 * What it does not catch: the irc tool's rendering of a peer, which the irc
 * room suite covers, and the terminal switch itself. The randomness of a room
 * id is observed as "differs across drivers and across registries", not
 * measured: a generator with a small space would pass.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
	AGENT_KINDS,
	AGENT_STATUSES,
	type AgentKind,
	type AgentRef,
	AgentRegistry,
	type AgentStatus,
	MAIN_AGENT_ID,
	type RegistryEvent,
} from "@veyyon/coding-agent/registry/agent-registry";

let registry: AgentRegistry;

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	registry = AgentRegistry.global();
});

function ids(refs: readonly AgentRef[]): string[] {
	return refs.map(ref => ref.id);
}

function driver(id: string, room?: string, target: AgentRegistry = registry): AgentRef {
	return target.register({
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

/** The room `id` holds, opened for it. Fails the test when the registry refuses. */
function roomOf(id: string): string {
	const room = registry.ensureRoom(id);
	if (room === undefined) throw new Error(`ensureRoom refused ${id}`);
	return room;
}

/** A room opened by driver `owner`, with every id in `members` registered into it. */
function openRoom(owner: string, ...members: string[]): string {
	driver(owner);
	const room = roomOf(owner);
	for (const member of members) driver(member, room);
	return room;
}

describe("isPeer", () => {
	test("two drivers sharing a room are peers of each other, in both directions", () => {
		openRoom("A", "B");
		expect(registry.isPeer("A", "B")).toBe(true);
		expect(registry.isPeer("B", "A")).toBe(true);
	});

	test("a driver is never its own peer", () => {
		openRoom("A");
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

	test("drivers that each opened a room are strangers", () => {
		openRoom("A");
		openRoom("B");
		expect(registry.get("A")?.room).not.toBe(registry.get("B")?.room);
		expect(registry.isPeer("A", "B")).toBe(false);
	});

	/**
	 * The room string is only honoured on a driver. A spawn carrying one, or a
	 * kind that is never a peer, must not become reachable from next door.
	 */
	test("only a driver can hold a room; every other kind with the same string is not a peer", () => {
		const room = openRoom("A");
		const reach: Record<string, boolean> = {};
		for (const kind of AGENT_KINDS) {
			registry.register({
				id: `X-${kind}`,
				displayName: kind,
				kind,
				session: null,
				sessionFile: `/transcripts/X-${kind}.jsonl`,
				scope: `scope-X-${kind}`,
				room,
			});
			reach[kind] = registry.isPeer("A", `X-${kind}`);
		}
		expect(reach).toEqual({ main: true, sub: false, advisor: false });
	});
});

describe("peer reach through the conversation boundary", () => {
	test("a driver can address its peer although they share no scope", () => {
		openRoom("A", "B");
		expect(registry.canAddress("A", "B")).toBe(true);
		expect(ids(registry.listAddressableBy("A"))).toContain("B");
	});

	/**
	 * The spawn's `Main` is its own driver; the driver next door is a stranger
	 * to it, and so is everything under that driver.
	 */
	test("a spawn cannot reach the peer driver or the peer's spawns", () => {
		openRoom("A", "B");
		spawn("A-worker", "A");
		spawn("B-worker", "B");
		expect(registry.canAddress("A-worker", "B")).toBe(false);
		expect(registry.canAddress("A-worker", "B-worker")).toBe(false);
		expect(registry.canAddress("B", "A-worker")).toBe(false);
		expect(ids(registry.listAddressableBy("A-worker")).sort()).toEqual(["A"]);
	});

	test("`Main` written by a spawn still resolves to its own driver, not the peer", () => {
		openRoom("A", "B");
		spawn("A-worker", "A");
		expect(registry.resolveId(MAIN_AGENT_ID, registry.scopeOf("A-worker"))?.id).toBe("A");
	});
});

describe("roomMembers and peers", () => {
	test("members are every driver of the room including self, oldest first", () => {
		openRoom("A", "B", "C");
		const [a, b, c] = ["A", "B", "C"].map(id => registry.get(id)!);
		b!.createdAt = 20;
		a!.createdAt = 10;
		c!.createdAt = 30;
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
		const room = openRoom("A");
		for (const status of AGENT_STATUSES) {
			driver(`P-${status}`, room);
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
		const room = roomOf("A");
		expect(room).toMatch(/^room:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(registry.get("A")?.room).toBe(room);
		expect(events.map(event => [event.type, event.ref.id])).toEqual([["status_changed", "A"]]);
	});

	test("is idempotent and returns the room the driver already holds", () => {
		driver("A");
		const room = roomOf("A");
		const events: RegistryEvent[] = [];
		registry.onChange(event => events.push(event));
		expect(registry.ensureRoom("A")).toBe(room);
		expect(registry.ensureRoom("A")).toBe(room);
		expect(events).toEqual([]);
	});

	test("a second driver registered with that room is then a peer", () => {
		openRoom("A", "B");
		expect(ids(registry.peers("A"))).toEqual(["B"]);
	});

	test("refuses an unknown id and every non-driver kind", () => {
		openRoom("A");
		const refused: Record<string, string | undefined> = { unknown: registry.ensureRoom("nobody") };
		for (const kind of AGENT_KINDS) {
			if (kind === "main") continue;
			spawn(`A-${kind}`, "A", kind);
			refused[kind] = registry.ensureRoom(`A-${kind}`);
		}
		expect(refused).toEqual({ unknown: undefined, sub: undefined, advisor: undefined });
		expect(registry.get("A-sub")?.room).toBeUndefined();
	});

	/**
	 * A room is reached by being handed its id by a member. An id computed
	 * from the driver's own id could be named into by any host registering a
	 * driver in this process, so the id carries nothing of the driver: two
	 * registries opening a room for the same driver id get different rooms,
	 * and the room of one driver is not the room of the next.
	 */
	test("room ids are distinct across drivers and not derivable from the driver id", () => {
		const driverIds = [MAIN_AGENT_ID, "main:0192-aaaa", "A", "B"];
		const rooms = driverIds.map(id => {
			driver(id);
			return roomOf(id);
		});
		expect(new Set(rooms).size).toBe(driverIds.length);
		for (const [index, id] of driverIds.entries()) expect(rooms[index]).not.toContain(id);

		const second = new AgentRegistry();
		const again = driverIds.map(id => {
			driver(id, undefined, second);
			return second.ensureRoom(id);
		});
		for (const [index, room] of again.entries()) expect(room).not.toBe(rooms[index]);
	});
});

describe("joining a room", () => {
	/**
	 * The guess an attacker or a careless host would make first is the old
	 * derived form; every string nobody holds is refused the same way, and the
	 * refusal leaves no row behind.
	 */
	test("registering a driver with a room nobody holds throws naming the room and registers nothing", () => {
		driver("A");
		roomOf("A");
		for (const guess of ["room:A", "room:guess", ""]) {
			expect(() => driver(`B${guess}`, guess)).toThrow(`Room "${guess}" is not open in this process`);
			expect(registry.get(`B${guess}`)).toBeUndefined();
		}
		expect(ids(registry.peers("A"))).toEqual([]);
	});

	/**
	 * The check guards drivers only: every other kind drops its room string, so
	 * an unheld string on a spawn is inert rather than an error.
	 */
	test("per kind, an unheld room string throws for a driver and is dropped for every other kind", () => {
		const outcome: Record<string, string> = {};
		for (const kind of AGENT_KINDS) {
			try {
				const ref = registry.register({
					id: `K-${kind}`,
					displayName: kind,
					kind,
					session: null,
					room: "room:nobody",
				});
				outcome[kind] = ref.room === undefined ? "dropped" : `kept ${ref.room}`;
			} catch {
				outcome[kind] = "throws";
			}
		}
		expect(outcome).toEqual({ main: "throws", sub: "dropped", advisor: "dropped" });
	});

	/**
	 * A killed driver holds nothing: its room is not a place a new driver can
	 * be put, whatever the killed row still says. Swept over every status the
	 * sole holder can be in.
	 */
	test("a room held only by an aborted driver is not joinable; every other holder status is", () => {
		const joinable: Partial<Record<AgentStatus, boolean>> = {};
		for (const status of AGENT_STATUSES) {
			driver(`holder-${status}`);
			const room = roomOf(`holder-${status}`);
			registry.mirrorStatus(`holder-${status}`, status);
			try {
				driver(`joiner-${status}`, room);
				joinable[status] = true;
			} catch {
				joinable[status] = false;
			}
		}
		expect(joinable).toEqual({ running: true, idle: true, parked: true, aborted: false });
	});

	/**
	 * A revive re-registers the same agent under its own id. The row it
	 * replaces is the one holding the room, so the room is still open when the
	 * check runs; refusing it would leave the revived driver outside its room.
	 */
	test("re-registering a member with its own room succeeds, for the sole holder and for a joiner", () => {
		const room = openRoom("A", "B");
		expect(() => driver("A", room)).not.toThrow();
		expect(() => driver("B", room)).not.toThrow();
		registry.unregister("B");
		expect(() => driver("A", room)).not.toThrow();
		expect(registry.get("A")?.room).toBe(room);
		expect(ids(registry.roomMembers("A"))).toEqual(["A"]);
	});
});
