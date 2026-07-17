/**
 * IRC delivery controller: owns the pending IRC queues (peer interrupts and
 * passive asides), routes incoming bus messages into the session (steer /
 * pending queue / context append / wake turn by state), drains the inbox for
 * the `irc` tool, generates ephemeral auto-replies, and flushes asides that
 * missed their step-boundary injection.
 */
import type { Agent } from "@veyyon/pi-agent-core";
import { logger, prompt } from "@veyyon/pi-utils";
import type { Settings } from "../config/settings";
import { IrcBus, type IrcMessage } from "../irc/bus";
import parentIrcSteerTemplate from "../prompts/steering/parent-irc.md" with { type: "text" };
import ircAutoReplyTemplate from "../prompts/system/irc-autoreply.md" with { type: "text" };
import ircIncomingTemplate from "../prompts/system/irc-incoming.md" with { type: "text" };
import { AgentRegistry } from "../registry/agent-registry";
import type { AgentSessionEvent } from "./agent-session";
import type { CustomMessage } from "./messages";
import type { SessionManager } from "./session-manager";

/** Session facilities the controller drives; closures over AgentSession privates. */
export interface IrcDeliveryControllerDeps {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	isDisposed(): boolean;
	isStreaming(): boolean;
	isPlanModeEnabled(): boolean;
	canAutoContinueForFollowUp(): boolean;
	resetPromptMaintenanceState(): void;
	beginInFlight(): void;
	endInFlight(): void;
	emitSessionEvent(event: AgentSessionEvent): Promise<void>;
	runEphemeralTurn(args: { promptText: string }): Promise<{ replyText: string }>;
}

export class IrcDeliveryController {
	readonly #deps: IrcDeliveryControllerDeps;
	// Incoming IRC messages received while a turn was streaming. Parent IRCs
	// enter the steering queue; peer IRCs enter the interrupt queue and drain as
	// asides at the next boundary; passive IRC records stay in the aside queue.
	#interrupts: CustomMessage[] = [];
	#asides: CustomMessage[] = [];

	constructor(deps: IrcDeliveryControllerDeps) {
		this.#deps = deps;
	}

	/** Non-consuming peek: true while peer IRC interrupts are queued (early-outs `job poll` / `irc wait`). */
	get hasInterrupts(): boolean {
		return this.#interrupts.length > 0;
	}

