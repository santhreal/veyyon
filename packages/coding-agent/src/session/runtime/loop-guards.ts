/**
 * Loop guards: the two detectors that interrupt a model repeating itself.
 *
 * This is a session collaborator. It holds the cross-turn tool-call loop guard with the settings it
 * was built from, and the Gemini reasoning-header detector for the reasoning block in flight, and
 * reaches the session only through {@link LoopGuardsHost}.
 *
 * - **Repeated tool calls** ({@link LoopGuards.onTurnEnd}) record each finished assistant turn. When
 *   one tool call repeats with the same result past the threshold, a hidden
 *   `tool-call-loop-redirect` message joins the live context and the session log before the next
 *   model call.
 * - **Reasoning-header runaway** ({@link LoopGuards.observe}) counts consecutive thought-summary
 *   titles in a Gemini reasoning block. At the threshold the stream is aborted, the stalled turn is
 *   dropped, a hidden `gemini-tool-call-reminder` joins the context and the log, and the run
 *   continues.
 */
import type { AgentMessage } from "@veyyon/agent-core";
import type { Api, AssistantMessage, AssistantMessageEvent, Model, ToolResultMessage } from "@veyyon/ai";
import { GeminiHeaderRunDetector, isGeminiThinkingModel } from "@veyyon/ai/utils/thinking-loop";
import { type RepeatedToolCallDetection, ToolCallLoopGuard } from "@veyyon/ai/utils/tool-call-loop-guard";
import { errorMessage, logger, prompt } from "@veyyon/utils";
import type { Settings } from "../../config/settings";
import { turnControlPrompts } from "../../prompts/turn-control/rows";
import type { CustomMessage } from "../messages";
import { GEMINI_TOOL_REMINDER_TYPE, TOOL_CALL_LOOP_REDIRECT_TYPE } from "../nudges";

/** Abort reason for the Gemini reasoning-header runaway interrupt. Recorded on the discarded
 *  assistant turn only; never reaches the model. */
export const GEMINI_HEADER_INTERRUPT_REASON = "Interrupted: emit a tool call instead of more planning";

/** The agent slice the guards drive. `Agent` satisfies this structurally. */
export interface LoopGuardsAgent {
	readonly state: { readonly messages: readonly AgentMessage[] };
	appendMessage(message: AgentMessage): void;
	abort(reason?: string): void;
	waitForIdle(): Promise<void>;
	continue(): Promise<unknown>;
}

/** The session log slice a guard's hidden message is recorded in. `SessionManager` satisfies this. */
export interface LoopGuardsStore {
	appendCustomMessageEntry<T>(
		customType: string | undefined,
		content: string | undefined,
		display: boolean | undefined,
		details?: T,
		attribution?: "agent",
	): string;
}

/** What {@link LoopGuards} needs from the session that holds it. */
export interface LoopGuardsHost {
	readonly agent: LoopGuardsAgent;
	readonly sessionStore: LoopGuardsStore;
	/** Read on every turn and every reasoning block, so a settings change applies to the next one. */
	readonly settings: Settings;
	/** Current model; the header guard applies to Gemini thinking models only. */
	model(): Model<Api> | undefined;
	/** Prompt generation the deferred reminder must still match to be delivered. */
	promptGeneration(): number;
	isDisposed(): boolean;
	emitNotice(level: "warning", message: string, source: string): void;
	schedulePostPromptTask(task: (signal: AbortSignal) => Promise<void>): void;
	/** Drop an assistant turn from the live context and the persisted branch. */
	discardAssistantTurn(message: AssistantMessage): void;
}

/** A finished assistant turn and the tool results it produced. */
export interface LoopGuardsTurn {
	readonly message: AssistantMessage;
	readonly toolResults: readonly ToolResultMessage[];
}

export class LoopGuards {
	readonly #host: LoopGuardsHost;
	#toolCallGuard: ToolCallLoopGuard | undefined;
	/** The settings {@link #toolCallGuard} was built from; a change rebuilds it with no history. */
	#toolCallGuardKey: string | undefined;
	/** Detector for the reasoning block in flight. Rebuilt on each `thinking_start` when the header
	 *  guard applies; undefined for other models or with the guard off. */
	#headerDetector: GeminiHeaderRunDetector | undefined;

	constructor(host: LoopGuardsHost) {
		this.#host = host;
	}

	/**
	 * Record a finished assistant turn. A repeated tool call past the threshold appends a hidden
	 * redirect to `messages` (the context the next model call reads), to the agent when `messages` is
	 * a different array, and to the session log.
	 */
	onTurnEnd(messages: AgentMessage[], turn: LoopGuardsTurn): void {
		const detection = this.#activeToolCallGuard()?.recordTurn(turn);
		if (detection) this.#injectToolCallLoopRedirect(messages, detection);
	}

	/**
	 * Feed one streamed assistant event to the header detector. Each reasoning block
	 * (`thinking_start`) re-arms a fresh detector when the guard applies; thinking deltas count
	 * thought-summary headers; assistant prose or a tool call ends the run. Called synchronously from
	 * the assistant-message interceptor so the abort lands before more budget burns. Armed on
	 * `thinking_start` rather than `turn_start`, which the agent loop skips for the first turn, so the
	 * first reasoning block is guarded too.
	 */
	observe(message: AssistantMessage, event: AssistantMessageEvent): void {
		if (event.type === "thinking_start") {
			this.#headerDetector = this.#headerGuardActive() ? new GeminiHeaderRunDetector() : undefined;
			return;
		}
		const detector = this.#headerDetector;
		if (!detector) return;
		if (event.type === "thinking_delta") {
			if (detector.push(event.delta)) this.#interruptHeaderRunaway(detector.count, message.timestamp);
			return;
		}
		// Leaving the reasoning channel ends the run: the consecutive-header count only applies within
		// one uninterrupted stretch of reasoning.
		if (event.type === "text_start" || event.type === "toolcall_start") {
			detector.reset();
		}
	}

