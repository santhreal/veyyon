/**
 * The set of conversations this process is running that no screen is showing.
 *
 * A session object both holds a conversation and runs its turn, so a screen that
 * stopped displaying one ended the turn with it. Registering the session here
 * separates the two: the turn runs to completion against a session the UI no
 * longer draws.
 *
 * Callers, none of which is the owner of this registry:
 * - The terminal's `/new` registers the displayed session and attaches the screen
 *   to a new one, when `session.newKeepsBackground` is on.
 * - An RPC client's `new_session` with `background: true`, and an ACP client's
 *   `_veyyon/sessions/background`, register the session they were driving.
 * - `/resume`, an RPC `switch_session` and an ACP `session/load` or
 *   `session/resume` call {@link BackgroundSessions.take} to reclaim a registered
 *   session by its transcript, so they re-attach the live object instead of
 *   replaying that file as finished text.
 * - The `/resume` picker, the RPC `get_background_sessions` and
 *   `cancel_background_session` commands and the matching ACP methods read
 *   {@link BackgroundSessions.list} and {@link BackgroundSessions.describe} and
 *   stop a conversation through {@link BackgroundSessions.cancel}.
 * - The status line subscribes to the count, because a conversation spending
 *   tokens off-screen has no other surface.
 * - Shutdown calls {@link BackgroundSessions.drain}.
 *
 * Every handoff passes `session.backgroundLimit`, and a handoff past that limit
 * stops the oldest running conversation.
 *
 * A registered session is disposed once it goes quiet: its loop is idle and no
 * background job it owns will wake it again. Disposal writes its `session_exit`
 * record, releases its browser tabs, eval kernels and advisor runtime, drops
 * its registry entry, and releases its hold on the shared MCP manager. The
 * process-wide agent lifecycle and worker subprocesses stay up for the session
 * the UI moved to.
 *
 * {@link BackgroundSessions.cancel} ends a registered conversation's turn through
 * the session's own abort, which closes the provider stream, and disposes it
 * without waiting for its background jobs.
 */

import * as path from "node:path";
import { errorMessage, logger } from "@veyyon/utils";
import type { AgentSession } from "./agent-session";
import type { CreateAgentSessionResult } from "./factory-options";

/**
 * How long shutdown waits for handed-off background sessions to go quiet before
 * it stops and disposes them. Matches SHUTDOWN_DISPOSE_TIMEOUT_MS: long enough
 * for an in-flight turn to finish, short enough that a wedged turn cannot strand
 * quit forever.
 */
export const SHUTDOWN_DRAIN_TIMEOUT_MS = 5_000;

/** Abort reason recorded on a conversation stopped because a newer handoff passed the limit. */
export const BACKGROUND_LIMIT_STOP_REASON = "Stopped: background conversation limit reached";

/**
 * The two host bindings `createAgentSession` returns beside a session. A host
 * that draws dialogs or delivers notifications installs them through these,
 * because the session's tools read them from a store the session object does
 * not expose.
 */
export type SessionHostBindings = Pick<CreateAgentSessionResult, "setToolUIContext" | "setToolNotifier">;

/** A session a host attaches to, with its host bindings. */
export type AttachableSession = SessionHostBindings & Pick<CreateAgentSessionResult, "session">;

/**
 * Creates the session a host attaches to when the one it was driving is
 * registered as running in the background. Built once from the options the
 * process launched with, so a session started this way carries the same model,
 * prompts, tools and extensions.
 */
export type NextSessionFactory = () => Promise<AttachableSession>;

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
	/** Resolves once the session went quiet and was disposed, or `/resume` reclaimed it. */
	readonly settled: Promise<void>;
	/** Session ids of the older conversations this handoff stopped to stay within the limit. */
	readonly displaced: readonly string[];
}

export class BackgroundSessions {
	static #instance: BackgroundSessions | undefined;

	#nextHandoff = 0;
	#kept = new Map<AgentSession, KeptSession>();
	/** Registered sessions whose stop is in flight; they no longer count against the limit. */
	#stopping = new Set<AgentSession>();
	/** Aborting one ends that session's wait for quiet, so it is disposed without waiting further. */
	#quietWaits = new Map<AgentSession, AbortController>();
	static global(): BackgroundSessions {
		BackgroundSessions.#instance ??= new BackgroundSessions();
		return BackgroundSessions.#instance;
	}

	readonly #listeners = new Set<() => void>();

	/** How many handed-off sessions have not settled yet. */
	get size(): number {
		return this.#kept.size;
	}

