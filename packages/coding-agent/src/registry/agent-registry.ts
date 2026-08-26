/**
 * AgentRegistry - Process-global registry of agents (main session and subagents),
 * tracking status and active sessions for cross-agent communication and lifecycle management.
 */

// Owner subpaths, not the "@veyyon/utils" barrel. This module is the SOLE path by which
// `tools/read.ts` reaches that barrel, and the barrel brings 23 modules onto the file-read
// closure that nothing there asks for. See the barrel absence in
// `test/architecture/leveraged-imports-stay-cut.test.ts`.
import * as logger from "@veyyon/utils/logger";
import { errorMessage } from "@veyyon/utils/type-guards";
import type { AgentSession } from "../session/agent-session";
import { oneLineLabel } from "../task/types";

export const MAIN_AGENT_ID = "Main";

/**
 * Agent execution status: `running` (active turn), `idle` (live in memory),
 * `parked` (session disposed, revivable), or `aborted` (hard-killed, terminal).
 */
export const AGENT_STATUSES = ["running", "idle", "parked", "aborted"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];
/**
 * - `main`/`sub`: the user-facing agent tree (driving agent + task subagents).
 * - `advisor`: a passive review transcript persisted like a subagent for usage
 *   attribution and Control Center observability, but never a peer — hidden from
 *   agent-facing rosters (`irc`, `history://`) and not messageable/revivable.
 */
export type AgentKind = "main" | "sub" | "advisor";

/**
 * Tool call paused at a human approval prompt, tracked explicitly so budgets,
 * dashboards, and prompt queues can distinguish waiting on a human from active work.
 */
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
	/**
	 * Conversation scope (SessionManager session ID of root `main` session),
	 * isolating agent rosters across concurrent conversations in the same process.
	 */
	scope?: string;
	/** Short gist of what the agent is currently doing (latest intent or tool), for the work-aware roster. Display-only. */
	activity?: string;
	/** Model the agent runs on, as a `provider/id` string. Display-only; undefined when not known at registration. */
	model?: string;
	/**
	 * True if the agent stopped to wait on another agent, granting it a longer
	 * grace window before parked cleanup.
	 */
	waitingOnPeer?: boolean;
	/**
	 * Active tool approval wait, distinguishing blocked agents from actively working
	 * ones while status remains `running`.
	 */
	pendingApproval?: PendingApproval;
	/**
	 * Total ms spent waiting on closed approval prompts, banked so runtime budgets
	 * do not penalize agents for operator reading time.
	 */
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

	/**
	 * Register an agent, deriving conversation scope from parent lineage when omitted
	 * so the entire spawn tree shares one scope.
	 */
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
		this.#refs.set(ref.id, ref);
		this.#emit({ type: "registered", ref });
		return ref;
	}

	#deriveScope(input: RegisterInput): string | undefined {
		if (input.parentId) return this.#refs.get(input.parentId)?.scope;
		// A root session names its own conversation, and its caller states the id.
		// The transcript path is the fallback for a caller that has no id to give.
		// A parentless SUBAGENT is left unattributed on purpose: it is an orphan
		// nobody claimed, and inventing a scope from its own path would produce a
		// name nothing else shares, hiding it from the roster that should show it.
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

	/**
	 * Record a normalized, single-line activity gist and bump `lastActivity` for
	 * running agents without emitting events or altering recency for idle peers.
	 */
	setActivity(id: string, activity: string): void {
		const ref = this.#refs.get(id);
		if (!ref) return;
		if (ref.status !== "running") return;
		const gist = oneLineLabel(activity);
		ref.lastActivity = Date.now();
		if (ref.activity === gist) return;
		ref.activity = gist;
	}

	/**
	 * Record whether the agent finished by waiting on a peer, without bumping
	 * `lastActivity` or emitting events.
	 */
	setWaitingOnPeer(id: string, waiting: boolean): void {
		const ref = this.#refs.get(id);
		if (!ref) return;
		ref.waitingOnPeer = waiting;
	}

	/**
	 * Set or clear an approval wait, emitting `status_changed` for UI updates and
	 * banking closed wait durations into `approvalWaitedMs` without bumping `lastActivity`.
	 */
	setPendingApproval(id: string, pending: PendingApproval | undefined): void {
		const ref = this.#refs.get(id);
		if (!ref) return;
		const open = ref.pendingApproval;
		if (open === undefined && pending === undefined) return;
		if (open !== undefined) {
			// `Math.max(0, …)` because a clock step backwards must never subtract from
			// the banked total: a negative contribution would make the exclusion
			// smaller than the waits already recorded, which is worse than not counting
			// this one at all.
			ref.approvalWaitedMs = (ref.approvalWaitedMs ?? 0) + Math.max(0, Date.now() - open.since);
		}
		ref.pendingApproval = pending;
		this.#emit({ type: "status_changed", ref });
	}

	/**
	 * Timestamp (ms) when the current open approval wait began, or undefined if not waiting.
	 * Runtime budgets exclude this plus banked time.
	 */
	pendingApprovalSince(id: string): number | undefined {
		return this.#refs.get(id)?.pendingApproval?.since;
	}

	/**
	 * Total ms banked from closed approval waits (0 if none), intended to be combined
	 * with {@link pendingApprovalSince} for full wait-time exclusion.
	 */
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

	/**
	 * Re-root an agent's conversation scope (e.g. after `/new` or `/resume`),
	 * leaving former child scopes intact so abandoned subagents remain isolated.
	 */
	rescope(id: string, scope: string | undefined): void {
		const ref = this.#refs.get(id);
		if (!ref || ref.scope === scope) return;
		ref.scope = scope;
		this.#emit({ type: "status_changed", ref });
	}

	/**
	 * Check if two conversation scopes can see each other, treating undefined
	 * on either side as visible (e.g. collab guests or test fixtures).
	 */
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

	/**
	 * Central conversation-boundary decision deciding if `senderId` can address `targetId`,
	 * enforcing scope matching and excluding advisors/self.
	 */
	canAddress(senderId: string, targetId: string): boolean {
		if (senderId === targetId) return false;
		const target = this.#refs.get(targetId);
		if (!target || target.kind === "advisor") return false;
		return AgentRegistry.sameScope(target.scope, this.scopeOf(senderId));
	}

	/**
	 * List alive peers (`running` or `idle`) in the same conversation scope.
	 */
	listVisibleTo(id: string): AgentRef[] {
		return this.list().filter(
			ref => this.canAddress(id, ref.id) && (ref.status === "running" || ref.status === "idle"),
		);
	}

	/**
	 * List all addressable peers in scope including revivable `parked` ones (excluding `aborted`).
	 */
	listAddressableBy(id: string): AgentRef[] {
		return this.list().filter(ref => this.canAddress(id, ref.id) && ref.status !== "aborted");
	}

	get(id: string): AgentRef | undefined {
		return this.#refs.get(id);
	}

	list(): AgentRef[] {
		return [...this.#refs.values()];
	}

	/**
	 * Count running task subagents in `scope` (and optionally under a specific subtree `under`),
	 * scoped to the active conversation.
	 */
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

	/**
	 * Traverse and return all descendant agent IDs below `id` in the spawn tree (nearest first),
	 * cycle-safe.
	 */
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
				// A listener throwing is a bug in the listener, not an expected condition:
				// it keeps its subscription and keeps missing events, so whatever it
				// renders (the agent roster, a status line) silently stops tracking
				// reality. The dispatch loop still continues for the other listeners.
				logger.warn("Agent registry listener threw; it missed this event", {
					event: event.type,
					error: errorMessage(error),
				});
			}
		}
	}
}
