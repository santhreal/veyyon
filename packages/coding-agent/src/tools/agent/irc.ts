/**
 * IRC tool — agent-to-agent messaging over the process-global IrcBus.
 *
 * `send` is fire-and-forget: the bus routes the message to the recipient
 * (waking idle agents with a real turn, reviving parked ones via the
 * lifecycle manager, injecting a non-interrupting aside into busy ones) and
 * returns delivery receipts immediately. Replies are real turns by the
 * recipient, observed with `wait` (or the `await: true` send sugar). `inbox`
 * drains pending messages; `list` shows every addressable peer.
 */

import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@veyyon/agent-core";
import type { ToolExample } from "@veyyon/ai";
import { errorMessage, formatDuration, prompt } from "@veyyon/utils";
import { type } from "arktype";
import { toolsPrompts } from "../../prompts/tools/rows";
import type { AgentRegistry } from "../../registry/agent-registry";
import {
	IrcBus,
	type IrcDeliveryReceipt,
	type IrcMessage,
	type IrcRoomReceipt,
	ROOM_CHANNEL,
	ROOM_POST_MAX_CHARS,
	ROOM_WAKE_CAP,
	roomSeatLabel,
} from "../../task/irc-bus";
import type { ToolSession } from "..";

const DEFAULT_IRC_TIMEOUT_MS = 120_000;

/** When a conversation reads a `#room` post, as the poster's receipt says it. */
const ROOM_OUTCOME_TEXT: Record<IrcRoomReceipt["outcome"], string> = {
	working: "working; reads it at its next step",
	idle: "idle; reads it at its next turn",
	woken: "woken by it",
	failed: "failed",
};

// Re-exported for back-compat: the definition lives in the light module so the
// tool registry can gate irc without loading this implementation at boot.
import { isIrcEnabled } from "./irc-enabled";

export { isIrcEnabled };

const ircSchema = type({
	op: type("'send' | 'wait' | 'inbox' | 'list'").describe("irc operation"),
	"to?": type("string").describe('send: recipient agent id or "all"'),
	"message?": type("string").describe("send: message body"),
	"replyTo?": type("string").describe("send: message id being answered"),
	"await?": type("boolean").describe('send: wait for the recipient\'s reply (invalid with to:"all")'),
	"from?": type("string").describe("wait: only accept a message from this agent id"),
	"timeoutMs?": type("number").describe("wait: timeout in milliseconds (0 waits indefinitely)"),
	"peek?": type("boolean").describe("inbox: list messages without consuming them"),
});

export type IrcParams = typeof ircSchema.infer;

interface IrcPeerInfo {
	id: string;
	displayName: string;
	kind: string;
	status: string;
	parentId?: string;
	unread: number;
	lastActivity: number;
	activity?: string;
	/** True for a driving agent in the sender's room. See `AgentRegistry.peers`. */
	room?: true;
}

/** A conversation `#room` reaches, as `irc list` shows it. */
export interface IrcRoomSeat {
	id: string;
	/** How the room numbers it: `2 · parser whitespace`, or `conversation 2`. */
	label: string;
	/** The conversation that listed the room. */
	self?: true;
}

export interface IrcDetails {
	op: "send" | "wait" | "inbox" | "list";
	from?: string;
	to?: string;
	receipts?: IrcDeliveryReceipt[];
	/** What became of a `#room` post at each conversation it reached. */
	room?: IrcRoomReceipt[];
	/** Message consumed by `wait` / `send await:true`; null when the wait timed out. */
	waited?: IrcMessage | null;
	inbox?: IrcMessage[];
	peers?: IrcPeerInfo[];
	/** `list` from a driving agent in a room: every conversation `#room` reaches, in seat order. */
	seats?: IrcRoomSeat[];
}

function formatIncoming(msg: IrcMessage): string {
	const replyTag = msg.replyTo ? ` (reply to ${msg.replyTo})` : "";
	return `[${msg.id}] ${msg.from}${replyTag}: ${msg.body}`;
}

