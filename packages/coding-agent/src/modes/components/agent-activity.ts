/**
 * The live side of the Agent Control Center: who is running, what they are
 * doing, and what everyone said.
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
 * {@link AgentRegistry}'s refs and already-parsed session entries, and returns
 * plain rows and messages. The reading of session files stays at the edge, in
 * the dashboard, which keeps every rule below directly assertable in a unit
 * test with real values rather than through a rendered frame.
 */
import type { AgentMessage } from "@veyyon/agent-core";
import type { AgentKind, AgentRef, AgentStatus } from "../../registry/agent-registry";
import { MAIN_AGENT_ID } from "../../registry/agent-registry";
import type { FileEntry } from "../../session/session-entries";

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
	/** Stable, human-readable label: {@link MAIN_CALL_SIGN} or a call sign. */
	callSign: string;
	/** The registry's own label, kept for the lens where the full name matters. */
	displayName: string;
	model?: string;
	/** Short gist of current work. Present only while `status === "running"`. */
	activity?: string;
	sessionFile: string | null;
	createdAt: number;
	lastActivity: number;
}

/**
 * Order the roster the way a reader scans it: the driving session first, then
 * everyone else oldest-first.
 *
 * Spawn order, not recency: call signs are assigned from this order, so a
 * recency sort would rename agents as they worked, and a name that moves is
 * worse than no name. `id` breaks exact-tie timestamps so the order is total
 * and two runs of the same roster never disagree.
 */
function rosterOrder(a: AgentRef, b: AgentRef): number {
	if (a.id === MAIN_AGENT_ID) return -1;
	if (b.id === MAIN_AGENT_ID) return 1;
	if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
	return a.id.localeCompare(b.id);
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
			callSign,
			displayName: ref.displayName,
			model: ref.model,
			activity: ref.activity,
			sessionFile: ref.sessionFile,
			createdAt: ref.createdAt,
			lastActivity: ref.lastActivity,
		};
	});
}

/** Agents with a turn in flight, in roster order. */
export function runningAgents(agents: readonly LiveAgent[]): LiveAgent[] {
	return agents.filter(agent => agent.status === "running");
}

/** One turn in the room view. */
export interface RoomMessage {
	/** Call sign of whoever produced it. */
	speaker: string;
	agentId: string;
	role: "user" | "assistant";
	/** Epoch milliseconds, from the session entry's own timestamp. */
	at: number;
	text: string;
}

/**
 * Plain text of a message, blocks flattened, or `""` when it carries none.
 *
 * Tool calls, thinking blocks, and images collapse to nothing on purpose: the
 * room is a conversation view, and a turn that only called a tool has nothing
 * to say in it. The live roster already shows tool activity, per agent, as it
 * happens.
 */
export function messageText(message: AgentMessage): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.map(block => {
			if (!block || typeof block !== "object") return "";
			if (!("type" in block) || (block as { type?: unknown }).type !== "text") return "";
			const text = (block as { text?: unknown }).text;
			return typeof text === "string" ? text : "";
		})
		.filter(text => text.length > 0)
		.join("\n")
		.trim();
}

/**
 * The turns one agent contributed to the room.
 *
 * Only `user` and `assistant` entries survive, and only when they carry text.
 * An entry with an unparseable timestamp is dropped rather than merged at epoch
 * zero, where it would silently pin itself to the top of every room forever.
 */
export function roomMessagesFrom(agent: LiveAgent, entries: readonly FileEntry[]): RoomMessage[] {
	const out: RoomMessage[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = (entry as { message?: AgentMessage }).message;
		if (!message) continue;
		const role = (message as { role?: unknown }).role;
		if (role !== "user" && role !== "assistant") continue;
		const text = messageText(message);
		if (!text) continue;
		const at = Date.parse(entry.timestamp);
		if (!Number.isFinite(at)) continue;
		out.push({ speaker: agent.callSign, agentId: agent.id, role, at, text });
	}
	return out;
}

/**
 * Interleave every agent's turns into one conversation, newest last.
 *
 * `limit` keeps the TAIL, because a room is read from the bottom: the useful
 * thing about a long multi-agent run is what just happened, not how it opened.
 * Ties break on `agentId` so two turns written in the same millisecond keep a
 * stable order across renders instead of flickering.
 */
export function mergeRoomMessages(streams: readonly RoomMessage[][], limit: number): RoomMessage[] {
	const merged = streams.flat().sort((a, b) => {
		if (a.at !== b.at) return a.at - b.at;
		return a.agentId.localeCompare(b.agentId);
	});
	if (limit <= 0 || merged.length <= limit) return merged;
	return merged.slice(merged.length - limit);
}
