/**
 * The set of conversations this process is running that no screen is showing.
 *
 * A session object both holds a conversation and runs its turn, so a screen that
 * stopped displaying one ended the turn with it. Registering the session here
 * separates the two: the turn runs to completion against a session the UI no
 * longer draws.
 *
 * Four callers, none of which is the owner of this registry:
 * - `/new` registers the displayed session and attaches the screen to a new one,
 *   when `session.newKeepsBackground` is on.
 * - `/resume` calls {@link BackgroundSessions.take} to reclaim a registered
 *   session by its transcript, so it re-attaches the live object instead of
 *   replaying that file as finished text.
 * - The status line subscribes to the count, because a conversation spending
 *   tokens off-screen has no other surface.
 * - Shutdown calls {@link BackgroundSessions.drain}.
 *
 * A registered session is flushed, never disposed. Disposal tears down the
 * process-wide singletons a top-level session owns — its MCP manager, its async
 * job manager, its eval kernel — and the session the UI moved to inherits them,
 * so ownership stays with the registered session until the process exits. This
 * registry waits for the turn to settle and then persists the transcript.
 *
 * Stopping a conversation is deliberately not a verb here. Ending a turn closes
 * a provider stream and settles a transcript, which is the responsibility of the
 * session running it and is what `session.newKeepsBackground` selects. The
 * status line counts these conversations rather than offering a kill that would
 * only half-work.
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
 * Creates the session a screen attaches to when the one it was displaying is
 * registered as running in the background. Built once from the options the
 * process launched with, so a session started this way carries the same model,
 * prompts, tools and extensions.
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
	 * The entry describing a session that is on screen rather than handed over.
	 *
	 * `attachMainSession` returns a {@link KeptSession} whether or not anything moved,
	 * and re-attaching the session already displayed moves nothing. Registering it
	 * instead would count a visible conversation in {@link size}, which is the number
	 * the status line shows for conversations nobody is watching.
	 */
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
					sessions: [...unsettled].map(entry => ({ sessionId: entry.sessionId, sessionFile: entry.sessionFile })),
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
