/**
 * The live roster and the room view that replaced the Control Center's source tabs.
 *
 * WHY THIS SUITE EXISTS (AGENTCC-BUNDLED-TAB-SERVES-ZERO-PURPOSE). The card's
 * top strip used to filter agents by where their file lives -- All / Project /
 * User / Bundled -- which is not a question anyone opens the card to answer.
 * The replacement answers "who is running and what are they doing", and it only
 * works if two properties hold, both of which are invisible in a screenshot and
 * so are pinned here:
 *
 *   1. A call sign is STABLE. Names are assigned from spawn order, never from
 *      recency or status, because an agent that gets renamed while you watch it
 *      is worse than an agent with no name at all.
 *   2. The room is ONE conversation. Turns from every agent interleave by their
 *      own timestamps, and the tail is what survives a limit, because a room is
 *      read from the bottom.
 */
import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import {
	ADVISOR_CALL_SIGN,
	AGENT_CODE_NAMES,
	codeNameFor,
	collectLiveAgents,
	MAIN_CALL_SIGN,
	mergeRoomMessages,
	messageText,
	roomMessagesFrom,
	runningAgents,
} from "@veyyon/coding-agent/modes/components/agent-activity";
import type { AgentKind, AgentRef, AgentStatus } from "@veyyon/coding-agent/registry/agent-registry";
import { MAIN_AGENT_ID } from "@veyyon/coding-agent/registry/agent-registry";
import type { FileEntry } from "@veyyon/coding-agent/session/session-entries";

function ref(overrides: Partial<AgentRef> & { id: string; createdAt: number }): AgentRef {
	return {
		displayName: overrides.id,
		kind: "sub" as AgentKind,
		status: "running" as AgentStatus,
		session: null,
		sessionFile: null,
		lastActivity: overrides.createdAt,
		...overrides,
	} as AgentRef;
}

function textMessage(role: "user" | "assistant", text: string): AgentMessage {
	return { role, content: [{ type: "text", text }] } as unknown as AgentMessage;
}

function messageEntry(id: string, timestamp: string, message: AgentMessage): FileEntry {
	return { type: "message", id, parentId: null, timestamp, message } as FileEntry;
}

