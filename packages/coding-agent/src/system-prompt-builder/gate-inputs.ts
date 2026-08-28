import type { AgentTool } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import { $flag } from "@veyyon/utils";
import { INTENT_FIELD } from "@veyyon/wire";
import { resolveDialect } from "../config/dialect-format";
import { shouldInlineToolDescriptors } from "../config/inline-tool-descriptors-mode";
import type { Settings } from "../config/settings";
import { enabledSubagentNames, resolveDelegation } from "../task/subagent-settings";
import { isIrcEnabled } from "../tools/irc-enabled";

export interface GateInputs {
	readonly personality: string | undefined;
	readonly renderMermaid: boolean;
	readonly taskBatch: boolean;
	readonly taskMaxConcurrency: number;
	readonly taskIrcEnabled: boolean;
	readonly eagerTasks: boolean;
	readonly eagerTasksAlways: boolean;
	readonly subagentNames: string[];
	readonly includeModelInPrompt: boolean;
	readonly includeWorkspaceTree: boolean;
	readonly inlineToolDescriptors: boolean;
	readonly nativeTools: boolean;
	readonly intentField: string | undefined;
}

export const OMITTED_GATE_DEFAULTS = {
	personality: "default",
	renderMermaid: true,
	taskBatch: true,
	taskMaxConcurrency: 0,
	taskIrcEnabled: false,
	eagerTasks: false,
	eagerTasksAlways: false,
	subagentNames: [] as readonly string[],
	includeModelInPrompt: false,
	includeWorkspaceTree: false,
	inlineToolDescriptors: false,
	nativeTools: true,
} as const satisfies { readonly [K in Exclude<keyof GateInputs, "intentField">]: unknown };

export interface GateInputContext {
	readonly tools: ReadonlyMap<string, AgentTool>;
	readonly model?: (Pick<Model, "supportsTools"> & Partial<Pick<Model, "id">>) | undefined;
	readonly taskDepth?: number;
}

export function resolveGateInputs(settings: Settings, context: GateInputContext): GateInputs {
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
		inlineToolDescriptors: shouldInlineToolDescriptors(settings.get("inlineToolDescriptors"), context.model?.id),
		nativeTools: resolveDialect(settings.get("tools.format"), context.model) === undefined,
		intentField: resolveIntentField(settings),
	};
}

export function resolveIntentField(settings: Settings): string | undefined {
	return $flag("VEYYON_INTENT_TRACING", settings.get("tools.intentTracing")) ? INTENT_FIELD : undefined;
}
