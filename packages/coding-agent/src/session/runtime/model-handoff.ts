/**
 * Prewalk and plan-yolo: the two one-way model handoffs a session can start with.
 *
 * This is a session collaborator. It holds the armed target of each handoff and the latches that
 * sequence it, and reaches the session only through {@link ModelHandoffHost}. Both hand a run from
 * the starting model to a `target` once the starting model has produced a plan, and neither switch
 * runs twice:
 *
 * - **Prewalk** ({@link advancePrewalk}) switches at the first completed turn that runs an edit or
 *   write tool once a todo list exists. A hidden nudge asks the starting model for the plan, and a
 *   hidden checklist asks the target to verify its work.
 * - **Plan-yolo** ({@link armPlanYoloIfNeeded}) puts the session in read-only plan mode before the
 *   first prompt and switches when the model resolves the plan, with no interactive review.
 */
import * as fs from "node:fs/promises";
import type { AgentMessage, AgentToolResult, AgentTurnEndContext } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import { modelsAreEqual } from "@veyyon/catalog/models";
import { isEnoent, prompt } from "@veyyon/utils";
import { listLocalPlanFileUrls } from "../../internal-urls/local-protocol";
import { resolveApprovedPlan } from "../../plan-mode/approved-plan";
import { DEFAULT_PLAN_FILE_URL } from "../../plan-mode/plan-file-url";
import type { PlanModeState } from "../../plan-mode/state";
import { planModePrompts } from "../../prompts/plan-mode/rows";
import { turnControlPrompts } from "../../prompts/turn-control/rows";
import type { ConfiguredThinkingLevel } from "../../thinking";
import { type ResolveToolDetails, runResolveInvocation } from "../../tools/agent/resolve";
import { TOOL } from "../../tools/core/builtin-names";
import { ToolError } from "../../tools/core/tool-errors";
import type { PlanYolo, Prewalk } from "../agent-session-types";
import {
	PLAN_YOLO_HANDOFF_MESSAGE_TYPE,
	PREWALK_ACTION_TOOLS,
	PREWALK_CHECKLIST_MESSAGE_TYPE,
	PREWALK_CONTINUE_MESSAGE_TYPE,
	PREWALK_PLAN_MESSAGE_TYPE,
} from "../nudges";

/** The agent slice a handoff drives: read and rewrite the live context, and steer hidden nudges. */
export interface ModelHandoffAgent {
	readonly state: { readonly messages: readonly AgentMessage[] };
	steer(message: AgentMessage): void;
	replaceMessages(messages: AgentMessage[]): void;
}

export interface ModelHandoffHost {
	readonly agent: ModelHandoffAgent;
	/** The model the session runs now. */
	model(): Model | undefined;
	/** Switch models for this session without saving the choice. */
	setModelTemporary(model: Model, thinkingLevel?: ConfiguredThinkingLevel): Promise<void>;
	emitNotice(level: "info", message: string, source: string): void;
	/** Resolves once the message has reached the session file. */
	waitForPersistence(message: AgentMessage): Promise<void>;
	/** Whether a todo list exists or the session has no todo tool, after recording this turn's todo calls. */
	todoGateOpen(toolResults: AgentTurnEndContext["toolResults"]): boolean;
	getActiveToolNames(): string[];
	hasBuiltInTool(name: string): boolean;
	setActiveToolsByName(toolNames: string[]): Promise<void>;
	getPlanModeState(): PlanModeState | undefined;
	setPlanModeState(state: PlanModeState | undefined): void;
	getPlanReferencePath(): string;
	setStandingResolveHandler(handler: ((input: unknown) => Promise<unknown> | unknown) | null): void;
	/** Filesystem path of a plan reference, whichever spelling it carries. */
	resolvePlanPath(planFilePath: string): string;
	/** Filesystem path of the session's `local://` root. */
	localRootPath(): string;
}

export class ModelHandoff {
	readonly #host: ModelHandoffHost;
	#prewalk: Prewalk | undefined;
	/** True once the plan nudge has been queued; scrubbed from context at the switch. */
	#prewalkPlanInjected = false;
	#planYolo: PlanYolo | undefined;
	#planYoloPreviousTools: string[] | undefined;
	#planYoloArmed = false;

	constructor(host: ModelHandoffHost, config: { prewalk?: Prewalk; planYolo?: PlanYolo }) {
		this.#host = host;
		this.#prewalk = config.prewalk;
		this.#planYolo = config.planYolo;
	}

