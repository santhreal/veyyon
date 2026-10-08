/**
 * Plan mode: the read-only planning state, the approved-plan reference, and the decision ladder.
 *
 * This is a session collaborator. It holds the plan mode state, the plan reference the model reads
 * after approval, and the two counters of the decision ladder, and reaches the session only through
 * {@link PlanModeHost}. The five fields move together: enabling plan mode re-arms the reference,
 * disabling it clears the ladder and drops its forced tool choice.
 *
 * - **The context message** ({@link buildContextMessage}) restates the plan mode rules on every
 *   prompt while plan mode is on.
 * - **The reference message** ({@link buildReferenceMessage}) points the model at the plan file
 *   once after plan mode ends, and again after compaction discards the turn that held it.
 * - **The decision ladder** ({@link enforceDecisionAtSettle}) appends a reminder and forces a tool
 *   call when a plan mode turn stops without a decision tool, at most `PLAN_MODE_REMINDER_MAX`
 *   times before the stop reaches the user.
 */
import * as fs from "node:fs";
import type { AgentMessage } from "@veyyon/agent-core";
import type { ProtectedToolMatcher } from "@veyyon/agent-core/compaction/tool-protection";
import type { AssistantMessage, Message, ToolChoice } from "@veyyon/ai";
import { isEnoent, logger, prompt } from "@veyyon/utils";
import { type LocalProtocolOptions, resolveLocalUrlToPath } from "../../internal-urls/local-protocol";
import { DEFAULT_PLAN_FILE_URL } from "../../plan-mode/plan-file-url";
import { createPlanReadMatcher } from "../../plan-mode/plan-protection";
import type { PlanModeState } from "../../plan-mode/state";
import { planModePrompts } from "../../prompts/plan-mode/rows";
import { enabledAgentNames, preferredAgentName } from "../../task/agent-settings";
import { TOOL } from "../../tools/core/builtin-names";
import type { EditMode } from "../../utils/edit-mode";
import type { ScheduledAgentContinueOptions } from "../agent-session-types";
import type { CustomMessage } from "../messages";
import { PLAN_DECISION_TOOLS, PLAN_MODE_REMINDER_MAX } from "../nudges";

/** Tool-choice label of the forced decision the ladder queues. */
const DECISION_CHOICE_LABEL = "plan-mode-decision";

/** Whether a tool call ends a plan mode turn with a decision the user acts on. */
function isPlanDecisionTool(name: string): boolean {
	return PLAN_DECISION_TOOLS.has(name);
}

/** The agent slice plan mode reads and appends to. `Agent` satisfies this structurally. */
export interface PlanModeAgent {
	readonly state: { readonly tools: readonly { readonly name: string }[] };
	appendMessage(message: AgentMessage): void;
}

/** The session log slice the decision ladder appends its reminder to. `SessionManager` satisfies this. */
export interface PlanModeSessionStore {
	appendMessage(message: Message): void;
}

/** The tool-choice queue slice the decision ladder forces through. `ToolChoiceQueue` satisfies this. */
export interface PlanModeToolChoices {
	pushOnce(choice: ToolChoice, options: { label: string }): void;
	removeByLabel(label: string): void;
}

/** What {@link PlanModeRuntime} needs from the session that holds it. */
export interface PlanModeHost {
	readonly agent: PlanModeAgent;
	readonly sessionStore: PlanModeSessionStore;
	readonly toolChoices: PlanModeToolChoices;
	/** The last assistant message in the live context, aborted ones included. */
	lastAssistantMessage(): AssistantMessage | undefined;
	/** Whether the registry holds a tool, active or not. */
	hasTool(name: string): boolean;
	/** The registered task tool, whose roster names the agents a research step may spawn. */
	taskTool(): unknown;
	/** Filesystem path of a plan reference, whichever spelling it carries. */
	resolvePlanPath(planFilePath: string): string;
	localProtocolOptions(): LocalProtocolOptions;
	activeEditMode(): EditMode;
	scheduleAgentContinue(options: ScheduledAgentContinueOptions): void;
	/** Prompt generation a scheduled continuation must still match to be valid. */
	promptGeneration(): number;
}

