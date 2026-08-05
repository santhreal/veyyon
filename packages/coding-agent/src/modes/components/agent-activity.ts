/**
 * The live side of the Agent Control Center: who is running and what each one
 * is called.
 *
 * WHY THIS MODULE EXISTS. The Control Center used to open on a strip of source
 * tabs -- All, Project, User, Bundled -- which answered a question nobody asks.
 * Where an agent's markdown file happens to live tells you nothing about
 * whether it is running, what it is working on, or whether it is worth your
 * attention, and the tab strip spent the top of the card saying it four times.
 * What the card is actually opened to find out is the live picture, so that is
 * what this module computes.
 *
 * Everything here is PURE and file-system free: it takes the process-global
 * {@link AgentRegistry}'s refs and returns plain rows, which keeps every rule
 * below directly assertable in a unit test with real values rather than through
 * a rendered frame.
 */
import type { AgentKind, AgentRef, AgentStatus } from "../../registry/agent-registry";
import { MAIN_AGENT_ID } from "../../registry/agent-registry";

/**
 * Call signs handed to subagents, in order.
 *
 * A subagent's real id is a spawn-scoped string nobody can hold in their head
 * (`task-3f2a…`), and its `displayName` is usually a slice of the task prompt,
 * so a transcript that labels turns by either reads as noise. A short, fixed
 * call sign is memorable, and memorable is the entire point of a room view: you
 * follow a conversation by who is speaking.
 *
 * Deliberately concrete nouns with no shared prefix and no shared first letter
 * run, so two rows never look alike at a glance in a dim list.
 */
export const AGENT_CODE_NAMES = [
	"Kestrel",
	"Otter",
	"Juniper",
	"Cobalt",
	"Marlin",
	"Sable",
	"Vireo",
	"Onyx",
	"Lark",
	"Basalt",
	"Quill",
	"Ember",
] as const;

/** What the driving session is called in every live surface. */
export const MAIN_CALL_SIGN = "Main";

/** What a passive advisor transcript is called; it is not a task peer. */
export const ADVISOR_CALL_SIGN = "Advisor";

/**
 * The call sign for the `order`-th agent of a kind, wrapping past the list.
 *
 * Wrapping suffixes rather than falling back to the raw id: past twelve
 * concurrent subagents the names repeat, and `Kestrel-2` still reads as a name
 * while `task-3f2a…` does not. The number starts at 2 because the first cycle
 * carries no suffix, so the common case stays clean.
 */
export function codeNameFor(order: number): string {
	const base = AGENT_CODE_NAMES[order % AGENT_CODE_NAMES.length];
	const cycle = Math.floor(order / AGENT_CODE_NAMES.length);
	return cycle === 0 ? base : `${base}-${cycle + 1}`;
}

/** One row of the live roster: an agent that exists in this process right now. */
export interface LiveAgent {
	id: string;
	kind: AgentKind;
	status: AgentStatus;
	/** Spawning agent, when it is not the driving session. Nested runs read as a tree. */
	parentId?: string;
	/** Stable, human-readable label: {@link MAIN_CALL_SIGN} or a call sign. */
	callSign: string;
	/**
	 * The registry's own label. For a task subagent this is the AGENT TYPE it was
	 * spawned from (`reviewer`, `scout`): `task/executor.ts` registers it as
	 * `agent.name`, which is why the roster can name the type without a second
	 * lookup.
	 */
	displayName: string;
	model?: string;
	/** Short gist of current work. Present only while `status === "running"`. */
	activity?: string;
	sessionFile: string | null;
	createdAt: number;
	lastActivity: number;
	/**
	 * The agent's sign-off said it had stopped to wait on a peer.
	 *
	 * Carried onto the row because it is the only thing that separates an agent
	 * blocked on a reply that may never come from one that simply finished:
	 * `AgentStatus` calls both of them `parked`. See `agentDisplayState`.
	 */
	waitingOnPeer?: boolean;
	/**
	 * A tool call of this agent's is stopped at an approval prompt right now.
	 *
	 * A blocked agent's status is `running`, because it IS mid-turn, so nothing
	 * else on the row separates a spawn waiting on a person from one grinding
	 * through a build. Reduced to a boolean here because that is all a roster
	 * row spends it on; the prompt's own detail stays on the registry ref.
	 */
	blockedOnApproval?: boolean;
}

