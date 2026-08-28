/** IrcBus - Process-global mailbox bus for agent-to-agent messaging. Replaces the old auto-reply model: a `send` never blocks on the recipient */

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

/** Structured, content-free facts about one exactly-once IRC delivery attempt. `rich` is deliberately small: the canonical agent-communication policy */
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

/** One line of the bus's own record of the traffic: the message and how it landed. */
export interface IrcLogEntry {
	message: IrcMessage;
	outcome: IrcDeliveryReceipt["outcome"];
	/** Present only on `failed`: why it did not reach the recipient. */
	error?: string;
	/** Content-free structured delivery facts, gated by session instrumentation. */
	telemetry?: IrcDeliveryTelemetry;
	/** The conversation this line belongs to, stamped at record time from the sender's (else the recipient's) {@link AgentRef.scope}. */
	scope?: string;
}

interface IrcWaiter {
	from?: string;
	resolve: (msg: IrcMessage) => void;
	cancel: () => void;
}

/** Mailbox cap per agent; oldest messages are dropped beyond it. */
const MAILBOX_CAP = 100;

/** Traffic lines kept for the comms view. A cap, not a page: the log is read from the newest end, and an unbounded one would grow for the life of a */
const LOG_CAP = 500;

/** Consecutive strictly-alternating messages allowed between one pair of agents before the bus stops carrying them. */
const PING_PONG_CAP = 16;

/** Who counts as alive for a blocking `wait`, so it ends when nobody can answer instead of burning its whole timeout. */
export interface IrcLivenessOptions {
	registry: AgentRegistry;
	senderId: string;
	mode?: "running" | "revivable";
}

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

	/** Fire-and-forget delivery. Never blocks on the recipient generating anything: the receipt reports how the message reached the recipient */
	async send(
		msg: Omit<IrcMessage, "id" | "ts">,
		opts?: { expectsReply?: boolean; suppressRelay?: boolean },
	): Promise<IrcDeliveryReceipt> {
		// One wrapper around the whole delivery, so the log gets every leg exactly once. `#send` returns from seven places -- three refusals, the waiter
		const message: IrcMessage = { ...msg, id: Snowflake.next(), ts: Date.now() };
		let attempt: IrcDeliveryAttempt;
		try {
			attempt = await this.#send(message, opts);
		} catch (error) {
			// `#send` reports its known failures as receipts, but the relay, the waiter hand-off and the mailbox enqueue all sit outside its try
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

	/** The bus's own record of the traffic, oldest first, capped at {@link LOG_CAP}. A copy: the array is handed to render paths that hold it across frames, and */
	log(): IrcLogEntry[] {
		return this.#log.slice();
	}

	/** Subscribe to traffic as it happens. Returns the unsubscribe. A listener that throws must not break delivery -- it is a display feed -- */
	onMessage(listener: (entry: IrcLogEntry) => void): () => void {
		this.#logListeners.add(listener);
		return () => this.#logListeners.delete(listener);
	}

	/** Drop every trace of the named agents: their mailboxes, their pending waiters, and every traffic line they took part in. */
	forgetAgents(ids: Iterable<string>, scope?: string): void {
		const gone = new Set(ids);
		if (gone.size === 0) return;
		for (const id of gone) {
			this.#mailboxes.delete(id);
			// SNAPSHOT the array. `cancel` settles, and settling runs `cleanup`, which splices this very array through `#removeWaiter`. Iterating it
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

	/** How many messages the tail of the traffic log has spent confined to `a` and `b`, counting back from the newest. */
	#pingPongLength(a: string, b: string): number {
		if (a === b) return 0;
		let length = 0;
		for (let index = this.#log.length - 1; index >= 0; index--) {
			const { from, to } = this.#log[index]!.message;
			if (from !== a && to !== a && from !== b && to !== b) continue;
			if (!((from === a && to === b) || (from === b && to === a))) break;
			length++;
		}
		return length;
	}

	#record(entry: IrcLogEntry, attempt: IrcDeliveryAttempt): void {
		// Stamped here and nowhere else: both endpoints are registered at the moment a message is recorded, so this is the only place the answer is
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

	/** The conversation a message belongs to: the sender's scope, else the recipient's. */
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
		// Checked after the recipient is known to exist and be messageable, so a
		// loop refusal never masks the more specific reason a send was doomed.
		if (this.#pingPongLength(message.from, message.to) >= PING_PONG_CAP) {
			return {
				to: message.to,
				outcome: "failed",
				error:
					`You and "${message.to}" have exchanged ${PING_PONG_CAP} messages in a row without either of you talking to anyone else, ` +
					"so this one was not delivered. Stop messaging that agent. Decide the open question yourself with the information you already have, " +
					"or report to whoever spawned you that the two of you cannot agree and name the specific decision you are stuck on.",
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
			// Live hand-off failed (e.g. recipient disposed mid-shutdown): buffer the message so a later `wait`/`inbox` from the recipient can still
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

	/** Block until a message for `agentId` (optionally from `filter.from`) arrives; consume + return it. Null on timeout (`timeoutMs <= 0` waits */
	async wait(
		agentId: string,
		filter: { from?: string },
		timeoutMs: number,
		signal?: AbortSignal,
		options?: { drainPending?: boolean; liveness?: IrcLivenessOptions },
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
		const livenessMode = liveness?.mode ?? "running";
		const livenessReason =
			livenessMode === "revivable"
				? `IRC wait aborted: agent "${filter.from}" has exited and cannot reply`
				: filter.from
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
			// Settles, not merely cleans up. `cancel` had no caller until `forgetAgents` gained one, and it was written as `cleanup()` alone:
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
			// `revivable` asks whether the peer could still answer, not whether it is answering now. A recipient that is idle or parked is woken by the
			const canStillReply = (from: string): boolean => {
				const ref = registry.get(from);
				return ref !== undefined && ref.status !== "aborted" && registry.canAddress(senderId, from);
			};
			const target = filter.from;
			const check =
				livenessMode === "revivable" && target
					? () => canStillReply(target)
					: target
						? () => hasRunningSender(target)
						: () => hasRunningSender();
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
		if (opts?.peek) return mailbox.slice();
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

	/** Surface agent↔agent traffic as a display-only card on the driving session's UI. Skipped when that agent is either endpoint: as recipient its own */
	#relayToMainUi(message: IrcMessage, scope: string | undefined): void {
		// Exact scope first, then an unattributed root. Two roots can match the permissive `sameScope` rule at once (a scoped conversation plus a
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
			// Display-only forwarding must never affect delivery semantics, so the throw is still swallowed. What is not acceptable is swallowing it
			logger.warn("Inter-agent message was delivered but could not be shown in the transcript", {
				from: message.from,
				to: message.to,
				error: String(error),
				impact: "Delivery was unaffected; only the display copy was lost.",
			});
		}
	}
}
