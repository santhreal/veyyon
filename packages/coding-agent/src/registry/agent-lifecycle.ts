/** AgentLifecycleManager - Owns the idle → parked → revived lifecycle of adopted subagents. */

import { clamp, errorMessage, logger } from "@veyyon/utils";
import type { AgentSession } from "../session/agent-session";
import { type AgentRef, AgentRegistry, MAIN_AGENT_ID, type RegistryEvent } from "./agent-registry";

export type AgentReviver = () => Promise<AgentSession>;

/** Builds a reviver for a `parked` ref restored from disk (the persisted-subagent scan, collab mirror, resumed process) that carries a sessionFile but no in-memory */
export type PersistedSubagentReviverFactory = (ref: AgentRef) => Promise<AgentReviver | undefined>;
export type PersistedSubagentIdleTtlResolver = (ref: AgentRef) => number;

/** Close budgets for a ref the manager adopts on demand rather than at hand-over. A cold-revived ref used to be adopted with both budgets at zero, so it parked on its */
export interface PersistedSubagentCloseBudget {
	parkedMs: number;
	waitingMs: number;
}
export type PersistedSubagentCloseBudgetResolver = (ref: AgentRef) => PersistedSubagentCloseBudget;

export interface AdoptOptions {
	/** TTL before an idle agent is parked. <= 0 disables parking. */
	idleTtlMs: number;
	/** TTL before a PARKED agent is closed for good, counted from the park. <= 0 keeps it listed and revivable until exit, which is the operator's off switch. */
	closeParkedMs?: number;
	/** The same budget for an agent whose last message said it was waiting on another agent (see {@link AgentRef.waitingOnPeer}). Defaults to `closeParkedMs`. */
	closeWaitingMs?: number;
	/** Recreates a live AgentSession from the ref's sessionFile. Absent => not resumable after park (e.g. isolated runs). */
	revive?: AgentReviver;
}

interface AdoptedAgent {
	idleTtlMs: number;
	closeParkedMs: number;
	closeWaitingMs: number;
	revive?: AgentReviver;
	deadline?: number;
	/** Which stage `deadline` belongs to, so the timer knows what to do when it fires. */
	stage?: "park" | "close";
}

/** Arm the next deadline. `deadline` and `stage` are only ever written together, because a deadline the expiry cannot classify is worse than no deadline: it stays in */
function arm(adopted: AdoptedAgent, at: number, stage: "park" | "close"): void {
	adopted.deadline = at;
	adopted.stage = stage;
}

/** Drop any pending deadline, clearing its stage with it. See {@link arm}. */
function disarm(adopted: AdoptedAgent): void {
	adopted.deadline = undefined;
	adopted.stage = undefined;
}

/** Normalize a pair of close budgets. Shared by {@link AgentLifecycleManager.adopt} and the cold-adopt path so there is ONE place that decides what zero means. */
function normalizeCloseBudgets(
	parkedMs: number | undefined,
	waitingMs: number | undefined,
): PersistedSubagentCloseBudget {
	const parked = Math.max(0, parkedMs ?? 0);
	return { parkedMs: parked, waitingMs: parked === 0 ? 0 : Math.max(parked, waitingMs ?? parked) };
}

/** How long {@link AgentLifecycleManager.close} waits before re-checking an agent whose revive was still in flight when its close budget expired. */
const REVIVE_RECHECK_MS = 1_000;

export class AgentLifecycleManager {
	static #global: AgentLifecycleManager | undefined;

	static global(): AgentLifecycleManager {
		if (!AgentLifecycleManager.#global) {
			AgentLifecycleManager.#global = new AgentLifecycleManager();
		}
		return AgentLifecycleManager.#global;
	}

	/** Reset the global manager. Test-only. */
	static resetGlobalForTests(): void {
		const current = AgentLifecycleManager.#global;
		if (current) {
			current.#unsubscribe?.();
			current.#unsubscribe = undefined;
			current.#clearTimer();
			current.#adopted.clear();
			current.#revivals.clear();
			current.#parking.clear();
			current.#persistedReviverFactory = undefined;
		}
		AgentLifecycleManager.#global = undefined;
	}