export class PlanModeRuntime {
	readonly #host: PlanModeHost;
	#state: PlanModeState | undefined;
	/** True once the reference message reached the context; cleared when that context is replaced. */
	#referenceSent = false;
	#referencePath: string = DEFAULT_PLAN_FILE_URL;
	/** Reminders appended since the last decision or user turn; capped at `PLAN_MODE_REMINDER_MAX`. */
	#reminderCount = 0;
	/** Set when a reminder is appended; cleared by the next tool run or user turn. */
	#reminderAwaitingProgress = false;

	constructor(host: PlanModeHost) {
		this.#host = host;
	}

	get state(): PlanModeState | undefined {
		return this.#state;
	}

	get enabled(): boolean {
		return this.#state?.enabled === true;
	}

	setState(state: PlanModeState | undefined): void {
		this.#state = state;
		if (state?.enabled) {
			this.#referenceSent = false;
			this.#referencePath = state.planFilePath;
		} else {
			this.#clearLadder();
			// Drop any unconsumed forced decision so a post-plan execution turn
			// does not inherit a stale `required` tool choice.
			this.#host.toolChoices.removeByLabel(DECISION_CHOICE_LABEL);
		}
	}

	get referencePath(): string {
		return this.#referencePath;
	}

	setReferencePath(path: string): void {
		this.#referencePath = path;
	}

	markReferenceSent(): void {
		this.#referenceSent = true;
	}

	/** Compaction discarded the turn that held the reference; the next prompt re-reads the plan from disk (#1246). */
	invalidateReference(): void {
		this.#referenceSent = false;
	}

	/** A new session starts with no reference sent and the default plan file. */
	resetReference(): void {
		this.#referenceSent = false;
		this.#referencePath = DEFAULT_PLAN_FILE_URL;
	}

	/** Any finished tool counts as progress; a decision tool also resets the reminder budget. */
	noteToolCompleted(toolName: string): void {
		this.#reminderAwaitingProgress = false;
		if (isPlanDecisionTool(toolName)) this.#reminderCount = 0;
	}

	/** A user turn owns the next decision: reset the ladder and drop a forced choice it preempted. */
	noteUserTurn(): void {
		this.#clearLadder();
		this.#host.toolChoices.removeByLabel(DECISION_CHOICE_LABEL);
	}

