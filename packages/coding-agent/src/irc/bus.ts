/**
 * IrcBus - Process-global mailbox bus for agent-to-agent messaging.
 *
 * Replaces the old auto-reply model: a `send` never blocks on the recipient
 * generating anything. Delivery resolves the recipient via the global
 * AgentRegistry — parked agents are revived through the
 * AgentLifecycleManager, idle agents are woken with a real turn, and busy
 * agents receive the message as a non-interrupting aside at the next step
 * boundary (see AgentSession.deliverIrcMessage). Replies are real turns by
 * the recipient, observed via `wait` — with one exception: when the sender
 * awaits a reply and the recipient cannot run a real reply turn in time
 * (mid-turn with async execution disabled — possibly blocked in a
 * synchronous task spawn whose batch includes the sender — or idle in plan
 * mode, where autonomous wake turns are suppressed), the recipient session
 * generates an ephemeral side-channel auto-reply.
 */

import { type InstrumentationLevel, sessionTelemetryDetail } from "@veyyon/ai/instrumentation";
import { errorMessage, logger, Snowflake } from "@veyyon/utils";
import { settingsOrNull } from "../config/settings-instance";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { type AgentKind, AgentRegistry } from "../registry/agent-registry";
import type { CustomMessage } from "../session/messages";

export interface IrcMessage {
	id: string;
	/** Sender agent id. */
	from: string;
	/** Recipient agent id (resolved; "all" is expanded by the tool, not stored). */
	to: string;
	body: string;
	ts: number;
	/** Message id being answered. */
	replyTo?: string;
}

export interface IrcDeliveryReceipt {
	to: string;
	outcome: "injected" | "woken" | "revived" | "failed";
	error?: string;
}

/** The delivery path taken inside the bus. */
export type IrcDeliveryRoute = "refused" | "waiter" | "injected" | "wake" | "revival" | "buffered" | "unavailable";

/** Recipient classification without persisting its agent id. */
export type IrcRecipientClass = AgentKind | "unknown";

/**
 * Structured, content-free facts about one exactly-once IRC delivery attempt.
 *
 * `rich` is deliberately small: the canonical agent-communication policy
 * admits the category at rich, but identifiers, routes, and timings are kept
 * for ultra. Optional ultra fields also keep old JSONL readers compatible.
 */
export interface IrcDeliveryTelemetry {
	level: "rich" | "ultra";
	outcome: IrcDeliveryReceipt["outcome"];
	/** UTF-8 byte count of the message payload; never the payload itself. */
	payloadBytes: number;
	/** Ultra: sender agent id. */
	sender?: string;
	/** Ultra: coarse recipient kind, not its id. */
	recipientClass?: IrcRecipientClass;
	/** Ultra: hand-off path through refusal, wait, wake, live injection, revival, or buffering. */
	route?: IrcDeliveryRoute;
	/** Ultra: whether a parked recipient was revived before hand-off. */
	revived?: boolean;
	/** Ultra: end-to-end send-to-record latency, in milliseconds. */
	deliveryLatencyMs?: number;
	/** Ultra: derived only from the already-represented reply relationship. */
	messageKind?: "message" | "reply";
}

/** Complete content-free facts before a participant's policy projects rich or ultra fields. */
export interface IrcDeliveryFacts {
	outcome: IrcDeliveryReceipt["outcome"];
	payloadBytes: number;
	sender: string;
	recipientClass: IrcRecipientClass;
	route: IrcDeliveryRoute;
	revived: boolean;
	deliveryLatencyMs: number;
	messageKind: "message" | "reply";
}

/** Complete directional facts offered to one participant for policy-gated persistence. */
export interface IrcPersistedDeliveryFacts extends IrcDeliveryFacts {
	messageId: string;
	direction: "sent" | "received";
}

/** Directional JSONL record written to one participating agent session. */
export interface IrcPersistedDeliveryTelemetry extends IrcDeliveryTelemetry {
	/** Shared across sent/received records for cross-session deduplication. */
	messageId: string;
	/** This session's role in the delivery. */
	direction: "sent" | "received";
}

interface IrcDeliveryAttempt extends IrcDeliveryReceipt {
	recipientClass: IrcRecipientClass;
	route: IrcDeliveryRoute;
	revived: boolean;
}