	/** The conversations running here, oldest handoff first. */
	list(): BackgroundConversation[] {
		return Array.from(this.#kept.values(), entry => this.#describe(entry));
	}

	/** The registered conversation with `sessionId`, if one is running here. */
	describe(sessionId: string): BackgroundConversation | undefined {
		const entry = this.#findById(sessionId);
		return entry && this.#describe(entry);
	}

	/**
	 * End the registered conversation with `sessionId` and wait until it is
	 * disposed. Resolves `false`, and stops nothing, when no conversation here has
	 * that id. `reason` is recorded on the aborted turn.
	 */
	async cancel(sessionId: string, reason: string): Promise<boolean> {
		const entry = this.#findById(sessionId);
		if (!entry) return false;
		await this.#stop(entry, reason);
		return true;
	}

	#findById(sessionId: string): KeptSession | undefined {
		for (const entry of this.#kept.values()) {
			if (entry.sessionId === sessionId) return entry;
		}
		return undefined;
	}

	#describe(entry: KeptSession): BackgroundConversation {
		return {
			sessionId: entry.sessionId,
			sessionFile: entry.sessionFile,
			title: entry.session.sessionManager.getSessionName(),
			detachedAt: entry.detachedAt,
			streaming: entry.session.isStreaming,
			stopping: this.#stopping.has(entry.session),
		};
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
	 * `limit` is how many conversations may run here at once. A handoff past it
	 * is accepted and stops the oldest running conversations instead, so the
	 * number of provider streams billing off-screen never exceeds `limit`.
	 *
	 * Idempotent per session: handing the same object over twice returns the
	 * first entry rather than waiting on it twice.
	 */
	keep(session: AgentSession, limit: number): KeptSession {
		assertBackgroundLimit(limit);
		const existing = this.#kept.get(session);
		if (existing) return existing;
		const running = Array.from(this.#kept.values()).filter(entry => !this.#stopping.has(entry.session));
		const overflow = running.slice(0, Math.max(0, running.length + 1 - limit));
		const sessionId = session.sessionManager.getSessionId();
		const handoff = ++this.#nextHandoff;
		const quietWait = new AbortController();
		this.#quietWaits.set(session, quietWait);
		const entry: KeptSession = {
			session,
			sessionId,
			sessionFile: session.sessionManager.getSessionFile(),
			detachedAt: Date.now(),
			handoff,
			settled: this.#settle(session, sessionId, handoff, quietWait.signal),
			displaced: overflow.map(displaced => displaced.sessionId),
		};
		this.#kept.set(session, entry);
		for (const displaced of overflow) {
			void this.#stop(displaced, BACKGROUND_LIMIT_STOP_REASON);
		}
		this.#emit();
		return entry;
	}

	/**
	 * End a registered conversation's turn and wait until it is disposed.
	 *
	 * The session's own abort closes the provider stream; the entry then leaves
	 * the set and is disposed, which cancels the background jobs it owns. An
	 * abort that throws is logged, and the wait still ends when the entry settles.
	 */
	async #stop(entry: KeptSession, reason: string): Promise<void> {
		const { session } = entry;
		this.#stopping.add(session);
		try {
			await session.abort({ reason });
		} catch (error) {
			logger.warn("Background conversation failed to stop", {
				sessionId: entry.sessionId,
				error: errorMessage(error),
			});
		}
		this.#quietWaits.get(session)?.abort();
		await entry.settled;
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
				displaced: [],
			}
		);
	}

	/**
	 * Reclaim a kept session by the transcript it writes to, so `/resume` can
	 * re-attach the LIVE object instead of replaying its file as finished text.
	 * It leaves the background set and is not disposed: the UI is displaying it
	 * again.
	 */
	take(sessionFile: string): AgentSession | undefined {
		const entry = this.find(sessionFile);
		return entry && this.reclaim(entry) ? entry.session : undefined;
	}

	/**
	 * Reclaim the session `entry` registered, unless it already ended or was
	 * reclaimed: `false` then, and nothing changes. A reclaimed session leaves
	 * the set and is not disposed.
	 */
	reclaim(entry: KeptSession): boolean {
		if (this.#kept.get(entry.session)?.handoff !== entry.handoff) return false;
		this.#quietWaits.get(entry.session)?.abort();
		this.#discard(entry.session, entry.handoff);
		return true;
	}

	/** The registered conversation writing to `sessionFile`, if one is. */
	find(sessionFile: string): KeptSession | undefined {
		const wanted = path.resolve(sessionFile);
		for (const entry of this.#kept.values()) {
			if (entry.sessionFile && path.resolve(entry.sessionFile) === wanted) return entry;
		}
		return undefined;
	}

	/**
	 * Wait for the turns handed off before this call to go quiet, bounded by
	 * `timeoutMs`. A session still running at the bound is stopped and disposed
	 * so shutdown can proceed.
	 */
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
			// Only an entry that is still the current handoff of its session is this
			// drain's to stop: one `/resume` reclaimed is on screen, and the same
			// object may already be registered again under a newer handoff.
			const abandoned = Array.from(unsettled).filter(
				entry => this.#kept.get(entry.session)?.handoff === entry.handoff,
			);
			// A turn cut off here ends its transcript earlier than the conversation
			// did. Name them: the only other trace is the `session_exit` record.
			if (abandoned.length > 0) {
				logger.warn("Background conversations stopped at shutdown before they went quiet", {
					timeoutMs,
					sessions: abandoned.map(entry => ({
						sessionId: entry.sessionId,
						sessionFile: entry.sessionFile,
					})),
				});
			}
			for (const entry of abandoned) {
				this.#quietWaits.get(entry.session)?.abort();
				this.#discard(entry.session, entry.handoff);
			}
			await Promise.all(abandoned.map(entry => dispose(entry.session, entry.sessionId)));
		}
	}

	#discard(session: AgentSession, handoff: number): void {
		if (this.#kept.get(session)?.handoff === handoff) {
			this.#kept.delete(session);
			this.#stopping.delete(session);
			this.#quietWaits.delete(session);
			this.#emit();
		}
	}

	async #settle(session: AgentSession, sessionId: string, handoff: number, quiet: AbortSignal): Promise<void> {
		try {
			await session.waitForQuiescence(quiet);
			await session.sessionManager.flush();
		} catch (error) {
			logger.warn("Handed-off session failed to settle", { sessionId, error: errorMessage(error) });
		}
		// Reclaimed by `/resume`, or taken over by shutdown's drain: this entry no longer owns it.
		if (this.#kept.get(session)?.handoff !== handoff) return;
		this.#discard(session, handoff);
		await dispose(session, sessionId);
	}
}