	/** Prewalk state, if armed and active. */
	get prewalk(): Prewalk | undefined {
		return this.#prewalk;
	}

	/** Advance the one-way prewalk switch at a completed assistant-turn boundary. */
	async advancePrewalk(liveMessages: AgentMessage[], context: AgentTurnEndContext | undefined): Promise<void> {
		const prewalk = this.#prewalk;
		if (!prewalk || context?.message.role !== "assistant") return;
		const host = this.#host;

		// Every branch below assumes the agent loop runs another turn. It does not if THIS turn had no
		// tool calls: the loop treats a text-only turn as the agent being done. The plan nudge asks for
		// a prose reply, which makes a text-only turn common right after it, and that ended SWE-bench
		// runs before any code was written. Force one more turn only in that self-created window.
		if (this.#prewalkPlanInjected && context.toolResults.length === 0) {
			host.agent.steer({
				role: "custom",
				customType: PREWALK_CONTINUE_MESSAGE_TYPE,
				content: turnControlPrompts["turn-control/prewalk-continue"].text,
				attribution: "agent",
				display: false,
				timestamp: Date.now(),
			});
		}

		// The plan nudge instructs "finish the plan, then init the todo list from it and start", so the
		// switch waits until a todo list exists AND the model has started implementing (first
		// edit/write). The todo call itself never triggers: firing there handed the fast model the
		// whole implementation cold. Sessions without a todo tool skip the gate.
		const action = host.todoGateOpen(context.toolResults)
			? context.toolResults.find(result => PREWALK_ACTION_TOOLS[result.toolName])
			: undefined;
		if (!action) {
			if (!this.#prewalkPlanInjected) {
				this.#prewalkPlanInjected = true;
				host.agent.steer({
					role: "custom",
					customType: PREWALK_PLAN_MESSAGE_TYPE,
					content: turnControlPrompts["turn-control/prewalk-plan"].text,
					display: false,
					attribution: "agent",
					timestamp: Date.now(),
				});
				host.emitNotice("info", "Prewalk: injected deep-plan nudge.", "prewalk");
			}
			return;
		}

		await host.waitForPersistence(context.message);
		for (const toolResult of context.toolResults) {
			await host.waitForPersistence(toolResult);
		}

		this.#scrubPrewalkPlanNudge(liveMessages);
		const target = prewalk.target;
		const current = host.model();
		if (current && modelsAreEqual(current, target)) {
			this.#prewalk = undefined;
			return;
		}

		await host.setModelTemporary(target, prewalk.thinkingLevel);
		this.#prewalk = undefined;
		host.emitNotice(
			"info",
			`Prewalk: switched to ${target.provider}/${target.id} after first ${action.toolName} call.`,
			"prewalk",
		);
		host.agent.steer({
			role: "custom",
			customType: PREWALK_CHECKLIST_MESSAGE_TYPE,
			content: turnControlPrompts["turn-control/prewalk-checklist"].text,
			attribution: "agent",
			display: false,
			timestamp: Date.now(),
		});
	}

	/**
	 * Arm prewalk outside the normal startup path (the `/prewalk` slash command): sets the target and
	 * steers the plan nudge at once rather than at the next turn boundary, since a manual invocation
	 * means "start this now". A no-op with a notice while a prewalk is already armed and waiting.
	 */
	armPrewalk(target: Model, thinkingLevel?: ConfiguredThinkingLevel): void {
		const host = this.#host;
		if (this.#prewalk) {
			host.emitNotice(
				"info",
				`Prewalk: already armed for ${this.#prewalk.target.provider}/${this.#prewalk.target.id}, waiting for the first edit/write.`,
				"prewalk",
			);
			return;
		}
		this.#prewalk = { target, thinkingLevel };
		this.#prewalkPlanInjected = true;
		host.agent.steer({
			role: "custom",
			customType: PREWALK_PLAN_MESSAGE_TYPE,
			content: turnControlPrompts["turn-control/prewalk-plan"].text,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		});
		host.emitNotice(
			"info",
			`Prewalk: armed for ${target.provider}/${target.id} — will switch at the first edit/write once the todo list exists.`,
			"prewalk",
		);
	}