	#activeToolCallGuard(): ToolCallLoopGuard | undefined {
		const settings = this.#host.settings;
		if (settings.get("model.toolCallLoopGuard.enabled") !== true) {
			this.#toolCallGuard = undefined;
			this.#toolCallGuardKey = undefined;
			return undefined;
		}
		const threshold = settings.get("model.toolCallLoopGuard.threshold");
		const readSubsumptionThreshold = settings.get("model.toolCallLoopGuard.readSubsumptionThreshold");
		const exemptTools = settings
			.get("model.toolCallLoopGuard.exemptTools")
			.filter((tool): tool is string => typeof tool === "string" && tool.length > 0);
		const key = `${threshold}:${readSubsumptionThreshold}:${JSON.stringify(exemptTools)}`;
		if (!this.#toolCallGuard || this.#toolCallGuardKey !== key) {
			this.#toolCallGuard = new ToolCallLoopGuard({ threshold, exemptTools, readSubsumptionThreshold });
			this.#toolCallGuardKey = key;
		}
		return this.#toolCallGuard;
	}

	#injectToolCallLoopRedirect(messages: AgentMessage[], detection: RepeatedToolCallDetection): void {
		const content = prompt.render(turnControlPrompts["turn-control/tool-call-loop-redirect"].text, {
			tool_name: detection.toolName,
			count: detection.count,
			arguments_summary: detection.argumentsSummary,
			result_summary: detection.resultSummary || "(no text result)",
		});
		const details = {
			toolName: detection.toolName,
			count: detection.count,
			argumentsSummary: detection.argumentsSummary,
			resultSummary: detection.resultSummary,
		};
		logger.warn("cross-turn tool-call loop detected", { toolName: detection.toolName, count: detection.count });
		const redirect: CustomMessage = {
			role: "custom",
			customType: TOOL_CALL_LOOP_REDIRECT_TYPE,
			content,
			display: false,
			details,
			attribution: "agent",
			timestamp: Date.now(),
		};
		messages.push(redirect);
		const agent = this.#host.agent;
		if (agent.state.messages !== messages) agent.appendMessage(redirect);
		this.#host.sessionStore.appendCustomMessageEntry(TOOL_CALL_LOOP_REDIRECT_TYPE, content, false, details, "agent");
	}

	/**
	 * Whether the header guard applies: the loop guard is on (settings and
	 * `VEYYON_NO_THINKING_LOOP_GUARD`), the tool-call reminder is enabled, and the current model is a
	 * Gemini thinking model.
	 */
	#headerGuardActive(): boolean {
		const settings = this.#host.settings;
		const model = this.#host.model();
		return (
			process.env.VEYYON_NO_THINKING_LOOP_GUARD !== "1" &&
			settings.get("model.loopGuard.enabled") === true &&
			settings.get("model.loopGuard.toolCallReminder") === true &&
			model !== undefined &&
			isGeminiThinkingModel(model)
		);
	}

	/**
	 * Interrupt a reasoning stream that emitted too many consecutive planning headers without a tool
	 * call. Aborts the live turn, then after it unwinds drops the stalled reasoning-only turn (so its
	 * partial thinking is neither replayed nor reloaded), appends a hidden tool-call reminder, and
	 * continues. `targetTimestamp` identifies the aborted turn, so exactly that one is dropped.
	 */
	#interruptHeaderRunaway(headerCount: number, targetTimestamp: number): void {
		const host = this.#host;
		const model = host.model();
		logger.warn("Gemini reasoning-header runaway; interrupting to require a tool call", {
			model: model?.id,
			provider: model?.provider,
			headers: headerCount,
		});
		host.emitNotice(
			"warning",
			`Interrupted ${headerCount} planning headers with no tool call; reminded the model to issue one.`,
			"loop-guard",
		);
		host.agent.abort(GEMINI_HEADER_INTERRUPT_REASON);
		const generation = host.promptGeneration();
		const stale = (signal: AbortSignal): boolean =>
			signal.aborted || host.isDisposed() || host.promptGeneration() !== generation;
		host.schedulePostPromptTask(async signal => {
			if (stale(signal)) return;
			// Let the aborted stream finish unwinding so continue() does not race it.
			await host.agent.waitForIdle();
			if (stale(signal)) return;
			const aborted = host.agent.state.messages.findLast(
				(m): m is AssistantMessage => m.role === "assistant" && m.timestamp === targetTimestamp,
			);
			if (aborted) host.discardAssistantTurn(aborted);
			const content = prompt.render(turnControlPrompts["turn-control/gemini-tool-call-reminder"].text, {
				count: headerCount,
			});
			const details = { headers: headerCount };
			host.agent.appendMessage({
				role: "custom",
				customType: GEMINI_TOOL_REMINDER_TYPE,
				content,
				display: false,
				details,
				attribution: "agent",
				timestamp: Date.now(),
			});
			host.sessionStore.appendCustomMessageEntry(GEMINI_TOOL_REMINDER_TYPE, content, false, details, "agent");
			try {
				await host.agent.continue();
			} catch (err) {
				logger.warn("gemini tool-call reminder continue failed", { error: errorMessage(err) });
			}
		});
	}
}
