export type GateLiveness =
	| { readonly kind: "live" }
	| { readonly kind: "frozen-by-design"; readonly because: string }
	| { readonly kind: "frozen-by-placement"; readonly because: string };

export interface PromptGate {
	readonly setting: string;
	readonly variables: readonly string[];
	readonly sections?: readonly string[];
	readonly renders: string;
	readonly liveness: GateLiveness;
}

export const PROMPT_GATES = [
	{
		setting: "personality",
		variables: ["personality"],
		renders: "the personality block, or nothing when set to `none`",
		liveness: { kind: "live" },
	},
	{
		setting: "tui.renderMermaid",
		variables: ["renderMermaid"],
		renders: "whether the model is told Mermaid fences render as terminal diagrams",
		liveness: { kind: "live" },
	},
	{
		setting: "subagent.enabled",
		variables: ["tools"],
		renders: "the whole Delegation section, which is absent when subagents are off",
		liveness: { kind: "live" },
	},
	{
		setting: "subagent.delegation",
		variables: ["eagerTasks", "eagerTasksAlways"],
		renders: "whether the section asks for delegation, and whether it uses MUST/ONLY wording or the softer nudge",
		liveness: { kind: "live" },
	},
	{
		setting: "subagent.batch",
		variables: ["taskBatch"],
		renders: "which call shape the delegation guidance teaches",
		liveness: { kind: "live" },
	},
	{
		setting: "subagent.maxConcurrency",
		variables: ["MAX_CONCURRENCY"],
		renders: "the concurrency limit quoted in the delegation guidance",
		liveness: { kind: "live" },
	},
	{
		setting: "subagent.agents",
		variables: ["subagentNames", "hasSpawnableSubagent"],
		renders: "whether delegation prose is emitted and which enabled agent types it names",
		liveness: { kind: "live" },
	},
	{
		setting: "includeModelInPrompt",
		variables: [],
		sections: ["workstation"],
		renders: "whether the active model is surfaced in the workstation block",
		liveness: { kind: "live" },
	},
	{
		setting: "tools.format",
		variables: ["toolListMode"],
		renders: "whether tools are described inline or left to the provider's native tool list",
		liveness: { kind: "live" },
	},
	{
		setting: "inlineToolDescriptors",
		variables: ["toolListMode"],
		renders: "whether tool descriptors are inlined into the prompt body",
		liveness: { kind: "live" },
	},
	{
		setting: "includeWorkspaceTree",
		variables: [],
		sections: ["project"],
		renders: "whether the workspace directory tree is included in the PROJECT section",
		liveness: {
			kind: "frozen-by-placement",
			because:
				"sdk.ts reads it into a closure constant above `rebuildSystemPrompt`, so every rebuild re-reads the session-start value",
		},
	},
	{
		setting: "tools.intentTracing",
		variables: ["intentTracing", "intentField"],
		renders: "the paragraph explaining the intent field injected into every tool schema",
		liveness: { kind: "live" },
	},
] as const satisfies readonly PromptGate[];

export type PromptGateEntry = (typeof PROMPT_GATES)[number];

export type PromptGateSetting = PromptGateEntry["setting"];

export const PROMPT_GATE_SETTINGS: readonly PromptGateSetting[] = PROMPT_GATES.map(gate => gate.setting);

export const LIVE_PROMPT_GATE_SETTINGS: readonly string[] = PROMPT_GATES.filter(
	gate => gate.liveness.kind === "live",
).map(gate => gate.setting);

export const FROZEN_PROMPT_GATE_SETTINGS: readonly string[] = PROMPT_GATES.filter(
	gate => gate.liveness.kind !== "live",
).map(gate => gate.setting);

export const PROMPT_GATE_VARIABLES: readonly string[] = [...new Set(PROMPT_GATES.flatMap(gate => [...gate.variables]))];

const liveGateSettings = new Set(LIVE_PROMPT_GATE_SETTINGS);

export function isLivePromptGate(setting: string): boolean {
	return liveGateSettings.has(setting);
}

export function promptGateFor(setting: string): PromptGateEntry | undefined {
	return PROMPT_GATES.find(gate => gate.setting === setting);
}

export function gateSections(gate: PromptGate): readonly string[] {
	return gate.sections ?? [];
}

export function frozenGateNotice(setting: string): string | undefined {
	const gate = promptGateFor(setting);
	if (gate === undefined || gate.liveness.kind === "live") return undefined;
	return `Saved, but this session already fixed "${setting}" at startup, so the system prompt keeps its current text (${gate.renders}). It applies on the next session.`;
}
