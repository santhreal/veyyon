/**
 * Every SETTING that changes the system prompt, and whether flipping it reaches the model.
 *
 * WHY THIS EXISTS. `section-registry.ts` centralized the prompt's sections: what they are,
 * what order they arrive in, which are overridable. One level down, inside those sections,
 * `prompts/session/system-prompt.md` gates text on about twenty variables, and a settings-fed
 * gate was declared in up to six places that had to agree and that nothing compared:
 *
 *   1. `{{#if intentTracing}}` in the template.
 *   2. an optional field on `BuildSystemPromptOptions`.
 *   3. a default in that interface's destructure, which is a SECOND owner of the default,
 *      independent of the setting's own default in `config/settings-domains/`.
 *   4. population at the call site in `sdk.ts`.
 *   5. an entry in the template context object.
 *   6. a hand-written `case` in `modes/controllers/selector-controller.ts`, if flipping the
 *      setting was supposed to rebuild the prompt.
 *
 * Step 6 was the one that failed quietly and the one an operator notices. That switch had
 * exactly two prompt-rebuilding cases, `personality` and `tui.renderMermaid`, while
 * `subagent.batch`, `subagent.delegation`, `subagent.maxConcurrency`, `tools.format` and
 * `includeModelInPrompt` all change prompt text and had none. Flipping one of those in the
 * settings UI changed the setting and left the prompt describing the previous configuration
 * until an unrelated rebuild (a model change, an edit-mode change, a slash command, a memory
 * hook) happened to fire. Nothing was logged, so the prompt and the settings simply disagreed.
 *
 * `default-template.ts` records the same class of failure from the other direction:
 * `taskIrcEnabled` and `eagerTasksAlways` were dropped by an edit and rendered nothing.
 *
 * WHAT THIS FILE CHANGES. The rebuild trigger is now DERIVED from these rows:
 * `selector-controller.ts` asks {@link isLivePromptGate} instead of carrying a case per
 * setting, so registering a gate is what makes it take effect and there is no second list to
 * forget. A row is a decision recorded once, in the place a reader looks for it.
 *
 * FROZEN GATES ARE STATED, NOT IMPLIED. Some gates cannot follow a mid-session flip at all,
 * because `sdk.ts` reads them into a closure constant BEFORE `rebuildSystemPrompt` is
 * defined, so every later rebuild re-reads the same captured value. That was true of five
 * gates and was recorded only in a prose aside in `session/agent-session.ts`. Each one now
 * declares itself frozen and says why, because the two reasons are not the same thing:
 * `inlineToolDescriptors` is frozen deliberately (the whole prune machinery is fixed at
 * session start, so a mid-session model switch keeps the start-time decision), while
 * `includeWorkspaceTree` is frozen only because its read sits above the closure boundary.
 * The first is a design decision. The second is an accident, and naming it as one is the
 * point: `gate-registry.test.ts` pins the frozen list so it cannot grow in silence.
 *
 * NAMING THE ACCIDENT IS WHAT FIXED ONE. `tools.intentTracing` carried a
 * `frozen-by-placement` row whose `because` said moving the read was not enough on its own,
 * since the same constant decided whether the intent field went into every tool schema. That
 * sentence was the whole work order: `sdk.ts` passes a resolver now, `Agent` calls it per
 * turn for both the provider context and the loop config, and the gate is live. A row that
 * states why something is broken is a row someone can close.
 */

/** Why a gate cannot follow a mid-session flip. */
export type GateLiveness =
	/** A flip rebuilds the prompt, because {@link LIVE_PROMPT_GATE_SETTINGS} drives the trigger. */
	| { readonly kind: "live" }
	/** Fixed at session start on purpose. `because` states the design reason. */
	| { readonly kind: "frozen-by-design"; readonly because: string }
	/**
	 * Fixed at session start with no reason anyone chose, because `sdk.ts` reads it into a
	 * closure constant above `rebuildSystemPrompt`. `because` names the read that would have
	 * to move for the gate to become live.
	 */
	| { readonly kind: "frozen-by-placement"; readonly because: string };

/** One setting that changes the system prompt. */
export interface PromptGate {
	/** The settings path, exactly as `settings.get` takes it. */
	readonly setting: string;
	/**
	 * The template variables this setting decides.
	 *
	 * A list rather than one name because the mapping is genuinely many-to-one:
	 * `toolListMode` is decided by `tools.format` and `inlineToolDescriptors` together, so
	 * keying this registry on the variable would have needed two rows describing one question
	 * and no way to ask "does flipping this setting reach the prompt".
	 */
	readonly variables: readonly string[];
	/**
	 * The RUNTIME SECTIONS this setting decides the presence of, if any.
	 *
	 * A setting reaches the prompt in one of two ways and they are not interchangeable: through a
	 * template variable a `{{#if}}` reads, or by deciding whether a runtime section is assembled at
	 * all. Two rows used to describe the second kind as though it were the first, naming a
	 * `{{#if includeWorkspaceTree}}` the template has never contained. Keeping them separate is what
	 * lets `variables` be checked against the template, which is how those two were found.
	 */
	readonly sections?: readonly string[];
	/** What the model sees change, in one line. */
	readonly renders: string;
	readonly liveness: GateLiveness;
}

