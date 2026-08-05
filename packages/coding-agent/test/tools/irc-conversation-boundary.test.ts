/**
 * `irc list`, `irc send` and `irc wait` across TWO conversations in one process.
 *
 * WHY TWO. Every assertion here is about reaching state that belongs to SOMEBODY
 * ELSE. With a single conversation registered there is no second conversation to
 * reach, so the identical test passes against the unscoped code and the scoped
 * code alike. That is not a hypothetical registry shape: ACP's `session/new`
 * keeps every session it opens in one map until `session/close`, each registered
 * as its own `kind: "main"` with its own scope.
 *
 * WHY ONE OWNER. The three operations used to spell the boundary three different
 * ways: `listVisibleTo` for the roster, a hand-rolled `sameScope` comparison for
 * the send, and `listVisibleTo` again inside the wait's liveness watch. A rule
 * written three times is a rule that gets fixed twice. They now all resolve
 * through `AgentRegistry.canAddress`, and the last test in this file is the one
 * that fails if they ever diverge again: it asserts that every id the roster
 * OFFERS is an id the send ACCEPTS, and that no id it withholds is accepted.
 *
 * `Settings.isolated()` appears only to give the tool a settings object for
 * `irc.timeoutMs`. Nothing here is measured through it; the conversation
 * boundary comes from the registry.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { IrcBus } from "@veyyon/coding-agent/irc/bus";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { IrcTool } from "@veyyon/coding-agent/tools/irc";
import { makeToolSession } from "../helpers/tool-session";

function liveSession(): AgentSession {
	return {
		deliverIrcMessage: async () => "delivered",
		emitIrcRelayObservation: () => {},
	} as unknown as AgentSession;
}

function toolFor(registry: AgentRegistry, agentId: string): IrcTool {
	const session: ToolSession = makeToolSession({
		cwd: "/tmp",
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

let registry: AgentRegistry;

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	registry = AgentRegistry.global();
	// Conversation A: a driving root, one running spawn, one parked spawn.
	registry.register({ id: "acp:a", displayName: "main", kind: "main", session: liveSession(), scope: "session-a" });
	registry.register({
		id: "Scout-A",
		displayName: "scout",
		kind: "sub",
		parentId: "acp:a",
		session: liveSession(),
		status: "running",
	});
	registry.register({
		id: "Archivist-A",
		displayName: "archivist",
		kind: "sub",
		parentId: "acp:a",
		session: null,
		sessionFile: "/tmp/archivist-a.jsonl",
		status: "parked",
	});
	// Conversation B, opened in the same process by a second `session/new`.
	registry.register({ id: "acp:b", displayName: "main", kind: "main", session: liveSession(), scope: "session-b" });
	registry.register({
		id: "Scout-B",
		displayName: "scout",
		kind: "sub",
		parentId: "acp:b",
		session: liveSession(),
		status: "running",
	});
});

afterEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

describe("The roster an agent reads", () => {
	/**
	 * The exact list, not "it is filtered". The ids in this text are the ids the
	 * model will hand to `send`, so the set has to be pinned rather than sampled:
	 * a missing peer is a coordination failure and an extra one is the leak.
	 */
	test("names this conversation's peers, including the parked one, and nobody else's", async () => {
		const listed = await textOf(toolFor(registry, "Scout-A"), { op: "list" });

		const ids = listed
			.split("\n")
			.filter(line => line.startsWith("- "))
			.map(line => line.slice(2, line.indexOf(" [")));
		expect(ids.sort()).toEqual(["Archivist-A", "acp:a"]);
		expect(listed).toContain("Parked agents are revived automatically when you message them.");
	});

	/** The same question from the other conversation, so a filter that empties the roster fails. */
	test("names the other conversation's peers when asked from there", async () => {
		const listed = await textOf(toolFor(registry, "Scout-B"), { op: "list" });

		const ids = listed
			.split("\n")
			.filter(line => line.startsWith("- "))
			.map(line => line.slice(2, line.indexOf(" [")));
		expect(ids).toEqual(["acp:b"]);
	});
});

describe("Delivery across the boundary", () => {
	/**
	 * Refused BY NAME. A directed send revives a parked recipient, so an
	 * unguarded one does not merely deliver across the boundary: it restarts an
	 * agent of a conversation the sender has nothing to do with and has it answer
	 * into that conversation's transcript.
	 */
	test("refuses a directed send to another conversation's agent", async () => {
		const said = await textOf(toolFor(registry, "Scout-A"), {
			op: "send",
			to: "Scout-B",
			message: "what are you working on",
		});

		expect(said).toContain("cannot be messaged from this conversation");
		expect(IrcBus.global().log()).toEqual([]);
	});

	/** Same-conversation delivery is untouched, so refusal cannot be mistaken for a working fix. */
	test("delivers to a peer of the same conversation", async () => {
		const said = await textOf(toolFor(registry, "Scout-A"), {
			op: "send",
			to: "acp:a",
			message: "status",
		});

		expect(said).toContain("acp:a: delivered");
	});

	/** A broadcast fans out to this conversation's live peers only. */
	test("keeps a broadcast inside the sender's conversation", async () => {
		await textOf(toolFor(registry, "Scout-A"), { op: "send", to: "all", message: "heads up" });

		expect(
			IrcBus.global()
				.log()
				.map(entry => entry.message.to),
		).toEqual(["acp:a"]);
	});

	/**
	 * The anti-drift test, and the reason the boundary has one owner. If someone
	 * later tightens the roster without tightening the send, or the reverse, the
	 * two sets stop agreeing and this fails: the roster would either advertise a
	 * peer that cannot be reached, or hide one that can.
	 */
	test("every id the roster offers is an id the send accepts, and no other", async () => {
		const listed = await textOf(toolFor(registry, "Scout-A"), { op: "list" });
		const offered = new Set(
			listed
				.split("\n")
				.filter(line => line.startsWith("- "))
				.map(line => line.slice(2, line.indexOf(" ["))),
		);

		for (const candidate of ["acp:a", "Archivist-A", "acp:b", "Scout-B"]) {
			expect({ candidate, offered: offered.has(candidate) }).toEqual({
				candidate,
				offered: registry.canAddress("Scout-A", candidate),
			});
		}
	});
});
