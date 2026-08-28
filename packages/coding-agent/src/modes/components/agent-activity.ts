/** The live side of the Agent Control Center: who is running and what each one is called. */
import type { AgentKind, AgentRef, AgentStatus } from "../../registry/agent-registry";

/** Call signs handed to subagents, in order. A subagent's real id is a spawn-scoped string nobody can hold in their head */
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

/** The call sign for the `order`-th agent of a kind, wrapping past the list. Wrapping suffixes rather than falling back to the raw id: past twelve */
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
	/** The registry's own label. For a task subagent this is the AGENT TYPE it was spawned from (`reviewer`, `scout`): `task/executor.ts` registers it as */
	displayName: string;
	model?: string;
	/** Short gist of current work. Present only while `status === "running"`. */
	activity?: string;
	sessionFile: string | null;
	createdAt: number;
	lastActivity: number;
	/** The agent's sign-off said it had stopped to wait on a peer. Carried onto the row because it is the only thing that separates an agent */
	waitingOnPeer?: boolean;
	/** A tool call of this agent's is stopped at an approval prompt right now. A blocked agent's status is `running`, because it IS mid-turn, so nothing */
	blockedOnApproval?: boolean;
}

/** Order the roster the way a reader scans it: the driving session first, then everyone else oldest-first. */
function rosterOrder(a: AgentRef, b: AgentRef): number {
	// A driving agent is recognized by its role, not by a name. Its id is derived
	// from the conversation it drives, so a roster holding two of them still puts
	// each one first among its own rows.
	if (a.kind === "main" && b.kind !== "main") return -1;
	if (b.kind === "main" && a.kind !== "main") return 1;
	return a.createdAt - b.createdAt;
}

/** The model the agent is running RIGHT NOW, taken from its live session. {@link AgentRef.model} is written once, at registration, and never again. A */
function liveModelOf(ref: AgentRef): string | undefined {
	const model = ref.session?.model;
	return model ? `${model.provider}/${model.id}` : undefined;
}

/** Turn the registry's refs into roster rows, assigning call signs. Advisors are included and named as advisors rather than dropped. They are */
export function collectLiveAgents(refs: readonly AgentRef[]): LiveAgent[] {
	const ordered = refs.slice().sort(rosterOrder);
	let subOrder = 0;
	let advisorOrder = 0;
	const result = new Array<LiveAgent>(ordered.length);
	for (let ri = 0; ri < ordered.length; ri++) {
		const ref = ordered[ri]!;
		let callSign: string;
		if (ref.kind === "main") {
			callSign = MAIN_CALL_SIGN;
		} else if (ref.kind === "advisor") {
			advisorOrder += 1;
			callSign = advisorOrder === 1 ? ADVISOR_CALL_SIGN : `${ADVISOR_CALL_SIGN}-${advisorOrder}`;
		} else {
			callSign = codeNameFor(subOrder);
			subOrder += 1;
		}
		result[ri] = {
			id: ref.id,
			kind: ref.kind,
			status: ref.status,
			parentId: ref.parentId,
			callSign,
			displayName: ref.displayName,
			model: liveModelOf(ref) ?? ref.model,
			activity: ref.activity,
			sessionFile: ref.sessionFile,
			createdAt: ref.createdAt,
			lastActivity: ref.lastActivity,
			waitingOnPeer: ref.waitingOnPeer,
			blockedOnApproval: ref.pendingApproval !== undefined,
		};
	}
	return result;
}

/** The agent TYPE behind a roster row: the name of the agent definition it was spawned from (`reviewer`, `scout`, `task`). */
export function agentType(agent: LiveAgent): string {
	const type = agent.displayName.trim();
	if (!type || type === agent.id) return "";
	if (type.toLowerCase() === agent.callSign.toLowerCase()) return "";
	return type;
}
