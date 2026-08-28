/** AgentRegistry - Process-global registry of agents (the main session plus every subagent), keyed by stable id. */

// Owner subpaths, not the "@veyyon/utils" barrel. This module is the SOLE path by which `tools/read.ts` reaches that barrel, and the barrel brings 23 modules onto the file-read
import * as logger from "@veyyon/utils/logger";
import { errorMessage } from "@veyyon/utils/type-guards";
import type { AgentSession } from "../session/agent-session";
import { oneLineLabel } from "../task/types";

/** The name a driving agent answers to INSIDE its own conversation, and the name the model is told to address. Not a key: a process holds several */
export const MAIN_AGENT_ID = "Main";

/** The registry id for a driving agent, derived from the conversation it starts. Every other host already names its own — an ACP root registers as */
export function mainAgentIdFor(sessionId: string): string {
	return `main:${sessionId}`;
}

/** - `running`: a turn is in flight. - `idle`: live AgentSession in memory, awaiting work. Finished agents are */
export const AGENT_STATUSES = ["running", "idle", "parked", "aborted"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];
/** - `main`/`sub`: the user-facing agent tree (driving agent + task subagents). - `advisor`: a passive review transcript persisted like a subagent for usage */
export type AgentKind = "main" | "sub" | "advisor";

/** A tool call that has stopped and is waiting for a human to answer it. This exists as REAL STATE rather than a private boolean inside the approval */
export interface PendingApproval {
	/** The tool whose call is blocked. */
	toolName: string;
	/** Why permission is required, as it is shown on the card. Absent for a bare tier prompt. */
	reason?: string;
	/** When the wait began, so a consumer can subtract the interval it must not charge. */
	since: number;
}

export interface AgentRef {
	id: string;
	displayName: string;
	kind: AgentKind;
	parentId?: string;
	status: AgentStatus;
	/** Null exactly when parked/aborted. */
	session: AgentSession | null;
	sessionFile: string | null;
	createdAt: number;
	lastActivity: number;
	/** The conversation this agent belongs to: the SessionManager session id of the root `main` session it was spawned under. */
	scope?: string;
	/** Short gist of what the agent is currently doing (latest intent or tool), for the work-aware roster. Display-only. */
	activity?: string;
	/** Model the agent runs on, as a `provider/id` string. Display-only; undefined when not known at registration. */
	model?: string;
	/** The agent's last message said it was waiting on another agent, so it stopped on purpose rather than simply going quiet. Read by the lifecycle manager to */
	waitingOnPeer?: boolean;
	/** Set while this agent has a tool call stopped at an approval prompt, cleared the moment the prompt is answered, abandoned or refused. See */
	pendingApproval?: PendingApproval;
	/** Total milliseconds this agent has spent stopped at approval prompts that are now CLOSED. Undefined until it has waited at least once. */
	approvalWaitedMs?: number;
}

export type RegistryEvent =
	| { type: "registered"; ref: AgentRef }
	| { type: "status_changed"; ref: AgentRef }
	| { type: "removed"; ref: AgentRef };

type RegistryListener = (event: RegistryEvent) => void;

export interface RegisterInput {
	id: string;
	displayName: string;
	kind: AgentKind;
	parentId?: string;
	session: AgentSession | null;
	sessionFile?: string | null;
	/** Conversation root; inherited from `parentId` when omitted. See {@link AgentRef.scope}. */
	scope?: string;
	status?: AgentStatus;
	/** Model the agent runs on, as a `provider/id` string. */
	model?: string;
}

export class AgentRegistry {
	static #global: AgentRegistry | undefined;

	static global(): AgentRegistry {
		if (!AgentRegistry.#global) {
			AgentRegistry.#global = new AgentRegistry();
		}
		return AgentRegistry.#global;
	}

	/** Reset the global registry. Test-only. */
	static resetGlobalForTests(): void {
		AgentRegistry.#global = new AgentRegistry();
	}

	readonly #refs = new Map<string, AgentRef>();
	readonly #listeners = new Set<RegistryListener>();

	/** Register an agent, deriving its conversation {@link AgentRef.scope} when the caller does not state one. */
	register(input: RegisterInput): AgentRef {
		const now = Date.now();
		const ref: AgentRef = {
			id: input.id,
			displayName: input.displayName,
			kind: input.kind,
			parentId: input.parentId,
			status: input.status ?? "running",
			session: input.session,
			sessionFile: input.sessionFile ?? null,
			createdAt: now,
			lastActivity: now,
			model: input.model,
			scope: input.scope ?? this.#deriveScope(input),
		};
		// An id is the key, so registering one twice REPLACES the earlier agent. That is legitimate when the same agent re-registers (a revive re-attaches
		const displaced = this.#refs.get(ref.id);
		if (displaced && displaced.sessionFile !== ref.sessionFile) {
			logger.error("Agent registry id reused by a different agent; the displaced agent loses its row", {
				id: ref.id,
				displacedSessionFile: displaced.sessionFile,
				displacedStatus: displaced.status,
				sessionFile: ref.sessionFile,
			});
		}
		this.#refs.set(ref.id, ref);
		this.#emit({ type: "registered", ref });
		return ref;
	}

