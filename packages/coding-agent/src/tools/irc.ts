/** IRC tool — agent-to-agent messaging over the process-global IrcBus. `send` is fire-and-forget: the bus routes the message to the recipient */

import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@veyyon/agent-core";
import type { ToolExample } from "@veyyon/ai";
import { errorMessage, formatDuration, prompt } from "@veyyon/utils";
import { type } from "arktype";
import { IrcBus, type IrcDeliveryReceipt, type IrcMessage } from "../irc/bus";
import { toolsPrompts } from "../prompts/tools/rows";
import type { AgentRegistry } from "../registry/agent-registry";
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
	// Only the ops that block observe an interrupt. `list`, `inbox`, a fire-and-forget `send` and a `send` the tool rejects all return at once,
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
		// ONE call, and the registry owns what it means. This is the roster the MODEL reads, and the ids it hands back are the ids the model then
		const peers = registry.listAddressableBy(senderId).map(ref => ({
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
		const requested = params.to?.trim();
		const message = params.message?.trim();
		if (!requested) {
			return errorResult('`to` is required for op="send".', { op: "send", from: senderId });
		}
		// The model is told to address a driving agent as `Main`. That is a role, not a key: a process running two conversations has one of each, so the
		const to = registry.resolveId(requested, registry.scopeOf(senderId))?.id ?? requested;
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
			// Broadcasts fan out to running peers only; reviving every parked agent or waking completed/idle agents on a broadcast would restart finished subagents
			if (!isBroadcast && registry.get(to) && !registry.canAddress(senderId, to)) {
				return errorResult(
					`Agent "${to}" cannot be messaged from this conversation. Run \`irc list\` for the peers of this session.`,
					{ op: "send", to },
				);
			}
			const targetRefs = isBroadcast ? registry.listVisibleTo(senderId).filter(ref => ref.status === "running") : [];
			const targets = isBroadcast ? targetRefs.map(ref => ref.id) : [to];
			// A broadcast that also reaches a driving agent delivers the body to it directly (its own incoming card); relaying the sibling legs to the
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
						// The send already succeeded; if the wait was interrupted by our caller signal (steering / IRC), preserve the delivery receipt so
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

// The TUI renderer lives in `irc-render.ts` (light module, boot-path safe);
// re-exported here so the library surface and existing importers keep working.
export { createIrcMessageCard, ircToolRenderer } from "./irc-render";
