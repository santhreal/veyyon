/**
 * The narrow session API a graphical front end drives.
 *
 * `AgentSession` exposes several hundred members because the terminal reaches
 * into every one of its subsystems. A front end that only sends text, shows
 * messages, answers a permission prompt and reports usage needs a fraction of
 * that, and coupling to the whole class means every internal rename reaches the
 * front end. `AgentSessionFacade` is that fraction, stated as an interface, with
 * one implementation over a live session.
 *
 * The facade owns the permission prompt. `start()` installs it as the session's
 * {@link ClientBridge}, so a tool that requires approval reaches
 * `requestPermission`, which is published as a `tool_call` carrying
 * `needsApproval: true` and held until {@link AgentSessionFacade.approveTool} or
 * {@link AgentSessionFacade.rejectTool} names its call id. A session that
 * already carries a bridge belongs to another host, and `start()` rejects
 * rather than displacing it.
 */

import type { AgentMessage, AgentToolResult } from "@veyyon/agent-core";
import type { ImageContent, Model } from "@veyyon/ai";
import type { ClientBridge, ClientBridgePermissionOutcome } from "@veyyon/kernel/session/client-bridge";
import { errorMessage, logger } from "@veyyon/utils";
import type { AgentSession } from "./agent-session";
import type { AgentSessionEvent } from "./agent-session-types";
import { USER_INTERRUPT_LABEL } from "./messages";

/** A tool call the session started, or is holding for approval. */
export interface FacadeToolCall {
	callId: string;
	toolName: string;
	args: unknown;
	/** What the call is about to do, when the tool describes itself. */
	intent?: string;
	/**
	 * True while the call is parked on {@link AgentSessionFacade.approveTool} or
	 * {@link AgentSessionFacade.rejectTool}. False for a call already running.
	 */
	needsApproval: boolean;
	/** Files the call names, for a front end that highlights them. */
	locations?: { path: string; line?: number }[];
}

/** The outcome of a tool call. */
export interface FacadeToolResult {
	callId: string;
	toolName: string;
	result: AgentToolResult<unknown>;
	isError: boolean;
}

/** Context consumption after a turn. */
export interface FacadeUsage {
	tokens: number;
	contextWindow: number;
	/** `tokens` as a percentage of `contextWindow`, or 0 when no window is known. */
	percent: number;
}

/**
 * What the session is doing, for a front end that shows a spinner or a label.
 *
 * `stopped` is terminal: it is published by {@link AgentSessionFacade.stop} and
 * is never followed by another activity.
 */
export type FacadeActivity = "idle" | "thinking" | "streaming" | "tool" | "compacting" | "retrying" | "stopped";

/** Event name → the payload its handler receives. */
export interface FacadeEventMap {
	message: AgentMessage;
	tool_call: FacadeToolCall;
	tool_result: FacadeToolResult;
	usage: FacadeUsage;
	status: FacadeActivity;
	error: Error;
}

export interface AgentSessionFacade {
	/** Subscribe to the session and take ownership of its permission prompt. */
	start(): Promise<void>;
	/** Release the subscription and dispose the session. Idempotent. */
	stop(): Promise<void>;
	readonly running: boolean;
	/** Send a user message, with optional image attachments. */
	submit(text: string, attachments?: ImageContent[]): Promise<void>;
	/**
	 * Abort the running turn as a user interrupt.
	 *
	 * The plan for this interface spelled this `void`; aborting a turn is
	 * asynchronous and can fail, and a `void` return would drop that failure.
	 */
	interrupt(): Promise<void>;
	/** Re-send the last turn. Resolves false when there was nothing to retry. */
	retry(): Promise<boolean>;
	/** Let a held tool call run. Returns false when no call is held under `callId`. */
	approveTool(callId: string): boolean;
	/** Refuse a held tool call. Returns false when no call is held under `callId`. */
	rejectTool(callId: string, reason?: string): boolean;
	/** Register a handler. The returned function removes it. */
	on<K extends keyof FacadeEventMap>(event: K, handler: (payload: FacadeEventMap[K]) => void): () => void;
	readonly model: Model | undefined;
	/** The provider the current model belongs to, or `""` before one is selected. */
	readonly provider: string;
	/** Context consumption as a percentage, or 0 when no window is known. */
	readonly contextUsage: number;
	readonly tokenCount: number;
}

/**
 * The rung a permission prompt selects when a front end approves or refuses a
 * single call. `test/architecture/the-session-facade-is-narrow.test.ts` pins that
 * `PERMISSION_OPTIONS` still carries both, so a table edit that drops one turns
 * the suite red instead of reaching a session as an unknown option id.
 */
const ALLOW_ONCE = { optionId: "allow_once", kind: "allow_once" } as const;
const REJECT_ONCE = { optionId: "reject_once", kind: "reject_once" } as const;

interface HeldPermission {
	call: FacadeToolCall;
	settle: (outcome: ClientBridgePermissionOutcome) => void;
}

class SessionFacade implements AgentSessionFacade {
	#session: AgentSession;
	#started = false;
	#unsubscribe: (() => void) | undefined;
	#held = new Map<string, HeldPermission>();
	#handlers = new Map<keyof FacadeEventMap, Set<(payload: never) => void>>();
	#activity: FacadeActivity = "idle";

	constructor(session: AgentSession) {
		this.#session = session;
	}

	get running(): boolean {
		return this.#started && !this.#session.isDisposed;
	}

	get model(): Model | undefined {
		return this.#session.model;
	}

	get provider(): string {
		return this.#session.model?.provider ?? "";
	}

	get contextUsage(): number {
		return this.#session.getContextUsage()?.percent ?? 0;
	}

	get tokenCount(): number {
		return this.#session.getContextUsage()?.tokens ?? 0;
	}