	#deriveScope(input: RegisterInput): string | undefined {
		if (input.parentId) return this.#refs.get(input.parentId)?.scope;
		// A root session names its own conversation, and its caller states the id. The transcript path is the fallback for a caller that has no id to give.
		return input.kind === "main" ? (input.sessionFile ?? undefined) : undefined;
	}

	setStatus(id: string, status: AgentStatus): void {
		const ref = this.#refs.get(id);
		if (!ref || ref.status === status) return;
		ref.status = status;
		// Activity describes current work; it is meaningless once the agent
		// leaves `running`, so drop it to avoid showing stale work in rosters.
		if (status !== "running") ref.activity = undefined;
		ref.lastActivity = Date.now();
		this.#emit({ type: "status_changed", ref });
	}

	/** Record a short activity gist for the work-aware roster. Display-only and read on demand (`irc list`, peer roster), so it emits no event — keeping */
	setActivity(id: string, activity: string): void {
		const ref = this.#refs.get(id);
		if (!ref) return;
		if (ref.status !== "running") return;
		const gist = oneLineLabel(activity);
		ref.lastActivity = Date.now();
		if (ref.activity === gist) return;
		ref.activity = gist;
	}

	/** Record that this agent did something, without changing its status. {@link setActivity} is the subagent heartbeat and carries a gist; the */
	noteTurn(id: string): void {
		const ref = this.#refs.get(id);
		if (!ref) return;
		ref.lastActivity = Date.now();
	}

	/** Record whether the agent's last message said it was waiting on another agent. Emits nothing and does not touch `lastActivity`: this is a property OF the */
	setWaitingOnPeer(id: string, waiting: boolean): void {
		const ref = this.#refs.get(id);
		if (!ref) return;
		ref.waitingOnPeer = waiting;
	}

	/** Mark this agent as stopped at an approval prompt, or clear the mark. Emits `status_changed` so a roster or dashboard repaints the moment an agent */
	setPendingApproval(id: string, pending: PendingApproval | undefined): void {
		const ref = this.#refs.get(id);
		if (!ref) return;
		const open = ref.pendingApproval;
		if (open === undefined && pending === undefined) return;
		if (open !== undefined) {
			// `Math.max(0, …)` because a clock step backwards must never subtract from the banked total: a negative contribution would make the exclusion
			ref.approvalWaitedMs = (ref.approvalWaitedMs ?? 0) + Math.max(0, Date.now() - open.since);
		}
		ref.pendingApproval = pending;
		this.#emit({ type: "status_changed", ref });
	}

	/** When this agent began waiting on a human, or undefined if it is not waiting. The OPEN interval only. A runtime budget must exclude */
	pendingApprovalSince(id: string): number | undefined {
		return this.#refs.get(id)?.pendingApproval?.since;
	}

	/** Total milliseconds already banked from CLOSED approval waits; 0 if none. Compose with {@link pendingApprovalSince} for the full exclusion: */
	approvalWaitedMs(id: string): number {
		return this.#refs.get(id)?.approvalWaitedMs ?? 0;
	}

	attachSession(id: string, session: AgentSession, sessionFile?: string | null): void {
		const ref = this.#refs.get(id);
		if (!ref) return;
		ref.session = session;
		if (sessionFile !== undefined) ref.sessionFile = sessionFile;
		ref.lastActivity = Date.now();
	}

	detachSession(id: string): void {
		const ref = this.#refs.get(id);
		if (!ref) return;
		ref.session = null;
	}

	unregister(id: string): void {
		const ref = this.#refs.get(id);
		if (!ref) return;
		this.#refs.delete(id);
		this.#emit({ type: "removed", ref });
	}

	/** Re-root this agent's conversation scope, for a driving session that has switched to a different transcript (`/new`, `/resume`, ACP load, an */
	rescope(id: string, scope: string | undefined): void {
		const ref = this.#refs.get(id);
		if (!ref || ref.scope === scope) return;
		ref.scope = scope;
		// The clock belongs to the conversation that just ended. Carrying it over is the cross-session leak in its quietest form: `/new` after a day of
		const now = Date.now();
		ref.createdAt = now;
		ref.lastActivity = now;
		this.#emit({ type: "status_changed", ref });
	}

	/** Whether two conversation scopes may see each other. Deliberately permissive: an unknown scope on either side is visible. A */
	static sameScope(a: string | undefined, b: string | undefined): boolean {
		return !a || !b || a === b;
	}

	/** Every agent belonging to `scope`, for a roster rendered on behalf of one conversation. */
	listInScope(scope: string | undefined): AgentRef[] {
		return this.list().filter(ref => AgentRegistry.sameScope(ref.scope, scope));
	}

	/** The conversation an agent belongs to, or undefined when it is unknown or unattributed. */
	scopeOf(id: string | undefined): string | undefined {
		return id === undefined ? undefined : this.#refs.get(id)?.scope;
	}

	/** THE conversation-boundary decision, for every caller that has two agent ids and needs to know whether one may reach the other. `irc send`, `irc list`, */
	canAddress(senderId: string, targetId: string): boolean {
		if (senderId === targetId) return false;
		const target = this.#refs.get(targetId);
		if (!target || target.kind === "advisor") return false;
		return AgentRegistry.sameScope(target.scope, this.scopeOf(senderId));
	}

	/** Peers `id` may address RIGHT NOW: alive (running | idle) and in its conversation. */
	listVisibleTo(id: string): AgentRef[] {
		return this.list().filter(
			ref => this.canAddress(id, ref.id) && (ref.status === "running" || ref.status === "idle"),
		);
	}

	/** Peers `id` may address at all, including PARKED ones. Parked is not dead: messaging a parked peer revives it, and that is a */
	listAddressableBy(id: string): AgentRef[] {
		return this.list().filter(ref => this.canAddress(id, ref.id) && ref.status !== "aborted");
	}

	/** The driving agent of `scope`, or undefined when that conversation has none. A conversation has exactly one. Where two somehow match — a stale ref a */
	mainInScope(scope: string | undefined): AgentRef | undefined {
		let found: AgentRef | undefined;
		for (const ref of this.#refs.values()) {
			if (ref.kind !== "main") continue;
			if (!AgentRegistry.sameScope(ref.scope, scope)) continue;
			if (!found || ref.createdAt >= found.createdAt) found = ref;
		}
		return found;
	}

	/** Turn a name an agent WROTE into the ref it meant, from the point of view of the conversation `senderScope` names. */
	resolveId(name: string, senderScope: string | undefined): AgentRef | undefined {
		const exact = this.#refs.get(name);
		if (exact) return exact;
		if (name !== MAIN_AGENT_ID) return undefined;
		return this.mainInScope(senderScope);
	}

	get(id: string): AgentRef | undefined {
		return this.#refs.get(id);
	}

	list(): AgentRef[] {
		return Array.from(this.#refs.values());
	}

	/** Number of task subagents with a turn currently executing in `scope`, and, when `under` is given, below that agent in the spawn tree. */
	runningSubagentCount(scope?: string, under?: string): number {
		const subtree = under === undefined ? undefined : new Set(this.descendantsOf(under));
		let count = 0;
		for (const ref of this.#refs.values()) {
			if (ref.kind !== "sub" || ref.status !== "running") continue;
			if (!AgentRegistry.sameScope(ref.scope, scope)) continue;
			if (subtree && !subtree.has(ref.id)) continue;
			count++;
		}
		return count;
	}

	/** Every agent below `id` in the spawn tree, nearest first, excluding `id`. The registry owns `parentId`, so it owns the walk: a caller that needs "this */
	descendantsOf(id: string): string[] {
		const byParent = new Map<string, string[]>();
		for (const ref of this.#refs.values()) {
			if (!ref.parentId) continue;
			const siblings = byParent.get(ref.parentId);
			if (siblings) siblings.push(ref.id);
			else byParent.set(ref.parentId, [ref.id]);
		}
		const found: string[] = [];
		const seen = new Set<string>([id]);
		const queue = [id];
		while (queue.length > 0) {
			const current = queue.shift() as string;
			for (const child of byParent.get(current) ?? []) {
				if (seen.has(child)) continue;
				seen.add(child);
				found.push(child);
				queue.push(child);
			}
		}
		return found;
	}

	onChange(listener: RegistryListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emit(event: RegistryEvent): void {
		for (const listener of this.#listeners) {
			try {
				listener(event);
			} catch (error) {
				// A listener throwing is a bug in the listener, not an expected condition: it keeps its subscription and keeps missing events, so whatever it
				logger.warn("Agent registry listener threw; it missed this event", {
					event: event.type,
					error: errorMessage(error),
				});
			}
		}
	}
}
