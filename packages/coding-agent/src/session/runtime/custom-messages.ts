/**
 * Custom messages: how a message an extension, a tool or the session itself builds reaches the
 * conversation, by whether a turn is streaming when it arrives.
 *
 * This is a session collaborator with no state of its own. It reaches the session only through
 * {@link CustomMessagesHost}.
 *
 * - **Delivery** ({@link CustomMessages.send}) queues the message while a turn streams, as a steer, a
 *   follow-up or context for the next turn, and otherwise starts a turn with it, appends it to the
 *   context without one, or holds it for the next turn when the client defers the turns the agent
 *   starts on its own.
 * - **A prompt** ({@link CustomMessages.prompt}) runs the message as the prompt of a turn, with the
 *   notices a magic keyword in a user-invoked skill's arguments adds.
 * - **An append** ({@link CustomMessages.append}) records the message in the context and the session
 *   file without a turn.
 */
import { type Agent, AgentBusyError, type AgentMessage } from "@veyyon/agent-core";
import type { SessionManager } from "@veyyon/kernel/session/session-manager";
import { contentText } from "@veyyon/utils/content-text";
import type { PromptOptions } from "../agent-session-types";
import {
	type CustomMessage,
	type CustomMessagePayload,
	normalizeCustomMessagePayload,
	SKILL_PROMPT_MESSAGE_TYPE,
} from "../messages";
import type { ImageAttachments } from "./image-attachments";
import type { NextTurnMessages } from "./next-turn-messages";
import type { QueuedMessages } from "./queued-messages";

/** How {@link CustomMessages.send} delivers a message. */
export interface SendCustomMessageOptions {
	/** Start a turn with the message when no turn is streaming. */
	triggerTurn?: boolean;
	/** The queue a message sent while a turn streams joins; `nextTurn` also holds an idle message without a turn. */
	deliverAs?: "steer" | "followUp" | "nextTurn";
	/** The text the queue chip shows for the message. */
	queueChipText?: string;
	/** Accept an empty stop as the end of the turn the message starts, instead of retrying it. */
	acceptTerminalEmptyStop?: boolean;
}

/** How {@link CustomMessages.prompt} runs a message. */
export type PromptCustomMessageOptions = Pick<PromptOptions, "streamingBehavior" | "toolChoice"> & {
	/** The text the queue chip shows for the message when it is queued. */
	queueChipText?: string;
	/** Queue the message as `streamingBehavior` says even when no turn is streaming. */
	queueOnly?: boolean;
};

/** The fields of a custom message a caller supplies; the role and the timestamp are added on delivery. */
export type CustomMessageFields<T> = Pick<
	CustomMessage<T>,
	"customType" | "content" | "display" | "details" | "attribution"
>;

/** What {@link CustomMessages} needs from the session that holds it. */
export interface CustomMessagesHost {
	/** Normalizes the images a message carries for the active model. */
	readonly images: Pick<ImageAttachments, "normalizeMessage">;
	/** The hidden messages held for the next turn. */
	readonly nextTurn: Pick<NextTurnMessages, "queue">;
	/** The steer and follow-up queues, the drain that starts a turn on them, and the order messages reach them in. */
	readonly queue: Pick<QueuedMessages, "enqueue" | "scheduleDrain" | "deliverInOrder">;
	/** The agent whose context an appended message joins. */
	readonly agent: Pick<Agent, "appendMessage">;
	/** The session file an appended message is recorded in. */
	readonly sessionStore: Pick<SessionManager, "appendCustomMessageEntry">;
	/** Resolves once the tools a turn reaches are hydrated. */
	startupHydration(): Promise<void>;
	/** Whether a turn is streaming. */
	isStreaming(): boolean;
	/** Whether the client defers the turns the agent starts on its own, and none is allowed now. */
	defersAgentInitiatedTurns(): boolean;
	/** Run `message` as the prompt of a turn the agent starts on its own. */
	promptAgentInitiated(message: CustomMessage, options?: { acceptTerminalEmptyStop?: boolean }): Promise<void>;
	/** Run `message` as the prompt of a turn, with `prependMessages` ahead of it. */
	promptWithMessage(
		message: AgentMessage,
		text: string,
		options: Pick<PromptOptions, "toolChoice"> & { prependMessages?: AgentMessage[] },
	): Promise<void>;
	/** The hidden notices a magic keyword in `text` adds to the turn that carries it. */
	keywordNotices(text: string): CustomMessage[];
}

/**
 * `details` with the text the queue chip shows for a queued custom message. Details that are not an
 * object are replaced, since the chip text needs a record to ride on.
 */
function withQueueChipText<T>(details: T | undefined, queueChipText: string): T {
	const base = details && typeof details === "object" ? (details as Record<string, unknown>) : {};
	return { ...base, __queueChipText: queueChipText } as T;
}

/** A custom message as steer/follow-up delivery queues it, without starting a turn. */
function queuedCustomMessage<T = unknown>(message: CustomMessageFields<T>, queueChipText?: string): CustomMessage<T> {
	const details = queueChipText !== undefined ? withQueueChipText(message.details, queueChipText) : message.details;
	return {
		role: "custom",
		customType: message.customType,
		content: message.content,
		display: message.display,
		details,
		attribution: message.attribution ?? "agent",
		timestamp: Date.now(),
	};
}

export class CustomMessages {
	readonly #host: CustomMessagesHost;

	constructor(host: CustomMessagesHost) {
		this.#host = host;
	}

