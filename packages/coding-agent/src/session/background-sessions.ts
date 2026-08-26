/**
 * BackgroundSessions - keeps a handed-off AgentSession running after the UI
 * has moved on to a new one.
 *
 * `/new` used to abort the turn in flight: the session object the UI displays
 * is the same object that runs the turn, and starting a new session reset that
 * object in place. Handing the old object to this keeper instead lets its turn
 * run to completion while the UI attaches to a freshly created session.
 *
 * A kept session is flushed, never disposed. Disposal is what tears down the
 * process-wide singletons a top-level session owns (its MCP manager, its async
 * job manager, its eval kernel), and the session the UI moved to inherits
 * those. So the kept session keeps its ownership until the process exits, and
 * this keeper only waits for the turn to settle and then persists the
 * transcript. `drain()` is the shutdown seam: it waits for every kept turn.
 */

import * as path from "node:path";
import { errorMessage, logger } from "@veyyon/utils";
import type { AgentSession } from "./agent-session";

/**
 * How long shutdown waits for handed-off background sessions to settle and flush
 * their transcripts before abandoning them. Matches SHUTDOWN_DISPOSE_TIMEOUT_MS:
 * long enough for an in-flight turn to flush, short enough that a wedged turn
 * cannot strand quit forever.
 */
export const SHUTDOWN_DRAIN_TIMEOUT_MS = 5_000;

/**
 * Creates the session the UI moves to when the displayed one is handed off.
 * Built once from the options the process launched with, so a session started
 * this way carries the same model, prompts, tools and extensions.
 */
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
		return [...this.#kept.values()];
	}

	/** How many handed-off sessions have not settled yet. */
	get size(): number {
		return this.#kept.size;
	}

	/**
	 * Watch the set for arrivals and departures. Returns the unsubscribe.
	 *
	 * A conversation that left the screen is spending tokens where nothing draws
	 * it, so the count has to reach the status line the moment it changes rather
	 * than on whatever repaint happens next. Fires after the set is already
	 * updated, so a listener reading {@link size} sees the new value.
	 */
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

	/**
	 * Take a session the UI no longer displays and let its turn finish.
	 *
	 * Idempotent per session: handing the same object over twice returns the
	 * first entry rather than waiting on it twice.
	 */
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

	/**
	 * Reclaim a kept session by the transcript it writes to, so `/resume` can
	 * re-attach the LIVE object instead of replaying its file as finished text.
	 * It leaves the background set: the UI is displaying it again, and its
	 * pending settle only flushes what the turn already wrote.
	 */
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

	/**
	 * Wait for the turns handed off before this call, bounded by `timeoutMs`.
	 * A session that has not settled within the bound is abandoned so shutdown
	 * can proceed.
	 */
	async drain(timeoutMs: number = SHUTDOWN_DRAIN_TIMEOUT_MS): Promise<void> {
		if (this.#kept.size === 0) return;
		const snapshot = [...this.#kept.values()];
		const settled = Promise.all(snapshot.map(entry => entry.settled));
		const timeout = Promise.withResolvers<void>();
		const timer = setTimeout(timeout.resolve, timeoutMs);
		try {
			await Promise.race([settled, timeout.promise]);
		} finally {
			clearTimeout(timer);
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
