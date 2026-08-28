/** The set of conversations this process is running that no screen is showing. A session object both holds a conversation and runs its turn, so a screen that */

import * as path from "node:path";
import { errorMessage, logger } from "@veyyon/utils";
import type { AgentSession } from "./agent-session";

/** How long shutdown waits for handed-off background sessions to settle and flush their transcripts before abandoning them. Matches SHUTDOWN_DISPOSE_TIMEOUT_MS: */
export const SHUTDOWN_DRAIN_TIMEOUT_MS = 5_000;

/** Creates the session a screen attaches to when the one it was displaying is registered as running in the background. Built once from the options the */
export type InteractiveSessionFactory = () => Promise<AgentSession>;

/** A session that is still running after the UI attached to a different one. */
export interface KeptSession {
	readonly session: AgentSession;
	/** Session id at the moment it was handed off. */
	readonly sessionId: string;
	/** Transcript this session writes to, the key `/resume` names it by. */
	readonly sessionFile: string | undefined;
	readonly detachedAt: number;
	/** Monotonic counter disambiguating successive handoffs of the same session object. */
	readonly handoff: number;
	/** Resolves once the turn settled and the transcript was flushed. */
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

	/** Sessions still finishing their turn, oldest handoff first. */
	get kept(): readonly KeptSession[] {
		return Array.from(this.#kept.values());
	}

	/** How many handed-off sessions have not settled yet. */
	get size(): number {
		return this.#kept.size;
	}

	/** Watch the set for arrivals and departures. Returns the unsubscribe. A conversation that left the screen is spending tokens where nothing draws */
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

	/** Take a session the UI no longer displays and let its turn finish. Idempotent per session: handing the same object over twice returns the */
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

	/** The entry describing a session that is on screen rather than handed over. `attachMainSession` returns a {@link KeptSession} whether or not anything moved, */
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

	/** Reclaim a kept session by the transcript it writes to, so `/resume` can re-attach the LIVE object instead of replaying its file as finished text. */
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

	/** Wait for the turns handed off before this call, bounded by `timeoutMs`. A session that has not settled within the bound is abandoned so shutdown */
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
			// An abandoned entry is a transcript that stopped short of its flush.
			// Name them: the only other trace of the loss is a file that ends
			// earlier than the conversation did.
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