	/**
	 * Deliver `message` and report whether this call started a turn and waited for it.
	 *
	 * While a turn streams, `nextTurn` holds the message for the next turn and anything else queues it
	 * as a steer or a follow-up. When no turn streams, `triggerTurn` starts one with the message, unless
	 * the client defers the turns the agent starts on its own, which holds it for the next turn instead;
	 * without `triggerTurn` the message joins the context with no turn. A message that starts a turn
	 * waits for the startup hydration a prompt waits for, since it reaches the same tools. Messages are
	 * routed in the order they were sent, whatever their images take to normalize.
	 *
	 * `false` covers every path that did not run a turn, including a `triggerTurn` the client deferred,
	 * so a caller that mirrors the turn's `agent_end` does not act on one that never ran.
	 */
	async send<T = unknown>(message: CustomMessagePayload<T>, options?: SendCustomMessageOptions): Promise<boolean> {
		const host = this.#host;
		if (options?.triggerTurn) await host.startupHydration();
		const normalizedPayload = normalizeCustomMessagePayload<T>(message);
		const details =
			options?.queueChipText && options.deliverAs !== "nextTurn"
				? withQueueChipText(normalizedPayload.details, options.queueChipText)
				: normalizedPayload.details;
		const appMessage: CustomMessage<T> = {
			role: "custom",
			customType: normalizedPayload.customType,
			content: normalizedPayload.content,
			display: normalizedPayload.display,
			details,
			attribution: normalizedPayload.attribution,
			timestamp: Date.now(),
		};
		return host.queue.deliverInOrder(host.images.normalizeMessage(appMessage), normalized =>
			this.#route(normalized, options),
		);
	}

	/**
	 * Route a normalized message by what the session reads when its turn to be delivered comes. A turn
	 * the message starts is returned unawaited, so the messages handed over after it are not held for it.
	 */
	#route<T>(message: CustomMessage<T>, options: SendCustomMessageOptions | undefined): boolean | Promise<boolean> {
		const host = this.#host;
		if (host.isStreaming()) {
			if (options?.deliverAs === "nextTurn") {
				host.nextTurn.queue(message, options?.triggerTurn ?? false);
				return false;
			}

			host.queue.enqueue(message, options?.deliverAs === "followUp" ? "followUp" : "steer");
			host.queue.scheduleDrain();
			return false;
		}

		if (options?.deliverAs === "nextTurn") {
			if (options?.triggerTurn) {
				if (host.defersAgentInitiatedTurns()) {
					host.nextTurn.queue(message, false);
					return false;
				}
				return host
					.promptAgentInitiated(message, { acceptTerminalEmptyStop: options.acceptTerminalEmptyStop === true })
					.then(() => true);
			}
			this.append(message);
			return false;
		}

		if (options?.triggerTurn) {
			if (host.defersAgentInitiatedTurns()) {
				host.nextTurn.queue(message, false);
				return false;
			}
			return host.promptAgentInitiated(message).then(() => true);
		}

		this.append(message);
		return false;
	}

	/**
	 * Run `message` as the prompt of a turn.
	 *
	 * A skill a person invoked carries the notices a magic keyword in its arguments adds, ahead of the
	 * message. `queueOnly` queues the notices and the message as `streamingBehavior` says without a
	 * turn; while a turn streams they are sent as that kind of message. Either way a missing
	 * `streamingBehavior` throws {@link AgentBusyError}.
	 */
	async prompt<T = unknown>(message: CustomMessageFields<T>, options?: PromptCustomMessageOptions): Promise<void> {
		const host = this.#host;
		const textContent = contentText(message.content, { separator: "" });

		let keywordNotices: CustomMessage[] = [];
		if (message.customType === SKILL_PROMPT_MESSAGE_TYPE && message.attribution === "user") {
			const details = message.details;
			let skillArgs = "";
			if (details && typeof details === "object" && "args" in details && typeof details.args === "string") {
				skillArgs = details.args;
			}
			keywordNotices = host.keywordNotices(skillArgs);
		}

		if (options?.queueOnly) {
			if (!options.streamingBehavior) {
				throw new AgentBusyError();
			}
			const mode = options.streamingBehavior;
			// The keyword notices are text with no image to normalize; they are delivered with the
			// message so nothing handed over meanwhile lands between them.
			await host.queue.deliverInOrder(
				host.images.normalizeMessage(queuedCustomMessage(message, options.queueChipText)),
				normalized => {
					for (const notice of keywordNotices) host.queue.enqueue(queuedCustomMessage(notice), mode);
					host.queue.enqueue(normalized, mode);
				},
			);
			return;
		}
		if (host.isStreaming()) {
			if (!options?.streamingBehavior) {
				throw new AgentBusyError();
			}
			for (const notice of keywordNotices) {
				await this.send(notice, { deliverAs: options.streamingBehavior });
			}
			await this.send(message, {
				deliverAs: options.streamingBehavior,
				queueChipText: options.queueChipText,
			});
			return;
		}

		const customMessage: CustomMessage<T> = {
			role: "custom",
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
			attribution: message.attribution ?? "agent",
			timestamp: Date.now(),
		};

		await host.promptWithMessage(customMessage, textContent, {
			...options,
			prependMessages: keywordNotices.length > 0 ? keywordNotices : undefined,
		});
	}

	/** Append `message` to the model's context and the session file without starting a turn. */
	append<T>(message: CustomMessage<T>): void {
		this.#host.agent.appendMessage(message);
		this.#host.sessionStore.appendCustomMessageEntry(
			message.customType,
			message.content,
			message.display,
			message.details,
			message.attribution ?? "agent",
		);
	}
}
