/**
 * AgentLifecycleManager - Owns the idle → asleep → awake lifecycle of adopted
 * spawned agents.
 *
 * The task executor hands a finished agent over via {@link AgentLifecycleManager.adopt};
 * from then on the manager arms a TTL timer whenever the agent goes `idle`, puts
 * it to sleep on expiry (disposes the live session, keeps the AgentRef +
 * sessionFile), and wakes it on demand through {@link AgentLifecycleManager.ensureLive}.
 * A stopped agent falls asleep the same way through
 * {@link AgentLifecycleManager.fallAsleep}. Nothing here drops an agent for being
 * asleep: only the end of its conversation or the process removes one.
 */

import { clamp, errorMessage, logger } from "@veyyon/utils";
import type { AgentSession } from "../session/agent-session";
import { hasRunningJobsUnder } from "../session/runtime/owned-async-jobs";
import { type AgentRef, AgentRegistry, MAIN_AGENT_ID, type RegistryEvent } from "./agent-registry";

export type AgentReviver = () => Promise<AgentSession>;

/**
 * Builds a reviver for an `asleep` ref restored from disk (the persisted-agent scan,
 * collab mirror, resumed process) that carries a sessionFile but no in-memory
 * adoption. Returns undefined when the ref cannot be faithfully rebuilt (no
 * persisted session contract, or its workspace is gone). Injected from the
 * top-level session so this manager stays free of sdk/SessionManager imports.
 */
export type PersistedAgentReviverFactory = (ref: AgentRef) => Promise<AgentReviver | undefined>;
export type PersistedAgentIdleTtlResolver = (ref: AgentRef) => number;

export interface AdoptOptions {
	/** TTL before an idle agent falls asleep. <= 0 keeps it live until the session exits. */
	idleTtlMs: number;
	/**
	 * Recreates a live AgentSession from the ref's sessionFile. Absent => a wake goes
	 * through the persisted-agent factory, which rebuilds from the transcript when the
	 * agent's workspace still exists (an isolated run's worktree does not).
	 */
	revive?: AgentReviver;
}

interface AdoptedAgent {
	idleTtlMs: number;
	revive?: AgentReviver;
	/** When the idle agent falls asleep. Absent while it is running, asleep or pinned. */
	deadline?: number;
}

/**
 * Report a session's turns to the registry: `agent_start` on an `idle` ref makes
 * it `running`, `agent_end` on a `running` ref makes it `idle`. Installed once per
 * live session by the executor at hand-over and by a wake; the subscription needs
 * no teardown because a disposed session emits nothing.
 *
 * Both writes are conditional on the current status so a turn event that arrives
 * after the agent fell asleep is dropped rather than rejected by the transition
 * table: the event describes a session the registry has already let go of.
 */
export function syncStatusWithTurns(registry: AgentRegistry, id: string, session: AgentSession): void {
	session.subscribe(event => {
		const status = registry.get(id)?.status;
		if (event.type === "agent_start" && status === "idle") registry.setStatus(id, "running");
		else if (event.type === "agent_end" && status === "running") registry.setStatus(id, "idle");
	});
}

export class AgentLifecycleManager {
	static #global: AgentLifecycleManager | undefined;

	/**
	 * The manager of the process-wide registry. It is rebuilt when that registry has been replaced, so
	 * a manager never terminates, sleeps or wakes through a registry nothing else reads any more.
	 */
	static global(): AgentLifecycleManager {
		const registry = AgentRegistry.global();
		const current = AgentLifecycleManager.#global;
		if (current && current.#registry === registry) return current;
		if (current) current.#retire();
		AgentLifecycleManager.#global = new AgentLifecycleManager(registry);
		return AgentLifecycleManager.#global;
	}

	/** Reset the global manager. Test-only. */
	static resetGlobalForTests(): void {
		const current = AgentLifecycleManager.#global;
		if (current) current.#retire();
		AgentLifecycleManager.#global = undefined;
	}

	/** Stop listening to the registry and drop every timer and tracked agent. */
	#retire(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#clearTimer();
		this.#adopted.clear();
		this.#revivals.clear();
		this.#sleeping.clear();
		this.#pinned.clear();
		this.#persistedReviverFactory = undefined;
	}

