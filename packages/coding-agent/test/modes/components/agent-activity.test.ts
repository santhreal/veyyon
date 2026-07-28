/**
 * The live roster that replaced the Control Center's source tabs.
 *
 * WHY THIS SUITE EXISTS (AGENTCC-BUNDLED-TAB-SERVES-ZERO-PURPOSE). The card's
 * top strip used to filter agents by where their file lives -- All / Project /
 * User / Bundled -- which is not a question anyone opens the card to answer.
 * The replacement answers "who is running and what are they doing", and it only
 * works if a call sign is STABLE: names are assigned from spawn order, never
 * from recency or status, because an agent that gets renamed while you watch it
 * is worse than an agent with no name at all. That property is invisible in a
 * screenshot, so it is pinned here.
 */
import { describe, expect, it } from "bun:test";
import {
	ADVISOR_CALL_SIGN,
	AGENT_CODE_NAMES,
	agentType,
	codeNameFor,
	collectLiveAgents,
	type LiveAgent,
	MAIN_CALL_SIGN,
} from "@veyyon/coding-agent/modes/components/agent-activity";
import type { AgentKind, AgentRef, AgentStatus } from "@veyyon/coding-agent/registry/agent-registry";
import { MAIN_AGENT_ID } from "@veyyon/coding-agent/registry/agent-registry";

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

	/**
	 * A total order, and equal timestamps keep the order they arrived in.
	 *
	 * `createdAt` is a millisecond clock and a fan-out registers its whole fleet
	 * inside one tick, so this is the COMMON case rather than an edge one. The
	 * roster used to break the tie on the id, comparing it as text, and this test
	 * asserted that: `sub-a` before `sub-z` looks right until the ids are
	 * numbered, where it puts `10-Sub` between `1-Sub` and `2-Sub`. The sort is
	 * stable and `AgentRegistry.list()` hands over its `Map` in insertion order,
	 * so a tie now means "the order they were registered in", which is the spawn
	 * order the function is trying to express.
	 */
	it("keeps registration order when spawn timestamps are identical", () => {
		const agents = collectLiveAgents([ref({ id: "sub-z", createdAt: 7 }), ref({ id: "sub-a", createdAt: 7 })]);
		expect(agents.map(agent => agent.id)).toEqual(["sub-z", "sub-a"]);
	});

	/**
	 * The case the id comparison actually broke: ten or more agents fanned out in
	 * one tick, with numeric ids. Text order reads 1, 10, 11, 2; registration
	 * order reads 1, 2, 3.
	 */
	it("lists a same-tick fan-out of numbered agents in spawn order", () => {
		const spawned = Array.from({ length: 12 }, (_, index) => ref({ id: `${index}-Sub`, createdAt: 7 }));

		const agents = collectLiveAgents(spawned);

		expect(agents.map(agent => agent.id)).toEqual(spawned.map(agent => agent.id));
	});

	/**
	 * And the ordering rule that outranks the tie-break is untouched: an agent
	 * registered later but stamped earlier still sorts first.
	 */
	it("still sorts by spawn time before falling back to registration order", () => {
		const agents = collectLiveAgents([ref({ id: "sub-late", createdAt: 9 }), ref({ id: "sub-early", createdAt: 2 })]);

		expect(agents.map(agent => agent.id)).toEqual(["sub-early", "sub-late"]);
	});
});

/**
 * The agent TYPE shown next to a call sign.
 *
 * WHY IT MATTERS. A call sign is memorable but arbitrary: `Kestrel` says nothing
 * about whether the thing burning tokens over there is a reviewer or a scout.
 * The type is the answer, and it was rendered ONLY when an agent had no activity
 * to report, which is exactly when nobody is looking at the row. These pin the
 * three cases where the honest answer is to print nothing, because each of them
 * would otherwise put a word on the row that the reader already has.
 */
describe("agentType", () => {
	function row(overrides: Partial<LiveAgent>): LiveAgent {
		return {
			id: "sub-a",
			kind: "sub",
			status: "running",
			callSign: "Kestrel",
			displayName: "reviewer",
			sessionFile: null,
			createdAt: 1,
			lastActivity: 1,
			...overrides,
		};
	}

	/** The ordinary case: the definition the executor spawned the agent from. */
	it("returns the agent definition's name", () => {
		expect(agentType(row({ displayName: "reviewer" }))).toBe("reviewer");
	});

	/**
	 * The driving session registers as `main` under the call sign `Main`, so
	 * printing the type would render "Main main" on the top row of every roster.
	 * Case-insensitive, because the two are written differently by design.
	 */
	it("prints nothing when the label only restates the call sign", () => {
		expect(agentType(row({ callSign: "Main", displayName: "main" }))).toBe("");
		expect(agentType(row({ callSign: "Advisor", displayName: "advisor" }))).toBe("");
	});

	/**
	 * An agent persisted by an earlier run registers under its own id as the
	 * label, which is the id the row is already identified by.
	 */
	it("prints nothing when the label is just the agent id", () => {
		expect(agentType(row({ id: "task-3f2a", displayName: "task-3f2a" }))).toBe("");
	});

	/** Whitespace is not a type. A blank label must not reserve a column. */
	it("treats a blank or whitespace-only label as no type", () => {
		expect(agentType(row({ displayName: "" }))).toBe("");
		expect(agentType(row({ displayName: "   " }))).toBe("");
	});

	/** And a label that merely CONTAINS the call sign is still a real type. */
	it("keeps a label that contains the call sign without being it", () => {
		expect(agentType(row({ callSign: "Kestrel", displayName: "Kestrel reviewer" }))).toBe("Kestrel reviewer");
	});

	/** Surrounding whitespace is trimmed rather than padding the column. */
	it("trims the label it returns", () => {
		expect(agentType(row({ displayName: "  scout  " }))).toBe("scout");
	});
});
