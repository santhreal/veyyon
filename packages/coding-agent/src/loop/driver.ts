import type { UserMessage } from "@veyyon/ai";
import type { SessionContext } from "@veyyon/kernel/session/session-context";
import { errorMessage, logger } from "@veyyon/utils";
import { settings } from "../config/settings";
import {
	consumeLoopLimitIteration,
	createLoopLimitRuntime,
	isLoopDurationExpired,
	type LoopLimitConfig,
	type LoopLimitRuntime,
} from "../modes/loop-limit";
import type { AgentSession } from "../session/agent-session";
import type { AgentSessionEvent } from "../session/agent-session-types";

export interface LoopDriverPort {
	/** The session the loop drives. */
	readonly session: AgentSession;
	/** Another mode holds the session, so the loop must neither activate nor drive. */
	blockingMode(): "plan" | "vibe" | "goal" | undefined;
	/** Mid-turn, compacting, or draining post-turn maintenance. */
	isAutoSubmitBlocked(): boolean;
	/** This host can open a turn at all right now. */
	canSubmit(): boolean;
	/** Open the next loop iteration turn. */
	submitPrompt(prompt: string): void | Promise<void>;
	/** Compaction command handler for loop.mode = "compact". */
	compact?(): Promise<void>;
	/** Clear/reset command handler for loop.mode = "reset". */
	clear?(): Promise<void>;
	/** Configured action for each loop iteration (prompt, compact, reset). */
	loopAction?(): "prompt" | "compact" | "reset";
	/** Say something to the operator in this host's register. */
	warn(message: string): void;
	/** The loop's flags or record moved: repaint whatever states them. */
	changed(): void;
}

/** Delay before each loop iteration so the user has a window to interrupt or stop. */
export const LOOP_CONTINUATION_DELAY_MS = 800;

export function extractUserMessageText(message: UserMessage): string | undefined {
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) {
		const text = message.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map(part => part.text)
			.join("\n");
		return text || undefined;
	}
	return undefined;
}

export function lastUserPrompt(session: AgentSession): string | undefined {
	const messages = session.messages ?? [];
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role === "user" && !message.synthetic) {
			const text = extractUserMessageText(message);
			if (text) return text;
		}
	}
	return undefined;
}

/**
 * Host-agnostic loop driver: manages loop enabled/paused state, auto-submission of the
 * last prompt with delay and busy checks, duration/iteration limits, and session lifecycle
 * event tracking.
 */
export class LoopDriver {
	readonly #port: LoopDriverPort;
	#enabled = false;
	#prompt: string | undefined = undefined;
	#limit: LoopLimitRuntime | undefined = undefined;
	#timer: NodeJS.Timeout | undefined;
	#unsubscribe?: () => void;

	constructor(port: LoopDriverPort) {
		this.#port = port;
	}

	get enabled(): boolean {
		return this.#enabled;
	}

	set enabled(value: boolean) {
		this.#enabled = value;
		if (!value) {
			this.cancelAutoSubmit();
		}
		this.#port.changed();
	}

	get prompt(): string | undefined {
		return this.#prompt;
	}

	set prompt(value: string | undefined) {
		this.#prompt = value;
	}

	get limit(): LoopLimitRuntime | undefined {
		return this.#limit;
	}

	set limit(value: LoopLimitRuntime | undefined) {
		this.#limit = value;
	}

	start(options?: { prompt?: string; limit?: LoopLimitConfig }): void {
		const blocking = this.#port.blockingMode();
		if (blocking) {
			this.#port.warn(`Exit ${blocking} mode first.`);
			return;
		}
		this.#enabled = true;
		this.#limit = createLoopLimitRuntime(options?.limit);
		if (options?.prompt !== undefined) {
			this.#prompt = options.prompt;
		} else if (!this.#prompt) {
			this.#prompt = lastUserPrompt(this.#port.session);
		}
		this.#port.changed();
		if (this.#prompt && this.#port.canSubmit() && !this.#port.isAutoSubmitBlocked()) {
			this.scheduleAutoSubmit();
		}
	}

