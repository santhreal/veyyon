import { clamp, errorMessage, logger } from "@veyyon/utils";
import type { AgentSession } from "../session/agent-session";
import { type AgentRef, AgentRegistry, MAIN_AGENT_ID, type RegistryEvent } from "./agent-registry";

export type AgentReviver = () => Promise<AgentSession>;

export type PersistedSubagentReviverFactory = (ref: AgentRef) => Promise<AgentReviver | undefined>;
export type PersistedSubagentIdleTtlResolver = (ref: AgentRef) => number;

export interface PersistedSubagentCloseBudget {
	parkedMs: number;
	waitingMs: number;
}
export type PersistedSubagentCloseBudgetResolver = (ref: AgentRef) => PersistedSubagentCloseBudget;

export interface AdoptOptions {
	idleTtlMs: number;
	closeParkedMs?: number;
	closeWaitingMs?: number;
	revive?: AgentReviver;
}

interface AdoptedAgent {
	idleTtlMs: number;
	closeParkedMs: number;
	closeWaitingMs: number;
	revive?: AgentReviver;
	deadline?: number;
	stage?: "park" | "close";
}

function arm(adopted: AdoptedAgent, at: number, stage: "park" | "close"): void {
	adopted.deadline = at;
	adopted.stage = stage;
}

function disarm(adopted: AdoptedAgent): void {
	adopted.deadline = undefined;
	adopted.stage = undefined;
}

function normalizeCloseBudgets(
	parkedMs: number | undefined,
	waitingMs: number | undefined,
): PersistedSubagentCloseBudget {
	const parked = Math.max(0, parkedMs ?? 0);
	return { parkedMs: parked, waitingMs: parked === 0 ? 0 : Math.max(parked, waitingMs ?? parked) };
}

const REVIVE_RECHECK_MS = 1_000;

export class AgentLifecycleManager {
	static #global: AgentLifecycleManager | undefined;

	static global(): AgentLifecycleManager {
		if (!AgentLifecycleManager.#global) {
			AgentLifecycleManager.#global = new AgentLifecycleManager();
		}
		return AgentLifecycleManager.#global;
	}

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
	readonly #parking = new Set<string>();
	readonly #revivals = new Map<string, Promise<AgentSession>>();
	#unsubscribe: (() => void) | undefined;
	#persistedReviverFactory: PersistedSubagentReviverFactory | undefined;
	#timer: NodeJS.Timeout | undefined;
	#persistedReviveTtl: number | PersistedSubagentIdleTtlResolver = 0;
	#persistedReviveCloseBudget: PersistedSubagentCloseBudget | PersistedSubagentCloseBudgetResolver = {
		parkedMs: 0,
		waitingMs: 0,
	};

	constructor(registry: AgentRegistry = AgentRegistry.global()) {
		this.#registry = registry;
		this.#unsubscribe = registry.onChange(event => this.#onRegistryEvent(event));
	}

	setPersistedSubagentReviverFactory(
		factory: PersistedSubagentReviverFactory,
		idleTtl: number | PersistedSubagentIdleTtlResolver,
		closeBudget: PersistedSubagentCloseBudget | PersistedSubagentCloseBudgetResolver = { parkedMs: 0, waitingMs: 0 },
	): void {
		this.#persistedReviverFactory = factory;
		this.#persistedReviveTtl = idleTtl;
		this.#persistedReviveCloseBudget = closeBudget;
	}

	adopt(id: string, opts: AdoptOptions): void {
		if (id === MAIN_AGENT_ID) return;
		const ref = this.#registry.get(id);
		if (!ref) {
			logger.warn("AgentLifecycleManager.adopt: unknown agent id", { id });
			return;
		}
		if (ref.kind === "main") return;
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

	has(id: string): boolean {
		return this.#adopted.has(id);
	}

	isParking(id: string): boolean {
		return this.#parking.has(id);
	}

	async park(id: string): Promise<void> {
		const adopted = this.#adopted.get(id);
		if (!adopted || this.#parking.has(id)) return;
		const ref = this.#registry.get(id);
		const session = ref?.status === "idle" ? ref.session : null;
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
					arm(currentAdoption, Date.now() + currentAdoption.idleTtlMs, "park");
				}
			}
			this.#scheduleNext();
		}
	}

	async ensureLive(id: string): Promise<AgentSession> {
		const ref = this.#registry.get(id);
		if (!ref) {
			throw new Error(
				`Unknown agent "${id}" — it was never registered or has been released. If a transcript exists, read history://${id}.`,
			);
		}
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
				const budget =
					typeof this.#persistedReviveCloseBudget === "function"
						? this.#persistedReviveCloseBudget(ref)
						: this.#persistedReviveCloseBudget;
				const { parkedMs, waitingMs } = normalizeCloseBudgets(budget.parkedMs, budget.waitingMs);
				this.#adopted.set(id, { idleTtlMs, closeParkedMs: parkedMs, closeWaitingMs: waitingMs, revive });
				coldAdopted = true;
			}
		}
		try {
			if (ref.status !== "parked" || !revive) {
				throw new Error(
					`Agent "${id}" is ${ref.status} and cannot be revived${revive ? "" : " (no reviver registered)"}. Its transcript remains readable at history://${id}.`,
				);
			}
			return await this.#revive(id, revive, ref);
		} catch (error) {
			if (coldAdopted) this.#adopted.delete(id);
			throw error;
		}
	}

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

	async terminate(id: string, reason: string): Promise<void> {
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
		this.#registry.setStatus(id, "idle");
		return session;
	}

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
		const delay = clamp(nextDeadline - Date.now(), 0, 2_147_483_647);
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			const now = Date.now();
			const due: Array<{ id: string; stage: "park" | "close" }> = [];
			for (const [id, adopted] of this.#adopted) {
				if (adopted.deadline === undefined || adopted.deadline > now) continue;
				const stage = adopted.stage;
				disarm(adopted);
				if (stage === undefined) {
					this.#refreshDeadline(id, adopted);
					continue;
				}
				due.push({ id, stage });
			}
			this.#scheduleNext();
			void (async () => {
				for (const { id, stage } of due) {
					const adopted = this.#adopted.get(id);
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