export class IrcTool implements AgentTool<typeof ircSchema, IrcDetails> {
	readonly name = "irc";
	readonly approval = "read" as const;
	readonly label = "IRC";
	readonly summary = "Send and receive messages between agents";
	readonly description: string;
	readonly parameters = ircSchema;
	readonly strict = true;
	// Only the ops that block observe an interrupt. `list`, `inbox`, a
	// fire-and-forget `send` and a `send` the tool rejects all return at once,
	// and handing those the IRC abort signal meant a peer message arriving in the
	// same batch replaced their result with a "skipped" placeholder: a malformed
	// send then read as an interrupted wait and the caller never saw what was
	// wrong with it.
	readonly interruptible = (args: Partial<IrcParams>): boolean =>
		args.op === "wait" || (args.op === "send" && args.await === true);

	readonly examples: readonly ToolExample<typeof ircSchema.infer>[] = [
		{
			caption: "Fire-and-forget DM — same send wakes idle/parked peers",
			call: {
				op: "send",
				to: "AuthLoader",
				message: "Still touching src/server/auth.ts? I need to add a 401 path.",
			},
		},
		{
			caption: "Round-trip when you cannot proceed without the answer",
			call: {
				op: "send",
				to: "Main",
				message: "JWT or session cookies for the auth flow?",
				await: true,
			},
		},
	];
	readonly loadMode = "discoverable";
	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(toolsPrompts["tools/irc"].text);
	}

	static createIf(session: ToolSession): IrcTool | null {
		if (!isIrcEnabled(session.settings, session.taskDepth ?? 0, session.maxNestedSpawnDepth)) return null;
		if (!session.agentRegistry || !session.getAgentId) return null;
		return new IrcTool(session);
	}

	async execute(
		_toolCallId: string,
		params: IrcParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<IrcDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<IrcDetails>> {
		const registry = this.session.agentRegistry;
		const senderId = this.session.getAgentId?.() ?? null;
		if (!registry) {
			return errorResult("IRC is unavailable in this session.", { op: params.op });
		}
		if (!senderId) {
			return errorResult("IRC is unavailable: caller has no agent id.", { op: params.op });
		}

		switch (params.op) {
			case "list":
				return this.#executeList(registry, senderId);
			case "send":
				return this.#executeSend(registry, senderId, params, signal);
			case "wait":
				return this.#executeWait(registry, senderId, params, signal);
			case "inbox":
				return this.#executeInbox(registry, senderId, params);
			default:
				return errorResult("Unknown irc op.", { op: params.op });
		}
	}

	#executeList(registry: AgentRegistry, senderId: string): AgentToolResult<IrcDetails> {
		const bus = IrcBus.global();
		// ONE call, and the registry owns what it means. This is the roster the
		// MODEL reads, and the ids it hands back are the ids the model then
		// messages, so an unfiltered list is not a display bug: it is how a
		// spawned agent from a conversation the operator closed gets woken to answer a
		// question about work it never did.
		//
		// `listAddressableBy` is built on the same `canAddress` decision that the
		// send below consults, so the roster can no longer offer a peer the send
		// would refuse, or withhold one it would accept. It replaces a hand-rolled
		// pair of filters that restated the caller, advisor and scope rules a
		// second time; two spellings of one rule is how the drift starts. Parked
		// peers are listed because messaging one revives it, which is supported.
		const peerIds = new Set(registry.peers(senderId).map(ref => ref.id));
		const peers = registry.listAddressableBy(senderId).map(ref => ({
			id: ref.id,
			displayName: ref.displayName,
			kind: ref.kind,
			status: ref.status,
			parentId: ref.parentId,
			unread: bus.unreadCount(ref.id),
			lastActivity: ref.lastActivity,
			activity: ref.activity,
			// A driving agent beside this one in the terminal. Not a spawn, not a
			// parent: it has its own conversation and its own spawns, and a message
			// to it wakes a session the operator can switch to.
			room: peerIds.has(ref.id) || undefined,
		}));
		const lines: string[] = [];
		if (peers.length === 0) {
			lines.push("No other agents.");
		} else {
			lines.push(`${peers.length} peer(s):`);
			for (const peer of peers) {
				const extras = [
					peer.room ? "room peer: a driving agent beside this conversation, not a subordinate" : undefined,
					peer.activity || undefined,
					peer.unread > 0 ? `unread ${peer.unread}` : undefined,
					peer.parentId ? `parent ${peer.parentId}` : undefined,
					`active ${formatDuration(Date.now() - peer.lastActivity)} ago`,
				].filter(Boolean);
				lines.push(`- ${peer.id} [${peer.displayName} · ${peer.kind} · ${peer.status}] — ${extras.join(", ")}`);
			}
			if (peers.some(peer => peer.status === "parked")) {
				lines.push("");
				lines.push("Parked agents are revived automatically when you message them.");
			}
			if (peerIds.size > 0) {
				lines.push("");
				lines.push('`to: "all"` reaches your own spawns only; address a room peer by its id.');
			}
		}
		// A driving agent in a room also reaches the room's channel. Listed by
		// seat, the numbers `@2` and the room view use, and on one line: the
		// `- ` rows above are the ids a direct send takes.
		const own = registry.get(senderId);
		const seats =
			own?.kind === "main" && own.room !== undefined
				? registry.roomSeats(senderId).map(
						(ref, index): IrcRoomSeat => ({
							id: ref.id,
							label: roomSeatLabel(index + 1, ref),
							...(ref.id === senderId ? { self: true as const } : {}),
						}),
					)
				: undefined;
		if (seats) {
			const reach = seats.map(seat => `${seat.label} (${seat.id}${seat.self ? ", you" : ""})`).join("; ");
			lines.push("");
			lines.push(
				`${ROOM_CHANNEL}: ${reach}. \`to: "${ROOM_CHANNEL}"\` posts to all of them; an idle one reads it at its next turn, or now when the post names it (\`@2\`).`,
			);
		}
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { op: "list", from: senderId, peers, ...(seats ? { seats } : {}) },
		};
	}

	async #executeSend(
		registry: AgentRegistry,
		senderId: string,
		params: IrcParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<IrcDetails>> {
		const requested = params.to?.trim();
		const message = params.message?.trim();
		if (!requested) {
			return errorResult('`to` is required for op="send".', { op: "send", from: senderId });
		}
		// The model is told to address a driving agent as `Main`. That is a role,
		// not a key: a process running two conversations has one of each, so the
		// name is resolved against the sender's own conversation and a message
		// written here cannot land in another one's driving session. A name that
		// resolves to nothing is passed through as written, so the bus keeps
		// ownership of the "no such peer" answer instead of this tool guessing.
		const to = registry.resolveId(requested, registry.scopeOf(senderId))?.id ?? requested;
		if (!message) {
			return errorResult('`message` is required for op="send".', { op: "send", from: senderId });
		}
		if (requested === ROOM_CHANNEL) {
			return this.#executeRoomPost(registry, senderId, message, params);
		}
		if (to === senderId) {
			return errorResult("Cannot send an IRC message to yourself.", { op: "send", from: senderId, to });
		}
		const isBroadcast = to === "all";
		if (isBroadcast && params.await) {
			return errorResult('`await` is invalid with to:"all" — broadcasts have no single replier.', {
				op: "send",
				from: senderId,
				to,
			});
		}

		const bus = IrcBus.global();
		let waited: IrcMessage | null | undefined;
		const timeoutMs = params.await ? this.#resolveTimeoutMs(params) : undefined;
		const awaitAbort = params.await ? new AbortController() : undefined;
		const awaitCancelled = new Error("IRC await cancelled");
		let removeAwaitAbortListener: (() => void) | undefined;
		const waiting = params.await
			? bus
					.wait(senderId, { from: to }, timeoutMs ?? DEFAULT_IRC_TIMEOUT_MS, awaitAbort?.signal, {
						drainPending: false,
						liveness: { registry, senderId, mode: "revivable" },
					})
					.then(
						message => ({ message, error: null as Error | null }),
						error => ({
							message: null,
							error: error === awaitCancelled ? null : error instanceof Error ? error : new Error(String(error)),
						}),
					)
			: undefined;
		if (params.await && signal && awaitAbort) {
			if (signal.aborted) {
				awaitAbort.abort(signal.reason instanceof Error ? signal.reason : new Error("IRC wait aborted"));
			} else {
				const onAbort = (): void => {
					awaitAbort.abort(signal.reason instanceof Error ? signal.reason : new Error("IRC wait aborted"));
				};
				signal.addEventListener("abort", onAbort, { once: true });
				removeAwaitAbortListener = () => signal.removeEventListener("abort", onAbort);
			}
		}

		try {
			// Broadcasts fan out to running peers only; reviving every parked agent or
			// waking completed/idle agents on a broadcast would restart finished spawned agents
			// and cause stampedes. Direct sends still go through the bus so an idle
			// recipient is woken and a parked recipient is revived, but only where
			// `canAddress` says the caller may reach it: `bus.send` revives whatever
			// id it is handed, so an unguarded directed send is the one path that
			// can wake an agent belonging to a transcript the operator already left,
			// and have it answer into that transcript. Refused by name rather than
			// silently dropped, because a send that reports success and reaches
			// nobody is worse than one that says who it could not find.
			//
			// The SAME predicate the roster above is built from, so "listed" and
			// "reachable" cannot disagree. Unknown ids still fall through to the
			// bus, which owns that message and distinguishes it from a refusal.
			if (!isBroadcast && registry.get(to) && !registry.canAddress(senderId, to)) {
				return errorResult(
					`Agent "${to}" cannot be messaged from this conversation. Run \`irc list\` for the peers of this session.`,
					{ op: "send", to },
				);
			}
			// `to: "all"` is this conversation's spawns. A room peer is reachable by
			// id and is listed, but a broadcast that woke every driving agent in the
			// terminal would charge each of them a turn for a message meant for the
			// sender's own tree.
			const targetRefs = isBroadcast
				? registry
						.listVisibleTo(senderId)
						.filter(ref => ref.status === "running" && !registry.isPeer(senderId, ref.id))
				: [];
			const targets = isBroadcast ? targetRefs.map(ref => ref.id) : [to];
			// A broadcast that also reaches a driving agent delivers the body to it
			// directly (its own incoming card); relaying the sibling legs to the
			// main UI would then show the same body once per other recipient.
			// Matched by role, because a driving agent's id names its conversation.
			const suppressRelay = targetRefs.some(ref => ref.kind === "main");
			const receipts = await Promise.all(
				targets.map(target =>
					bus.send(
						{ from: senderId, to: target, body: message, replyTo: params.replyTo },
						// Awaited sends mark the sender as blocked on an answer so a
						// busy recipient that cannot reach a step boundary (async
						// disabled) auto-replies instead of stranding the sender.
						{ expectsReply: params.await || undefined, suppressRelay: suppressRelay || undefined },
					),
				),
			);

			const lines: string[] = [];
			const delivered = receipts.filter(receipt => receipt.outcome !== "failed");
			if (targets.length === 0) {
				lines.push("No live peers to broadcast to.");
			} else if (delivered.length === 0) {
				lines.push("No recipients received the message.");
			} else {
				lines.push(`Delivered to ${delivered.length} peer(s):`);
			}
			for (const receipt of receipts) {
				lines.push(
					receipt.outcome === "failed"
						? `- ${receipt.to}: failed — ${receipt.error ?? "unknown error"}`
						: `- ${receipt.to}: ${receipt.outcome}`,
				);
			}

			if (params.await && waiting && timeoutMs !== undefined) {
				lines.push("");
				if (delivered.length > 0) {
					const reply = await waiting;
					if (reply.error) {
						// The send already succeeded; if the wait was interrupted by our
						// caller signal (steering / IRC), preserve the delivery receipt so
						// the agent loop keeps this tool as "sent" instead of marking it
						// skipped, which would prompt a duplicate resend on the next turn.
						if (signal?.aborted) {
							lines.push(
								`Send delivered but the reply wait was interrupted before ${to} answered. ` +
									"Check `inbox` or `wait` again after handling the interrupt.",
							);
						} else {
							throw reply.error;
						}
					} else {
						waited = reply.message;
						if (waited) {
							lines.push(`Reply from ${waited.from}:`);
							lines.push(waited.body);
						} else {
							lines.push(
								`No reply from ${to} within ${formatDuration(timeoutMs)}. ` +
									"They may answer later — check `inbox` or `wait` again.",
							);
						}
					}
				} else {
					awaitAbort?.abort(awaitCancelled);
					const reply = await waiting;
					if (reply.error) throw reply.error;
				}
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					op: "send",
					from: senderId,
					to,
					receipts,
					...(waited !== undefined ? { waited } : {}),
				},
				isError: delivered.length === 0 && targets.length > 0,
			};
		} finally {
			awaitAbort?.abort(awaitCancelled);
			removeAwaitAbortListener?.();
		}
	}

	/**
	 * `to: "#room"`: one post to every driving conversation in the sender's
	 * room. The bus decides who may post and who wakes; this words its answer.
	 * A spawned agent is refused with the one address it has for news, its
	 * parent, which decides what the room hears.
	 */
	#executeRoomPost(
		registry: AgentRegistry,
		senderId: string,
		message: string,
		params: IrcParams,
	): AgentToolResult<IrcDetails> {
		const refuse = (text: string): AgentToolResult<IrcDetails> =>
			errorResult(text, { op: "send", from: senderId, to: ROOM_CHANNEL });
		if (params.await) {
			return refuse(`\`await\` is invalid with to:"${ROOM_CHANNEL}": a room post has no single replier.`);
		}
		if (params.replyTo) {
			return refuse(
				`\`replyTo\` answers a direct message. A ${ROOM_CHANNEL} post is read by the whole room, so say in its body what it answers.`,
			);
		}
		const post = IrcBus.global().postToRoom({ member: senderId, body: message });
		if (!post.posted) {
			if (post.reason === "not-a-driver") {
				const parent = registry.get(senderId)?.parentId;
				return refuse(
					`${ROOM_CHANNEL} is the channel between a room's driving conversations, and a spawned agent does not post to it. ` +
						`Report to your parent${parent ? ` \`${parent}\`` : ""} instead; it decides what the room hears.`,
				);
			}
			if (post.reason === "too-long") {
				return refuse(
					`A ${ROOM_CHANNEL} post holds at most ${ROOM_POST_MAX_CHARS} characters and this one has ${message.length}: every conversation in the room pays for it. Write the detail to a file and post its path.`,
				);
			}
			return refuse(
				`This conversation is in no room, so ${ROOM_CHANNEL} reaches nobody. A room exists once a second conversation is opened beside this one.`,
			);
		}
		const lines: string[] = [];
		if (post.receipts.length === 0) {
			lines.push(`Posted to ${ROOM_CHANNEL}. No other conversation is in the room now; one that joins reads it.`);
		} else {
			lines.push(`Posted to ${ROOM_CHANNEL}:`);
			for (const receipt of post.receipts) {
				const error = receipt.error ? ` — ${receipt.error}` : "";
				lines.push(`- ${receipt.label} (${receipt.to}): ${ROOM_OUTCOME_TEXT[receipt.outcome]}${error}`);
			}
		}
		if (post.wakeHeld) {
			lines.push("");
			lines.push(
				`A conversation the post names stayed idle and reads it at its next turn: ${ROOM_WAKE_CAP} posts in a row have woken one without the operator posting to the room.`,
			);
		}
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { op: "send", from: senderId, to: ROOM_CHANNEL, room: post.receipts },
			isError: post.receipts.length > 0 && post.receipts.every(receipt => receipt.outcome === "failed"),
		};
	}

	async #executeWait(
		registry: AgentRegistry,
		senderId: string,
		params: IrcParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<IrcDetails>> {
		const from = params.from?.trim() || undefined;
		const session = registry.get(senderId)?.session;
		const pending =
			typeof session?.drainPendingIrcInboxMessages === "function"
				? session.drainPendingIrcInboxMessages(senderId, { from, limit: 1 })[0]
				: undefined;
		if (pending) {
			return {
				content: [{ type: "text", text: formatIncoming(pending) }],
				details: { op: "wait", from: senderId, waited: pending },
			};
		}
		const timeoutMs = this.#resolveTimeoutMs(params);
		try {
			const waited = await IrcBus.global().wait(senderId, { from }, timeoutMs, signal, {
				liveness: { registry, senderId },
			});
			if (!waited) {
				const filterNote = from ? ` from ${from}` : "";
				return {
					content: [{ type: "text", text: `No message${filterNote} within ${formatDuration(timeoutMs)}.` }],
					details: { op: "wait", from: senderId, waited: null },
					// A clean wait timeout carries no information once consumed.
					useless: true,
				};
			}
			return {
				content: [{ type: "text", text: formatIncoming(waited) }],
				details: { op: "wait", from: senderId, waited },
			};
		} catch (error) {
			if (signal?.aborted) {
				throw error;
			}
			return errorResult(errorMessage(error), { op: "wait", from: senderId });
		}
	}

	#executeInbox(registry: AgentRegistry, senderId: string, params: IrcParams): AgentToolResult<IrcDetails> {
		const busMessages = IrcBus.global().inbox(senderId, { peek: params.peek });
		const session = registry.get(senderId)?.session;
		const pendingMessages =
			typeof session?.drainPendingIrcInboxMessages === "function"
				? session.drainPendingIrcInboxMessages(senderId)
				: [];
		const messages = busMessages.concat(pendingMessages).sort((a, b) => a.ts - b.ts);
		if (messages.length === 0) {
			return {
				content: [{ type: "text", text: "Inbox empty." }],
				details: { op: "inbox", from: senderId, inbox: [] },
				// An empty inbox drain carries no information once consumed.
				useless: true,
			};
		}
		const header = params.peek ? `${messages.length} unread message(s):` : `${messages.length} message(s):`;
		const lines = [header, ...messages.map(msg => `- ${formatIncoming(msg)}`)];
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { op: "inbox", from: senderId, inbox: messages },
		};
	}

	#resolveTimeoutMs(params: IrcParams): number {
		if (params.timeoutMs !== undefined) {
			return normalizeIrcTimeoutMs(params.timeoutMs);
		}
		return normalizeIrcTimeoutMs(this.session.settings.get("irc.timeoutMs"));
	}
}

function errorResult(text: string, details: IrcDetails): AgentToolResult<IrcDetails> {
	return {
		content: [{ type: "text", text }],
		details,
		isError: true,
	};
}

function normalizeIrcTimeoutMs(value: number): number {
	if (value === 0) return 0; // 0 = timeout disabled
	// Negative or non-finite settings are misconfigurations — fall back to the
	// default instead of producing an instant 1 ms timeout.
	if (!Number.isFinite(value) || value < 0) return DEFAULT_IRC_TIMEOUT_MS;
	return Math.max(1, Math.trunc(value));
}
