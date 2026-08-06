/**
 * AgentLifecycleManager - Owns the idle → parked → revived lifecycle of
 * adopted subagents.
 *
 * The task executor hands a finished agent over via {@link AgentLifecycleManager.adopt};
 * from then on the manager arms a TTL timer whenever the agent goes `idle`,
 * parks it on expiry (disposes the live session, keeps the AgentRef +
 * sessionFile), and revives it on demand through
 * {@link AgentLifecycleManager.ensureLive}. Only this manager flips
 * `parked` ↔ `idle`.
 */

import { clamp, logger } from "@veyyon/utils";
import type { AgentSession } from "../session/agent-session";
import { type AgentRef, AgentRegistry, MAIN_AGENT_ID, type RegistryEvent } from "./agent-registry";

export type AgentReviver = () => Promise<AgentSession>;

/**
 * Builds a reviver for a `parked` ref restored from disk (the persisted-subagent scan,
 * collab mirror, resumed process) that carries a sessionFile but no in-memory
 * adoption. Returns undefined when the ref cannot be faithfully rebuilt (no
 * persisted session contract, or its workspace is gone). Injected from the
 * top-level session so this manager stays free of sdk/SessionManager imports.
 */
export type PersistedSubagentReviverFactory = (ref: AgentRef) => Promise<AgentReviver | undefined>;
export type PersistedSubagentIdleTtlResolver = (ref: AgentRef) => number;

/**
 * Close budgets for a ref the manager adopts on demand rather than at hand-over.
 *
 * A cold-revived ref used to be adopted with both budgets at zero, so it parked on its
 * idle TTL and then stayed listed for the rest of the session whatever the operator had
 * set. Resume a session, message a few old agents, and the roster grew monotonically,
 * which is the one thing the close stage exists to prevent. The budgets travel through
 * the same injected seam as the idle TTL because the reason they were missing was
 * plumbing rather than policy.
 */
export interface PersistedSubagentCloseBudget {
	parkedMs: number;
	waitingMs: number;
}
export type PersistedSubagentCloseBudgetResolver = (ref: AgentRef) => PersistedSubagentCloseBudget;

