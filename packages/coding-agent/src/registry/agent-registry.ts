/**
 * AgentRegistry - Process-global registry of agents (the main session plus
 * every subagent), keyed by stable id.
 *
 * Tracks each agent's status and (when live) its AgentSession so peers can be
 * addressed by id (`irc`, `task resume`, `history://`). Sessions are
 * registered explicitly at creation; finished agents stay registered as
 * `idle` (live) or `parked` (session disposed, ref + sessionFile retained for
 * revival) and are only removed on explicit release/teardown.
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
 * - `running`: a turn is in flight.
 * - `idle`: live AgentSession in memory, awaiting work. Finished agents are
 *   `idle`, not removed.
 * - `parked`: session disposed; AgentRef + sessionFile retained, revivable.
 * - `aborted`: hard-killed, terminal.
 */
export type AgentStatus = "running" | "idle" | "parked" | "aborted";
/**
 * - `main`/`sub`: the user-facing agent tree (driving agent + task subagents).
 * - `advisor`: a passive review transcript persisted like a subagent for usage
 *   attribution and Control Center observability, but never a peer — hidden from
 *   agent-facing rosters (`irc`, `history://`) and not messageable/revivable.
 */
export type AgentKind = "main" | "sub" | "advisor";

/**
 * A tool call that has stopped and is waiting for a human to answer it.
 *
 * This exists as REAL STATE rather than a private boolean inside the approval
 * wrapper because three separate consumers have to distinguish "blocked on a
 * person" from "quiet", and each of them gets it wrong otherwise:
 *
 *   - the runtime budget, which must not spend an operator's reading time
 *     (`subagent.maxRuntimeMs` would otherwise abort an agent whose card is
 *     still on screen, which is abandonment with the prompt still visible),
 *   - the agent dashboard and rosters, which cannot today tell a blocked agent
 *     from a working one, so a stuck spawn looks like a busy spawn,
 *   - the operator's own prompt queue, which needs the attribution below to say
 *     WHO is asking and for WHAT the moment two agents ask at once.
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
	 * The conversation this agent belongs to: the SessionManager session id of
	 * the root `main` session it was spawned under.
	 *
	 * The session id rather than the transcript path, because the two disagree in
	 * both directions. A brand-new session has an id before it has ever been
	 * written to disk, so a path-keyed scope would be undefined for exactly the
	 * window in which the first subagents spawn; and `/move` rewrites the path of
	 * a conversation that never ended, which a path-keyed scope would read as a
	 * new one.
	 *
	 * The registry is process-global, but an agent roster is not. One process
	 * holds several conversations at once — `/new` and `/resume` re-root the
	 * driving session, ACP and cmux hosts register one `main` per client
	 * session, and the SDK embeds more — and without this every one of them
	 * listed every other one's subagents. Two rosters that disagree about what
	 * exists is the mild version; messaging an agent that belongs to a
	 * conversation you closed an hour ago is the real one.
	 *
	 * Undefined means "not attributable to a conversation" (a collab guest
	 * mirror, a hand-built ref in a test). Scoping treats an unknown scope on
	 * EITHER side as visible, so the filter can only ever hide an agent both
	 * sides positively agree belongs somewhere else.
	 */
	scope?: string;
	/** Short gist of what the agent is currently doing (latest intent or tool), for the work-aware roster. Display-only. */
	activity?: string;
	/** Model the agent runs on, as a `provider/id` string. Display-only; undefined when not known at registration. */
	model?: string;
	/**
	 * The agent's last message said it was waiting on another agent, so it stopped
	 * on purpose rather than simply going quiet. Read by the lifecycle manager to
	 * grant it a longer grace before a parked agent is closed for good: it is the
	 * one most likely to be messaged next, and closing it on the ordinary timer
	 * throws away exactly the peer the operator is about to need.
	 */
	waitingOnPeer?: boolean;
	/**
	 * Set while this agent has a tool call stopped at an approval prompt, cleared
	 * the moment the prompt is answered, abandoned or refused. See
	 * {@link PendingApproval}.
	 *
	 * A blocked agent is `running`, because it is mid-turn, and is therefore
	 * indistinguishable from a working one by status alone. That is the gap this
	 * closes: without it, a spawn waiting on a person and a spawn grinding through
	 * a build look identical to every consumer in the process.
	 */
	pendingApproval?: PendingApproval;
	/**
	 * Total milliseconds this agent has spent stopped at approval prompts that are
	 * now CLOSED. Undefined until it has waited at least once.
	 *
	 * Separate from {@link pendingApproval} because a live interval and a finished
	 * one answer different questions, and a consumer that reads only the live one
	 * gets the wrong number. An agent that answered three forty-second prompts and
	 * is now working has no `pendingApproval` at all, so a runtime budget reading
	 * only `since` would charge it the full two minutes of the operator's reading
	 * time. The full exclusion is this total PLUS the open interval, if any.
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
	 * Register an agent, deriving its conversation {@link AgentRef.scope} when the
	 * caller does not state one.
	 *
	 * Derivation is by LINEAGE, not by the agent's own transcript: a subagent
	 * writes its session file inside its parent's directory, so its own path
	 * names a different string for the same conversation. Taking the parent's
	 * scope makes a whole spawn tree one scope, however deep it nests.
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
	 * Record a short activity gist for the work-aware roster. Display-only and
	 * read on demand (`irc list`, peer roster), so it emits no event — keeping
	 * the per-tool-call update rate off the registry listener path (same as
	 * `attachSession`, which also bumps `lastActivity` without emitting). Only a
	 * `running` agent has current work: a heartbeat for any other status is
	 * dropped, so a late progress flush can't resurrect activity on a ref that
	 * `setStatus` just cleared. Every running heartbeat refreshes `lastActivity`
	 * — even when the gist text is unchanged — so the roster's "active … ago" and
	 * recency sort track real work, not just the last status change.
	 * The gist is normalized to one bounded line (`oneLineLabel`) so model-derived
	 * intent text can neither break the roster nor smuggle terminal escapes —
	 * every caller is safe without sanitizing at its own call site.
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
	 * Record whether the agent's last message said it was waiting on another agent.
	 *
	 * Emits nothing and does not touch `lastActivity`: this is a property OF the
	 * stop that just happened, not new activity, and bumping the timestamp would
	 * push out the very deadline the flag exists to lengthen. Set once at the end of
	 * a run, before the status flips.
	 */
	setWaitingOnPeer(id: string, waiting: boolean): void {
		const ref = this.#refs.get(id);
		if (!ref) return;
		ref.waitingOnPeer = waiting;
	}

	/**
	 * Mark this agent as stopped at an approval prompt, or clear the mark.
	 *
	 * Emits `status_changed` so a roster or dashboard repaints the moment an agent
	 * starts or stops waiting on a person: the whole point of the state is that it
	 * is VISIBLE, and a silent field would leave the dashboard showing a blocked
	 * spawn as a working one until something else happened to trigger a repaint.
	 *
	 * Does NOT touch `lastActivity`. Waiting on a human is not agent activity, and
	 * bumping the timestamp would push out deadlines that are measured from real
	 * work, which is the opposite of what {@link pendingApprovalSince} is for.
	 *
	 * Clearing an open wait BANKS its duration into {@link AgentRef.approvalWaitedMs}
	 * first. Without that, an agent that answered a prompt and went back to work
	 * reports nothing, and a budget reading only the open interval charges it every
	 * second the operator spent reading. The banking happens here rather than at the
	 * call site so no caller can forget it and silently under-credit the agent.
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
	 * When this agent began waiting on a human, or undefined if it is not waiting.
	 *
	 * The OPEN interval only. A runtime budget must exclude
	 * {@link approvalWaitedMs} as well, or it charges the agent for every prompt
	 * already answered: a budget is meant to bound the AGENT's work, not the
	 * operator's reading speed, and an agent killed while its card is on screen
	 * loses its work and leaves the operator answering a prompt for something
	 * already dead.
	 */
	pendingApprovalSince(id: string): number | undefined {
		return this.#refs.get(id)?.pendingApproval?.since;
	}

	/**
	 * Total milliseconds already banked from CLOSED approval waits; 0 if none.
	 *
	 * Compose with {@link pendingApprovalSince} for the full exclusion:
	 * `approvalWaitedMs(id) + (since === undefined ? 0 : now - since)`. Returning 0
	 * rather than undefined is deliberate: this value is only ever summed, and an
	 * undefined that a caller forgets to coalesce turns the whole exclusion into
	 * `NaN`, which compares false against every budget and silently disables it.
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
	 * Re-root this agent's conversation scope, for a driving session that has
	 * switched to a different transcript (`/new`, `/resume`, ACP load, an
	 * extension `switchSession`).
	 *
	 * Only the agent named here moves. Its former children keep the old scope on
	 * purpose: they belong to the conversation that just ended, and the caller
	 * that re-roots a session is expected to release them (see
	 * `AgentSession.#rescopeAgentRegistry`). Anything that survives the release —
	 * a ref another owner is holding — is then correctly invisible to the new
	 * conversation rather than silently inherited by it.
	 */
	rescope(id: string, scope: string | undefined): void {
		const ref = this.#refs.get(id);
		if (!ref || ref.scope === scope) return;
		ref.scope = scope;
		this.#emit({ type: "status_changed", ref });
	}

	/**
	 * Whether two conversation scopes may see each other.
	 *
	 * Deliberately permissive: an unknown scope on either side is visible. A
	 * filter that hid everything it could not attribute would empty the roster of
	 * a collab guest (whose refs are mirrored from the host and carry no local
	 * scope) and of every render-only test, which is a worse failure than the one
	 * scoping exists to fix.
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
	 * THE conversation-boundary decision, for every caller that has two agent ids
	 * and needs to know whether one may reach the other. `irc send`, `irc list`,
	 * `irc wait`'s liveness watch and the job tool's roster all route through this
	 * or through the two list methods below, which are themselves defined in terms
	 * of it.
	 *
	 * ONE owner on purpose. Those four surfaces each carried their own spelling of
	 * the same rule, and a rule expressed four times is a rule that gets fixed
	 * three times: the version that drifts is the one nobody remembers exists, and
	 * it is the one that keeps the leak open. There is now nothing left to keep in
	 * sync, and a change to the boundary is a change to this method.
	 *
	 * Advisors are excluded here rather than at each call site for the same
	 * reason. They are read-only observability transcripts, never peers, and every
	 * caller that forgot the check exposed one.
	 */
	canAddress(senderId: string, targetId: string): boolean {
		if (senderId === targetId) return false;
		const target = this.#refs.get(targetId);
		if (!target || target.kind === "advisor") return false;
		return AgentRegistry.sameScope(target.scope, this.scopeOf(senderId));
	}

	/**
	 * Peers `id` may address RIGHT NOW: alive (running | idle) and in its
	 * conversation.
	 *
	 * Flat namespace within a conversation: every other agent of the same scope
	 * is visible, at any depth. Across conversations nothing is, which is what
	 * stops `irc list` in a resumed session from offering peers that belong to
	 * the transcript it replaced.
	 */
	listVisibleTo(id: string): AgentRef[] {
		return this.list().filter(
			ref => this.canAddress(id, ref.id) && (ref.status === "running" || ref.status === "idle"),
		);
	}

	/**
	 * Peers `id` may address at all, including PARKED ones.
	 *
	 * Parked is not dead: messaging a parked peer revives it, and that is a
	 * supported flow, so the roster a model reads has to list them or the revival
	 * is unreachable. `aborted` is excluded because it is the one terminal state
	 * the bus refuses outright.
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
	 * Number of task subagents with a turn currently executing in `scope`, and,
	 * when `under` is given, below that agent in the spawn tree.
	 *
	 * Scoped because the number is a badge an operator reads as "how much work is
	 * mine right now". Counting the whole process makes a session that spawned
	 * nothing report three running spawns, and there is no row anywhere in that
	 * conversation's UI that accounts for them. An omitted scope counts
	 * everything, for a caller with no conversation to name (a collab guest's
	 * mirrored registry).
	 *
	 * `under` is the same argument one level down: while the view is focused on
	 * an agent, "mine" is that agent's subtree, and the surfaces beside the badge
	 * (the subagent HUD) already scope themselves that way.
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
	 * Every agent below `id` in the spawn tree, nearest first, excluding `id`.
	 *
	 * The registry owns `parentId`, so it owns the walk: a caller that needs "this
	 * agent and everything it spawned" — tearing a session down without leaving a
	 * grandchild running work nobody will ever collect — must not re-derive the
	 * relationship from the flat list.
	 *
	 * Cycle-safe. A parent id is only ever written at registration, so a cycle
	 * should be impossible, but a visited set costs nothing and a teardown path is
	 * the worst place to hang.
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