	async start(): Promise<void> {
		if (this.#started) return;
		if (this.#session.isDisposed) throw new Error("Cannot start a facade over a disposed session");
		if (this.#session.clientBridge !== undefined) {
			throw new Error(
				"This session already routes through a client bridge; a facade cannot own its permission prompt. Drive the existing host instead.",
			);
		}
		this.#session.setClientBridge(this.#bridge());
		this.#unsubscribe = this.#session.subscribe(event => {
			this.#onSessionEvent(event);
		});
		this.#started = true;
		await this.#session.whenStartupHydrated();
	}

	async stop(): Promise<void> {
		if (!this.#started) return;
		this.#started = false;
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		for (const held of [...this.#held.values()]) held.settle({ outcome: "cancelled" });
		this.#held.clear();
		this.#session.setClientBridge(undefined);
		this.#setActivity("stopped");
		await this.#session.dispose();
	}

	async submit(text: string, attachments?: ImageContent[]): Promise<void> {
		if (!this.running) throw new Error("Cannot submit to a facade that is not running");
		await this.#session.prompt(text, attachments && attachments.length > 0 ? { images: attachments } : undefined);
	}

	interrupt(): Promise<void> {
		return this.#session.abort({ reason: USER_INTERRUPT_LABEL });
	}

	retry(): Promise<boolean> {
		return this.#session.retry();
	}

	approveTool(callId: string): boolean {
		const held = this.#held.get(callId);
		if (!held) return false;
		this.#held.delete(callId);
		held.settle({ outcome: "selected", optionId: ALLOW_ONCE.optionId, kind: ALLOW_ONCE.kind });
		return true;
	}

	rejectTool(callId: string, reason?: string): boolean {
		const held = this.#held.get(callId);
		if (!held) return false;
		this.#held.delete(callId);
		if (reason) logger.debug("facade rejected a tool call", { callId, toolName: held.call.toolName, reason });
		held.settle({ outcome: "selected", optionId: REJECT_ONCE.optionId, kind: REJECT_ONCE.kind });
		return true;
	}

	on<K extends keyof FacadeEventMap>(event: K, handler: (payload: FacadeEventMap[K]) => void): () => void {
		const set = this.#handlers.get(event) ?? new Set<(payload: never) => void>();
		const erased = handler as (payload: never) => void;
		set.add(erased);
		this.#handlers.set(event, set);
		return () => {
			set.delete(erased);
		};
	}

	#emit<K extends keyof FacadeEventMap>(event: K, payload: FacadeEventMap[K]): void {
		const set = this.#handlers.get(event);
		if (!set) return;
		for (const handler of [...set]) {
			try {
				(handler as (value: FacadeEventMap[K]) => void)(payload);
			} catch (err) {
				logger.warn("facade event handler threw", { event, error: errorMessage(err) });
			}
		}
	}

	#setActivity(activity: FacadeActivity): void {
		if (this.#activity === activity) return;
		this.#activity = activity;
		this.#emit("status", activity);
	}

	#emitUsage(): void {
		const usage = this.#session.getContextUsage();
		if (!usage) return;
		this.#emit("usage", { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent });
	}

	#onSessionEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			case "agent_start":
				this.#setActivity("thinking");
				break;
			case "message_update":
				this.#setActivity("streaming");
				break;
			case "message_end":
				this.#emit("message", event.message);
				break;
			case "tool_execution_start":
				this.#setActivity("tool");
				this.#emit("tool_call", {
					callId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
					...(event.intent === undefined ? {} : { intent: event.intent }),
					needsApproval: false,
				});
				break;
			case "tool_execution_end":
				this.#emit("tool_result", {
					callId: event.toolCallId,
					toolName: event.toolName,
					result: event.result,
					isError: event.isError === true,
				});
				break;
			case "turn_end":
				this.#emitUsage();
				break;
			case "agent_end":
				this.#setActivity("idle");
				this.#emitUsage();
				break;
			case "auto_compaction_start":
				this.#setActivity("compacting");
				break;
			case "auto_compaction_end":
				this.#setActivity("idle");
				break;
			case "auto_retry_start":
				this.#setActivity("retrying");
				break;
			case "auto_retry_end":
				this.#setActivity(this.#session.isDisposed ? "stopped" : "idle");
				if (!event.success && event.finalError) this.#emit("error", new Error(event.finalError));
				break;
			case "notice":
				if (event.level === "error") this.#emit("error", new Error(event.message));
				break;
			default:
				break;
		}
	}

	#bridge(): ClientBridge {
		return {
			capabilities: { requestPermission: true },
			requestPermission: (toolCall, _options, signal) => {
				const { promise, resolve } = Promise.withResolvers<ClientBridgePermissionOutcome>();
				if (signal?.aborted) {
					resolve({ outcome: "cancelled" });
					return promise;
				}
				const call: FacadeToolCall = {
					callId: toolCall.toolCallId,
					toolName: toolCall.toolName,
					args: toolCall.rawInput,
					intent: toolCall.title,
					needsApproval: true,
					...(toolCall.locations ? { locations: toolCall.locations } : {}),
				};
				let settled = false;
				const settle = (outcome: ClientBridgePermissionOutcome) => {
					if (settled) return;
					settled = true;
					signal?.removeEventListener("abort", onAbort);
					this.#held.delete(call.callId);
					resolve(outcome);
				};
				const onAbort = () => settle({ outcome: "cancelled" });
				signal?.addEventListener("abort", onAbort, { once: true });
				this.#held.set(call.callId, { call, settle });
				this.#emit("tool_call", call);
				return promise;
			},
		};
	}
}

/** Wrap a live session in the narrow API a front end drives. */
export function createSessionFacade(session: AgentSession): AgentSessionFacade {
	return new SessionFacade(session);
}
