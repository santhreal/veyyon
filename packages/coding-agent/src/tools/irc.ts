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
import { IrcBus, type IrcDeliveryReceipt, type IrcMessage } from "../irc/bus";
import { toolsPrompts } from "../prompts/tools/rows";
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import type { ToolSession } from ".";

const DEFAULT_IRC_TIMEOUT_MS = 120_000;

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
}

export interface IrcDetails {
	op: "send" | "wait" | "inbox" | "list";
	from?: string;
	to?: string;
	receipts?: IrcDeliveryReceipt[];
	/** Message consumed by `wait` / `send await:true`; null when the wait timed out. */
	waited?: IrcMessage | null;
	inbox?: IrcMessage[];
	peers?: IrcPeerInfo[];
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
	readonly interruptible = true;

	readonly examples: readonly ToolExample<typeof ircSchema.infer>[] = [
		{
			caption: "List peers",
			call: { op: "list" },
		},
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
		{
			caption: "Block until a specific peer answers",
			call: { op: "wait", from: "AuthLoader", timeoutMs: 60000 },
		},
		{
			caption: "Drain pending messages",
			call: { op: "inbox" },
		},
		{
			caption: "Broadcast to live peers (no replies expected)",
			call: {
				op: "send",
				to: "all",
				message: "About to refactor src/server/middleware/*. Anyone already in there?",
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
		// Scoped to the caller's conversation, and scoped HERE rather than only in
		// the surfaces a human looks at. This is the roster the MODEL reads, and
		// the ids it hands back are the ids the model then messages, so an
		// unfiltered list is not a display bug: it is how a subagent from a
		// conversation the operator closed gets woken to answer a question about
		// work it never did. `listVisibleTo` already excludes the caller, advisors
		// and dead agents, so the hand-rolled filter it replaces is now only the
		// `parked` case, which stays listed because messaging a parked peer is a
		// supported revival.
		const visible = registry.listVisibleTo(senderId);
		const parked = registry
			.listInScope(registry.get(senderId)?.scope)
			.filter(ref => ref.id !== senderId && ref.kind !== "advisor" && ref.status === "parked");
		const peers = [...visible, ...parked].map(ref => ({
			id: ref.id,
			displayName: ref.displayName,
			kind: ref.kind,
			status: ref.status,
			parentId: ref.parentId,
			unread: bus.unreadCount(ref.id),
			lastActivity: ref.lastActivity,
			activity: ref.activity,
		}));
		const lines: string[] = [];
		if (peers.length === 0) {
			lines.push("No other agents.");
		} else {
			lines.push(`${peers.length} peer(s):`);
			for (const peer of peers) {
				const extras = [
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
		}
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { op: "list", from: senderId, peers },
		};
	}

	async #executeSend(
		registry: AgentRegistry,
		senderId: string,
		params: IrcParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<IrcDetails>> {
		const to = params.to?.trim();
		const message = params.message?.trim();
		if (!to) {
			return errorResult('`to` is required for op="send".', { op: "send", from: senderId });
		}
		if (!message) {
			return errorResult('`message` is required for op="send".', { op: "send", from: senderId });
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
			// Broadcasts fan out to live peers only (running | idle); reviving every
			// parked agent on a broadcast would be a stampede. Direct sends still go
			// through the bus so a parked recipient IS revived, but only inside the
			// caller's own conversation: `bus.send` revives whatever id it is
			// handed, so an unscoped directed send is the one path that can wake an
			// agent belonging to a transcript the operator already left, and have it
			// answer into that transcript. Refused by name rather than silently
			// dropped, because a send that reports success and reaches nobody is
			// worse than one that says who it could not find.
			if (!isBroadcast && !AgentRegistry.sameScope(registry.get(to)?.scope, registry.get(senderId)?.scope)) {
				return errorResult(
					`Agent "${to}" belongs to a different conversation and cannot be messaged from this one. Run \`irc list\` for the peers of this session.`,
					{ op: "send", to },
				);
			}
			const targets = isBroadcast ? registry.listVisibleTo(senderId).map(ref => ref.id) : [to];
			// A broadcast that also reaches the main agent delivers the body to it
			// directly (its own incoming card); relaying the sibling legs to the
			// main UI would then show the same body once per other recipient.
			const suppressRelay = isBroadcast && targets.includes(MAIN_AGENT_ID);
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
		const messages = [...busMessages, ...pendingMessages].sort((a, b) => a.ts - b.ts);
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

// The TUI renderer lives in `irc-render.ts` (light module, boot-path safe);
// re-exported here so the library surface and existing importers keep working.
export { createIrcMessageCard, ircToolRenderer } from "./irc-render";