	readonly #registry: AgentRegistry;
	readonly #adopted = new Map<string, AdoptedAgent>();
	/**
	 * Sessions being closed by {@link fallAsleep} right now. A wake waits for the
	 * close it raced with, so it never receives a session that is being disposed and
	 * the session it attaches is never detached by the close finishing after it.
	 */
	readonly #sleeping = new Map<string, Promise<void>>();
	/** In-flight wakes, so concurrent {@link ensureLive} calls coalesce. */
	readonly #revivals = new Map<string, Promise<AgentSession>>();
	/**
	 * Ids a screen is attached to, with the number of holders. A pinned agent never
	 * falls asleep on its idle TTL: the expiry is dropped and re-armed from the last
	 * unpin. Without this a focus could attach to the session a concurrent sleep was
	 * flushing and disposing, leaving the transcript, the status line and the
	 * editor's interrupt on a dead session.
	 */
	readonly #pinned = new Map<string, number>();
	#unsubscribe: (() => void) | undefined;
	#persistedReviverFactory: PersistedAgentReviverFactory | undefined;
	/** One process-wide next-deadline timer; never one poller/timer per agent. */
	#timer: NodeJS.Timeout | undefined;
	/** TTL policy applied when a ref restored from disk is woken. */
	#persistedReviveTtl: number | PersistedAgentIdleTtlResolver = 0;

	constructor(registry: AgentRegistry = AgentRegistry.global()) {
		this.#registry = registry;
		this.#unsubscribe = registry.onChange(event => this.#onRegistryEvent(event));
	}

	/**
	 * Install the factory used to wake `asleep` refs that carry no reviver: refs
	 * restored from disk (the persisted-agent scan, collab mirror, resumed process)
	 * and refs whose run left none. Set by the top-level session, which owns the
	 * ambient deps (auth, models, MCP, artifacts) the factory needs at wake time.
	 */
	setPersistedAgentReviverFactory(
		factory: PersistedAgentReviverFactory,
		idleTtl: number | PersistedAgentIdleTtlResolver,
	): void {
		this.#persistedReviverFactory = factory;
		this.#persistedReviveTtl = idleTtl;
	}