export interface AdoptOptions {
	/** TTL before an idle agent is parked. <= 0 disables parking. */
	idleTtlMs: number;
	/**
	 * TTL before a PARKED agent is closed for good, counted from the park. <= 0
	 * keeps it listed and revivable until exit, which is the operator's off switch.
	 */
	closeParkedMs?: number;
	/**
	 * The same budget for an agent whose last message said it was waiting on another
	 * agent (see {@link AgentRef.waitingOnPeer}). Defaults to `closeParkedMs`.
	 */
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

/**
 * Arm the next deadline. `deadline` and `stage` are only ever written together,
 * because a deadline the expiry cannot classify is worse than no deadline: it stays in
 * the map, already in the past, so the scheduler keeps selecting it as the next wake
 * with a zero delay and spins instead of failing once. Writing both through one
 * function is what keeps that pair from drifting.
 */
function arm(adopted: AdoptedAgent, at: number, stage: "park" | "close"): void {
	adopted.deadline = at;
	adopted.stage = stage;
}

/** Drop any pending deadline, clearing its stage with it. See {@link arm}. */
function disarm(adopted: AdoptedAgent): void {
	adopted.deadline = undefined;
	adopted.stage = undefined;
}

/**
 * Normalize a pair of close budgets. Shared by {@link AgentLifecycleManager.adopt} and the
 * cold-adopt path so there is ONE place that decides what zero means.
 *
 * A zero quiet budget means "never close", and that has to include the waiting case:
 * honouring a waiting budget beside it would close exactly the agents most likely to be
 * needed while leaving every ordinary one listed, which inverts the switch instead of
 * disabling it. The waiting budget is also never shorter than the quiet one, because an
 * agent that stopped to let a peer finish has not run out of things to do.
 */
function normalizeCloseBudgets(
	parkedMs: number | undefined,
	waitingMs: number | undefined,
): PersistedSubagentCloseBudget {
	const parked = Math.max(0, parkedMs ?? 0);
	return { parkedMs: parked, waitingMs: parked === 0 ? 0 : Math.max(parked, waitingMs ?? parked) };
}

/**
 * How long {@link AgentLifecycleManager.close} waits before re-checking an agent
 * whose revive was still in flight when its close budget expired.
 *
 * A fixed step, deliberately not derived from the close budget: the question it
 * answers is "has the wake finished yet", which has nothing to do with how long
 * the agent was allowed to sit parked.
 */
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
	/**
	 * Close budgets applied when a cold-revived ref is adopted on demand.
	 *
	 * Defaults to zero so a host that installs a factory without them keeps the old
	 * never-close behaviour rather than silently acquiring a close stage it did not ask
	 * for. The non-ACP bootstrap passes the operator's resolved budgets.
	 */
	#persistedReviveCloseBudget: PersistedSubagentCloseBudget | PersistedSubagentCloseBudgetResolver = {
		parkedMs: 0,
		waitingMs: 0,
	};

	constructor(registry: AgentRegistry = AgentRegistry.global()) {
		this.#registry = registry;
		this.#unsubscribe = registry.onChange(event => this.#onRegistryEvent(event));
	}

	/**
	 * Install the factory used to cold-revive `parked` refs restored from disk
	 * (the persisted-subagent scan, collab mirror, resumed process) — they carry a sessionFile
	 * but no adoption. Set by the top-level session, which owns the ambient deps
	 * (auth, models, MCP, artifacts) the factory needs at revive time.
	 */
	setPersistedSubagentReviverFactory(
		factory: PersistedSubagentReviverFactory,
		idleTtl: number | PersistedSubagentIdleTtlResolver,
		closeBudget: PersistedSubagentCloseBudget | PersistedSubagentCloseBudgetResolver = { parkedMs: 0, waitingMs: 0 },
	): void {
		this.#persistedReviverFactory = factory;
		this.#persistedReviveTtl = idleTtl;
		this.#persistedReviveCloseBudget = closeBudget;
	}

	/**
	 * Take ownership of a finished subagent. Caller has already set registry
	 * status to "idle". Arms the TTL timer (idleTtlMs <= 0 adopts without one).
	 *
	 * Two stages, one timer. An idle agent is parked when `idleTtlMs` elapses, which
	 * releases its session and keeps its transcript; a parked agent is closed when
	 * its close budget elapses, which drops the ref so a long session stops
	 * accumulating finished agents in every roster. Either budget at or below zero
	 * disables its stage.
	 */
	adopt(id: string, opts: AdoptOptions): void {
		if (id === MAIN_AGENT_ID) return;
		if (!this.#registry.get(id)) {
			logger.warn("AgentLifecycleManager.adopt: unknown agent id", { id });
			return;
		}
		// A zero quiet budget means "never close", and that has to include the waiting
		// case: honouring a waiting budget beside it would close exactly the agents most
		// likely to be needed while leaving every ordinary one listed, which inverts the
		// switch instead of disabling it. Normalized here rather than trusted from the
		// caller so the invariant holds for every adoption, not just the settings path.
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

	/**
	 * Persist the live idle session, dispose only its live resources, detach it,
	 * and mark the agent `parked`. Running agents are never parked. No-op unless
	 * the id is adopted, idle, and live.
	 */
	async park(id: string): Promise<void> {
		const adopted = this.#adopted.get(id);
		if (!adopted || this.#parking.has(id)) return;
		const ref = this.#registry.get(id);
		const session = ref?.status === "idle" ? ref.session : null;
		// Parkability is decided BEFORE the deadline is touched. Disarming first meant
		// that a park() on an agent that is not parkable (already `parked`, running,
		// detached) wiped its armed deadline and returned without re-arming, and
		// `parked` is a stable state, so no later `status_changed` would ever re-derive
		// one: the agent stayed listed forever. The disarm belongs to the park that
		// actually happens.
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
					error: String(error),
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
				logger.warn("AgentLifecycleManager.park: session dispose failed", { id, error: String(error) });
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

	/**
	 * Return the live session, reviving from the sessionFile if parked.
	 * Throws a plain Error if the id is unknown, aborted, or parked without a
	 * reviver. Concurrent calls share one in-flight revive.
	 */
	async ensureLive(id: string): Promise<AgentSession> {
		const ref = this.#registry.get(id);
		if (!ref) {
			throw new Error(
				`Unknown agent "${id}" — it was never registered or has been released. If a transcript exists, read history://${id}.`,
			);
		}
		// `aborted` is terminal, and it is checked BEFORE the session because the two
		// disagree for as long as the kill takes. The abort path flips the status and
		// then awaits `dispose()` under a five-second deadline, so during that window
		// the ref reads `aborted` while still holding the session being torn down.
		// Trusting `ref.session` there hands a wake a dying session instead of refusing,
		// and a wake arriving one moment after a failure is the likeliest wake there is.
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

	/**
	 * Resolve a reviver and bring the agent back to a live session. A ref
	 * restored from disk is `parked` with a sessionFile but no in-memory
	 * adoption; build a reviver via the injected persisted-subagent factory and
	 * adopt it so the agent rejoins the normal idle↔parked lifecycle. Throws
	 * when the agent is not revivable or no reviver can be produced.
	 */
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
				// A cold-revived ref carries the operator's CURRENT close budgets, injected
				// beside the idle TTL. It used to carry zeros, which meant a ref restored from
				// disk and woken once was never closed again, so a resumed session accumulated
				// every agent it ever revived. The close budget counts from `lastActivity`, and
				// the revive below bumps that through `setStatus(id, "idle")`, so a just-woken
				// agent gets a FULL budget from the wake rather than being dropped for having
				// been parked a long time.
				const budget =
					typeof this.#persistedReviveCloseBudget === "function"
						? this.#persistedReviveCloseBudget(ref)
						: this.#persistedReviveCloseBudget;
				const { parkedMs, waitingMs } = normalizeCloseBudgets(budget.parkedMs, budget.waitingMs);
				this.#adopted.set(id, { idleTtlMs, closeParkedMs: parkedMs, closeWaitingMs: waitingMs, revive });
				coldAdopted = true;
			}
		}
		// Every exit from the cold-adopt region is compensated, not just the one the
		// revive throws from. The status re-check below used to sit OUTSIDE this try, so
		// a ref whose status changed during the `await` on the factory (abort,
		// release-and-reregister, collab mirror update) threw past the compensation and
		// left a reviver built from a STALE ref in #adopted with no deadline armed:
		// every later ensureLive then prefers that over rebuilding via the factory.
		// Guarding the whole region means a fourth exit path added later is covered by
		// construction rather than by remembering this comment.
		try {
			if (ref.status !== "parked" || !revive) {
				throw new Error(
					`Agent "${id}" is ${ref.status} and cannot be revived${revive ? "" : " (no reviver registered)"}. Its transcript remains readable at history://${id}.`,
				);
			}
			return await this.#revive(id, revive, ref.sessionFile);
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
				logger.warn("AgentLifecycleManager.release: session dispose failed", { id, error: String(error) });
			}
		}
		this.#registry.unregister(id);
	}

	/**
	 * Kill an agent: abort the turn it is in the middle of, then release it.
	 *
	 * The order matters. Releasing a running session disposes it with a provider
	 * request still in flight and nothing left to receive the answer, so the
	 * abort has to land first. A parked or idle agent has no turn to abort and
	 * goes straight to release.
	 *
	 * Shared rather than reimplemented per caller: the dashboard's `x` key and
	 * the `job` tool's `cancel` are the same operation reached two ways, and the
	 * abort-then-release ordering is exactly the kind of detail a second copy
	 * gets wrong. The transcript survives at `history://<id>`; what is destroyed
	 * is the live agent, not the record of what it did.
	 *
	 * A throwing abort propagates and the release does NOT run. That looks like
	 * the wrong call for a method whose purpose is to guarantee a kill, and it is
	 * deliberate: a session that cannot abort is a session whose provider request
	 * cannot be stopped, and disposing it anyway is the exact "response lands on
	 * nothing" the ordering exists to prevent. The caller surfaces the failure to
	 * whoever asked, which is the only thing that turns it into something a human
	 * can act on.
	 */
	async terminate(id: string, reason: string): Promise<void> {
		const ref = this.#registry.get(id);
		if (ref?.status === "running" && ref.session) {
			await ref.session.abort({ reason });
		}
		await this.release(id);
	}

	/**
	 * Close a parked agent for good: drop the ref so it stops appearing in rosters
	 * and can no longer be revived by messaging it.
	 *
	 * Only a `parked` agent is closed. An agent that was revived, or that a
	 * follow-up turn is driving, is `idle` or `running` by the time this runs and is
	 * left alone. The close deadline was set when it parked and a status change
	 * re-derives it, but this second check makes the ordering irrelevant.
	 *
	 * A revive already IN FLIGHT is the third case, and status alone cannot see it: a
	 * reviving agent is still `parked` until its rebuilt session is attached, so
	 * closing on that window would unregister the ref while someone is waking the
	 * agent. `ensureLive` records the revive in `#revivals` before it yields, so this
	 * check observes every wake that could interleave with the timer.
	 *
	 * That third case is also the one `#refreshDeadline` cannot serve, and re-deriving
	 * through it was a zero-delay spin. The ref is still `parked`, so the derivation
	 * produces `lastActivity + closeBudget` again, and that instant is already in the
	 * past by definition: it is what fired this call. The scheduler then wakes on a
	 * zero delay, close refuses again, and the pair runs flat out for as long as the
	 * revive takes (transcript replay, MCP, auth: seconds), starving the event loop
	 * that the revive itself is waiting on. Counting the re-check from NOW keeps
	 * exactly one pending wake. It is also the only thing that re-examines an agent
	 * whose revive THREW: that leaves the ref `parked` with no status change, so
	 * nothing else would ever derive a deadline for it again.
	 *
	 * Its transcript is untouched and stays readable through `history://`, which is
	 * what makes closing safe: what is dropped is the live reference and the ability
	 * to wake it, not the record of what it did.
	 */
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
		const ids = [...this.#adopted.keys()];
		await Promise.all(ids.map(id => this.release(id)));
		this.#revivals.clear();
		this.#parking.clear();
		this.#persistedReviverFactory = undefined;
	}

	/**
	 * Attach a freshly rebuilt session to its ref.
	 *
	 * The ref is re-read AFTER the rebuild because `revive()` is slow (transcript
	 * replay, MCP, auth) and anything may have released the id meanwhile: process
	 * teardown, an explicit release, an abort. `attachSession` and `setStatus` both
	 * no-op on an unknown id, so without this check the caller would receive a live
	 * session that no registry entry owns and nothing will ever dispose. Fail loudly
	 * and dispose it here instead.
	 *
	 * `aborted` is the second half of that check and it is refused for the same
	 * reason, mirroring the in-flight-revive guard in {@link close}. A kill flips the
	 * status and then disposes `ref.session`, which is already null for a `parked`
	 * ref, so the abort disposes nothing; attaching here afterwards would resurrect a
	 * terminal agent with a live session no teardown path will ever reach. Refusing
	 * costs one condition and the wake is refused the same way {@link ensureLive}
	 * refuses one that arrives a moment later.
	 */
	async #revive(id: string, revive: AgentReviver, sessionFile: string | null): Promise<AgentSession> {
		const session = await revive();
		const current = this.#registry.get(id);
		if (!current || current.status === "aborted") {
			try {
				await session.dispose();
			} catch (error) {
				logger.warn("AgentLifecycleManager.revive: disposing an orphaned revive failed", {
					id,
					error: String(error),
				});
			}
			throw new Error(
				current
					? `Agent "${id}" was terminated while it was being revived. Its transcript remains readable at history://${id}.`
					: `Agent "${id}" was released while it was being revived. Its transcript remains readable at history://${id}.`,
			);
		}
		this.#registry.attachSession(id, session, sessionFile);
		// Emits status_changed → "idle", which re-arms the TTL timer below.
		this.#registry.setStatus(id, "idle");
		return session;
	}

	/**
	 * Set the next deadline for whichever stage the agent is in.
	 *
	 * `idle` counts toward the park, `parked` toward the close. Both count from
	 * `lastActivity`, which `setStatus` bumps on every transition, so a parked
	 * agent's close budget starts at the park and a revived agent's park budget
	 * starts again from the revival. A waiting agent gets its own budget, because it
	 * stopped to let a peer finish rather than because it ran out of things to do.
	 * Every other status (`running`, `aborted`) carries no deadline at all.
	 */
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
				// Clear before deciding. A due deadline left in place is one `#scheduleNext`
				// immediately re-reads as the next wake, and since it is already in the past
				// the delay is zero, so an entry nothing can act on would spin the scheduler
				// forever instead of failing once. Re-derive it from the ref instead.
				disarm(adopted);
				if (stage === undefined) {
					this.#refreshDeadline(id, adopted);
					continue;
				}
				due.push({ id, stage });
			}
			this.#scheduleNext();
			// Expiries are drained in order so a large idle cohort cannot trigger
			// an unbounded burst of persistence and process teardown work. That
			// serialization is also what makes a captured stage go stale: while an
			// earlier agent's flush is in flight, a later one can be woken, run a turn
			// and go idle again.
			void (async () => {
				for (const { id, stage } of due) {
					const adopted = this.#adopted.get(id);
					// Every due entry was disarmed above, so a deadline here means something
					// re-derived one during the drain: a status change, or a re-adoption. That
					// fresh deadline describes the agent as it is now, while the captured stage
					// describes it as it was before the drain started, so the stage is dropped
					// rather than applied. No action is lost; the scheduler already holds the
					// newer one.
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