describe("call signs are stable names, not decoration", () => {
	/**
	 * The first cycle carries no suffix and the second does. Asserted on the
	 * exported list rather than on hard-coded words so adding a name to the list
	 * cannot silently shift what the wrap produces.
	 */
	it("names the first cycle bare and suffixes every cycle after it", () => {
		expect(codeNameFor(0)).toBe(AGENT_CODE_NAMES[0]);
		expect(codeNameFor(AGENT_CODE_NAMES.length - 1)).toBe(AGENT_CODE_NAMES[AGENT_CODE_NAMES.length - 1]);
		expect(codeNameFor(AGENT_CODE_NAMES.length)).toBe(`${AGENT_CODE_NAMES[0]}-2`);
		expect(codeNameFor(AGENT_CODE_NAMES.length * 2 + 1)).toBe(`${AGENT_CODE_NAMES[1]}-3`);
	});

	/** Two rows that look alike in a dim list defeat the point of naming them. */
	it("hands out distinct names with no repeats inside a cycle", () => {
		const names = AGENT_CODE_NAMES.map((_, index) => codeNameFor(index));
		expect(new Set(names).size).toBe(AGENT_CODE_NAMES.length);
	});

	/**
	 * The main session is always `Main`, wherever it sits in the ref list, and it
	 * consumes no call sign: if it did, the first real subagent would be `Otter`
	 * and every roster would be off by one from the list a reader can see.
	 */
	it("labels the driving session Main and starts subagents at the first call sign", () => {
		const agents = collectLiveAgents([
			ref({ id: "sub-a", createdAt: 20 }),
			ref({ id: MAIN_AGENT_ID, kind: "main", createdAt: 5 }),
			ref({ id: "sub-b", createdAt: 30 }),
		]);
		expect(agents.map(agent => agent.callSign)).toEqual([MAIN_CALL_SIGN, AGENT_CODE_NAMES[0], AGENT_CODE_NAMES[1]]);
		expect(agents.map(agent => agent.id)).toEqual([MAIN_AGENT_ID, "sub-a", "sub-b"]);
	});

	/**
	 * The stability property itself, and the reason the sort is by `createdAt`
	 * rather than `lastActivity`: an older agent that just did something must not
	 * steal the newer one's name. This is the assertion that fails if anyone
	 * "improves" the roster by sorting on recency.
	 */
	it("keeps a name attached to its agent when another agent becomes the most recent", () => {
		const first = ref({ id: "sub-a", createdAt: 10, lastActivity: 10 });
		const second = ref({ id: "sub-b", createdAt: 20, lastActivity: 999 });
		const before = collectLiveAgents([first, second]);
		const after = collectLiveAgents([{ ...first, lastActivity: 5000 }, second]);

		const nameOf = (agents: ReturnType<typeof collectLiveAgents>, id: string) =>
			agents.find(agent => agent.id === id)?.callSign;
		expect(nameOf(before, "sub-a")).toBe(AGENT_CODE_NAMES[0]);
		expect(nameOf(after, "sub-a")).toBe(AGENT_CODE_NAMES[0]);
		expect(nameOf(after, "sub-b")).toBe(AGENT_CODE_NAMES[1]);
	});

	/**
	 * An advisor is not a task peer, so it does not take a call sign -- but it IS
	 * running and burning tokens, so hiding it would reproduce, one level down,
	 * the exact blind spot the source tabs had.
	 */
	it("shows advisors under their own label without consuming a call sign", () => {
		const agents = collectLiveAgents([
			ref({ id: "advisor-1", kind: "advisor", createdAt: 1 }),
			ref({ id: "sub-a", createdAt: 2 }),
			ref({ id: "advisor-2", kind: "advisor", createdAt: 3 }),
		]);
		expect(agents.map(agent => agent.callSign)).toEqual([
			ADVISOR_CALL_SIGN,
			AGENT_CODE_NAMES[0],
			`${ADVISOR_CALL_SIGN}-2`,
		]);
	});

	/** A total order: equal timestamps must not leave two renders disagreeing. */
	it("breaks identical spawn timestamps on id so the order is total", () => {
		const agents = collectLiveAgents([ref({ id: "sub-z", createdAt: 7 }), ref({ id: "sub-a", createdAt: 7 })]);
		expect(agents.map(agent => agent.id)).toEqual(["sub-a", "sub-z"]);
	});

	/** `running` is the only in-flight status; the rest are finished or dead. */
	it("counts only running agents as running", () => {
		const agents = collectLiveAgents([
			ref({ id: "a", createdAt: 1, status: "running" }),
			ref({ id: "b", createdAt: 2, status: "idle" }),
			ref({ id: "c", createdAt: 3, status: "parked" }),
			ref({ id: "d", createdAt: 4, status: "aborted" }),
		]);
		expect(runningAgents(agents).map(agent => agent.id)).toEqual(["a"]);
	});
});