	/**
	 * Add plan-read protection to a shake config so the active plan file survives beside skill
	 * reads. The matcher reads the reference path at match time, so a retitled plan is covered.
	 */
	withProtection<T extends { protectedTools: ProtectedToolMatcher[] }>(config: T): T {
		const planMatcher = createPlanReadMatcher(() => this.#referencePath);
		return { ...config, protectedTools: [...config.protectedTools, planMatcher] };
	}

	/** The approved-plan reference, or null while plan mode is on, once sent, or when the file is gone. */
	async buildReferenceMessage(): Promise<CustomMessage | null> {
		if (this.enabled) return null;
		if (this.#referenceSent) return null;

		const planFilePath = this.#referencePath;
		try {
			await fs.promises.access(this.#host.resolvePlanPath(planFilePath), fs.constants.R_OK);
		} catch (error) {
			if (isEnoent(error)) return null;
			throw error;
		}

		const content = prompt.render(planModePrompts["plan-mode/reference"].text, { planFilePath });
		this.#referenceSent = true;
		return {
			role: "custom",
			customType: "plan-mode-reference",
			content,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	/** The plan mode rules for the next prompt, or null when plan mode is off. */
	async buildContextMessage(): Promise<CustomMessage | null> {
		const state = this.#state;
		if (!state?.enabled) return null;
		const sessionPlanUrl = DEFAULT_PLAN_FILE_URL;
		const resolvedPlanPath = this.#host.resolvePlanPath(state.planFilePath);
		const resolvedSessionPlan = resolveLocalUrlToPath(sessionPlanUrl, this.#host.localProtocolOptions());
		const displayPlanPath =
			state.planFilePath.startsWith("local:") || resolvedPlanPath !== resolvedSessionPlan
				? state.planFilePath
				: sessionPlanUrl;

		const planExists = fs.existsSync(resolvedPlanPath);
		// The research step names `scout` when that agent is enabled and any other enabled agent
		// otherwise, so the instruction names an agent the spawn path accepts.
		const agentNames = enabledAgentNames(this.#host.taskTool());
		const researchAgent = preferredAgentName(agentNames, "scout"); // not-a-tool-name: agent ids
		const activeToolNames = new Set(this.#host.agent.state.tools.map(tool => tool.name));
		const workspaceDiscoveryTools =
			[TOOL.search, TOOL.read]
				.filter(name => activeToolNames.has(name))
				.map(name => `\`${name}\``)
				.join(", ") || "the available read-only tools";
		const content = prompt.render(planModePrompts["plan-mode/active"].text, {
			planFilePath: displayPlanPath,
			planExists,
			// Keyed on the name: the delegation prose renders only when an agent name exists.
			canDelegate: researchAgent !== undefined,
			researchAgent,
			workspaceDiscoveryTools,
			askToolName: TOOL.ask,
			writeToolName: TOOL.write,
			editToolName: TOOL.edit,
			isHashlineEditMode: this.#host.activeEditMode() === "hashline",
			reentry: state.reentry ?? false,
			iterative: state.workflow === "iterative",
		});

		return {
			role: "custom",
			customType: "plan-mode-context",
			content,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	/**
	 * At a plan mode stop with no tool call, append the decision reminder, force a tool call and
	 * schedule a continuation. Returns true when a continuation was scheduled.
	 */
	async enforceDecisionAtSettle(): Promise<boolean> {
		if (!this.enabled) return false;
		const assistantMessage = this.#host.lastAssistantMessage();
		if (!assistantMessage) return false;
		if (assistantMessage.stopReason === "error" || assistantMessage.stopReason === "aborted") return false;

		const calledDecisionTool = assistantMessage.content.some(
			content => content.type === "toolCall" && isPlanDecisionTool(content.name),
		);
		if (calledDecisionTool) {
			this.#clearLadder();
			return false;
		}
		if (assistantMessage.content.some(content => content.type === "toolCall")) return false;
		if (this.#reminderAwaitingProgress) return false;
		if (this.#reminderCount >= PLAN_MODE_REMINDER_MAX) {
			logger.debug("Plan mode convergence: reminder cap reached; yielding to user");
			return false;
		}
		if (!this.#host.hasTool(TOOL.ask) || !this.#host.hasTool(TOOL.resolve)) {
			logger.warn("Plan mode enforcement skipped because ask/resolve tools are unavailable", {
				activeToolNames: this.#host.agent.state.tools.map(tool => tool.name),
			});
			return false;
		}

		this.#reminderCount++;
		this.#reminderAwaitingProgress = true;
		const toolChoices = this.#host.toolChoices;
		toolChoices.pushOnce("required", { label: DECISION_CHOICE_LABEL });
		const reminder = prompt.render(planModePrompts["plan-mode/tool-decision-reminder"].text, {
			askToolName: TOOL.ask,
		});
		const reminderMessage: Message = {
			role: "developer",
			content: [{ type: "text", text: reminder }],
			attribution: "agent",
			timestamp: Date.now(),
		};

		this.#host.agent.appendMessage(reminderMessage);
		this.#host.sessionStore.appendMessage(reminderMessage);
		this.#host.scheduleAgentContinue({
			generation: this.#host.promptGeneration(),
			// If the continuation never runs (new prompt, dispose, compaction,
			// handoff), the forced choice must not leak onto an unrelated turn.
			onSkip: () => toolChoices.removeByLabel(DECISION_CHOICE_LABEL),
		});
		return true;
	}

	#clearLadder(): void {
		this.#reminderCount = 0;
		this.#reminderAwaitingProgress = false;
	}
}