/**
 * Every setting that changes the system prompt.
 *
 * `as const satisfies` rather than a `readonly PromptGate[]` annotation: the annotation
 * widens `setting` to `string`, and the derived unions below would then have no members to
 * derive, which is the same trap `section-registry.ts` documents for its own rows.
 */
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
		// The master switch reaches the prompt by removing the `task` TOOL, which takes
		// the whole `{{#has tools "task"}}` Delegation section with it. It is listed
		// here because an operator flipping it must see the prompt change, and because
		// the registry is where "which settings rewrite the prompt" is answered.
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
		// `MAX_CONCURRENCY` and not `taskMaxConcurrency`, which is what this row said until a check
		// compared every row's variables against the template and found three that named nothing.
		// `taskMaxConcurrency` is the BUILDER option's name; `system-prompt.ts` passes it to the
		// template as `MAX_CONCURRENCY`. This field is contracted as the template's name, and a
		// statement condition naming the real variable would have been rejected as unknown.
		variables: ["MAX_CONCURRENCY"],
		renders: "the concurrency limit quoted in the delegation guidance",
		liveness: { kind: "live" },
	},
	{
		setting: "subagent.maxRecursionDepth",
		variables: ["taskIrcEnabled"],
		renders: "the IRC-backed parallel coordination clause, which is present only when this session can still spawn",
		liveness: { kind: "live" },
	},
	{
		setting: "subagent.agents",
		variables: ["subagentNames", "hasSubagentSpecialists"],
		renders:
			"which specialists delegation prose names, so it cannot route work to an agent this session cannot spawn",
		liveness: { kind: "live" },
	},
	{
		setting: "includeModelInPrompt",
		// No template variable: this decides whether a RUNTIME SECTION is emitted at all, and runtime
		// sections are assembled in `system-prompt.ts` rather than gated inside the template. Saying
		// `["includeModelInPrompt"]` here claimed a `{{#if includeModelInPrompt}}` that has never
		// existed, which is the sort of thing this registry is supposed to stop rather than assert.
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
		liveness: {
			kind: "frozen-by-design",
			because:
				"the prune machinery is fixed at session start so a mid-session model switch keeps the start-time decision; see the comment above the read in sdk.ts",
		},
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
		// LIVE as of 2026-07-26, and it took both halves the old `because` named. `sdk.ts` now
		// passes a RESOLVER (`intentTracingEnabled`) instead of a captured constant, and `Agent`
		// calls it when it builds the provider context and again when it builds the loop config,
		// both per turn, so the tool schemas follow the setting. `resolveIntentField` in
		// `gate-inputs.ts` is the single owner both readers go through, because a prompt that
		// explains an intent field the schemas do not carry is worse than one that omits it, and
		// two copies of that expression is exactly how they drift apart.
		liveness: { kind: "live" },
	},
] as const satisfies readonly PromptGate[];

/** One row, with its literal setting path intact. */
export type PromptGateEntry = (typeof PROMPT_GATES)[number];

/** Every settings path that changes the system prompt, live or not. */
export type PromptGateSetting = PromptGateEntry["setting"];

/** Every settings path that changes the system prompt, in registry order. */
export const PROMPT_GATE_SETTINGS: readonly PromptGateSetting[] = PROMPT_GATES.map(gate => gate.setting);

/**
 * The settings whose flip must rebuild the prompt.
 *
 * `selector-controller.ts` reads this instead of carrying a `case` per setting. That switch
 * had two of these nine, so seven settings changed the configuration and left the prompt
 * behind.
 */
export const LIVE_PROMPT_GATE_SETTINGS: readonly string[] = PROMPT_GATES.filter(
	gate => gate.liveness.kind === "live",
).map(gate => gate.setting);

/**
 * The settings a mid-session flip cannot reach, whether or not anyone chose that.
 *
 * Exported so a test can pin it: this list shrinking is progress, and it growing is a
 * regression that would otherwise be invisible.
 */
export const FROZEN_PROMPT_GATE_SETTINGS: readonly string[] = PROMPT_GATES.filter(
	gate => gate.liveness.kind !== "live",
).map(gate => gate.setting);

/** The template variables the registry accounts for, deduplicated. */
export const PROMPT_GATE_VARIABLES: readonly string[] = [...new Set(PROMPT_GATES.flatMap(gate => [...gate.variables]))];

/**
 * Whether flipping `setting` must rebuild the system prompt.
 *
 * A `Set` rather than `Array.includes` because this is called from the settings selector's
 * change handler, which runs on every keystroke-driven toggle in the UI.
 */
const liveGateSettings = new Set(LIVE_PROMPT_GATE_SETTINGS);

export function isLivePromptGate(setting: string): boolean {
	return liveGateSettings.has(setting);
}

/** The row for a settings path, or `undefined` when the setting does not touch the prompt. */
export function promptGateFor(setting: string): PromptGateEntry | undefined {
	return PROMPT_GATES.find(gate => gate.setting === setting);
}

/**
 * The line to show an operator who flipped a gate this session cannot pick up.
 *
 * A flip that changes nothing and says nothing is the silent case: the settings UI shows the
 * new value, the prompt keeps the old text, and there is no way to tell from the outside. The
 * wording lives here rather than at the call site so the reason a gate is frozen and the
 * sentence explaining it cannot drift apart.
 *
 * Returns `undefined` for a live gate and for a setting that does not touch the prompt, so a
 * caller can ask about every setting change without deciding first.
 */
/**
 * The runtime sections a gate decides, or none.
 *
 * A function taking the WIDE `PromptGate` type, not `gate.sections?.length` at the call site. The
 * rows are `as const satisfies`, so a row that omits the optional field does not merely have it
 * `undefined`: the property is absent from that member of the union and reading it does not compile.
 * A parameter is not narrowed by an initializer, which is what makes this the one place that has to
 * know the field is optional.
 */
export function gateSections(gate: PromptGate): readonly string[] {
	return gate.sections ?? [];
}

export function frozenGateNotice(setting: string): string | undefined {
	const gate = promptGateFor(setting);
	if (gate === undefined || gate.liveness.kind === "live") return undefined;
	return `Saved, but this session already fixed "${setting}" at startup, so the system prompt keeps its current text (${gate.renders}). It applies on the next session.`;
}
