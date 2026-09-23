/**
 * `irc` across two DRIVING agents of one room, each with its own spawns.
 *
 * WHY IT EXISTS. A room peer is reachable through the conversation boundary,
 * which is the one exception the registry makes to it, and the irc tool is
 * the surface a model reaches it through. The defect class closed here is a
 * disagreement between the three verbs: a roster that lists a peer the send
 * refuses, a send that reaches a peer the roster hides, or a broadcast that
 * wakes the driver next door and charges it a turn for a message meant for
 * the sender's own tree.
 *
 * Every id is pinned by exact equality. The peer set is built from the
 * registry, not restated, so the assertion follows the rule and a widened
 * `isPeer` fails here rather than passing by coincidence.
 *
 * What it does not catch: the live delivery into a peer session, which is the
 * bus's contract and is covered under `task/irc`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { IrcBus } from "@veyyon/coding-agent/task/irc-bus";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { IrcTool } from "@veyyon/coding-agent/tools/agent/irc";
import { makeToolSession } from "../helpers/tool-session";

function liveSession(delivered: string[], id: string): AgentSession {
	return {
		deliverIrcMessage: async () => {
			delivered.push(id);
			return "delivered";
		},
		emitIrcRelayObservation: () => {},
	} as unknown as AgentSession;
}

function toolFor(registry: AgentRegistry, agentId: string): IrcTool {
	const session: ToolSession = makeToolSession({
		cwd: "/repo",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		agentRegistry: registry,
		getAgentId: () => agentId,
	});
	return new IrcTool(session);
}

async function textOf(tool: IrcTool, params: Parameters<IrcTool["execute"]>[1]): Promise<string> {
	const result = await tool.execute("call", params);
	return result.content.find(part => part.type === "text")?.text ?? "";
}

/** The ids a roster text offers, in the order it prints them. */
function rosterIds(listed: string): string[] {
	return listed
		.split("\n")
		.filter(line => line.startsWith("- "))
		.map(line => line.slice(2, line.indexOf(" [")));
}

let registry: AgentRegistry;
/** Ids whose session received a delivery, in delivery order. Cleared in place: the sessions hold it. */
const delivered: string[] = [];

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	registry = AgentRegistry.global();
	delivered.length = 0;
	const register = (id: string, kind: "main" | "sub", parentId?: string, room?: string): void => {
		registry.register({
			id,
			displayName: kind === "main" ? "main" : id.toLowerCase(),
			kind,
			parentId,
			session: liveSession(delivered, id),
			scope: kind === "main" ? `scope-${id}` : undefined,
			room,
			status: "running",
		});
	};
	// One terminal, one room, two drivers side by side, each with a running spawn.
	register("main:a", "main", undefined, "room:main:a");
	register("Scout-A", "sub", "main:a");
	register("main:b", "main", undefined, "room:main:a");
	register("Scout-B", "sub", "main:b");
	// A third driver in the same process that never joined the room: an ACP session.
	register("acp:c", "main");
});

afterEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

describe("The roster a driver reads", () => {
	test("names its own spawn and its room peer, marks the peer, and says how to address it", async () => {
		const listed = await textOf(toolFor(registry, "main:a"), { op: "list" });

		expect(rosterIds(listed).sort()).toEqual(["Scout-A", "main:b"]);
		const peerRow = listed.split("\n").find(line => line.startsWith("- main:b "));
		expect(peerRow).toContain("room peer");
		const ownRow = listed.split("\n").find(line => line.startsWith("- Scout-A "));
		expect(ownRow).not.toContain("room peer");
		expect(listed).toContain('`to: "all"` reaches your own spawns only; address a room peer by its id.');
	});

	test("says nothing about rooms to a driver with no peer", async () => {
		const listed = await textOf(toolFor(registry, "acp:c"), { op: "list" });
		expect(rosterIds(listed)).toEqual([]);
		expect(listed).not.toContain("room peer");
	});

	/** The spawn's roster is its own tree: the peer driver and the peer's spawn are strangers. */
	test("a spawn's roster stops at its own driver", async () => {
		const listed = await textOf(toolFor(registry, "Scout-A"), { op: "list" });
		expect(rosterIds(listed)).toEqual(["main:a"]);
	});
});

describe("A directed send", () => {
	test("from a driver reaches its room peer", async () => {
		const text = await textOf(toolFor(registry, "main:a"), { op: "send", to: "main:b", message: "ping" });
		expect(text).toContain("- main:b: delivered");
		expect(delivered).toEqual(["main:b"]);
	});

	test("from a spawn to the peer driver is refused by name and reaches nobody", async () => {
		const text = await textOf(toolFor(registry, "Scout-A"), { op: "send", to: "main:b", message: "ping" });
		expect(text).toContain('Agent "main:b" cannot be messaged from this conversation.');
		expect(delivered).toEqual([]);
	});

	test("from a driver to the peer's spawn is refused by name and reaches nobody", async () => {
		const text = await textOf(toolFor(registry, "main:a"), { op: "send", to: "Scout-B", message: "ping" });
		expect(text).toContain('Agent "Scout-B" cannot be messaged from this conversation.');
		expect(delivered).toEqual([]);
	});
});

describe('A broadcast (`to: "all"`)', () => {
	test("from a driver reaches its own spawns and not the peer beside it", async () => {
		const text = await textOf(toolFor(registry, "main:a"), { op: "send", to: "all", message: "ping" });
		expect(text).toContain("Delivered to 1 peer(s):");
		expect(delivered).toEqual(["Scout-A"]);
	});

	test("from a spawn reaches its own driver and nothing next door", async () => {
		await textOf(toolFor(registry, "Scout-A"), { op: "send", to: "all", message: "ping" });
		expect(delivered).toEqual(["main:a"]);
	});
});

describe("Roster, send and broadcast agree", () => {
	/**
	 * The invariant at the choke point: for every driver, every id the roster
	 * offers is one a directed send accepts, and the broadcast set is exactly
	 * the offered set minus the peers the registry reports. Swept over every
	 * driver so the rule holds from both sides of the room and from outside it.
	 */
	test("for every driver, listed = sendable, and broadcast = listed minus room peers", async () => {
		for (const ref of registry.list().filter(candidate => candidate.kind === "main")) {
			const tool = toolFor(registry, ref.id);
			const listed = rosterIds(await textOf(tool, { op: "list" })).sort();
			const sendable = registry
				.list()
				.filter(other => other.id !== ref.id && registry.canAddress(ref.id, other.id))
				.map(other => other.id)
				.sort();
			expect(listed).toEqual(sendable);
			delivered.length = 0;
			await textOf(tool, { op: "send", to: "all", message: "ping" });
			const peerIds = new Set(registry.peers(ref.id).map(peer => peer.id));
			expect([...delivered].sort()).toEqual(listed.filter(id => !peerIds.has(id)));
		}
	});
});
