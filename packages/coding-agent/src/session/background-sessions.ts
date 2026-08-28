import * as path from "node:path";
import { errorMessage, logger } from "@veyyon/utils";
import type { AgentSession } from "./agent-session";

export const SHUTDOWN_DRAIN_TIMEOUT_MS = 5_000;

export type InteractiveSessionFactory = () => Promise<AgentSession>;

export interface KeptSession {
	readonly session: AgentSession;
	readonly sessionId: string;
	readonly sessionFile: string | undefined;
	readonly detachedAt: number;
	readonly handoff: number;
	readonly settled: Promise<void>;
}

export class BackgroundSessions {
	static #instance: BackgroundSessions | undefined;

	#nextHandoff = 0;
	#kept = new Map<AgentSession, KeptSession>();
	static global(): BackgroundSessions {
		BackgroundSessions.#instance ??= new BackgroundSessions();
		return BackgroundSessions.#instance;
	}

	readonly #listeners = new Set<() => void>();

	get kept(): readonly KeptSession[] {
		return Array.from(this.#kept.values());
	}

	get size(): number {
		return this.#kept.size;
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	#emit(): void {
		for (const listener of this.#listeners) {
			try {
				listener();
			} catch (error) {
				logger.warn("Background session listener failed", { error: errorMessage(error) });
			}
		}
	}

	keep(session: AgentSession): KeptSession {
		const existing = this.#kept.get(session);
		if (existing) return existing;
		const sessionId = session.sessionManager.getSessionId();
		const handoff = ++this.#nextHandoff;
		const entry: KeptSession = {
			session,
			sessionId,
			sessionFile: session.sessionManager.getSessionFile(),
			detachedAt: Date.now(),
			handoff,
			settled: this.#settle(session, sessionId, handoff),
		};
		this.#kept.set(session, entry);
		this.#emit();
		return entry;
	}

	describeAttached(session: AgentSession): KeptSession {
		return (
			this.#kept.get(session) ?? {
				session,
				sessionId: session.sessionManager.getSessionId(),
				sessionFile: session.sessionManager.getSessionFile(),
				detachedAt: Date.now(),
				handoff: 0,
				settled: Promise.resolve(),
			}
		);
	}

	take(sessionFile: string): AgentSession | undefined {
		const wanted = path.resolve(sessionFile);
		for (const [session, entry] of this.#kept) {
			if (entry.sessionFile && path.resolve(entry.sessionFile) === wanted) {
				this.#discard(session, entry.handoff);
				return session;
			}
		}
		return undefined;
	}

	async drain(timeoutMs: number = SHUTDOWN_DRAIN_TIMEOUT_MS): Promise<void> {
		if (this.#kept.size === 0) return;
		const snapshot = Array.from(this.#kept.values());
		const unsettled = new Set(snapshot);
		const settled = Promise.all(
			snapshot.map(async entry => {
				await entry.settled;
				unsettled.delete(entry);
			}),
		);
		const timeout = Promise.withResolvers<void>();
		const timer = setTimeout(timeout.resolve, timeoutMs);
		try {
			await Promise.race([settled, timeout.promise]);
		} finally {
			clearTimeout(timer);
			if (unsettled.size > 0) {
				logger.warn("Background conversations abandoned at shutdown before their transcript flushed", {
					timeoutMs,
					sessions: Array.from(unsettled).map(entry => ({
						sessionId: entry.sessionId,
						sessionFile: entry.sessionFile,
					})),
				});
			}
			for (const entry of snapshot) {
				this.#discard(entry.session, entry.handoff);
			}
		}
	}

	#discard(session: AgentSession, handoff: number): void {
		if (this.#kept.get(session)?.handoff === handoff) {
			this.#kept.delete(session);
			this.#emit();
		}
	}

	async #settle(session: AgentSession, sessionId: string, handoff: number): Promise<void> {
		try {
			await session.waitForIdle();
			await session.sessionManager.flush();
		} catch (error) {
			logger.warn("Handed-off session failed to settle", { sessionId, error: errorMessage(error) });
		} finally {
			this.#discard(session, handoff);
		}
	}
}
