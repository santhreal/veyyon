import type { AgentKind, AgentRef, AgentStatus } from "../../registry/agent-registry";

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

export const MAIN_CALL_SIGN = "Main";

export const ADVISOR_CALL_SIGN = "Advisor";

export function codeNameFor(order: number): string {
	const base = AGENT_CODE_NAMES[order % AGENT_CODE_NAMES.length];
	const cycle = Math.floor(order / AGENT_CODE_NAMES.length);
	return cycle === 0 ? base : `${base}-${cycle + 1}`;
}

export interface LiveAgent {
	id: string;
	kind: AgentKind;
	status: AgentStatus;
	parentId?: string;
	callSign: string;
	displayName: string;
	model?: string;
	activity?: string;
	sessionFile: string | null;
	createdAt: number;
	lastActivity: number;
	waitingOnPeer?: boolean;
	blockedOnApproval?: boolean;
}

function rosterOrder(a: AgentRef, b: AgentRef): number {
	if (a.kind === "main" && b.kind !== "main") return -1;
	if (b.kind === "main" && a.kind !== "main") return 1;
	return a.createdAt - b.createdAt;
}

function liveModelOf(ref: AgentRef): string | undefined {
	const model = ref.session?.model;
	return model ? `${model.provider}/${model.id}` : undefined;
}

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

export function agentType(agent: LiveAgent): string {
	const type = agent.displayName.trim();
	if (!type || type === agent.id) return "";
	if (type.toLowerCase() === agent.callSign.toLowerCase()) return "";
	return type;
}