/** Project complete facts to the fields admitted by one instrumentation level. */
export function projectIrcDeliveryTelemetry(level: "rich" | "ultra", facts: IrcDeliveryFacts): IrcDeliveryTelemetry {
	const telemetry: IrcDeliveryTelemetry = {
		level,
		outcome: facts.outcome,
		payloadBytes: facts.payloadBytes,
	};
	if (level === "ultra") {
		telemetry.sender = facts.sender;
		telemetry.recipientClass = facts.recipientClass;
		telemetry.route = facts.route;
		telemetry.revived = facts.revived;
		telemetry.deliveryLatencyMs = facts.deliveryLatencyMs;
		telemetry.messageKind = facts.messageKind;
	}
	return telemetry;
}

/**
 * One line of the bus's own record of the traffic: the message and how it
 * landed.
 *
 * The mailboxes cannot serve this. A mailbox is a QUEUE -- `wait`, `inbox` and
 * the live hand-off all remove the message as they consume it -- so a surface
 * reading mailboxes sees only what has not been delivered yet, which on a
 * healthy run is nothing. Watching agents talk needs a record that delivery
 * does not erase, and it belongs to the bus rather than to whichever pane
 * happens to be open, so a pane opened mid-run still shows what was already
 * said.
 */
export interface IrcLogEntry {
	message: IrcMessage;
	outcome: IrcDeliveryReceipt["outcome"];
	/** Present only on `failed`: why it did not reach the recipient. */
	error?: string;
	/** Content-free structured delivery facts, gated by session instrumentation. */
	telemetry?: IrcDeliveryTelemetry;
	/**
	 * The conversation this line belongs to, stamped at record time from the
	 * sender's (else the recipient's) {@link AgentRef.scope}.
	 *
	 * Recorded rather than re-derived, because an agent id is not a conversation
	 * key. The registry map holds one ref per id at a time, but ids are
	 * model-chosen task names and two conversations in one process routinely run
	 * a `Reviewer` each, sequentially or after a release. Re-deriving the owner
	 * of a historical line from today's registry therefore attributes it to
	 * whichever conversation happens to hold the name now, and the two readers
	 * of this log both did exactly that: the Comms pane filtered by current
	 * membership (so a released agent's last words vanished, and a stranger's
	 * survived under a recycled name) and `forgetAgents` deleted by bare id (so
	 * a `/new` in one conversation erased another's traffic). At record time
	 * both endpoints are registered, so the answer is known and cannot rot.
	 *
	 * Undefined when neither endpoint carried a scope. Treated as visible by
	 * `AgentRegistry.sameScope`, the same permissive rule the roster uses.
	 */
	scope?: string;
}

interface IrcWaiter {
	from?: string;
	resolve: (msg: IrcMessage) => void;
	cancel: () => void;
}

/** Mailbox cap per agent; oldest messages are dropped beyond it. */
const MAILBOX_CAP = 100;

/**
 * Traffic lines kept for the comms view. A cap, not a page: the log is read
 * from the newest end, and an unbounded one would grow for the life of a
 * process that may run for hours of continuous agent chatter.
 */
const LOG_CAP = 500;

export class IrcBus {
	static #global: IrcBus | undefined;

	static global(): IrcBus {
		if (!IrcBus.#global) {
			IrcBus.#global = new IrcBus();
		}
		return IrcBus.#global;
	}

	/** Reset the global bus. Test-only. */
	static resetGlobalForTests(): void {
		IrcBus.#global = undefined;
	}

	readonly #registry: AgentRegistry;
	readonly #lifecycle: () => AgentLifecycleManager;
	readonly #mailboxes = new Map<string, IrcMessage[]>();
	readonly #waiters = new Map<string, IrcWaiter[]>();
	readonly #log: IrcLogEntry[] = [];
	readonly #logListeners = new Set<(entry: IrcLogEntry) => void>();
	readonly #instrumentationLevel: () => InstrumentationLevel;

	constructor(
		registry: AgentRegistry = AgentRegistry.global(),
		lifecycle?: AgentLifecycleManager,
		instrumentationLevel: () => InstrumentationLevel = () =>
			settingsOrNull()?.get("session.instrumentation") ?? "off",
	) {
		this.#registry = registry;
		// Lazy: the lifecycle global self-constructs against the global registry,
		// so only touch it when a parked recipient actually needs reviving.
		this.#lifecycle = () => lifecycle ?? AgentLifecycleManager.global();
		this.#instrumentationLevel = instrumentationLevel;
	}

