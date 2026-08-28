/** Every SETTING that changes the system prompt, and whether flipping it reaches the model. what order they arrive in, which are overridable. One level down, inside those sections, */

/** Why a gate cannot follow a mid-session flip. */
export type GateLiveness =
	/** A flip rebuilds the prompt, because {@link LIVE_PROMPT_GATE_SETTINGS} drives the trigger. */
	| { readonly kind: "live" }
	/** Fixed at session start on purpose. `because` states the design reason. */
	| { readonly kind: "frozen-by-design"; readonly because: string }
	/** Fixed at session start with no reason anyone chose, because `sdk.ts` reads it into a closure constant above `rebuildSystemPrompt`. `because` names the read that would have */
	| { readonly kind: "frozen-by-placement"; readonly because: string };

/** One setting that changes the system prompt. */
export interface PromptGate {
	/** The settings path, exactly as `settings.get` takes it. */
	readonly setting: string;
	/** The template variables this setting decides. A list rather than one name because the mapping is genuinely many-to-one: */
	readonly variables: readonly string[];
	/** The RUNTIME SECTIONS this setting decides the presence of, if any. A setting reaches the prompt in one of two ways and they are not interchangeable: through a */
	readonly sections?: readonly string[];
	/** What the model sees change, in one line. */
	readonly renders: string;
	readonly liveness: GateLiveness;
}

/** Every setting that changes the system prompt. `as const satisfies` rather than a `readonly PromptGate[]` annotation: the annotation */
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
		// The master switch reaches the prompt by removing the `task` TOOL, which takes the whole `{{#has tools "task"}}` Delegation section with it. It is listed
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
		// `MAX_CONCURRENCY` and not `taskMaxConcurrency`, which is what this row said until a check compared every row's variables against the template and found three that named nothing.
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
		// No template variable: this decides whether a RUNTIME SECTION is emitted at all, and runtime sections are assembled in `system-prompt.ts` rather than gated inside the template. Saying
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
		// Same category as `includeModelInPrompt`: a runtime section, not a template variable.
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
		// Both variables, because the setting decides both: `intentTracing` gates the bullet and
		// `intentField` is the parameter name interpolated into it. Naming only the first left
		// `intentField` claimed by nothing, so a statement condition on it would have been rejected.
		variables: ["intentTracing", "intentField"],
		renders: "the paragraph explaining the intent field injected into every tool schema",
		// LIVE as of 2026-07-26, and it took both halves the old `because` named. `sdk.ts` now passes a RESOLVER (`intentTracingEnabled`) instead of a captured constant, and `Agent`
		liveness: { kind: "live" },
	},
] as const satisfies readonly PromptGate[];

/** One row, with its literal setting path intact. */
export type PromptGateEntry = (typeof PROMPT_GATES)[number];

/** Every settings path that changes the system prompt, live or not. */
export type PromptGateSetting = PromptGateEntry["setting"];

/** Every settings path that changes the system prompt, in registry order. */
export const PROMPT_GATE_SETTINGS: readonly PromptGateSetting[] = PROMPT_GATES.map(gate => gate.setting);

/** The settings whose flip must rebuild the prompt. `selector-controller.ts` reads this instead of carrying a `case` per setting. That switch */
export const LIVE_PROMPT_GATE_SETTINGS: readonly string[] = PROMPT_GATES.filter(
	gate => gate.liveness.kind === "live",
).map(gate => gate.setting);

/** The settings a mid-session flip cannot reach, whether or not anyone chose that. Exported so a test can pin it: this list shrinking is progress, and it growing is a */
export const FROZEN_PROMPT_GATE_SETTINGS: readonly string[] = PROMPT_GATES.filter(
	gate => gate.liveness.kind !== "live",
).map(gate => gate.setting);

/** The template variables the registry accounts for, deduplicated. */
export const PROMPT_GATE_VARIABLES: readonly string[] = [...new Set(PROMPT_GATES.flatMap(gate => [...gate.variables]))];

/** Whether flipping `setting` must rebuild the system prompt. A `Set` rather than `Array.includes` because this is called from the settings selector's */
const liveGateSettings = new Set(LIVE_PROMPT_GATE_SETTINGS);

export function isLivePromptGate(setting: string): boolean {
	return liveGateSettings.has(setting);
}

/** The row for a settings path, or `undefined` when the setting does not touch the prompt. */
export function promptGateFor(setting: string): PromptGateEntry | undefined {
	return PROMPT_GATES.find(gate => gate.setting === setting);
}

/** The line to show an operator who flipped a gate this session cannot pick up. A flip that changes nothing and says nothing is the silent case: the settings UI shows the */
/** The runtime sections a gate decides, or none. A function taking the WIDE `PromptGate` type, not `gate.sections?.length` at the call site. The */
export function gateSections(gate: PromptGate): readonly string[] {
	return gate.sections ?? [];
}

export function frozenGateNotice(setting: string): string | undefined {
	const gate = promptGateFor(setting);
	if (gate === undefined || gate.liveness.kind === "live") return undefined;
	return `Saved, but this session already fixed "${setting}" at startup, so the system prompt keeps its current text (${gate.renders}). It applies on the next session.`;
}