/** Throw unless `limit` is a usable `session.backgroundLimit`: at least one conversation. */
export function assertBackgroundLimit(limit: number): void {
	if (!(limit >= 1)) {
		throw new RangeError(`session.backgroundLimit must be at least 1, got ${limit}`);
	}
}

async function dispose(session: AgentSession, sessionId: string): Promise<void> {
	try {
		await session.dispose();
	} catch (error) {
		logger.warn("Handed-off session failed to dispose", { sessionId, error: errorMessage(error) });
	}
}

/**
 * A conversation running in the background, described for a caller that never
 * holds the session object: a status line, a session picker, an RPC or ACP client.
 */
export interface BackgroundConversation {
	/** Session id at the moment it was handed off; {@link BackgroundSessions.cancel} takes it. */
	readonly sessionId: string;
	/** Transcript the conversation writes to, the key a resume reclaims it by. */
	readonly sessionFile: string | undefined;
	readonly title: string | undefined;
	/** When it was handed off, in epoch milliseconds. */
	readonly detachedAt: number;
	/** True while its turn is streaming; false while only its background jobs keep it registered. */
	readonly streaming: boolean;
	/** True once a stop was requested and the turn is unwinding. */
	readonly stopping: boolean;
}

/** What a host reports to its caller after a handoff. */
export interface BackgroundHandoff {
	/** The conversation that left the foreground. */
	readonly sessionId: string;
	readonly sessionFile: string | undefined;
	/**
	 * True when its turn was streaming at the handoff. False when it entered the background set
	 * only to let its background jobs finish; it is disposed once they end, at once when it has none.
	 */
	readonly streaming: boolean;
	/** Session ids of the older conversations the handoff stopped to stay within `session.backgroundLimit`. */
	readonly displaced: readonly string[];
	/** One line stating the outcome, independent of the command or request that caused the handoff. */
	readonly message: string;
}

/**
 * Describe `kept`, which a handoff registered under `limit`, for the caller
 * that asked for it. Call it right after the handoff: the outcome is read from
 * the session's state at the call. The message states that outcome without
 * naming the command or request that caused it, so every host prints the same line.
 */
export function backgroundHandoff(kept: KeptSession, limit: number): BackgroundHandoff {
	const streaming = kept.session.isStreaming;
	const outcome = streaming ? "continues in the background" : "closes once its background jobs finish";
	const stopped =
		kept.displaced.length > 0 ? `; stopped ${kept.displaced.join(", ")} (background limit ${limit})` : "";
	return {
		sessionId: kept.sessionId,
		sessionFile: kept.sessionFile,
		streaming,
		displaced: kept.displaced,
		message: `${kept.sessionId} ${outcome}${stopped}`,
	};
}

/** The off-screen conversations a session picker lists, addressed by transcript path. */
export interface RunningConversations {
	/** Whether the conversation writing to `sessionFile` is running off-screen. */
	isRunning(sessionFile: string): boolean;
	/** Abort that conversation's turn and resolve once its entry left the set. */
	stop(sessionFile: string): Promise<void>;
}

/**
 * The picker's view of `keeper`. A stop records `reason` on the aborted turn;
 * a path that names no registered conversation is left alone.
 */
export function runningConversations(keeper: BackgroundSessions, reason: string): RunningConversations {
	return {
		isRunning: sessionFile => keeper.find(sessionFile) !== undefined,
		stop: async sessionFile => {
			const entry = keeper.find(sessionFile);
			if (entry) await keeper.cancel(entry.sessionId, reason);
		},
	};
}