	/**
	 * Take ownership of a spawned agent at the end of its run. The caller has
	 * already set its status: `idle` arms the sleep deadline (idleTtlMs <= 0 adopts
	 * without one), `running` waits for {@link fallAsleep}.
	 */
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
		const adopted: AdoptedAgent = { idleTtlMs: opts.idleTtlMs, revive: opts.revive };
		this.#adopted.set(id, adopted);
		this.#refreshDeadline(id, adopted);
		this.#scheduleNext();
	}

	/** True if the id is adopted (asleep or live). */
	has(id: string): boolean {
		return this.#adopted.has(id);
	}

	/**
	 * True while {@link fallAsleep} is closing this agent's session, so a dispose hook
	 * can tell falling asleep from teardown.
	 */
	isFallingAsleep(id: string): boolean {
		return this.#sleeping.has(id);
	}

	/**
	 * Keep an agent's session live while something is attached to it. Returns the
	 * release, which is idempotent. Pinning is independent of adoption so a screen
	 * can attach to a running agent before the executor hands it over.
	 */
	pin(id: string): () => void {
		this.#pinned.set(id, (this.#pinned.get(id) ?? 0) + 1);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const holders = this.#pinned.get(id);
			if (holders === undefined) return;
			if (holders > 1) {
				this.#pinned.set(id, holders - 1);
				return;
			}
			this.#pinned.delete(id);
			const adopted = this.#adopted.get(id);
			const ref = this.#registry.get(id);
			if (!adopted || ref?.status !== "idle" || !ref.session || adopted.idleTtlMs <= 0) return;
			// Counted from the unpin, not from `lastActivity`: the agent was idle on
			// screen for as long as the operator was reading it, and a sleep that fires
			// the instant the screen leaves would drop the session they just left.
			adopted.deadline = Date.now() + adopted.idleTtlMs;
			this.#scheduleNext();
		};
	}

	/** True while a screen is attached to this agent's session. */
	isPinned(id: string): boolean {
		return this.#pinned.has(id);
	}

	/**
	 * Put an idle agent to sleep: persist its session, dispose the live resources,
	 * detach it and mark it `asleep`. Running agents never fall asleep this way. No-op
	 * unless the id is adopted, idle, live and not on screen.
	 */
	async sleep(id: string): Promise<void> {
		const adopted = this.#adopted.get(id);
		if (!adopted || this.#sleeping.has(id)) return;
		const ref = this.#registry.get(id);
		const session = ref?.status === "idle" ? ref.session : null;
		// Checked BEFORE the deadline is touched: clearing it for an agent that cannot
		// sleep right now (running, already asleep) would leave it with no deadline, and
		// nothing would derive one again until its next status change.
		if (!ref || !session) return;
		adopted.deadline = undefined;
		this.#scheduleNext();
		// A pinned agent is on screen. The deadline stays clear; the unpin re-arms it,
		// so the sleep is deferred rather than lost.
		if (this.#pinned.has(id)) return;
		try {
			await session.sessionManager.flush();
		} catch (error) {
			logger.warn("AgentLifecycleManager.sleep: session flush failed; keeping agent live", {
				id,
				error: errorMessage(error),
			});
			this.#rearmIdle(id);
			return;
		}
		// A follow-up may have started, or a screen attached, while the durable flush
		// was in flight. Re-check identity, status and pin before closing anything.
		const current = this.#registry.get(id);
		if (current?.status !== "idle" || current.session !== session || this.#pinned.has(id)) {
			this.#rearmIdle(id);
			return;
		}
		await this.fallAsleep(id, session);
	}

	/**
	 * Close a spawned agent's live session and mark it `asleep`, from `idle` or
	 * `running`. The executor calls this for a run that was stopped (killed, timed out,
	 * cancelled, failed) and for an isolated run, whose worktree is gone; the idle TTL
	 * reaches it through {@link sleep}. The transcript stays on disk and a message wakes
	 * the agent from it.
	 *
	 * `dispose` closes the session; the default is `session.dispose()`, and the
	 * executor passes a bounded one. Concurrent calls for one id share the close.
	 */
	fallAsleep(
		id: string,
		session: AgentSession,
		dispose: () => Promise<void> = () => session.dispose(),
	): Promise<void> {
		const inflight = this.#sleeping.get(id);
		if (inflight) return inflight;
		// Registered BEFORE `dispose` runs: the sdk's dispose hook asks
		// {@link isFallingAsleep} synchronously, and a hook that misses the close
		// unregisters the agent instead of letting it sleep.
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#sleeping.set(id, promise);
		void (async () => {
			try {
				await dispose();
			} catch (error) {
				logger.warn("AgentLifecycleManager.fallAsleep: session dispose failed", { id, error: errorMessage(error) });
			}
			try {
				const ref = this.#registry.get(id);
				if (ref?.session === session) this.#registry.detachSession(id);
				if (ref) this.#registry.setStatus(id, "asleep");
			} finally {
				this.#sleeping.delete(id);
				resolve();
				this.#scheduleNext();
			}
		})();
		return promise;
	}

	/**
	 * Return the live session, waking the agent from its sessionFile if it is asleep.
	 * Throws a plain Error if the id is unknown or no reviver can rebuild it.
	 * Concurrent calls share one in-flight wake.
	 */
	async ensureLive(id: string): Promise<AgentSession> {
		// A wake that arrives while the agent is falling asleep waits for the close to
		// finish, then wakes it from the transcript the close just flushed.
		await this.#sleeping.get(id);
		const ref = this.#registry.get(id);
		if (!ref) {
			throw new Error(
				`Unknown agent "${id}" — it was never registered or its conversation has ended. If a transcript exists, read history://${id}.`,
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
	 * Resolve a reviver and bring the agent back to a live session. An adopted ref
	 * carries the reviver its run left; any other asleep ref (restored from disk, or
	 * an isolated run's) is rebuilt through the injected persisted-agent factory and
	 * adopted so it rejoins the normal idle ↔ asleep lifecycle. Throws when no
	 * reviver can be produced.
	 */
	async #resolveAndRevive(id: string, ref: AgentRef): Promise<AgentSession> {
		let revive = this.#adopted.get(id)?.revive;
		let coldAdopted = false;
		if (!revive && ref.status === "asleep" && ref.sessionFile && this.#persistedReviverFactory) {
			revive = await this.#persistedReviverFactory(ref);
			if (revive) {
				this.#adopted.set(id, { idleTtlMs: this.#persistedIdleTtl(ref), revive });
				coldAdopted = true;
			}
		}
		// Every exit from the cold-adopt region is compensated, not only the one the
		// wake throws from: a ref whose status changed during the `await` on the factory
		// (release-and-reregister, collab mirror update) must not leave a reviver built
		// from a STALE ref in #adopted, which every later ensureLive would prefer over
		// rebuilding through the factory.
		try {
			if (ref.status !== "asleep" || !revive) {
				throw new Error(
					`Agent "${id}" is ${ref.status} and cannot be woken${revive ? "" : " (its transcript or workspace is gone)"}. Read history://${id} for what it did.`,
				);
			}
			return await this.#revive(id, revive, ref);
		} catch (error) {
			// A failed cold wake (stale ctx, missing cwd, bad MCP) must not leave a
			// poisoned reviver stuck in #adopted: drop it so a later ensureLive rebuilds
			// through the factory, which may have fresher context by then.
			if (coldAdopted) this.#adopted.delete(id);
			throw error;
		}
	}

	/** Hard removal: dispose if live, unregister from registry, drop deadlines. */
	async release(id: string): Promise<void> {
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

	/**
	 * Stop an agent and everything it spawned: abort the turn each one is in, and put
	 * the idle ones to sleep. Nothing is removed: every stopped agent stays in the
	 * roster and wakes when messaged. A first run that is aborted here falls asleep
	 * through the executor, which owns that session until the run settles.
	 *
	 * Deepest first, so no child is left running on behalf of a parent that has
	 * already stopped.
	 *
	 * A throwing abort propagates and nothing above it is stopped: a session that
	 * cannot abort is a session whose provider request cannot be stopped, and the
	 * caller surfaces that to whoever asked.
	 */
	async stop(id: string, reason: string): Promise<void> {
		for (const target of [...this.#registry.descendantsOf(id).reverse(), id]) {
			const ref = this.#registry.get(target);
			if (ref?.status === "running" && ref.session) await ref.session.abort({ reason });
			await this.sleep(target);
		}
	}

	/**
	 * Remove an agent and everything it spawned, for the end of the conversation that
	 * owns them: abort the turn each one is in, then release it.
	 *
	 * Within one agent the abort lands first: releasing a running session disposes it
	 * with a provider request still in flight and nothing left to receive the answer.
	 *
	 * Across the subtree, deepest first and the whole subtree before the agent that was
	 * named. `descendantsOf` walks `parentId` through the registry, so the moment a
	 * parent's ref is gone its children stop resolving as anyone's descendants and
	 * would keep running unreachable. The walk is snapshotted before anything is
	 * unregistered for the same reason.
	 *
	 * A throwing abort propagates and NOTHING below it is released, which keeps the
	 * agent that would not stop reachable through its parent chain so the caller can
	 * retry.
	 */
	async terminate(id: string, reason: string): Promise<void> {
		for (const target of [...this.#registry.descendantsOf(id).reverse(), id]) {
			const ref = this.#registry.get(target);
			if (ref?.status === "running" && ref.session) await ref.session.abort({ reason });
			await this.release(target);
		}
	}

	/** Teardown everything (process exit / main session dispose). */
	async dispose(): Promise<void> {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#clearTimer();
		const ids = Array.from(this.#adopted.keys());
		await Promise.all(ids.map(id => this.release(id)));
		this.#revivals.clear();
		this.#sleeping.clear();
		this.#pinned.clear();
		this.#persistedReviverFactory = undefined;
	}

	/**
	 * Attach a freshly rebuilt session to its ref.
	 *
	 * The ref is re-read AFTER the rebuild because `revive()` is slow (transcript
	 * replay, MCP, auth) and anything may have released or replaced the id meanwhile:
	 * process teardown, the end of its conversation, a collab mirror update.
	 * `attachSession` and `setStatus` both no-op on an unknown id, so without this
	 * check the caller would receive a live session that no registry entry owns and
	 * nothing will ever dispose. Fail loudly and dispose it here instead.
	 */
	async #revive(id: string, revive: AgentReviver, expectedRef: AgentRef): Promise<AgentSession> {
		const session = await revive();
		const current = this.#registry.get(id);
		if (!current || (current !== expectedRef && current.session !== session)) {
			try {
				await session.dispose();
			} catch (error) {
				logger.warn("AgentLifecycleManager.revive: disposing an orphaned wake failed", {
					id,
					error: errorMessage(error),
				});
			}
			throw new Error(
				current
					? `Agent "${id}" was replaced while it was waking. Its transcript remains readable at history://${id}.`
					: `Agent "${id}" was released while it was waking. Its transcript remains readable at history://${id}.`,
			);
		}
		this.#registry.attachSession(id, session, expectedRef.sessionFile);
		// Emits status_changed → "idle", which re-arms the TTL timer below.
		this.#registry.setStatus(id, "idle");
		return session;
	}

	/**
	 * Re-arm the sleep deadline from now for an idle, live, unpinned agent whose sleep
	 * did not happen (flush failed, a turn or a screen arrived during the flush).
	 */
	#rearmIdle(id: string): void {
		const adopted = this.#adopted.get(id);
		const ref = this.#registry.get(id);
		if (!adopted || ref?.status !== "idle" || !ref.session || adopted.idleTtlMs <= 0 || this.#pinned.has(id)) return;
		adopted.deadline = Date.now() + adopted.idleTtlMs;
		this.#scheduleNext();
	}

	/**
	 * Set the sleep deadline of an idle agent, counted from `lastActivity`, which
	 * `setStatus` bumps on every transition, so a woken agent's budget starts again
	 * from the wake. Every other status carries no deadline.
	 */
	#refreshDeadline(id: string, adopted: AdoptedAgent): void {
		const ref = this.#registry.get(id);
		adopted.deadline =
			ref?.status === "idle" && adopted.idleTtlMs > 0 ? ref.lastActivity + adopted.idleTtlMs : undefined;
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
			const due: string[] = [];
			for (const [id, adopted] of this.#adopted) {
				if (adopted.deadline === undefined || adopted.deadline > now) continue;
				// Cleared before acting. A due deadline left in place is one `#scheduleNext`
				// immediately re-reads as the next wake with a zero delay, so an entry the
				// sleep declines would spin the scheduler instead of failing once.
				adopted.deadline = undefined;
				due.push(id);
			}
			this.#scheduleNext();
			// Expiries are drained in order so a large idle cohort cannot trigger an
			// unbounded burst of persistence and process teardown work.
			void (async () => {
				for (const id of due) {
					const adopted = this.#adopted.get(id);
					// A deadline here was re-derived during the drain by a status change or a
					// re-adoption: it describes the agent as it is now, so this expiry is stale.
					if (!adopted || adopted.deadline !== undefined) continue;
					// Falling asleep disposes the session, which cancels the background jobs the agent
					// and the agents it spawned started. While one runs the agent is not done: its
					// result is still on its way, so the expiry is pushed back one idle period.
					if (this.#hasRunningWork(id)) {
						this.#rearmIdle(id);
						continue;
					}
					await this.sleep(id);
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

	/** True while a background job this agent or an agent it spawned started is still running. */
	#hasRunningWork(id: string): boolean {
		const manager = this.#registry.get(id)?.session?.asyncJobManager;
		return manager !== undefined && hasRunningJobsUnder(manager, id);
	}

	/** The operator's current idle TTL for a ref woken from disk. */
	#persistedIdleTtl(ref: AgentRef): number {
		return typeof this.#persistedReviveTtl === "function" ? this.#persistedReviveTtl(ref) : this.#persistedReviveTtl;
	}
}