	stop(message = "Loop mode disabled."): void {
		const wasEnabled = this.#enabled;
		this.#enabled = false;
		this.#prompt = undefined;
		this.#limit = undefined;
		this.cancelAutoSubmit();
		this.#port.changed();
		if (wasEnabled && message) {
			this.#port.warn(message);
		}
	}

	pause(): void {
		this.#prompt = undefined;
		this.cancelAutoSubmit();
	}

	scheduleAutoSubmit(): void {
		this.cancelAutoSubmit();
		if (!this.#enabled || !this.#prompt) return;
		const prompt = this.#prompt;
		const loopAction =
			this.#port.loopAction?.() ??
			(this.#port.session?.settings?.get("loop.mode") as "prompt" | "compact" | "reset" | undefined) ??
			(settings.get("loop.mode") as "prompt" | "compact" | "reset" | undefined) ??
			"prompt";
		this.#deferAutoSubmit(() => {
			void this.#runLoopIteration(loopAction, prompt);
		});
	}

	#deferAutoSubmit(callback: () => void): void {
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			if (!this.#enabled || !this.#port.canSubmit()) return;
			callback();
		}, LOOP_CONTINUATION_DELAY_MS);
	}

	cancelAutoSubmit(): void {
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
	}

	#submitPromptWhenReady(prompt: string): void {
		if (!this.#enabled || this.#prompt !== prompt || !this.#port.canSubmit()) return;
		if (isLoopDurationExpired(this.#limit)) {
			this.stop("Loop time limit reached. Loop mode disabled.");
			return;
		}
		if (this.#port.isAutoSubmitBlocked()) {
			this.#deferAutoSubmit(() => this.#submitPromptWhenReady(prompt));
			return;
		}
		void this.#port.submitPrompt(prompt);
	}

	async #runLoopIteration(action: "prompt" | "compact" | "reset", prompt: string): Promise<void> {
		if (!this.#enabled || this.#prompt !== prompt || !this.#port.canSubmit()) return;
		if (this.#port.isAutoSubmitBlocked()) {
			this.#deferAutoSubmit(() => {
				void this.#runLoopIteration(action, prompt);
			});
			return;
		}

		if (!consumeLoopLimitIteration(this.#limit)) {
			const message =
				this.#limit?.kind === "duration"
					? "Loop time limit reached. Loop mode disabled."
					: "Loop limit reached. Loop mode disabled.";
			this.stop(message);
			return;
		}

		if (action === "compact") {
			if (this.#port.compact) {
				await this.#port.compact();
			} else {
				await this.#port.session.compact();
			}
		} else if (action === "reset") {
			if (this.#port.clear) {
				await this.#port.clear();
			}
		}
		this.#submitPromptWhenReady(prompt);
	}

	async handleSessionEvent(event: AgentSessionEvent): Promise<void> {
		if (event.type === "agent_start") {
			this.cancelAutoSubmit();
			return;
		}
		if (event.type === "message_start" && event.message.role === "user" && !event.message.synthetic) {
			if (this.#enabled) {
				const text = extractUserMessageText(event.message);
				if (text) {
					this.#prompt = text;
				}
			}
			return;
		}
		if (event.type === "agent_end") {
			if (this.#enabled && this.#prompt) {
				this.scheduleAutoSubmit();
			}
		}
	}

	subscribeToSession(): void {
		this.#unsubscribe = this.#port.session.subscribe(event => {
			return this.handleSessionEvent(event).catch(error => {
				logger.warn("Loop driver session event handler failed", {
					event: event.type,
					error: errorMessage(error),
				});
			});
		});
	}

	unsubscribeFromSession(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
	}

	async restoreFromSession(sessionContext: SessionContext): Promise<"handled" | "not-a-loop"> {
		if (sessionContext.mode !== "loop") {
			return "not-a-loop";
		}
		this.#enabled = true;
		if (!this.#prompt) {
			this.#prompt = lastUserPrompt(this.#port.session);
		}
		this.#port.changed();
		if (this.#prompt && this.#port.canSubmit() && !this.#port.isAutoSubmitBlocked()) {
			this.scheduleAutoSubmit();
		}
		return "handled";
	}
}