	readonly #registry: AgentRegistry;
	readonly #adopted = new Map<string, AdoptedAgent>();
	/** Ids whose session is being disposed by {@link park} right now. */
	readonly #parking = new Set<string>();
	/** In-flight revives, so concurrent {@link ensureLive} calls coalesce. */
	readonly #revivals = new Map<string, Promise<AgentSession>>();
	#unsubscribe: (() => void) | undefined;
	#persistedReviverFactory: PersistedSubagentReviverFactory | undefined;
	/** One process-wide next-deadline timer; never one poller/timer per agent. */
	#timer: NodeJS.Timeout | undefined;
	/** TTL policy applied when a cold-revived ref is adopted on demand. */
	#persistedReviveTtl: number | PersistedSubagentIdleTtlResolver = 0;
	/** Close budgets applied when a cold-revived ref is adopted on demand. Defaults to zero so a host that installs a factory without them keeps the old */
	#persistedReviveCloseBudget: PersistedSubagentCloseBudget | PersistedSubagentCloseBudgetResolver = {
		parkedMs: 0,
		waitingMs: 0,
	};

	constructor(registry: AgentRegistry = AgentRegistry.global()) {
		this.#registry = registry;
		this.#unsubscribe = registry.onChange(event => this.#onRegistryEvent(event));
	}

	/** Install the factory used to cold-revive `parked` refs restored from disk (the persisted-subagent scan, collab mirror, resumed process) — they carry a sessionFile */
	setPersistedSubagentReviverFactory(
		factory: PersistedSubagentReviverFactory,
		idleTtl: number | PersistedSubagentIdleTtlResolver,
		closeBudget: PersistedSubagentCloseBudget | PersistedSubagentCloseBudgetResolver = { parkedMs: 0, waitingMs: 0 },
	): void {
		this.#persistedReviverFactory = factory;
		this.#persistedReviveTtl = idleTtl;
		this.#persistedReviveCloseBudget = closeBudget;
	}

	/** Take ownership of a finished subagent. Caller has already set registry status to "idle". Arms the TTL timer (idleTtlMs <= 0 adopts without one). */
	adopt(id: string, opts: AdoptOptions): void {
		// The bare alias names whichever agent drives the asking conversation, and
		// a driving agent is never adopted: there is no owner to hand it to.
		if (id === MAIN_AGENT_ID) return;
		const ref = this.#registry.get(id);
		if (!ref) {
			logger.warn("AgentLifecycleManager.adopt: unknown agent id", { id });
			return;
		}
		// Recognized by role rather than by name: a driving agent's id is derived
		// from the conversation it drives, so there is no one id to compare with.
		if (ref.kind === "main") return;
		// A zero quiet budget means "never close", and that has to include the waiting case: honouring a waiting budget beside it would close exactly the agents most
		const { parkedMs: closeParkedMs, waitingMs: closeWaitingMs } = normalizeCloseBudgets(
			opts.closeParkedMs,
			opts.closeWaitingMs,
		);
		const adopted: AdoptedAgent = {
			idleTtlMs: opts.idleTtlMs,
			closeParkedMs,
			closeWaitingMs,
			revive: opts.revive,
		};
		this.#adopted.set(id, adopted);
		this.#refreshDeadline(id, adopted);
		this.#scheduleNext();
	}

	/** True if the id is adopted (parked or live). */
	has(id: string): boolean {
		return this.#adopted.has(id);
	}

	/** True while {@link park} is disposing this agent's session (lets dispose hooks distinguish park from teardown). */
	isParking(id: string): boolean {
		return this.#parking.has(id);
	}

	/** Persist the live idle session, dispose only its live resources, detach it, and mark the agent `parked`. Running agents are never parked. No-op unless */
	async park(id: string): Promise<void> {
		const adopted = this.#adopted.get(id);
		if (!adopted || this.#parking.has(id)) return;
		const ref = this.#registry.get(id);
		const session = ref?.status === "idle" ? ref.session : null;
		// Parkability is decided BEFORE the deadline is touched. Disarming first meant that a park() on an agent that is not parkable (already `parked`, running,
		if (!ref || !session) return;
		disarm(adopted);
		this.#scheduleNext();

		this.#parking.add(id);
		let parked = false;
		try {
			try {
				await session.sessionManager.flush();
			} catch (error) {
				logger.warn("AgentLifecycleManager.park: session flush failed; keeping agent live", {
					id,
					error: errorMessage(error),
				});
				return;
			}
			// A follow-up may have started while the durable flush was in flight.
			// Re-check both identity and status before closing any live resources.
			const current = this.#registry.get(id);
			if (current?.status !== "idle" || current.session !== session) return;
			try {
				await session.dispose();
			} catch (error) {
				logger.warn("AgentLifecycleManager.park: session dispose failed", { id, error: errorMessage(error) });
			}
			this.#registry.detachSession(id);
			this.#registry.setStatus(id, "parked");
			parked = true;
		} finally {
			this.#parking.delete(id);
			if (!parked) {
				const current = this.#registry.get(id);
				const currentAdoption = this.#adopted.get(id);
				if (current?.status === "idle" && current.session && currentAdoption && currentAdoption.idleTtlMs > 0) {
					// Re-armed through `arm` so the stage travels with it: the expiry that fired
					// this park cleared both, and a deadline it cannot classify is one it cannot
					// act on.
					arm(currentAdoption, Date.now() + currentAdoption.idleTtlMs, "park");
				}
			}
			this.#scheduleNext();
		}
	}

	/** Return the live session, reviving from the sessionFile if parked. Throws a plain Error if the id is unknown, aborted, or parked without a */
	async ensureLive(id: string): Promise<AgentSession> {
		const ref = this.#registry.get(id);
		if (!ref) {
			throw new Error(
				`Unknown agent "${id}" — it was never registered or has been released. If a transcript exists, read history://${id}.`,
			);
		}
		// `aborted` is terminal, and it is checked BEFORE the session because the two disagree for as long as the kill takes. The abort path flips the status and
		if (ref.status === "aborted") {
			throw new Error(
				`Agent "${id}" was terminated and cannot be revived. Its transcript remains readable at history://${id}.`,
			);
		}
		if (ref.session) return ref.session;
		const inflight = this.#revivals.get(id);
		if (inflight) return inflight;
		const revival = this.#resolveAndRevive(id, ref);
		this.#revivals.set(id, revival);
		try {
			return await revival;
		} finally {
			this.#revivals.delete(id);
		}
	}

	/** Resolve a reviver and bring the agent back to a live session. A ref restored from disk is `parked` with a sessionFile but no in-memory */
	async #resolveAndRevive(id: string, ref: AgentRef): Promise<AgentSession> {
		let revive = this.#adopted.get(id)?.revive;
		let coldAdopted = false;
		if (!revive && ref.status === "parked" && ref.sessionFile && this.#persistedReviverFactory) {
			revive = await this.#persistedReviverFactory(ref);
			if (revive) {
				const idleTtlMs =
					typeof this.#persistedReviveTtl === "function"
						? this.#persistedReviveTtl(ref)
						: this.#persistedReviveTtl;
				// A cold-revived ref carries the operator's CURRENT close budgets, injected beside the idle TTL. It used to carry zeros, which meant a ref restored from
				const budget =
					typeof this.#persistedReviveCloseBudget === "function"
						? this.#persistedReviveCloseBudget(ref)
						: this.#persistedReviveCloseBudget;
				const { parkedMs, waitingMs } = normalizeCloseBudgets(budget.parkedMs, budget.waitingMs);
				this.#adopted.set(id, { idleTtlMs, closeParkedMs: parkedMs, closeWaitingMs: waitingMs, revive });
				coldAdopted = true;
			}
		}
		// Every exit from the cold-adopt region is compensated, not just the one the revive throws from. The status re-check below used to sit OUTSIDE this try, so
		try {
			if (ref.status !== "parked" || !revive) {
				throw new Error(
					`Agent "${id}" is ${ref.status} and cannot be revived${revive ? "" : " (no reviver registered)"}. Its transcript remains readable at history://${id}.`,
				);
			}
			return await this.#revive(id, revive, ref);
		} catch (error) {
			// A failed cold revive (stale ctx, missing cwd, bad MCP) must not leave a
			// poisoned reviver stuck in #adopted — drop it so a later ensureLive
			// rebuilds via the factory (which may have fresher context by then).
			if (coldAdopted) this.#adopted.delete(id);
			throw error;
		}
	}

	/** Hard removal: dispose if live, unregister from registry, drop deadlines. */
	async release(id: string): Promise<void> {
		const adopted = this.#adopted.get(id);
		if (adopted) disarm(adopted);
		this.#adopted.delete(id);
		this.#scheduleNext();
		const ref = this.#registry.get(id);
		if (ref?.session) {
			try {
				await ref.session.dispose();
			} catch (error) {
				logger.warn("AgentLifecycleManager.release: session dispose failed", { id, error: errorMessage(error) });
			}
		}
		this.#registry.unregister(id);
	}

	/** Kill an agent and everything it spawned: abort the turn each one is in the middle of, then release it. */
	async terminate(id: string, reason: string): Promise<void> {
		// Snapshotted before anything is unregistered: the walk reads live `parentId` links, and releasing as we go would cut the tree from under it.
		for (const descendant of this.#registry.descendantsOf(id).reverse()) {
			await this.#terminateOne(descendant, reason);
		}
		await this.#terminateOne(id, reason);
	}

	async #terminateOne(id: string, reason: string): Promise<void> {
		const ref = this.#registry.get(id);
		if (ref?.status === "running" && ref.session) {
			await ref.session.abort({ reason });
		}
		await this.release(id);
	}

	/** Close a parked agent for good: drop the ref so it stops appearing in rosters and can no longer be revived by messaging it. */
	async close(id: string): Promise<void> {
		const ref = this.#registry.get(id);
		const reviving = this.#revivals.has(id);
		if (ref?.status !== "parked" || reviving) {
			const adopted = this.#adopted.get(id);
			if (adopted) {
				if (reviving) arm(adopted, Date.now() + REVIVE_RECHECK_MS, "close");
				else this.#refreshDeadline(id, adopted);
				this.#scheduleNext();
			}
			return;
		}
		logger.debug("AgentLifecycleManager.close: dropping parked agent", {
			id,
			waitingOnPeer: ref.waitingOnPeer === true,
			parkedForMs: Date.now() - ref.lastActivity,
		});
		await this.release(id);
	}

	/** Teardown everything (process exit / main session dispose). */
	async dispose(): Promise<void> {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#clearTimer();
		const ids = Array.from(this.#adopted.keys());
		await Promise.all(ids.map(id => this.release(id)));
		this.#revivals.clear();
		this.#parking.clear();
		this.#persistedReviverFactory = undefined;
	}

	/** Attach a freshly rebuilt session to its ref. The ref is re-read AFTER the rebuild because `revive()` is slow (transcript */
	async #revive(id: string, revive: AgentReviver, expectedRef: AgentRef): Promise<AgentSession> {
		const session = await revive();
		const current = this.#registry.get(id);
		if (!current || (current !== expectedRef && current.session !== session) || current.status === "aborted") {
			try {
				await session.dispose();
			} catch (error) {
				logger.warn("AgentLifecycleManager.revive: disposing an orphaned revive failed", {
					id,
					error: errorMessage(error),
				});
			}
			throw new Error(
				current?.status === "aborted"
					? `Agent "${id}" was terminated while it was being revived. Its transcript remains readable at history://${id}.`
					: current
						? `Agent "${id}" was replaced while it was being revived. Its transcript remains readable at history://${id}.`
						: `Agent "${id}" was released while it was being revived. Its transcript remains readable at history://${id}.`,
			);
		}
		this.#registry.attachSession(id, session, expectedRef.sessionFile);
		// Emits status_changed → "idle", which re-arms the TTL timer below.
		this.#registry.setStatus(id, "idle");
		return session;
	}

	/** Set the next deadline for whichever stage the agent is in. `idle` counts toward the park, `parked` toward the close. Both count from */
	#refreshDeadline(id: string, adopted: AdoptedAgent): void {
		const ref = this.#registry.get(id);
		if (ref?.status === "idle" && adopted.idleTtlMs > 0) {
			arm(adopted, ref.lastActivity + adopted.idleTtlMs, "park");
			return;
		}
		if (ref?.status === "parked") {
			const budget = ref.waitingOnPeer === true ? adopted.closeWaitingMs : adopted.closeParkedMs;
			if (budget > 0) {
				arm(adopted, ref.lastActivity + budget, "close");
				return;
			}
		}
		disarm(adopted);
	}

	#clearTimer(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	#scheduleNext(): void {
		this.#clearTimer();
		let nextDeadline = Number.POSITIVE_INFINITY;
		for (const adopted of this.#adopted.values()) {
			if (adopted.deadline !== undefined) nextDeadline = Math.min(nextDeadline, adopted.deadline);
		}
		if (!Number.isFinite(nextDeadline)) return;
		// Node clamps larger delays to 1 ms. Bound the single scheduler delay and
		// re-evaluate later instead of accidentally expiring a long-lived cache.
		const delay = clamp(nextDeadline - Date.now(), 0, 2_147_483_647);
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			const now = Date.now();
			// Stage is captured with the id: the expiry decides what to do, and reading
			// it later could see a stage rewritten by a status change in between.
			const due: Array<{ id: string; stage: "park" | "close" }> = [];
			for (const [id, adopted] of this.#adopted) {
				if (adopted.deadline === undefined || adopted.deadline > now) continue;
				const stage = adopted.stage;
				// Clear before deciding. A due deadline left in place is one `#scheduleNext` immediately re-reads as the next wake, and since it is already in the past
				disarm(adopted);
				if (stage === undefined) {
					this.#refreshDeadline(id, adopted);
					continue;
				}
				due.push({ id, stage });
			}
			this.#scheduleNext();
			// Expiries are drained in order so a large idle cohort cannot trigger an unbounded burst of persistence and process teardown work. That
			void (async () => {
				for (const { id, stage } of due) {
					const adopted = this.#adopted.get(id);
					// Every due entry was disarmed above, so a deadline here means something re-derived one during the drain: a status change, or a re-adoption. That
					if (!adopted || adopted.deadline !== undefined) continue;
					if (stage === "park") await this.park(id);
					else await this.close(id);
				}
			})();
		}, delay);
		this.#timer.unref?.();
	}

	#onRegistryEvent(event: RegistryEvent): void {
		const adopted = this.#adopted.get(event.ref.id);
		if (!adopted) return;
		if (event.type === "removed") {
			this.#adopted.delete(event.ref.id);
			this.#scheduleNext();
			return;
		}
		if (event.type !== "status_changed") return;
		this.#refreshDeadline(event.ref.id, adopted);
		this.#scheduleNext();
	}
}
