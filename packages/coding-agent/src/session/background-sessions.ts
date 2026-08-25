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
import { logger } from "@veyyon/utils";
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
	/** Resolves once the turn settled and the transcript was flushed. */
	readonly settled: Promise<void>;
}

export class BackgroundSessions {
	static #instance: BackgroundSessions | undefined;

	#kept = new Map<AgentSession, KeptSession>();

	/** Process-wide keeper. The interactive host and its shutdown path share one. */
	static global(): BackgroundSessions {
		BackgroundSessions.#instance ??= new BackgroundSessions();
		return BackgroundSessions.#instance;
	}

	/** Sessions still finishing their turn, oldest handoff first. */
	get kept(): readonly KeptSession[] {
		return [...this.#kept.values()];
	}

	/** How many handed-off sessions have not settled yet. */
	get size(): number {
		return this.#kept.size;
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
		const entry: KeptSession = {
			session,
			sessionId,
			sessionFile: session.sessionManager.getSessionFile(),
			detachedAt: Date.now(),
			settled: this.#settle(session, sessionId),
		};
		this.#kept.set(session, entry);
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
				this.#kept.delete(session);
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
		const settled = Promise.all([...this.#kept.values()].map(entry => entry.settled));
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<void>(resolve => {
			timer = setTimeout(resolve, timeoutMs);
		});
		try {
			await Promise.race([settled, timeout]);
		} finally {
			clearTimeout(timer);
			this.#kept.clear();
		}
	}

	async #settle(session: AgentSession, sessionId: string): Promise<void> {
		try {
			await session.waitForIdle();
			await session.sessionManager.flush();
		} catch (error) {
			logger.warn("Handed-off session failed to settle", { sessionId, error: String(error) });
		} finally {
			this.#kept.delete(session);
		}
	}
}