/**
 * Order the roster the way a reader scans it: the driving session first, then
 * everyone else oldest-first.
 *
 * Spawn order, not recency: call signs are assigned from this order, so a
 * recency sort would rename agents as they worked, and a name that moves is
 * worse than no name.
 *
 * TIES FALL BACK TO REGISTRATION ORDER, not to the id. `createdAt` is a
 * millisecond clock and a fan-out registers its whole fleet inside one tick, so
 * ties are the COMMON case here rather than the edge one. Comparing ids there
 * sorted them as text, which puts `10-Sub` between `1-Sub` and `2-Sub`: twenty
 * agents spawned in order were listed 1, 10, 11, 12, 2, 3, and the call signs
 * assigned from that order were scrambled with them. `Array.prototype.sort` has
 * been stable since ES2019 and `AgentRegistry.list()` returns its `Map` in
 * insertion order, so returning 0 here keeps the registration order the
 * registry already has, which is the spawn order this function is trying to
 * express. The order is still total and two runs of the same roster still
 * agree; they now agree on the right answer.
 */
function rosterOrder(a: AgentRef, b: AgentRef): number {
	if (a.id === MAIN_AGENT_ID) return -1;
	if (b.id === MAIN_AGENT_ID) return 1;
	return a.createdAt - b.createdAt;
}

/**
 * Turn the registry's refs into roster rows, assigning call signs.
 *
 * Advisors are included and named as advisors rather than dropped. They are
 * hidden from agent-facing rosters because they are not addressable peers, but
 * this surface answers "what is running", and an advisor burning tokens in the
 * background is exactly the thing an operator is looking for when they open it.
 * Omitting a live agent from the live view would be the same silent gap the old
 * tabs had, one level down.
 */
export function collectLiveAgents(refs: readonly AgentRef[]): LiveAgent[] {
	const ordered = [...refs].sort(rosterOrder);
	let subOrder = 0;
	let advisorOrder = 0;
	return ordered.map(ref => {
		let callSign: string;
		if (ref.id === MAIN_AGENT_ID || ref.kind === "main") {
			callSign = MAIN_CALL_SIGN;
		} else if (ref.kind === "advisor") {
			advisorOrder += 1;
			callSign = advisorOrder === 1 ? ADVISOR_CALL_SIGN : `${ADVISOR_CALL_SIGN}-${advisorOrder}`;
		} else {
			callSign = codeNameFor(subOrder);
			subOrder += 1;
		}
		return {
			id: ref.id,
			kind: ref.kind,
			status: ref.status,
			parentId: ref.parentId,
			callSign,
			displayName: ref.displayName,
			model: ref.model,
			activity: ref.activity,
			sessionFile: ref.sessionFile,
			createdAt: ref.createdAt,
			lastActivity: ref.lastActivity,
			waitingOnPeer: ref.waitingOnPeer,
			blockedOnApproval: ref.pendingApproval !== undefined,
		};
	});
}

/**
 * The agent TYPE behind a roster row: the name of the agent definition it was
 * spawned from (`reviewer`, `scout`, `task`).
 *
 * {@link LiveAgent.displayName} carries it, because the task executor registers
 * a subagent under `agent.name`. Two rows have no type to show and return the
 * empty string rather than repeating what the reader already has: the driving
 * session registers as `main` and would print that word twice under the call
 * sign `Main`, and an agent persisted by an earlier run registers under its own
 * id as the label.
 *
 * It lives here rather than in the card that renders it because it is a pure
 * rule about a roster row, assertable against real values without a frame.
 */
export function agentType(agent: LiveAgent): string {
	const type = agent.displayName.trim();
	if (!type || type === agent.id) return "";
	if (type.toLowerCase() === agent.callSign.toLowerCase()) return "";
	return type;
}
