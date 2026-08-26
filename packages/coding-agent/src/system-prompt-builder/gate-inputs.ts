/**
 * Resolves settings-derived inputs for system prompt construction across session and CLI paths.
 */
import type { AgentTool } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import { $flag } from "@veyyon/utils";
import { INTENT_FIELD } from "@veyyon/wire";
import { resolveDialect } from "../config/dialect-format";
import { shouldInlineToolDescriptors } from "../config/inline-tool-descriptors-mode";
import type { Settings } from "../config/settings";
import { enabledSubagentNames, resolveDelegation } from "../task/subagent-settings";
import { isIrcEnabled } from "../tools/irc-enabled";

/**
 * Settings-derived slice of BuildSystemPromptOptions.
 */
export interface GateInputs {
	/**
	 * The personality to render, by name. "none" omits the block; undefined defaults to "default".
	 */
	readonly personality: string | undefined;
	/** Whether Mermaid fenced blocks are described as rendering to terminal ASCII diagrams. */
	readonly renderMermaid: boolean;
	/** Whether `subagent.batch` is on, which selects the delegation guidance's call shape. */
	readonly taskBatch: boolean;
	/** The concurrency limit the delegation guidance quotes. Zero means unlimited. */
	readonly taskMaxConcurrency: number;
	/** Whether the IRC-backed parallel coordination clause may appear in delegation policy. */
	readonly taskIrcEnabled: boolean;
	/** Ask the model to delegate through tasks unless the change is trivial. */
	readonly eagerTasks: boolean;
	/** Use the hard MUST/ONLY delegation wording (`subagent.delegation: required`) over the softer nudge. */
	readonly eagerTasksAlways: boolean;
	/**
	 * The agent types this session may spawn (subagent.agents), in discovery order.
	 */
	readonly subagentNames: string[];
	/** Whether the active model is surfaced in the workstation block. Prompt policy still uses it. */
	readonly includeModelInPrompt: boolean;
	/** Whether the workspace directory tree is included in the PROJECT section. */
	readonly includeWorkspaceTree: boolean;
	/** Inline full tool descriptors into the prompt body rather than naming the tools. */
	readonly inlineToolDescriptors: boolean;
	/**
	 * True when the provider supports native tool calling, omitting manual dialect instructions.
	 */
	readonly nativeTools: boolean;
	/**
	 * The intent field name injected into every tool schema, or undefined when tracing is off.
	 */
	readonly intentField: string | undefined;
}

/**
 * Fallback values used when gate options are omitted by the caller.
 */
export const OMITTED_GATE_DEFAULTS = {
	/** The named default personality, which is a personality: `none` is the way to have none. */
	personality: "default",
	renderMermaid: true,
	/** The batch call shape, matching `subagent.batch`, because the non-batch shape is the legacy one. */
	taskBatch: true,
	/** Zero means unlimited, so an omitting caller quotes no cap rather than inventing one. */
	taskMaxConcurrency: 0,
	taskIrcEnabled: false,
	eagerTasks: false,
	eagerTasksAlways: false,
	/** No spawnable agent, so delegation prose names none: it cannot route work to an unknown agent. */
	subagentNames: [] as readonly string[],
	/** Off, matching the setting: the model name is the one turn-volatile field in the prompt. */
	includeModelInPrompt: false,
	includeWorkspaceTree: false,
	inlineToolDescriptors: false,
	/** True: with no model to ask, assume the provider takes tool calls natively and teach no dialect. */
	nativeTools: true,
} as const satisfies { readonly [K in Exclude<keyof GateInputs, "intentField">]: unknown };

export interface GateInputContext {
	/** The active tool map, needed because delegation strength is resolved against spawnable agents. */
	readonly tools: ReadonlyMap<string, AgentTool>;
	/**
	 * The active model, or undefined when not yet initialized.
	 */
	readonly model?: (Pick<Model, "supportsTools"> & Partial<Pick<Model, "id">>) | undefined;
	/**
	 * How deep this session already is. A subagent always has peers, so IRC coordination is on
	 * regardless of the recursion limit; only a top-level session has to check it.
	 */
	readonly taskDepth?: number;
}

/**
 * Resolves all setting-gated system prompt inputs from settings and context.
 */
export function resolveGateInputs(settings: Settings, context: GateInputContext): GateInputs {
	// Resolved against the agents the task tool will actually accept, so the prompt cannot ask
	// for delegation this session has nowhere to send. With every agent disabled, `preferred`
	// and `required` both come back false.
	const taskTool = context.tools.get("task");
	const subagentNames = enabledSubagentNames(taskTool);
	const delegation = resolveDelegation(settings, subagentNames);

	return {
		personality: settings.get("personality"),
		renderMermaid: settings.get("tui.renderMermaid"),
		taskBatch: settings.get("subagent.batch"),
		taskMaxConcurrency: settings.get("subagent.maxConcurrency"),
		taskIrcEnabled:
			(context.taskDepth ?? 0) > 0 || (delegation.possible && isIrcEnabled(settings, context.taskDepth ?? 0)),
		eagerTasks: delegation.preferred,
		eagerTasksAlways: delegation.required,
		subagentNames,
		includeModelInPrompt: settings.get("includeModelInPrompt"),
		includeWorkspaceTree: settings.get("includeWorkspaceTree") ?? false,
		// `auto` enforces the per-model policy (inline for Gemini, off otherwise).
		inlineToolDescriptors: shouldInlineToolDescriptors(settings.get("inlineToolDescriptors"), context.model?.id),
		nativeTools: resolveDialect(settings.get("tools.format"), context.model) === undefined,
		intentField: resolveIntentField(settings),
	};
}

/**
 * Resolves the intent field name when intent tracing is enabled by env flag or setting.
 */
export function resolveIntentField(settings: Settings): string | undefined {
	return $flag("VEYYON_INTENT_TRACING", settings.get("tools.intentTracing")) ? INTENT_FIELD : undefined;
}