describe("the room is one conversation, not four transcripts", () => {
	const agents = collectLiveAgents([
		ref({ id: MAIN_AGENT_ID, kind: "main", createdAt: 1 }),
		ref({ id: "sub-a", createdAt: 2 }),
	]);
	const main = agents[0];
	const sub = agents[1];

	/**
	 * Text blocks flatten and everything else disappears. A turn that only called
	 * a tool has nothing to say in a conversation view, and rendering an empty
	 * bubble for it is how a room fills with noise.
	 */
	it("takes text from string content and from text blocks, and nothing from tool calls", () => {
		expect(messageText({ role: "user", content: "  plain  " } as unknown as AgentMessage)).toBe("plain");
		expect(messageText(textMessage("assistant", "hello\nthere"))).toBe("hello\nthere");
		expect(
			messageText({
				role: "assistant",
				content: [{ type: "toolCall", name: "read" }],
			} as unknown as AgentMessage),
		).toBe("");
	});

	/** Every surviving turn carries the speaker's call sign, its role, and a real epoch. */
	it("tags each turn with the speaking agent's call sign", () => {
		const messages = roomMessagesFrom(sub, [
			messageEntry("1", "2026-07-25T00:00:01.000Z", textMessage("assistant", "found it")),
		]);
		expect(messages).toEqual([
			{
				speaker: AGENT_CODE_NAMES[0],
				agentId: "sub-a",
				role: "assistant",
				at: Date.parse("2026-07-25T00:00:01.000Z"),
				text: "found it",
			},
		]);
	});

	/**
	 * An entry whose timestamp will not parse is dropped, not merged at epoch
	 * zero. `Date.parse` returning NaN would sort to the very top of every room
	 * forever, which reads as "this was said first" about a message nobody can
	 * place in time.
	 */
	it("drops entries with an unparseable timestamp instead of pinning them to the top", () => {
		const messages = roomMessagesFrom(sub, [
			messageEntry("1", "not-a-date", textMessage("assistant", "orphan")),
			messageEntry("2", "2026-07-25T00:00:02.000Z", textMessage("assistant", "kept")),
		]);
		expect(messages.map(message => message.text)).toEqual(["kept"]);
	});

	/** Non-message entries and text-free turns never reach the room. */
	it("ignores non-message entries and empty turns", () => {
		const messages = roomMessagesFrom(main, [
			{ type: "model_change", id: "1", parentId: null, timestamp: "2026-07-25T00:00:01.000Z" } as FileEntry,
			messageEntry("2", "2026-07-25T00:00:02.000Z", textMessage("assistant", "   ")),
			messageEntry("3", "2026-07-25T00:00:03.000Z", { role: "system", content: "x" } as unknown as AgentMessage),
		]);
		expect(messages).toEqual([]);
	});

	/** The interleave: two agents, one timeline, ordered by when each turn happened. */
	it("interleaves turns from every agent by timestamp", () => {
		const mainStream = roomMessagesFrom(main, [
			messageEntry("1", "2026-07-25T00:00:01.000Z", textMessage("user", "go")),
			messageEntry("2", "2026-07-25T00:00:04.000Z", textMessage("assistant", "done")),
		]);
		const subStream = roomMessagesFrom(sub, [
			messageEntry("3", "2026-07-25T00:00:02.000Z", textMessage("assistant", "looking")),
			messageEntry("4", "2026-07-25T00:00:03.000Z", textMessage("assistant", "found")),
		]);
		expect(mergeRoomMessages([mainStream, subStream], 0).map(m => `${m.speaker}: ${m.text}`)).toEqual([
			`${MAIN_CALL_SIGN}: go`,
			`${AGENT_CODE_NAMES[0]}: looking`,
			`${AGENT_CODE_NAMES[0]}: found`,
			`${MAIN_CALL_SIGN}: done`,
		]);
	});

	/**
	 * The limit keeps the TAIL. Slicing from the front would show the opening of
	 * a long run and hide the part the operator opened the tab to read.
	 */
	it("keeps the newest turns when the room is longer than the limit", () => {
		const stream = roomMessagesFrom(main, [
			messageEntry("1", "2026-07-25T00:00:01.000Z", textMessage("assistant", "one")),
			messageEntry("2", "2026-07-25T00:00:02.000Z", textMessage("assistant", "two")),
			messageEntry("3", "2026-07-25T00:00:03.000Z", textMessage("assistant", "three")),
		]);
		expect(mergeRoomMessages([stream], 2).map(m => m.text)).toEqual(["two", "three"]);
		expect(mergeRoomMessages([stream], 99).map(m => m.text)).toEqual(["one", "two", "three"]);
	});

	/** Same-millisecond turns must not flicker between renders. */
	it("breaks identical timestamps on agent id so the order is stable", () => {
		const at = "2026-07-25T00:00:05.000Z";
		const mainStream = roomMessagesFrom(main, [messageEntry("1", at, textMessage("assistant", "m"))]);
		const subStream = roomMessagesFrom(sub, [messageEntry("2", at, textMessage("assistant", "s"))]);
		expect(mergeRoomMessages([mainStream, subStream], 0).map(m => m.agentId)).toEqual([MAIN_AGENT_ID, "sub-a"]);
		expect(mergeRoomMessages([subStream, mainStream], 0).map(m => m.agentId)).toEqual([MAIN_AGENT_ID, "sub-a"]);
	});
});