	/**
	 * Fire-and-forget delivery. Never blocks on the recipient generating
	 * anything: the receipt reports how the message reached the recipient
	 * (waiter/aside = "injected", idle wake = "woken", park revival =
	 * "revived"), not what they did with it.
	 *
	 * Mailbox semantics: a successfully delivered message never lingers in
	 * the recipient's mailbox — injection/wake puts the full body into their
	 * context, so buffering it too would double-deliver via a later
	 * `wait`/`inbox` and inflate unread counts. Only a failed live hand-off
	 * is buffered for the recipient to drain later.
	 *
	 * `opts.expectsReply` marks sends whose caller is blocked on an answer
	 * (`send await:true`). It is forwarded to the recipient session so a
	 * mid-turn recipient that cannot reach a step boundary (async execution
	 * disabled — e.g. blocked in a synchronous task spawn awaiting the
	 * sender's own batch) can generate an ephemeral side-channel auto-reply
	 * instead of stranding the sender until timeout.
	 *
	 * `opts.suppressRelay` skips the display-only main-UI relay for this leg.
	 * Set by broadcast fan-out when the same broadcast also targets the main
	 * agent directly: the main agent then already sees the body as its own
	 * incoming card, so relaying the sibling legs would duplicate it.
	 */
	async send(
		msg: Omit<IrcMessage, "id" | "ts">,
		opts?: { expectsReply?: boolean; suppressRelay?: boolean },
	): Promise<IrcDeliveryReceipt> {
		// One wrapper around the whole delivery, so the log gets every leg exactly
		// once. `#send` returns from seven places -- three refusals, the waiter
		// hand-off, the live delivery, and two failure paths -- and recording at
		// each of them is how a log silently loses the cases nobody tested.
		const message: IrcMessage = { ...msg, id: Snowflake.next(), ts: Date.now() };
		let attempt: IrcDeliveryAttempt;
		try {
			attempt = await this.#send(message, opts);
		} catch (error) {
			// `#send` reports its known failures as receipts, but the relay, the
			// waiter hand-off and the mailbox enqueue all sit outside its try
			// blocks. An unexpected throw there would leave a leg that was really
			// attempted absent from the log, which reads as a message nobody sent.
			// Recorded as the failure it is, then rethrown unchanged: the log is a
			// display feed and must not change what the caller sees.
			this.#record(
				{ message, outcome: "failed", error: errorMessage(error) },
				{ to: message.to, outcome: "failed", recipientClass: "unknown", route: "unavailable", revived: false },
			);
			throw error;
		}
		const receipt: IrcDeliveryReceipt =
			attempt.error === undefined
				? { to: attempt.to, outcome: attempt.outcome }
				: { to: attempt.to, outcome: attempt.outcome, error: attempt.error };
		this.#record({ message, outcome: receipt.outcome, error: receipt.error }, attempt);
		return receipt;
	}

	/**
	 * The bus's own record of the traffic, oldest first, capped at {@link LOG_CAP}.
	 *
	 * A copy: the array is handed to render paths that hold it across frames, and
	 * a live reference would mutate under them mid-render.
	 */
	log(): IrcLogEntry[] {
		return [...this.#log];
	}

	/**
	 * Subscribe to traffic as it happens. Returns the unsubscribe.
	 *
	 * A listener that throws must not break delivery -- it is a display feed --
	 * so a throw is logged loudly and the remaining listeners still run, rather
	 * than the send path unwinding into a caller that was only trying to talk to
	 * another agent.
	 */
	onMessage(listener: (entry: IrcLogEntry) => void): () => void {
		this.#logListeners.add(listener);
		return () => this.#logListeners.delete(listener);
	}

	/**
	 * Drop every trace of the named agents: their mailboxes, their pending
	 * waiters, and every traffic line they took part in.
	 *
	 * Called when a driving session re-roots to a different transcript (`/new`,
	 * `/resume`) and releases the subagents of the conversation it left. The
	 * registry refs go, but the bus is process-global and its log is not keyed by
	 * conversation, so without this the Comms stream of a brand-new session opens
	 * on the previous session's chatter between agents that no longer exist —
	 * which is exactly the "agents from another session" the scoping fixes
	 * everywhere else.
	 *
	 * `scope` is the conversation being torn down, and it BOUNDS the purge. The
	 * ids alone do not: they are model-chosen task names, so a `Reviewer` in the
	 * conversation that is ending names the same string as a `Reviewer` that
	 * another conversation in this process ran earlier, and an id-only filter
	 * deleted that stranger's lines too. Deleting another conversation's record
	 * is the same cross-conversation write the scoping exists to stop, pointed
	 * outward instead of inward. Omitting `scope` keeps the old unbounded
	 * behaviour, for a caller that genuinely has no conversation to name.
	 *
	 * Mailboxes and waiters are NOT scope-filtered, and must not be: the registry
	 * holds one ref per id at a time, so `#mailboxes.get(id)` is unambiguously
	 * the ref being released. That includes the releasing agent's OWN mailbox:
	 * the call site passes its own id deliberately. Unread mail addressed to the
	 * driving agent belongs to the conversation it was sent in, and draining it
	 * into the transcript that replaced it is exactly the leak, so dropping it is
	 * intended rather than collateral.
	 *
	 * A waiter is CANCELLED rather than dropped: it is a promise something is
	 * blocked on, and a released agent's `wait` must unblock rather than hang for
	 * the life of the process.
	 */
	forgetAgents(ids: Iterable<string>, scope?: string): void {
		const gone = new Set(ids);
		if (gone.size === 0) return;
		for (const id of gone) {
			this.#mailboxes.delete(id);
			// SNAPSHOT the array. `cancel` settles, and settling runs `cleanup`,
			// which splices this very array through `#removeWaiter`. Iterating it
			// live skipped every second waiter, and the `delete` below then made
			// the skipped ones unreachable, so a second concurrent
			// `irc wait timeoutMs:0` on a released agent hung for the life of the
			// process. That is the exact hang `cancel` was changed to prevent,
			// reintroduced one line away from the fix.
			for (const waiter of [...(this.#waiters.get(id) ?? [])]) waiter.cancel();
			this.#waiters.delete(id);
		}
		const kept = this.#log.filter(
			entry =>
				!AgentRegistry.sameScope(entry.scope, scope) ||
				(!gone.has(entry.message.from) && !gone.has(entry.message.to)),
		);
		if (kept.length !== this.#log.length) this.#log.splice(0, this.#log.length, ...kept);
	}

	#record(entry: IrcLogEntry, attempt: IrcDeliveryAttempt): void {
		// Stamped here and nowhere else: both endpoints are registered at the
		// moment a message is recorded, so this is the only place the answer is
		// known for certain. The sender first, since a send always originates from a
		// registered agent, with the recipient as the fallback for a synthetic
		// line whose sender has already gone.
		entry.scope ??= this.#scopeOf(entry.message);
		const facts: IrcDeliveryFacts = {
			outcome: attempt.outcome,
			payloadBytes: Buffer.byteLength(entry.message.body, "utf8"),
			sender: entry.message.from,
			recipientClass: attempt.recipientClass,
			route: attempt.route,
			revived: attempt.revived,
			deliveryLatencyMs: Math.max(0, Date.now() - entry.message.ts),
			messageKind: entry.message.replyTo === undefined ? "message" : "reply",
		};
		const detail = sessionTelemetryDetail(this.#instrumentationLevel(), "agent-communication");
		if (detail === "rich" || detail === "ultra") {
			entry.telemetry = projectIrcDeliveryTelemetry(detail, facts);
		}
		this.#persistTelemetry(entry.message.from, {
			...facts,
			messageId: entry.message.id,
			direction: "sent",
		});
		if (entry.message.to !== entry.message.from) {
			this.#persistTelemetry(entry.message.to, {
				...facts,
				messageId: entry.message.id,
				direction: "received",
			});
		}

		this.#log.push(entry);
		if (this.#log.length > LOG_CAP) this.#log.splice(0, this.#log.length - LOG_CAP);
		for (const listener of this.#logListeners) {
			try {
				listener(entry);
			} catch (error) {
				logger.warn("IrcBus: a traffic listener threw; delivery was unaffected", {
					from: entry.message.from,
					to: entry.message.to,
					error: String(error),
				});
			}
		}
	}

	#persistTelemetry(agentId: string, facts: IrcPersistedDeliveryFacts): void {
		try {
			const session = this.#registry.get(agentId)?.session;
			const persist = session?.recordIrcDeliveryTelemetry;
			if (typeof persist === "function") {
				persist.call(session, facts);
			}
		} catch (error) {
			// Session persistence is observability-only. A closed or mirrored
			// session must not turn successful message delivery into failure.
			logger.warn("IrcBus: session telemetry persistence failed; delivery was unaffected", {
				agentId,
				error: String(error),
			});
		}
	}

	/**
	 * The conversation a message belongs to: the sender's scope, else the
	 * recipient's.
	 *
	 * Never throws. One caller is `#record`, which runs on the failure path that
	 * exists precisely because a registry read can throw (a collab guest's
	 * mirrored registry). Letting it propagate would lose the log line for the
	 * one delivery that most needs recording, which is the bug the wrapper around
	 * `#send` was added to fix. An unattributed line is permissive and visible;
	 * a missing one is neither.
	 */
	#scopeOf(message: IrcMessage): string | undefined {
		try {
			return this.#registry.get(message.from)?.scope ?? this.#registry.get(message.to)?.scope;
		} catch {
			return undefined;
		}
	}

	async #send(
		message: IrcMessage,
		opts?: { expectsReply?: boolean; suppressRelay?: boolean },
	): Promise<IrcDeliveryAttempt> {
		const ref = this.#registry.get(message.to);
		if (!ref) {
			return {
				to: message.to,
				outcome: "failed",
				error: `Unknown agent "${message.to}" — check \`irc list\` for live peers.`,
				recipientClass: "unknown",
				route: "refused",
				revived: false,
			};
		}
		if (ref.status === "aborted") {
			return {
				to: message.to,
				outcome: "failed",
				error: `Agent "${message.to}" was hard-aborted and cannot be messaged or revived. Its transcript remains readable at history://${message.to}.`,
				recipientClass: ref.kind,
				route: "refused",
				revived: false,
			};
		}
		// Advisor refs are observability-only transcripts, never messageable peers.
		if (ref.kind === "advisor") {
			return {
				to: message.to,
				outcome: "failed",
				error: `Agent "${message.to}" is a read-only advisor transcript and cannot be messaged.`,
				recipientClass: ref.kind,
				route: "refused",
				revived: false,
			};
		}

		let revived = false;
		if (ref.status === "parked") {
			try {
				await this.#lifecycle().ensureLive(message.to);
				revived = true;
			} catch (error) {
				return {
					to: message.to,
					outcome: "failed",
					error: errorMessage(error),
					recipientClass: ref.kind,
					route: "revival",
					revived: false,
				};
			}
		}

		// A pending `wait` from the recipient consumes the message directly —
		// it is returned from their irc tool call and never hits the inbox or
		// the session injection path.
		const waiter = this.#takeMatchingWaiter(message.to, message.from);
		if (waiter) {
			waiter.resolve(message);
			if (!opts?.suppressRelay) this.#relayToMainUi(message, this.#scopeOf(message));
			return {
				to: message.to,
				outcome: revived ? "revived" : "injected",
				recipientClass: ref.kind,
				route: "waiter",
				revived,
			};
		}

		const session = this.#registry.get(message.to)?.session;
		if (!session) {
			return {
				to: message.to,
				outcome: "failed",
				error: `Agent "${message.to}" has no live session.`,
				recipientClass: ref.kind,
				route: "unavailable",
				revived,
			};
		}

		try {
			const delivery = await session.deliverIrcMessage(message, opts);
			if (!opts?.suppressRelay) this.#relayToMainUi(message, this.#scopeOf(message));
			return {
				to: message.to,
				outcome: revived ? "revived" : delivery,
				recipientClass: ref.kind,
				route: delivery === "woken" ? "wake" : "injected",
				revived,
			};
		} catch (error) {
			// Live hand-off failed (e.g. recipient disposed mid-shutdown): buffer
			// the message so a later `wait`/`inbox` from the recipient can still
			// pick it up. The receipt stays "failed" — the recipient has not
			// seen it.
			this.#enqueue(message);
			return {
				to: message.to,
				outcome: "failed",
				error: errorMessage(error),
				recipientClass: ref.kind,
				route: "buffered",
				revived,
			};
		}
	}

	/**
	 * Block until a message for `agentId` (optionally from `filter.from`)
	 * arrives; consume + return it. Null on timeout (`timeoutMs <= 0` waits
	 * forever). Rejects when `signal` aborts. By default, already-buffered
	 * mail satisfies the wait before parking a future waiter; callers that
	 * need a strictly future reply can disable that drain.
	 */
	async wait(
		agentId: string,
		filter: { from?: string },
		timeoutMs: number,
		signal?: AbortSignal,
		options?: { drainPending?: boolean; liveness?: { registry: AgentRegistry; senderId: string } },
	): Promise<IrcMessage | null> {
		if (signal?.aborted) {
			throw signal.reason instanceof Error ? signal.reason : new Error("IRC wait aborted");
		}

		if (options?.drainPending !== false) {
			// Already-pending mail satisfies the wait without parking a waiter.
			const pending = this.#takeFromMailbox(agentId, filter.from);
			if (pending) return pending;
		}

		const { promise, resolve, reject } = Promise.withResolvers<IrcMessage | null>();
		let timer: NodeJS.Timeout | undefined;
		let onAbort: (() => void) | undefined;
		let unsubscribeLiveness: (() => void) | undefined;

		const liveness = options?.liveness;
		const livenessReason = filter.from
			? `IRC wait aborted: agent "${filter.from}" is not running`
			: "IRC wait aborted: no running peers remain";

		const settle = (
			outcome: { kind: "message"; msg: IrcMessage } | { kind: "timeout" } | { kind: "abort"; error: Error },
		): void => {
			cleanup();
			if (outcome.kind === "message") {
				resolve(outcome.msg);
			} else if (outcome.kind === "timeout") {
				resolve(null);
			} else {
				reject(outcome.error);
			}
		};

		const cleanup = (): void => {
			this.#removeWaiter(agentId, waiter);
			clearTimeout(timer);
			if (signal && onAbort) signal.removeEventListener("abort", onAbort);
			unsubscribeLiveness?.();
		};

		const waiter: IrcWaiter = {
			from: filter.from,
			resolve: msg => settle({ kind: "message", msg }),
			// Settles, not merely cleans up. `cancel` had no caller until
			// `forgetAgents` gained one, and it was written as `cleanup()` alone:
			// that deregisters the waiter and clears the timer, which removes the
			// last thing that could ever have settled the promise, so the caller
			// blocked in `wait` hung for the life of the process. Resolving null is
			// the honest outcome and the one callers already handle: nothing is
			// coming, for the same reason a timeout means nothing is coming.
			cancel: () => settle({ kind: "timeout" }),
		};

		if (signal) {
			onAbort = () =>
				settle({
					kind: "abort",
					error: signal.reason instanceof Error ? signal.reason : new Error("IRC wait aborted"),
				});
			signal.addEventListener("abort", onAbort, { once: true });
		}
		if (timeoutMs > 0) {
			timer = setTimeout(() => settle({ kind: "timeout" }), timeoutMs);
			timer.unref?.();
		}

		let waiters = this.#waiters.get(agentId);
		if (!waiters) {
			waiters = [];
			this.#waiters.set(agentId, waiters);
		}
		waiters.push(waiter);

		if (liveness) {
			const { registry, senderId } = liveness;
			const hasRunningSender = (from?: string): boolean =>
				registry.listVisibleTo(senderId).some(ref => ref.status === "running" && (!from || ref.id === from));
			const check = filter.from ? () => hasRunningSender(filter.from) : () => hasRunningSender();
			unsubscribeLiveness = registry.onChange(() => {
				if (!check()) {
					settle({ kind: "abort", error: new Error(livenessReason) });
				}
			});
			if (!check()) {
				settle({ kind: "abort", error: new Error(livenessReason) });
			}
		}

		return promise;
	}

	/** Drain (or peek) pending messages for `agentId`. */
	inbox(agentId: string, opts?: { peek?: boolean }): IrcMessage[] {
		const mailbox = this.#mailboxes.get(agentId);
		if (!mailbox || mailbox.length === 0) return [];
		if (opts?.peek) return [...mailbox];
		this.#mailboxes.delete(agentId);
		return mailbox;
	}

	unreadCount(agentId: string): number {
		return this.#mailboxes.get(agentId)?.length ?? 0;
	}

	#enqueue(message: IrcMessage): void {
		let mailbox = this.#mailboxes.get(message.to);
		if (!mailbox) {
			mailbox = [];
			this.#mailboxes.set(message.to, mailbox);
		}
		mailbox.push(message);
		if (mailbox.length > MAILBOX_CAP) {
			const dropped = mailbox.shift();
			logger.debug("IrcBus: mailbox full, dropped oldest message", {
				agentId: message.to,
				droppedId: dropped?.id,
				droppedFrom: dropped?.from,
			});
		}
	}

	/** Resolve the OLDEST waiter for `agentId` whose from-filter accepts `from`. */
	#takeMatchingWaiter(agentId: string, from: string): IrcWaiter | undefined {
		const waiters = this.#waiters.get(agentId);
		if (!waiters) return undefined;
		const index = waiters.findIndex(waiter => !waiter.from || waiter.from === from);
		if (index === -1) return undefined;
		const [waiter] = waiters.splice(index, 1);
		if (waiters.length === 0) this.#waiters.delete(agentId);
		return waiter;
	}

	#removeWaiter(agentId: string, waiter: IrcWaiter): void {
		const waiters = this.#waiters.get(agentId);
		if (!waiters) return;
		const index = waiters.indexOf(waiter);
		if (index !== -1) waiters.splice(index, 1);
		if (waiters.length === 0) this.#waiters.delete(agentId);
	}

	#takeFromMailbox(agentId: string, from?: string): IrcMessage | undefined {
		const mailbox = this.#mailboxes.get(agentId);
		if (!mailbox) return undefined;
		const index = from ? mailbox.findIndex(msg => msg.from === from) : 0;
		if (index === -1 || mailbox.length === 0) return undefined;
		const [message] = mailbox.splice(index, 1);
		if (mailbox.length === 0) this.#mailboxes.delete(agentId);
		return message;
	}

	/**
	 * Surface agent↔agent traffic as a display-only card on the driving session's
	 * UI. Skipped when that agent is either endpoint: as recipient its own
	 * `deliverIrcMessage` (or `wait` tool result) already shows the message, and
	 * as sender the irc send tool call already rendered the outbound body, so
	 * relaying it again would duplicate it in the transcript.
	 *
	 * The driving session is resolved BY THE TRAFFIC'S OWN CONVERSATION, not by
	 * the literal id `Main`. Two things were wrong with the constant. It leaked:
	 * an ACP or SDK host runs several conversations at once, only one of which
	 * can hold the id `Main`, so every other conversation's agent chatter was
	 * pasted verbatim into that one operator's transcript. And it silently did
	 * nothing in the common headless case: an ACP root registers as
	 * `acp:<sessionId>`, so `Main` never resolved and the relay a multi-agent run
	 * depends on was simply absent.
	 */
	#relayToMainUi(message: IrcMessage, scope: string | undefined): void {
		// Exact scope first, then an unattributed root. Two roots can match the
		// permissive `sameScope` rule at once (a scoped conversation plus a
		// hand-built or mirrored ref that names none), and "whichever came first"
		// is the class of guess this whole change exists to remove.
		const roots = this.#registry.listInScope(scope).filter(ref => ref.kind === "main" && ref.session !== null);
		const root = roots.find(ref => ref.scope !== undefined && ref.scope === scope) ?? roots[0];
		if (!root?.session) return;
		if (message.to === root.id || message.from === root.id) return;
		const mainSession = root.session;
		const record: CustomMessage = {
			role: "custom",
			customType: "irc:relay",
			content: `[IRC \`${message.from}\` → \`${message.to}\`]\n\n${message.body}`,
			display: true,
			details: { from: message.from, to: message.to, body: message.body },
			attribution: "agent",
			timestamp: message.ts,
		};
		try {
			mainSession.emitIrcRelayObservation(record);
		} catch (error) {
			// Display-only forwarding must never affect delivery semantics, so the
			// throw is still swallowed. What is not acceptable is swallowing it
			// quietly: the message WAS delivered but never appeared in the
			// transcript, so the user watching a multi-agent run sees a gap with no
			// indication one exists, and reports agents that "stopped talking to each
			// other" when they did not (Law 10).
			logger.warn("Inter-agent message was delivered but could not be shown in the transcript", {
				from: message.from,
				to: message.to,
				error: String(error),
				impact: "Delivery was unaffected; only the display copy was lost.",
			});
		}
	}
}
