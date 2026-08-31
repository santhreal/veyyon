/**
 * Turning settings into system-prompt input, in ONE place.
 *
 * WHY THIS EXISTS. `gate-registry.ts` records WHICH settings change the prompt. This module is
 * the other half: HOW each one becomes a `buildSystemPrompt` option. Those are different
 * questions, and only the first had an owner.
 *
 * The second had two consumers doing it independently, and one of them did not do it at all.
 * `sdk.ts` reads twelve settings and passes them to the builder, which is the session path.
 * `cli/prompt-cli.ts` is the inspection path, and its own file header says it "resolves the
 * same inputs a real session resolves" and justifies resolving the tool set for real because
 * "a prompt inspected against an imagined tool list is a prompt nobody will ever be sent". It
 * then passed exactly three things: tools, tool names, and cwd. Every settings-fed gate fell
 * to the omitted-option default in `system-prompt.ts`, so with `subagent.delegation=required`
 * and `personality=none` the tool rendered a prompt with no Eager Tasks section and a
 * personality block, both the opposite of what a session with those settings sends.
 *
 * That is the tooling reason a small gated edit is hard to make: the surface built to show you
 * the prompt was the one surface that could not show you a settings change.
 *
 * WHAT THIS FILE GUARANTEES. Both paths call {@link resolveGateInputs}, so the inspection
 * output follows the configuration by construction rather than by keeping a second copy of the
 * same twelve reads in step. A gate added here reaches both paths at once.
 *
 * WHAT IT DELIBERATELY DOES NOT COVER. Inputs that are not settings: the discovered tool set,
 * skills, rules, context files, the workspace tree, whether the obfuscator found secrets, which
 * memory backend resolved. Those come from the environment rather than from configuration, and
 * each caller resolves them from what it has.
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
 * The settings-derived slice of `BuildSystemPromptOptions`, and the ONE place these fields are
 * declared.
 *
 * PLACE 2 OF SIX, given one home. Each of these gates used to be declared twice: here, and again as
 * an optional field on `BuildSystemPromptOptions` with its own doc comment and its own restatement of
 * the default. The two could drift in type, in meaning, and in what they claimed the default was.
 * `BuildSystemPromptOptions` now extends `Partial<GateInputs>`, so adding a gate here reaches the
 * builder's signature by construction and there is one doc comment to read.
 *
 * The import goes one way on purpose: `system-prompt.ts` imports this module, so this module cannot
 * import `BuildSystemPromptOptions` back. That is why the slice is declared here rather than derived
 * from the options type.
 *
 * Defaults are NOT restated in these docs. {@link OMITTED_GATE_DEFAULTS} owns what an omitted option
 * is worth, and a doc comment repeating it is a second owner that nothing compares.
 */
export interface GateInputs {
	/**
	 * The personality to render, by name.
	 *
	 * Resolved against built-ins plus Tier-B `~/.veyyon/personalities` and `.veyyon/personalities`
	 * data files (project > user > built-in). `"none"` omits the block; an unknown name falls back to
	 * `"default"` with a warning.
	 *
	 * `undefined` means the setting is unset, which is NOT the same as `"none"`. The absence is passed
	 * through rather than resolved here, and {@link OMITTED_GATE_DEFAULTS} turns it into `"default"`.
	 * One owner either way; this keeps "the operator chose nothing" distinguishable from "the operator
	 * chose the default personality" for a reader of the resolved slice.
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
	 * The agent types this session may spawn (`subagent.agents`), in discovery order.
	 *
	 * Delegation prose names a specialist only when it is in this list: the bundled specialists ship
	 * off, and telling the model to route research to a `scout` it cannot spawn is an instruction it
	 * can only fail.
	 */
	readonly subagentNames: string[];
	/** Whether the active model is surfaced in the workstation block. Prompt policy still uses it. */
	readonly includeModelInPrompt: boolean;
	/** Whether the workspace directory tree is included in the PROJECT section. */
	readonly includeWorkspaceTree: boolean;
	/** Inline full tool descriptors into the prompt body rather than naming the tools. */
	readonly inlineToolDescriptors: boolean;
	/**
	 * True when the provider takes tool calls natively, so the prompt leaves the tool list to it.
	 *
	 * Derived here rather than left to the caller because it is the option `tools.format` reaches
	 * the prompt THROUGH: `toolListMode` is `!inlineToolDescriptors && nativeTools`. The gate was
	 * registered as live while nothing derived this, so flipping `tools.format` changed nothing in
	 * the inspected prompt and the registry's claim was true only of the session path.
	 */
	readonly nativeTools: boolean;
	/**
	 * The intent field name injected into every tool schema, or `undefined` when tracing is off.
	 *
	 * Both the presence and the name matter to the prompt: presence gates the paragraph, and the name
	 * is interpolated into it, so a prompt that explains a field the schemas do not carry is worse
	 * than one that omits it.
	 */
	readonly intentField: string | undefined;
}