	/** Drain both pending queues, interrupts first — the aside-provider injection order. */
	takePending(): CustomMessage[] {
		const pending = [...this.#interrupts, ...this.#asides];
		this.#interrupts = [];
		this.#asides = [];
		return pending;
	}

	/** IRC records that arrive after the loop's final aside poll — or while an abort skipped that
	 *  poll — land in pending IRC queues with no loop left to drain them; the queued-message drain's
	 *  gate (agent.hasQueuedMessages()) does not count peer IRC interrupts. Once idle, wake a turn so
	 *  the agent responds to the peer. Skip only when a queued steer/follow-up will itself drive a
	 *  resume turn whose aside poll already consumes these (no double-wake). */
	resumeStrandedAsides(): void {
		if (this.#deps.isDisposed() || this.#deps.isStreaming()) return;
		if (this.#interrupts.length === 0 && this.#asides.length === 0) return;
		if (this.#deps.canAutoContinueForFollowUp() && this.#deps.agent.hasQueuedMessages()) return;
		const records = this.takePending();
		if (this.#deps.isPlanModeEnabled()) {
			// Plan mode: fold stranded IRC asides into context without waking an
			// autonomous turn. Convergence to ask/resolve stays user-driven.
			for (const record of records) {
				this.#appendToContext(record);
			}
			return;
		}
		this.#wake(records);
	}

	#appendToContext(record: CustomMessage): void {
		this.#deps.agent.appendMessage(record);
		this.#deps.sessionManager.appendCustomMessageEntry(
			record.customType,
			record.content,
			record.display,
			record.details,
			record.attribution ?? "agent",
		);
	}

	/** Fire-and-forget wake turn for incoming IRC — idle delivery and stranded-aside resume both
	 *  route here. Wrapped in beginInFlight/endInFlight so the turn is tracked and its settle
	 *  re-drains anything that stranded during it. A user interrupt may have intentionally left a
	 *  follow-up queued behind an invalid tail (seam #5); the wake turn's loop would otherwise drain
	 *  it, so park the follow-up queue across the wake and restore it after. It stays queued post-wake
	 *  because canAutoContinueForFollowUp suppresses follow-up auto-resume while a user interrupt is
	 *  in effect, even though the wake left a provider-valid tail. */
	#wake(records: CustomMessage[]): void {
		const agent = this.#deps.agent;
		// Park only a *blocked* follow-up (one a user interrupt is intentionally holding); an
		// already-resumable follow-up can ride the wake turn normally without reordering.
		const parkedFollowUps =
			agent.peekSteeringQueue().length === 0 &&
			agent.peekFollowUpQueue().length > 0 &&
			!this.#deps.canAutoContinueForFollowUp()
				? [...agent.peekFollowUpQueue()]
				: [];
		if (parkedFollowUps.length > 0) {
			agent.replaceQueues([...agent.peekSteeringQueue()], []);
		}
		this.#deps.resetPromptMaintenanceState();
		this.#deps.beginInFlight();
		void agent
			.prompt(records)
			.catch(error => {
				logger.warn("IRC wake turn failed", { error: String(error) });
			})
			.finally(() => {
				if (parkedFollowUps.length > 0) {
					agent.replaceQueues([...agent.peekSteeringQueue()], [...parkedFollowUps, ...agent.peekFollowUpQueue()]);
				}
				this.#deps.endInFlight();
			});
	}

	/**
	 * Surfaces and consumes pending IRC incoming records before the next model
	 * step can inject them automatically.
	 *
	 * Tool results already expose the formatted body to the model. Leaving the
	 * same record in either pending IRC queue would deliver it a second time at
	 * the next step boundary — including on `peek`, which is why inbox peeks
	 * also drain here.
	 */
	drainInboxMessages(agentId: string, opts?: { from?: string; limit?: number }): IrcMessage[] {
		const messages: IrcMessage[] = [];
		const remainingInterrupts: CustomMessage[] = [];
		const remainingAsides: CustomMessage[] = [];
		const queues = [
			{ records: this.#interrupts, remaining: remainingInterrupts },
			{ records: this.#asides, remaining: remainingAsides },
		];
		for (const queue of queues) {
			for (const record of queue.records) {
				if (record.customType !== "irc:incoming") {
					queue.remaining.push(record);
					continue;
				}
				const details = record.details;
				if (!details || typeof details !== "object") {
					queue.remaining.push(record);
					continue;
				}
				const id = Reflect.get(details, "id");
				const from = Reflect.get(details, "from");
				const body = Reflect.get(details, "message");
				const replyTo = Reflect.get(details, "replyTo");
				if (typeof id !== "string" || typeof from !== "string" || typeof body !== "string") {
					queue.remaining.push(record);
					continue;
				}
				if (opts?.from !== undefined && from !== opts.from) {
					queue.remaining.push(record);
					continue;
				}
				if (opts?.limit !== undefined && messages.length >= opts.limit) {
					queue.remaining.push(record);
					continue;
				}
				messages.push({
					id,
					from,
					to: agentId,
					body,
					ts: record.timestamp,
					...(typeof replyTo === "string" ? { replyTo } : {}),
				});
			}
		}
		this.#interrupts = remainingInterrupts;
		this.#asides = remainingAsides;
		return messages;
	}

	/**
	 * Deliver an IRC message into this session (recipient side; called by the
	 * IrcBus). Emits the `irc_message` session event for UI cards and injects
	 * the rendered message into the model's context as an `irc:incoming`
	 * custom message:
	 *
	 * - mid-turn → queued on the aside channel and folded in at the next step
	 *   boundary (non-interrupting, like async-result deliveries) → "injected";
	 * - idle in plan mode → appended into context without waking an autonomous
	 *   turn (convergence stays user-driven) → "injected";
	 * - idle → starts a real turn with the message so the recipient wakes
	 *   → "woken".
	 *
	 * Never blocks on the recipient's turn: the wake turn is fire-and-forget.
	 *
	 * When the sender expects a reply (`send await:true`) and this session
	 * cannot produce a real reply turn in time — mid-turn with async execution
	 * disabled (the next step boundary may be gated on the sender's own batch
	 * finishing), or idle in plan mode (wake turns are suppressed) — an
	 * ephemeral side-channel auto-reply is generated from the current context
	 * (the old `respondAsBackground` path) and sent back over the bus on this
	 * agent's behalf.
	 */
	async deliver(msg: IrcMessage, opts?: { expectsReply?: boolean }): Promise<"injected" | "woken"> {
		if (this.#deps.isDisposed()) {
			throw new Error("Recipient session is disposed.");
		}
		const isStreaming = this.#deps.isStreaming();
		// Auto-reply eligibility: the sender is blocked on an answer and this
		// session cannot produce a real reply turn in time — either mid-turn with
		// async execution disabled (no step boundary until the sender's own batch
		// ends), or idle in plan mode (autonomous wake turns are suppressed).
		const planModeIdle = !isStreaming && this.#deps.isPlanModeEnabled();
		const autoReply =
			(opts?.expectsReply ?? false) && ((isStreaming && !this.#deps.settings.get("async.enabled")) || planModeIdle);
		const record: CustomMessage = {
			role: "custom",
			customType: "irc:incoming",
			content: prompt.render(ircIncomingTemplate, {
				from: msg.from,
				message: msg.body,
				replyTo: msg.replyTo ?? "",
				autoReplied: autoReply,
				interrupting: isStreaming,
			}),
			display: true,
			details: { id: msg.id, from: msg.from, message: msg.body, ...(msg.replyTo ? { replyTo: msg.replyTo } : {}) },
			attribution: "agent",
			timestamp: msg.ts,
		};
		void this.#deps.emitSessionEvent({ type: "irc_message", message: record });
		if (isStreaming) {
			const recipientParentId = AgentRegistry.global().get(msg.to)?.parentId;
			if (recipientParentId === msg.from) {
				this.#deps.agent.steer({
					role: "user",
					content: prompt.render(parentIrcSteerTemplate, { from: msg.from, message: msg.body }),
					attribution: "agent",
					timestamp: msg.ts,
					steering: true,
				});
			} else {
				this.#interrupts.push(record);
			}
			if (autoReply) void this.#runAutoReply(msg);
			return "injected";
		}
		// Plan mode: record into context but do not wake an autonomous turn.
		if (this.#deps.isPlanModeEnabled()) {
			this.#appendToContext(record);
			if (autoReply) void this.#runAutoReply(msg);
			return "injected";
		}
		// Idle: wake a real turn so the recipient responds (shared with the stranded-aside resume).
		this.#wake([record]);
		return "woken";
	}

	/**
	 * Generate and deliver an ephemeral auto-reply to `msg` on this agent's
	 * behalf: a no-tools side-channel turn over the current history (same
	 * pipeline as `/btw`), recorded into this session as an `irc:autoreply`
	 * aside so the model knows what was said for it, and sent back to the
	 * sender as a regular bus message (`replyTo: msg.id`) so their parked
	 * `wait`/`await:true` resolves. Failures only log — the sender then hits
	 * its normal wait timeout.
	 */
	async #runAutoReply(msg: IrcMessage): Promise<void> {
		try {
			const { replyText } = await this.#deps.runEphemeralTurn({
				promptText: prompt.render(ircAutoReplyTemplate, {
					from: msg.from,
					message: msg.body,
					replyTo: msg.replyTo ?? "",
				}),
			});
			const body = replyText.trim();
			if (!body || this.#deps.isDisposed()) return;
			const record: CustomMessage = {
				role: "custom",
				customType: "irc:autoreply",
				content: `[IRC you → \`${msg.from}\` (auto)]\n\n${body}`,
				display: true,
				details: { to: msg.from, body, replyTo: msg.id },
				attribution: "agent",
				timestamp: Date.now(),
			};
			void this.#deps.emitSessionEvent({ type: "irc_message", message: record });
			// Asides drain at the next step boundary; anything left over is
			// flushed at the start of the next prompt (flushPendingAsides).
			this.#asides.push(record);
			// `from` must be the id the sender addressed (msg.to) so their
			// from-filtered waiter matches.
			const receipt = await IrcBus.global().send({ from: msg.to, to: msg.from, body, replyTo: msg.id });
			if (receipt.outcome === "failed") {
				logger.warn("IRC auto-reply delivery failed", { to: msg.from, error: receipt.error });
			}
		} catch (error) {
			logger.warn("IRC auto-reply turn failed", { from: msg.from, error: String(error) });
		}
	}

	/**
	 * Persist any IRC asides that missed their step-boundary injection (the
	 * message landed after the turn's last aside drain). Called at the start
	 * of the next prompt so the model still sees them.
	 */
	flushPendingAsides(): void {
		if (this.#interrupts.length === 0 && this.#asides.length === 0) return;
		const records = this.takePending();
		for (const record of records) {
			// emitExternalEvent on message_end appends to agent state and dispatches
			// to all session listeners, which in turn handle TUI rendering and
			// sessionManager persistence via #handleAgentEvent.
			this.#deps.agent.emitExternalEvent({ type: "message_start", message: record });
			this.#deps.agent.emitExternalEvent({ type: "message_end", message: record });
		}
	}
}
