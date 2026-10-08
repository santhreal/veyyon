/**
 * The session an RPC client drives, and the handoffs that move it to
 * {@link BackgroundSessions} and back.
 *
 * `new_session` with `background: true` attaches the client to a new session
 * while the streaming one finishes its turn off-screen. `switch_session` to the
 * transcript of a conversation running in the background re-attaches the live
 * session instead of replaying its file. In both cases the session the client
 * was driving enters the background set under `session.backgroundLimit`.
 */

import type { AgentSession } from "../../session/agent-session";
import {
	type AttachableSession,
	assertBackgroundLimit,
	type BackgroundHandoff,
	BackgroundSessions,
	backgroundHandoff,
	type NextSessionFactory,
} from "../../session/background-sessions";

/** How the RPC host connects a session to its client. */
export interface RpcSessionRouting {
	/** Forward `session`'s events and command updates to the client. Returns the call that stops it. */
	route(session: AgentSession): () => void;
	/**
	 * Install the client's tool UI and extension runtime on a session the client
	 * has not driven before. A session reclaimed from the background was adopted
	 * when it was first attached and keeps that state.
	 */
	adopt(next: AttachableSession): Promise<void>;
}

export interface RpcSessionSlotOptions {
	readonly routing: RpcSessionRouting;
	/** Builds the session a background handoff attaches. Absent: `background()` fails. */
	readonly createNextSession?: NextSessionFactory;
	readonly keeper?: BackgroundSessions;
}

export class RpcSessionSlot {
	#session: AgentSession;
	#unroute: () => void;
	readonly #routing: RpcSessionRouting;
	readonly #createNextSession: NextSessionFactory | undefined;
	readonly #keeper: BackgroundSessions;

	/** Route `attached`, which the caller already adopted, to the client. */
	constructor(attached: AgentSession, options: RpcSessionSlotOptions) {
		this.#session = attached;
		this.#routing = options.routing;
		this.#createNextSession = options.createNextSession;
		this.#keeper = options.keeper ?? BackgroundSessions.global();
		this.#unroute = this.#routing.route(attached);
	}

	/** The session the client drives. */
	get session(): AgentSession {
		return this.#session;
	}

	/**
	 * Attach a new session and leave the driven one finishing its turn in the
	 * background. Resolves `undefined`, attaching nothing, when the driven
	 * session is not streaming: no turn needs to survive, so the caller resets it
	 * in place.
	 *
	 * The new session is adopted before the driven one is handed over, so a
	 * failure to build or adopt it leaves the client on the session it had.
	 */
	async background(): Promise<BackgroundHandoff | undefined> {
		if (!this.#session.isStreaming) return undefined;
		const createNextSession = this.#createNextSession;
		if (!createNextSession) {
			throw new Error("This RPC host cannot create a second session, so it cannot keep a turn running");
		}
		const limit = this.#limit();
		const next = await createNextSession();
		try {
			await this.#routing.adopt(next);
		} catch (error) {
			await next.session.dispose();
			throw error;
		}
		return this.#moveTo(next.session, limit);
	}

	/**
	 * Re-attach the background conversation writing to `sessionPath`, and hand
	 * the driven session to the background in its place. Resolves `undefined`,
	 * attaching nothing, when no conversation here writes that file.
	 */
	reclaim(sessionPath: string): BackgroundHandoff | undefined {
		if (!this.#keeper.find(sessionPath)) return undefined;
		// Read before the take: an invalid limit throws while the conversation is
		// still registered, instead of after it left the set with nothing attached.
		const limit = this.#limit();
		const live = this.#keeper.take(sessionPath);
		if (!live) return undefined;
		return this.#moveTo(live, limit);
	}

	#limit(): number {
		const limit = this.#session.settings.get("session.backgroundLimit");
		assertBackgroundLimit(limit);
		return limit;
	}

	#moveTo(next: AgentSession, limit: number): BackgroundHandoff {
		const kept = this.#keeper.keep(this.#session, limit);
		this.#unroute();
		this.#session = next;
		this.#unroute = this.#routing.route(next);
		return backgroundHandoff(kept, limit);
	}
}