/**
 * What each gate is worth to a caller that passes no gate options at all.
 *
 * PLACE 3 OF SIX, given one home. A settings-fed fragment of prompt text used to be declared in up
 * to six places that had to agree (see the header of `gate-registry.ts`), and this was the third:
 * `buildSystemPrompt` destructured every gate option with an inline fallback, so each default had a
 * SECOND owner independent of the setting's own default in `config/settings-domains/`, and nothing
 * compared them. The fallbacks were not one rule either. Some matched the settings default
 * (`taskBatch`, `renderMermaid`), some were the opposite of it (`eagerTasks: false` against a
 * shipped `subagent.delegation: preferred`), and reading them meant reading a 40-line destructure.
 *
 * WHAT AN OMITTED OPTION MEANS, stated once: the caller has no configuration to offer, so the gate
 * renders as if it were off or empty. That is deliberately NOT the same as "as a default session
 * would render", and the difference is measured rather than assumed:
 * `prompt-gate-inputs.test.ts` renders the prompt with these fallbacks and again with a default
 * session's resolved values and asserts they differ, naming the text an omitting caller loses.
 * That divergence is why `veyyon prompt` could not be built by omission and calls
 * {@link resolveGateInputs} instead. Four entries differ from a default session and the test names
 * all four: `eagerTasks`, `taskIrcEnabled` and `subagentNames` are off or empty where a default
 * session has them on, and `taskMaxConcurrency` is 0 (quote no cap) against the shipped 32.
 *
 * So this table is the answer to "what does the builder do when told nothing", and the test above is
 * the answer to "and how does that differ from a real session". A new fallback that silently
 * disagrees with its setting fails that test rather than shipping.
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
	 * The active model, or `undefined` when there is none yet.
	 *
	 * The whole object rather than an id: `inlineToolDescriptors: "auto"` keys its per-model
	 * policy off the id, and `tools.format: "auto"` needs `supportsTools` to decide whether a
	 * dialect has to be taught at all.
	 */
	readonly model?: (Pick<Model, "supportsTools"> & Partial<Pick<Model, "id">>) | undefined;
	/**
	 * How deep this session already is. A subagent always has peers, so IRC coordination is on
	 * regardless of the recursion limit; only a top-level session has to check it.
	 */
	readonly taskDepth?: number;
}

/**
 * Read every setting the system prompt gates on, once.
 *
 * Each read is the one the session already made, moved here unchanged, so the session path's
 * behaviour is identical and the inspection path stops being a second, thinner
 * implementation. `agentKind === "sub"` still overrides `personality` at the session call site:
 * that is a fact about the caller rather than about the settings, so it does not belong here.
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
 * The intent field's name when intent tracing is on, or `undefined` when it is off.
 *
 * ONE OWNER, because there are two readers and they must never disagree. This decides BOTH whether the
 * prompt explains the intent field and whether every tool schema carries it: `sdk.ts` passes the same
 * answer to the agent, which injects the field and strips it back out of the arguments. A prompt that
 * explains a field the schemas do not carry is worse than one that omits it, and two copies of this
 * expression is how that happens -- one of them stops honouring the env flag, or one gets a `?? false`,
 * and nothing fails.
 *
 * The env flag wins over the setting, which is why this is not a bare `settings.get`.
 */
export function resolveIntentField(settings: Settings): string | undefined {
	return $flag("VEYYON_INTENT_TRACING", settings.get("tools.intentTracing")) ? INTENT_FIELD : undefined;
}