	/**
	 * Remove the plan nudge from the LLM context before the model switch: the fast model inherits the
	 * plan the nudge produced, not the nudge itself. Splices the loop's live context array in place
	 * (the run streams from it) and mirrors the removal into agent state. The persisted transcript
	 * keeps the message for audit; a session reload re-materializes it, which prewalk's single-run
	 * lifecycle tolerates.
	 */
	#scrubPrewalkPlanNudge(liveMessages: AgentMessage[]): void {
		if (!this.#prewalkPlanInjected) return;
		const isPlanNudge = (m: AgentMessage): boolean =>
			m.role === "custom" && m.customType === PREWALK_PLAN_MESSAGE_TYPE;
		for (let i = liveMessages.length - 1; i >= 0; i--) {
			if (isPlanNudge(liveMessages[i])) liveMessages.splice(i, 1);
		}
		const agent = this.#host.agent;
		const stateMessages = agent.state.messages;
		const filtered = stateMessages.filter(m => !isPlanNudge(m));
		if (filtered.length !== stateMessages.length) agent.replaceMessages(filtered);
	}

	/**
	 * Arm plan-yolo before the first prompt is built: restricts tools to the plan-mode read-only set
	 * (plus `resolve`/`write`, both normally discovery-hidden), marks plan-mode state so the session
	 * injects the plan-mode-active instructions on this and every following prompt, and registers the
	 * auto-approve resolve handler. A no-op once armed or when plan-yolo is not configured.
	 */
	async armPlanYoloIfNeeded(): Promise<void> {
		if (!this.#planYolo || this.#planYoloArmed) return;
		this.#planYoloArmed = true;
		const host = this.#host;
		const previousTools = host.getActiveToolNames();
		const augmentations: string[] = [TOOL.resolve];
		if (host.hasBuiltInTool(TOOL.write)) augmentations.push(TOOL.write);
		await host.setActiveToolsByName(Array.from(new Set(previousTools.concat(augmentations))));
		this.#planYoloPreviousTools = previousTools;
		host.setPlanModeState({
			enabled: true,
			planFilePath: host.getPlanReferencePath() || DEFAULT_PLAN_FILE_URL,
			workflow: "parallel",
		});
		host.setStandingResolveHandler(input => this.#runPlanYoloApprovalResolve(input));
	}

	/**
	 * Standing resolve handler while plan-yolo's plan phase is active. Approves the instant the model
	 * calls `resolve { action: "apply" }` for the plan, the headless counterpart to plan mode's
	 * "Approve and execute", then restores tools, exits plan-mode state, switches to the configured
	 * `target`, and hands off the approved plan for it to implement.
	 */
	#runPlanYoloApprovalResolve(input: unknown): Promise<AgentToolResult<ResolveToolDetails>> {
		const host = this.#host;
		return runResolveInvocation(input as Parameters<typeof runResolveInvocation>[0], {
			sourceToolName: "plan_approval",
			label: "Plan ready for approval",
			apply: async (_reason, extra) => {
				const planYolo = this.#planYolo;
				const state = host.getPlanModeState();
				if (!planYolo || !state?.enabled) {
					throw new ToolError("Plan mode is not active.");
				}
				const { planFilePath, title } = await resolveApprovedPlan({
					suppliedTitle: extra?.title,
					statePlanFilePath: state.planFilePath,
					readPlan: url => this.#readPlanFile(url),
					listPlanFiles: () => listLocalPlanFileUrls(host.localRootPath()),
				});
				const previousTools = this.#planYoloPreviousTools;
				if (previousTools) {
					await host.setActiveToolsByName(previousTools);
				}
				host.setStandingResolveHandler(null);
				host.setPlanModeState(undefined);
				this.#planYolo = undefined;
				this.#planYoloPreviousTools = undefined;
				await host.setModelTemporary(planYolo.target, planYolo.thinkingLevel);
				host.emitNotice(
					"info",
					`Plan-yolo: plan approved, switched to ${planYolo.target.provider}/${planYolo.target.id} to implement "${title}".`,
					"plan-yolo",
				);
				host.agent.steer({
					role: "custom",
					customType: PLAN_YOLO_HANDOFF_MESSAGE_TYPE,
					content: prompt.render(planModePrompts["plan-mode/yolo-handoff"].text, { planFilePath, title }),
					attribution: "agent",
					display: false,
					timestamp: Date.now(),
				});
				return {
					content: [
						{ type: "text" as const, text: `Plan approved. Implementing now with ${planYolo.target.id}.` },
					],
					details: { planFilePath, title, planExists: true },
				};
			},
		});
	}

	async #readPlanFile(planFilePath: string): Promise<string | null> {
		try {
			return await fs.readFile(this.#host.resolvePlanPath(planFilePath), "utf8");
		} catch (error) {
			if (isEnoent(error)) return null;
			throw error;
		}
	}
}
