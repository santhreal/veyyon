/**
 * The system prompt as STATEMENTS, not as a document.
 *
 * WHY THIS EXISTS. The prompt subsystem had two mechanisms for structure and only one of them
 * was real. `section-registry.ts` declares sections as rows, so a section is addressable,
 * orderable, overridable and testable. The conditions INSIDE those sections were `{{#if}}`
 * blocks embedded in prose, so they were none of those things.
 *
 * Two symptoms show what that cost. `prompt-gate-registry.test.ts` had to REGEX
 * `system-prompt.md` to discover what the prompt gates on, because there was no list to read.
 * And `prompt-gate-inputs.test.ts` could only assert `expect(flipped).not.toBe(baseline)` over a
 * 76KB string, because a single gated line had no name to assert on. A "tiny point of the
 * prompt" was not addressable at all: sections were, and there are six of them.
 *
 * A statement has an id, so it can be named, asserted on, measured, overridden and ablated.
 *
 * THE GRANULARITY RULE, which is the whole design:
 *
 *   A statement is the smallest unit that can independently be present, absent, or different
 *   across sessions. If you cannot name a condition or configuration under which it would
 *   change, it is not a statement, it is part of one.
 *
 * That keeps the registry exactly as fine as behaviour requires and no finer. ROLE's fourteen
 * lines are two rows, not fourteen: the role sentence and five engineering principles are always
 * present together, so they are ONE statement, and the Mermaid bullet is a second because
 * `renderMermaid` can remove it.
 *
 * ONE ADDITION, which the last two sections forced and which is not a loophole: a unit the PROMPT
 * ITSELF DELIMITS may be its own statement even when nothing varies it. DELIVERY CONTRACT is five
 * unconditional XML blocks (`<contract>`, `<completeness>`, `<evidence-and-output>`, `<yielding>`,
 * `<critical>`) and EXECUTION WORKFLOW is six numbered steps under markdown headings; the rule above
 * would merge each set into a single row. The reason not to is that those boundaries are declared by
 * the document rather than invented by the registry, so splitting on them is not the arbitrary split
 * the rule exists to prevent, and an eval that ablates one contract block or one workflow step needs
 * each to have a name.
 *
 * So the check is: two adjacent `always` rows are a merge to make UNLESS the second one opens a unit
 * the document declares, meaning its text starts with a markdown heading or an XML tag. Two adjacent
 * `always` rows of plain prose are still reported, which is the case the rule was written for.
 *
 * CONDITIONS COME FROM A CLOSED VOCABULARY. A row names a variable, and the suite checks that
 * every named variable is either a registered settings gate (`gate-registry.ts`) or one of the
 * classified non-settings gates. A statement therefore cannot depend on something that does not
 * exist, which is the setting -> option -> default -> caller -> context -> template chain
 * collapsing into one row.
 *
 * THE TEXT LIVES IN MD FILES, one per statement, in `statements/<section>/<id>.md` beside this
 * file. The import is the registration, the same contract every other registry in this repo
 * states.
 *
 * They live HERE and not under `prompts/`, which is where they were first put and where they were
 * wrong: `prompts/registry.ts` owns every `.md` under `src/prompts`, so two registries claimed one
 * directory tree and `prompt-registry-coverage.test.ts` reported the statement files as prompts
 * that registry had failed to register. The test was right. A statement is not a prompt in that
 * sense: a prompt is a standalone document sent to a model, and a statement is a fragment of one.
 * Keeping statements beside the registry that registers them is also what every other registry in
 * this repo does.
 *
 * THE MIGRATION IS FINISHED, and knowing that is what makes the rest of this file readable. All
 * six template sections are assembled here, so this registry is the ONLY source of system-prompt
 * text; `prompts/session/system-prompt.md` supplies the document's shape and stays as the frozen
 * pre-migration reference the byte gate compares against. There is no half-converted state, so
 * there is no flag asking whether a section is converted, and {@link STATEMENT_SECTIONS} is
 * derived from the sections the document DECLARES rather than from these rows, with a load-time
 * check that every one is covered. Deriving it from the rows would mean a section could lose its
 * statements and simply drop off the list, silently handing that region back to the frozen copy.
 *
 * BYTE IDENTITY WAS THE MIGRATION'S SAFETY GATE AND REMAINS THE DRIFT GATE. This is text every
 * model reads, so drift is a silent behaviour change. `statement-assembly.test.ts` renders the
 * statements for each section and asserts the bytes equal what the Handlebars template produces
 * for the same inputs, across a matrix of gate combinations rather than just defaults.
 */

import { isRecord } from "@veyyon/utils";
import { renderBanner } from "./banner-grammar";
import { SYSTEM_PROMPT_SECTIONS } from "./section-registry";
import statementConventions from "./statements/conventions/conventions.md" with { type: "text" };
import statementDeliveryCompleteness from "./statements/delivery-contract/completeness.md" with { type: "text" };
import statementDeliveryContract from "./statements/delivery-contract/contract.md" with { type: "text" };
import statementDeliveryCritical from "./statements/delivery-contract/critical.md" with { type: "text" };
import statementDeliveryEvidenceAndOutput from "./statements/delivery-contract/evidence-and-output.md" with {
	type: "text",
};
import statementDeliveryPersonality from "./statements/delivery-contract/personality.md" with { type: "text" };
import statementDeliveryYielding from "./statements/delivery-contract/yielding.md" with { type: "text" };
import statementExecutionCleanup from "./statements/execution-workflow/cleanup.md" with { type: "text" };
import statementExecutionDecompose from "./statements/execution-workflow/decompose.md" with { type: "text" };
import statementExecutionImplement from "./statements/execution-workflow/implement.md" with { type: "text" };
import statementExecutionImplementAskFirst from "./statements/execution-workflow/implement-ask-first.md" with {
	type: "text",
};
import statementExecutionImplementGrep from "./statements/execution-workflow/implement-grep.md" with { type: "text" };
import statementExecutionImplementNoDestructive from "./statements/execution-workflow/implement-no-destructive.md" with {
	type: "text",
};
import statementExecutionReadSkillsAndRules from "./statements/execution-workflow/read-skills-and-rules.md" with {
	type: "text",
};
import statementExecutionResearch from "./statements/execution-workflow/research.md" with { type: "text" };
import statementExecutionResearchLspReferences from "./statements/execution-workflow/research-lsp-references.md" with {
	type: "text",
};
import statementExecutionResearchReread from "./statements/execution-workflow/research-reread.md" with { type: "text" };
import statementExecutionScope from "./statements/execution-workflow/scope.md" with { type: "text" };
import statementExecutionScopePlanFirst from "./statements/execution-workflow/scope-plan-first.md" with {
	type: "text",
};
import statementExecutionVerify from "./statements/execution-workflow/verify.md" with { type: "text" };
import statementRoleMermaid from "./statements/role/mermaid-diagrams.md" with { type: "text" };
import statementRolePrinciples from "./statements/role/principles.md" with { type: "text" };
import statementRuntimeAlwaysApplyRules from "./statements/runtime/always-apply-rules.md" with { type: "text" };
import statementRuntimeDomainRules from "./statements/runtime/domain-rules.md" with { type: "text" };
import statementRuntimeUrlsAgents from "./statements/runtime/internal-urls-agents.md" with { type: "text" };
import statementRuntimeUrlsHead from "./statements/runtime/internal-urls-head.md" with { type: "text" };
import statementRuntimeUrlsTail from "./statements/runtime/internal-urls-tail.md" with { type: "text" };
import statementRuntimeMcpDiscovery from "./statements/runtime/mcp-discovery-notice.md" with { type: "text" };
import statementRuntimeMemoryUrl from "./statements/runtime/memory-root-url.md" with { type: "text" };
import statementRuntimeObsidianUrl from "./statements/runtime/obsidian-vault-url.md" with { type: "text" };
import statementRuntimeSkills from "./statements/runtime/skills.md" with { type: "text" };
import statementRuntimeSkillsHeading from "./statements/runtime/skills-rules-heading.md" with { type: "text" };
import statementRuntimeInventoryList from "./statements/runtime/tool-inventory-list.md" with { type: "text" };
import statementRuntimeInventoryText from "./statements/runtime/tool-inventory-text.md" with { type: "text" };
import statementToolPolicyAst from "./statements/tool-policy/ast.md" with { type: "text" };
import statementToolPolicyAstEdit from "./statements/tool-policy/ast-edit.md" with { type: "text" };
import statementToolPolicyAstGrep from "./statements/tool-policy/ast-grep.md" with { type: "text" };
import statementToolPolicyAstPlainText from "./statements/tool-policy/ast-plain-text.md" with { type: "text" };
import statementToolPolicyDelegation from "./statements/tool-policy/delegation.md" with { type: "text" };
import statementToolPolicyDelegationCodexEager from "./statements/tool-policy/delegation-codex-eager.md" with {
	type: "text",
};
import statementToolPolicyDelegationCodexOff from "./statements/tool-policy/delegation-codex-off.md" with {
	type: "text",
};
import statementToolPolicyDelegationConcurrencyCap from "./statements/tool-policy/delegation-concurrency-cap.md" with {
	type: "text",
};
import statementToolPolicyDelegationGates from "./statements/tool-policy/delegation-gates.md" with { type: "text" };
import statementToolPolicyDelegationPreferred from "./statements/tool-policy/delegation-preferred.md" with {
	type: "text",
};
import statementToolPolicyDelegationRequired from "./statements/tool-policy/delegation-required.md" with {
	type: "text",
};
import statementToolPolicyDelegationSequence from "./statements/tool-policy/delegation-sequence.md" with {
	type: "text",
};
import statementToolPolicyDelegationSubagentValue from "./statements/tool-policy/delegation-subagent-value.md" with {
	type: "text",
};
import statementToolPolicyExploration from "./statements/tool-policy/exploration.md" with { type: "text" };
import statementToolPolicyExplorationGlob from "./statements/tool-policy/exploration-glob.md" with { type: "text" };
import statementToolPolicyExplorationGrep from "./statements/tool-policy/exploration-grep.md" with { type: "text" };
import statementToolPolicyExplorationRead from "./statements/tool-policy/exploration-read.md" with { type: "text" };
import statementToolPolicyGeneral from "./statements/tool-policy/general.md" with { type: "text" };
import statementToolPolicyInspectImage from "./statements/tool-policy/inspect-image.md" with { type: "text" };
import statementToolPolicyIntentField from "./statements/tool-policy/intent-field.md" with { type: "text" };
import statementToolPolicyLsp from "./statements/tool-policy/lsp.md" with { type: "text" };
import statementToolPolicyParallelMeansSubagents from "./statements/tool-policy/parallel-means-subagents.md" with {
	type: "text",
};
import statementToolPolicyReportToolIssue from "./statements/tool-policy/report-tool-issue.md" with { type: "text" };
import statementToolPolicySecretsRedaction from "./statements/tool-policy/secrets-redaction.md" with { type: "text" };
import statementToolPolicySpecializedBash from "./statements/tool-policy/specialized-bash.md" with { type: "text" };
import statementToolPolicySpecializedBashLitmus from "./statements/tool-policy/specialized-bash-litmus.md" with {
	type: "text",
};
import statementToolPolicySpecializedEdit from "./statements/tool-policy/specialized-edit.md" with { type: "text" };
import statementToolPolicySpecializedGlob from "./statements/tool-policy/specialized-glob.md" with { type: "text" };
import statementToolPolicySpecializedGrep from "./statements/tool-policy/specialized-grep.md" with { type: "text" };
import statementToolPolicySpecializedLsp from "./statements/tool-policy/specialized-lsp.md" with { type: "text" };
import statementToolPolicySpecializedRead from "./statements/tool-policy/specialized-read.md" with { type: "text" };
import statementToolPolicySpecializedTools from "./statements/tool-policy/specialized-tools.md" with { type: "text" };
import statementToolPolicySpecializedWrite from "./statements/tool-policy/specialized-write.md" with { type: "text" };
import statementToolPolicyToolIo from "./statements/tool-policy/tool-io.md" with { type: "text" };

/**
 * When a statement is included.
 *
 * THE FORMS ARE COUNTED, NOT GUESSED. `system-prompt.md` uses 26 `{{#if}}`, 22 `{{#has}}`, 2
 * `{{#ifAny}}` and 10 `{{else}}` arms, and the `{{#if}}` blocks nest: the tool inventory sits
 * inside `{{#if toolInfo.length}}` and then splits on `{{#if toolListMode}}`. So presence is not
 * always one variable, and the else arm of a block-level pair is a real condition rather than a
 * second statement. That is what {@link StatementCondition} has to express, and no more.
 *
 * THE FORMS COMPOSE, which is why `whenAll` and `whenAny` hold conditions rather than variable
 * names. The template's actual requirement is "A and not B" (the `{{else}}` at line 77 renders
 * `{{toolInventory}}` when there is tool info and the list mode is off), and a flat
 * `whenAll: string[]` cannot say that without either a second special form per combination or a
 * magic `!name` prefix. Recursion costs one line in each evaluator and says all of it.
 *
 * WHAT IS DELIBERATELY NOT HERE. Most conditionality in the template is INTRA-LINE, not
 * block-level: `- {{#if label}}{{label}}: \`{{name}}\`{{else}}\`{{name}}\`{{/if}}` inside an
 * `{{#each}}`, or a sentence that grows a clause when `taskBatch` is on. Those are not statements.
 * Modelling them here would shatter sentences into fragments and produce a registry far finer than
 * behaviour requires, which the granularity rule above forbids. The division is: this registry
 * decides whether a statement is PRESENT, and Handlebars decides what the statement SAYS, which is
 * why {@link assembleSection} renders each statement's text (see its note).
 */
export type StatementCondition =
	/** Always in the prompt. The absence of a condition is stated rather than left implicit. */
	| { readonly kind: "always" }
	/** Included when `variable` is truthy, matching `{{#if variable}}`. */
	| { readonly kind: "when"; readonly variable: string }
	/** Included when `collection` contains `member`, matching `{{#has collection "member"}}`. */
	| { readonly kind: "whenContains"; readonly collection: string; readonly member: string }
	/** Included when every nested condition holds, matching nested `{{#if}}` blocks. */
	| { readonly kind: "whenAll"; readonly conditions: readonly StatementCondition[] }
	/** Included when any nested condition holds, matching `{{#ifAny a b}}`. */
	| { readonly kind: "whenAny"; readonly conditions: readonly StatementCondition[] }
	/** Included when the nested condition does NOT hold: a block-level `{{else}}` arm. */
	| { readonly kind: "not"; readonly condition: StatementCondition };

/**
 * Row-authoring builders.
 *
 * Nested object literals say the same thing, and for a two-level condition they say it in four
 * lines of braces where `allOf(when("toolInfo"), not(when("toolListMode")))` says it in one. The
 * rows are the part of this file people read, so they get the readable spelling. These construct
 * the same values a literal would and are checked against literals in `statement-registry.test.ts`,
 * so they cannot drift into a second vocabulary.
 */
export function when(variable: string): StatementCondition {
	return { kind: "when", variable };
}

/** `{{#has collection "member"}}`. */
export function contains(collection: string, member: string): StatementCondition {
	return { kind: "whenContains", collection, member };
}

/** Every condition holds: nested `{{#if}}` blocks. */
export function allOf(...conditions: readonly StatementCondition[]): StatementCondition {
	return { kind: "whenAll", conditions };
}

/** Any condition holds: `{{#ifAny a b}}`. */
export function anyOf(...conditions: readonly StatementCondition[]): StatementCondition {
	return { kind: "whenAny", conditions };
}

/** The condition does not hold: a block-level `{{else}}` arm. */
export function not(condition: StatementCondition): StatementCondition {
	return { kind: "not", condition };
}

/**
 * The template variables that are FACTS ABOUT THE SESSION rather than settings.
 *
 * A statement's condition names a variable, and that variable has to come from somewhere. Most come
 * from a setting, and `gate-registry.ts` already enumerates those in each gate's `variables`. The
 * rest are facts the session discovers: whether any skills loaded, whether an Obsidian vault is
 * attached, what tools were built. Nothing enumerated them, so a condition could name a variable
 * that nothing ever sets and the statement would simply never appear, silently.
 *
 * `statement-registry.test.ts` closes that: every variable a condition names must be either a
 * registered gate's variable or a row here. The list therefore GROWS as sections convert, and the
 * failure when it has not is the point rather than a chore. It fails closed, which is why the check
 * is an equality against this list and not a lookup that shrugs when it misses.
 *
 * Each row says where the fact comes from, because "is this a real variable" is a question a reader
 * should be able to answer here instead of by grepping the builder.
 *
 * A VARIABLE BELONGS TO EXACTLY ONE OF THE TWO LISTS, and the suite checks they are disjoint. It
 * caught `hasSubagentSpecialists` here on the first run: it reads like a session fact, but it is
 * derived from the agents the task tool will accept and that tool is built from `subagent.agents`,
 * so the gate row owns it. Two owners would leave a reader unable to tell whether a setting controls
 * it, which is the question this list exists to answer.
 */
export const SESSION_FACT_VARIABLES: Readonly<Record<string, string>> = Object.freeze({
	skills: "the skills this session loaded, from the skill registry",
	rules: "domain rules whose globs the session matched",
	alwaysApplyRules: "rules the operator marked always-apply, so they are inlined rather than referenced",
	hasMemoryRoot: "whether the project has a memory root for `memory://root` to resolve",
	hasObsidian: "whether an Obsidian vault is attached, which is what makes `vault://` real",
	toolInfo: "the tools built for this session, as name and label pairs",
	toolInventory: "the pre-rendered inventory text, used when the tools are not listed natively",
	mcpDiscoveryMode: "whether MCP tools are discovered on demand rather than all being present",
	hasMCPDiscoveryServers: "whether any discoverable MCP server is configured, so the list is worth naming",
	toolRefs: "the resolved tool names to interpolate, so the prompt never names a tool that is not built",
	useCodexTaskPrompt:
		"whether the active model wants the Codex-style delegation wording, derived from the model rather than from a setting",
	secretsEnabled:
		"whether an obfuscator is holding secrets, so the redaction note is only shown to a session that can produce `#XXXX#` tokens",
});

/**
 * How exactly a converted section reproduces the template it replaced.
 *
 * BYTE-EXACT IS THE BAR and two sections meet it. The other four cannot, for one reason worth stating
 * precisely rather than hiding behind a looser assertion. Note this classifies the PRE-normalization
 * comparison, which is the one `statement-assembly.test.ts` makes: post-`format` differences are held
 * separately, per matrix point, by `statement-wiring.test.ts`.
 *
 * `format` strips a run of 2+ blank lines ENTIRELY and preserves a single one (`prompt.ts`, and it
 * says so). RUNTIME's template has three UNCONDITIONAL blank lines interleaved between its three
 * conditional rule blocks. So when two of those blocks are absent, two blank lines land next to each
 * other and both vanish, and `# Skills & Rules` ends up jammed against `# Internal URLs` with no
 * blank line at all. The spacing between two present blocks therefore depends on how many UNRELATED
 * blocks happen to be absent.
 *
 * A statement cannot own an unconditional blank line, because a statement's bytes appear only when
 * its condition holds. The same shape appears in `tool-policy` (three heading junctions),
 * `execution-workflow` (conditional bullets inside bullet lists) and `delivery-contract` (the
 * personality block sitting between two unconditional blanks). Measured across the whole matrix: NOT
 * ONE WORD differs at any point, and the blank-line deltas are enumerated per point in
 * `statement-matrix.ts` with the single mechanism that produces all of them written out there.
 *
 * Attempts that do not work, so they are not retried: giving the heading a trailing blank line takes
 * the differing cases from 3 to 13, because the template has no blank after the heading; giving the
 * conditional blocks a leading blank instead produces two adjacent blanks when the previous block is
 * present, which `format` then deletes entirely.
 */
export const SECTION_FIDELITY: Readonly<Record<string, "byte-exact" | "spacing-normalized">> = Object.freeze({
	conventions: "byte-exact",
	role: "byte-exact",
	runtime: "spacing-normalized",
	"tool-policy": "spacing-normalized",
	"execution-workflow": "spacing-normalized",
	"delivery-contract": "spacing-normalized",
});

/** One statement of the system prompt. */
export interface PromptStatement {
	/**
	 * Stable, addressable name, `<section>/<slug>`.
	 *
	 * This is the handle the whole design exists to provide: a test asserts a statement by id
	 * rather than by diffing 76KB, an eval ablates one rule by id, and `prompt-inspect` reports
	 * cost per id. It is also the path of its md file under `statements/`, so a row and its text
	 * are found from each other by reading, exactly as prompt ids work in `prompts/registry.ts`.
	 */
	readonly id: string;
	/** The section this statement belongs to, from `section-registry.ts`. */
	readonly section: string;
	readonly condition: StatementCondition;
	/** The statement's exact bytes, including its trailing newline. */
	readonly text: string;
	/** What this statement tells the model, and why it is its own statement. */
	readonly purpose: string;
}

/**
 * Every converted statement, in the order it reaches the model.
 *
 * `as const satisfies` and not a `readonly PromptStatement[]` annotation, for the reason
 * `section-registry.ts` documents at length: the annotation widens `id` and `section` to `string`
 * and the derivations below lose the literals they are derived from.
 *
 * ORDER IS THE PROMPT'S ORDER. Within a section, concatenating the included statements
 * reproduces that section's bytes, and `statement-assembly.test.ts` asserts exactly that against
 * the Handlebars render.
 *
 * EVERY SECTION IS CONVERTED. `system-prompt.md` is still the file the statements were extracted from
 * and still the byte-identity gate's reference, which is why it remains in the tree: the gate renders
 * the prompt both ways and compares. It stops being a source of truth the moment that gate retires.
 * `statement-registry.test.ts` pins the converted set, so a section silently reverting to the
 * template cannot go unnoticed.
 */
export const PROMPT_STATEMENTS = [
	{
		id: "conventions/conventions",
		section: "conventions",
		condition: { kind: "always" },
		text: statementConventions,
		purpose:
			"the <system-conventions> preamble: RFC 2119 vocabulary and the rule that system-authored XML markers are authoritative wherever they appear",
	},
	{
		id: "role/principles",
		section: "role",
		condition: { kind: "always" },
		text: statementRolePrinciples,
		purpose:
			"who the agent is plus the five engineering principles, which are one statement because no configuration removes any of them independently",
	},
	{
		id: "role/mermaid-diagrams",
		section: "role",
		condition: { kind: "when", variable: "renderMermaid" },
		text: statementRoleMermaid,
		purpose: "tells the model it may emit a mermaid block, which is only true when the terminal renders one as ASCII",
	},
	{
		id: "runtime/skills-rules-heading",
		section: "runtime",
		condition: { kind: "always" },
		text: statementRuntimeSkillsHeading,
		purpose:
			"the `# Skills & Rules` heading, which stands whether or not any of the three blocks under it render, so it is not part of any of them",
	},
	{
		id: "runtime/skills",
		section: "runtime",
		condition: when("skills"),
		text: statementRuntimeSkills,
		purpose:
			"the must-read-the-skill instruction plus the skill table, pointless and misleading when no skill loaded",
	},
	{
		id: "runtime/always-apply-rules",
		section: "runtime",
		condition: when("alwaysApplyRules"),
		text: statementRuntimeAlwaysApplyRules,
		purpose: "inlines the rules the operator marked always-apply, rather than referencing them by `rule://`",
	},
	{
		id: "runtime/domain-rules",
		section: "runtime",
		condition: when("rules"),
		text: statementRuntimeDomainRules,
		purpose:
			"lists the domain rules whose globs this session matched, with the globs so the model can tell when one applies",
	},
	{
		id: "runtime/internal-urls-head",
		section: "runtime",
		condition: { kind: "always" },
		text: statementRuntimeUrlsHead,
		purpose: "opens the internal-URL table with the two schemes every session has, `skill://` and `rule://`",
	},
	{
		id: "runtime/memory-root-url",
		section: "runtime",
		condition: when("hasMemoryRoot"),
		text: statementRuntimeMemoryUrl,
		purpose:
			"names `memory://root` only when the project has one, because a URL scheme the session cannot resolve is an instruction to fail",
	},
	{
		id: "runtime/internal-urls-agents",
		section: "runtime",
		condition: { kind: "always" },
		text: statementRuntimeUrlsAgents,
		purpose:
			"the agent, history, artifact and local schemes, which exist in every session because the harness provides them",
	},
	{
		id: "runtime/obsidian-vault-url",
		section: "runtime",
		condition: when("hasObsidian"),
		text: statementRuntimeObsidianUrl,
		purpose: "the `vault://` scheme and its query operations, real only when a vault is actually attached",
	},
	{
		id: "runtime/internal-urls-tail",
		section: "runtime",
		condition: { kind: "always" },
		text: statementRuntimeUrlsTail,
		purpose:
			"closes the table with the MCP, issue, PR and harness-doc schemes, including the avoid-unless-asked note",
	},
	{
		id: "runtime/tool-inventory-list",
		section: "runtime",
		condition: allOf(when("toolInfo"), when("toolListMode")),
		text: statementRuntimeInventoryList,
		purpose:
			"names the tools compactly when the provider carries their schemas natively, so the prompt does not repeat what the API already sent",
	},
	{
		id: "runtime/tool-inventory-text",
		section: "runtime",
		condition: allOf(when("toolInfo"), not(when("toolListMode"))),
		text: statementRuntimeInventoryText,
		purpose:
			"the full descriptor text instead, for a provider with no native tool schemas; the `{{else}}` arm of the same template block, which is why it is `not` rather than a second variable",
	},
	{
		id: "runtime/mcp-discovery-notice",
		section: "runtime",
		condition: allOf(when("toolInfo"), when("mcpDiscoveryMode")),
		text: statementRuntimeMcpDiscovery,
		purpose:
			"tells the model to search for MCP tools before concluding none exist, which is only true when tools are discovered on demand rather than all being present",
	},
	{
		id: "tool-policy/general",
		section: "tool-policy",
		condition: { kind: "always" },
		text: statementToolPolicyGeneral,
		purpose: "the General heading and the five tool-use rules that hold whatever tools exist",
	},
	{
		id: "tool-policy/parallel-means-subagents",
		section: "tool-policy",
		condition: contains("tools", "task"),
		text: statementToolPolicyParallelMeansSubagents,
		purpose:
			"tells the model that the word `parallel` demands subagents, which is only answerable when the task tool is built",
	},
	{
		id: "tool-policy/tool-io",
		section: "tool-policy",
		condition: { kind: "always" },
		text: statementToolPolicyToolIo,
		purpose: "the Tool I/O heading and the relative-path preference, true of every tool set",
	},
	{
		id: "tool-policy/intent-field",
		section: "tool-policy",
		condition: when("intentTracing"),
		text: statementToolPolicyIntentField,
		purpose: "names the intent parameter most tools take, and names it only when intent tracing puts it on them",
	},
	{
		id: "tool-policy/secrets-redaction",
		section: "tool-policy",
		condition: when("secretsEnabled"),
		text: statementToolPolicySecretsRedaction,
		purpose: "explains `#XXXX#` tokens, shown only to a session whose obfuscator can produce them",
	},
	{
		id: "tool-policy/inspect-image",
		section: "tool-policy",
		condition: contains("tools", "inspect_image"),
		text: statementToolPolicyInspectImage,
		purpose: "prefers the image tool over a plain read to spare context, when that tool exists",
	},
	{
		id: "tool-policy/specialized-tools",
		section: "tool-policy",
		condition: { kind: "always" },
		text: statementToolPolicySpecializedTools,
		purpose: "the heading and the MUST that governs the whole specialized-tool list below it",
	},
	{
		id: "tool-policy/specialized-read",
		section: "tool-policy",
		condition: contains("tools", "read"),
		text: statementToolPolicySpecializedRead,
		purpose: "routes file and directory reads to the read tool rather than a shell equivalent",
	},
	{
		id: "tool-policy/specialized-edit",
		section: "tool-policy",
		condition: contains("tools", "edit"),
		text: statementToolPolicySpecializedEdit,
		purpose: "routes surgical edits to the edit tool",
	},
	{
		id: "tool-policy/specialized-write",
		section: "tool-policy",
		condition: contains("tools", "write"),
		text: statementToolPolicySpecializedWrite,
		purpose: "routes create and overwrite to the write tool",
	},
	{
		id: "tool-policy/specialized-lsp",
		section: "tool-policy",
		condition: contains("tools", "lsp"),
		text: statementToolPolicySpecializedLsp,
		purpose: "routes code intelligence to the language server rather than to search",
	},
	{
		id: "tool-policy/specialized-grep",
		section: "tool-policy",
		condition: contains("tools", "grep"),
		text: statementToolPolicySpecializedGrep,
		purpose: "routes regex search to the grep tool and names the shell commands it replaces",
	},
	{
		id: "tool-policy/specialized-glob",
		section: "tool-policy",
		condition: contains("tools", "glob"),
		text: statementToolPolicySpecializedGlob,
		purpose: "routes globbing to the glob tool and names the shell commands it replaces",
	},
	{
		id: "tool-policy/specialized-bash",
		section: "tool-policy",
		condition: contains("tools", "bash"),
		text: statementToolPolicySpecializedBash,
		purpose: "bounds bash to real binaries and short pipelines, and says the shadowing commands are blocked",
	},
	{
		id: "tool-policy/specialized-bash-litmus",
		section: "tool-policy",
		condition: contains("tools", "bash"),
		text: statementToolPolicySpecializedBashLitmus,
		purpose:
			"the litmus test for bash versus a tool, its own statement because it is the rule a model actually applies rather than the bound above",
	},
	{
		id: "tool-policy/report-tool-issue",
		section: "tool-policy",
		condition: contains("tools", "report_tool_issue"),
		text: statementToolPolicyReportToolIssue,
		purpose:
			"the critical block asking the model to report inconsistent tool output, which is pointless without the tool that receives it",
	},
	{
		id: "tool-policy/exploration",
		section: "tool-policy",
		condition: { kind: "always" },
		text: statementToolPolicyExploration,
		purpose: "the Exploration heading and the rule against opening files hopefully, true of every tool set",
	},
	{
		id: "tool-policy/exploration-grep",
		section: "tool-policy",
		condition: contains("tools", "grep"),
		text: statementToolPolicyExplorationGrep,
		purpose: "names grep as the way to locate targets during exploration",
	},
	{
		id: "tool-policy/exploration-glob",
		section: "tool-policy",
		condition: contains("tools", "glob"),
		text: statementToolPolicyExplorationGlob,
		purpose: "names glob as the way to map structure during exploration",
	},
	{
		id: "tool-policy/exploration-read",
		section: "tool-policy",
		condition: contains("tools", "read"),
		text: statementToolPolicyExplorationRead,
		purpose: "asks for offset and limit reads rather than whole files, which only means something when read exists",
	},
	{
		id: "tool-policy/lsp",
		section: "tool-policy",
		condition: contains("tools", "lsp"),
		text: statementToolPolicyLsp,
		purpose:
			"the LSP section: the operations a language server answers and the instruction never to hand-search for them",
	},
	{
		id: "tool-policy/ast",
		section: "tool-policy",
		condition: anyOf(contains("tools", "ast_grep"), contains("tools", "ast_edit")),
		text: statementToolPolicyAst,
		purpose: "the AST heading and the prefer-syntax-aware rule, present when either AST tool is built",
	},
	{
		id: "tool-policy/ast-grep",
		section: "tool-policy",
		condition: contains("tools", "ast_grep"),
		text: statementToolPolicyAstGrep,
		purpose:
			"names the structural discovery tool, separate from the edit tool because either can be built without the other",
	},
	{
		id: "tool-policy/ast-edit",
		section: "tool-policy",
		condition: contains("tools", "ast_edit"),
		text: statementToolPolicyAstEdit,
		purpose:
			"names the codemod tool, its own row because a session can have structural search without structural edit",
	},
	{
		id: "tool-policy/ast-plain-text",
		section: "tool-policy",
		condition: anyOf(contains("tools", "ast_grep"), contains("tools", "ast_edit")),
		text: statementToolPolicyAstPlainText,
		purpose:
			"confines plain grep to cases where structure is irrelevant, which only needs saying when a structural tool exists",
	},
	{
		id: "tool-policy/delegation",
		section: "tool-policy",
		condition: contains("tools", "task"),
		text: statementToolPolicyDelegation,
		purpose: "the Delegation heading, which opens the section the task tool makes real",
	},
	{
		id: "tool-policy/delegation-codex-eager",
		section: "tool-policy",
		condition: allOf(contains("tools", "task"), when("useCodexTaskPrompt"), when("eagerTasks")),
		text: statementToolPolicyDelegationCodexEager,
		purpose:
			"the Codex-style wording that activates proactive delegation and revokes any earlier ask-first instruction",
	},
	{
		id: "tool-policy/delegation-codex-off",
		section: "tool-policy",
		condition: allOf(contains("tools", "task"), when("useCodexTaskPrompt"), not(when("eagerTasks"))),
		text: statementToolPolicyDelegationCodexOff,
		purpose:
			"the Codex-style wording that forbids spawning without an explicit request; the else arm of the same block, hence `not`",
	},
	{
		id: "tool-policy/delegation-required",
		section: "tool-policy",
		condition: allOf(
			contains("tools", "task"),
			not(when("useCodexTaskPrompt")),
			when("eagerTasks"),
			when("eagerTasksAlways"),
		),
		text: statementToolPolicyDelegationRequired,
		purpose:
			"delegation as the default with an exhaustive list of when to work alone, for the strongest delegation setting",
	},
	{
		id: "tool-policy/delegation-preferred",
		section: "tool-policy",
		condition: allOf(
			contains("tools", "task"),
			not(when("useCodexTaskPrompt")),
			when("eagerTasks"),
			not(when("eagerTasksAlways")),
		),
		text: statementToolPolicyDelegationPreferred,
		purpose:
			"the softer SHOULD wording; the else arm of the required block, and the one statement whose boundary is mid-line in the template rather than at a line break",
	},
	{
		id: "tool-policy/delegation-subagent-value",
		section: "tool-policy",
		condition: allOf(contains("tools", "task"), not(when("useCodexTaskPrompt"))),
		text: statementToolPolicyDelegationSubagentValue,
		purpose:
			"the four bullets on what a subagent is FOR, which the brace nesting hides inside the not-Codex branch rather than the task block",
	},
	{
		id: "tool-policy/delegation-gates",
		section: "tool-policy",
		condition: contains("tools", "task"),
		text: statementToolPolicyDelegationGates,
		purpose:
			"the Delegation gates list: scope before spawning, never outsource the plan, width equals real independence, prerequisites inline, and who owns the user's intent",
	},
	{
		id: "tool-policy/delegation-concurrency-cap",
		section: "tool-policy",
		condition: allOf(contains("tools", "task"), when("MAX_CONCURRENCY")),
		text: statementToolPolicyDelegationConcurrencyCap,
		purpose:
			"quotes the concurrency cap, gated on there being one; the template compares MAX_CONCURRENCY against zero with the `when` helper, and Handlebars truthiness already makes 0 falsy, so a plain `when` condition is exactly equivalent and no comparison form is needed",
	},
	{
		id: "tool-policy/delegation-sequence",
		section: "tool-policy",
		condition: contains("tools", "task"),
		text: statementToolPolicyDelegationSequence,
		purpose:
			"the sequence-only-when-necessary rule, including the IRC aside that Handlebars keeps inline because it varies within the sentence",
	},
	{
		id: "execution-workflow/scope",
		section: "execution-workflow",
		condition: { kind: "always" },
		text: statementExecutionScope,
		purpose: "the Scope heading and the step-1 framing every request goes through",
	},
	{
		id: "execution-workflow/read-skills-and-rules",
		section: "execution-workflow",
		condition: anyOf(when("skills"), when("rules")),
		text: statementExecutionReadSkillsAndRules,
		purpose:
			"tells the model to read skills and rules first, present only when there is something to read; the inner wording that picks between skills, rules or both stays in Handlebars because it varies within the sentence",
	},
	{
		id: "execution-workflow/scope-plan-first",
		section: "execution-workflow",
		condition: { kind: "always" },
		text: statementExecutionScopePlanFirst,
		purpose: "requires planning and convention research before touching files on multi-file work",
	},
	{
		id: "execution-workflow/research",
		section: "execution-workflow",
		condition: { kind: "always" },
		text: statementExecutionResearch,
		purpose: "the Research heading and the read-sections-not-snippets rule with its ban on a second convention",
	},
	{
		id: "execution-workflow/research-lsp-references",
		section: "execution-workflow",
		condition: contains("tools", "lsp"),
		text: statementExecutionResearchLspReferences,
		purpose:
			"requires a references lookup before changing an exported symbol, which only a language server can answer",
	},
	{
		id: "execution-workflow/research-reread",
		section: "execution-workflow",
		condition: { kind: "always" },
		text: statementExecutionResearchReread,
		purpose: "requires re-reading after a tool failure or an external change",
	},
	{
		id: "execution-workflow/decompose",
		section: "execution-workflow",
		condition: { kind: "always" },
		text: statementExecutionDecompose,
		purpose: "the Decompose heading, todo discipline, and the rule that cleanup is not planned up front",
	},
	{
		id: "execution-workflow/implement",
		section: "execution-workflow",
		condition: { kind: "always" },
		text: statementExecutionImplement,
		purpose: "the Implement heading and the fix-at-source, prefer-existing-files, review-as-the-user rules",
	},
	{
		id: "execution-workflow/implement-grep",
		section: "execution-workflow",
		condition: contains("tools", "grep"),
		text: statementExecutionImplementGrep,
		purpose: "grep instead of guessing, which needs the tool that makes it possible",
	},
	{
		id: "execution-workflow/implement-ask-first",
		section: "execution-workflow",
		condition: contains("tools", "ask"),
		text: statementExecutionImplementAskFirst,
		purpose: "asks before destructive commands when there is a tool to ask with",
	},
	{
		id: "execution-workflow/implement-no-destructive",
		section: "execution-workflow",
		condition: not(contains("tools", "ask")),
		text: statementExecutionImplementNoDestructive,
		purpose:
			"forbids destructive commands outright when there is no way to ask; the else arm of the same block, so it is `not` rather than a second variable",
	},
	{
		id: "execution-workflow/verify",
		section: "execution-workflow",
		condition: { kind: "always" },
		text: statementExecutionVerify,
		purpose: "the Verify heading, the proof-per-ask-type table, the smoke-test rule and the test-quality bar",
	},
	{
		id: "execution-workflow/cleanup",
		section: "execution-workflow",
		condition: { kind: "always" },
		text: statementExecutionCleanup,
		purpose: "the Cleanup phase: what it covers, that it is last, and that it is never pre-planned",
	},
	{
		id: "delivery-contract/contract",
		section: "delivery-contract",
		condition: { kind: "always" },
		text: statementDeliveryContract,
		purpose:
			"the inviolable contract block: never yield incomplete, never fabricate, never substitute an easier problem, clean cutover",
	},
	{
		id: "delivery-contract/completeness",
		section: "delivery-contract",
		condition: { kind: "always" },
		text: statementDeliveryCompleteness,
		purpose:
			"the completeness block defining what done means and banning stubs, silent scope reduction and relabelled unfinished work",
	},
	{
		id: "delivery-contract/evidence-and-output",
		section: "delivery-contract",
		condition: { kind: "always" },
		text: statementDeliveryEvidenceAndOutput,
		purpose:
			"the evidence block: output matches the ask, claims are grounded, inferences are marked, verification claims match what ran",
	},
	{
		id: "delivery-contract/yielding",
		section: "delivery-contract",
		condition: { kind: "always" },
		text: statementDeliveryYielding,
		purpose:
			"the yielding checklist and the bar for declaring blocked, which is the last thing the model reads before answering",
	},
	{
		id: "delivery-contract/personality",
		section: "delivery-contract",
		condition: when("personality"),
		text: statementDeliveryPersonality,
		purpose:
			"the operator's personality text, wrapped in its own tags, absent entirely when no personality is configured",
	},
	{
		id: "delivery-contract/critical",
		section: "delivery-contract",
		condition: { kind: "always" },
		text: statementDeliveryCritical,
		purpose: "the closing critical block: never narrate budgets, never re-audit an applied edit",
	},
] as const satisfies readonly PromptStatement[];

/** One row, with its literal id and section intact. */
export type PromptStatementEntry = (typeof PROMPT_STATEMENTS)[number];

/** Every statement id, which is what an override, an ablation or an assertion names. */
export type PromptStatementId = PromptStatementEntry["id"];

export const PROMPT_STATEMENT_IDS: readonly PromptStatementId[] = PROMPT_STATEMENTS.map(statement => statement.id);

/**
 * The sections whose text these statements supply: every section of the document.
 *
 * READ THE ORDER OF THIS DERIVATION, because it is the point. The list comes from
 * {@link SYSTEM_PROMPT_SECTIONS}, the registry that declares what the document HAS, and the check
 * below asserts every one of those sections owns at least one statement. It used to come from the
 * statements themselves, which was right while the migration ran section by section and wrong the
 * moment it finished: a list derived from the rows can only ever agree with the rows, so deleting
 * every statement of a section removed that section from the list, `statementSectionOverrides`
 * quietly stopped overriding it, and the frozen pre-migration copy in `system-prompt.md` reached
 * the model with nothing anywhere reporting the substitution. Deriving from the declared sections
 * instead turns the same mistake into a startup failure naming the section.
 *
 * There is no longer a partial state to represent, so there is no `isConvertedSection`. Asking
 * whether a section is assembled from statements has one answer now, and a reader who has to look
 * it up is a reader the old name misled.
 */
export const STATEMENT_SECTIONS: readonly string[] = SYSTEM_PROMPT_SECTIONS.filter(
	section => section.source === "template",
).map(section => section.id);

{
	const covered = new Set<string>(PROMPT_STATEMENTS.map(statement => statement.section));
	const uncovered = STATEMENT_SECTIONS.filter(section => !covered.has(section));
	if (uncovered.length > 0) {
		throw new Error(
			`system prompt sections have no statements: ${uncovered.join(", ")}. ` +
				"Every template section's text comes from statements in this registry; a section with none " +
				"would fall back to the frozen pre-migration copy in prompts/session/system-prompt.md, which " +
				"no longer tracks the product. Add a statement row and its .md file under statements/<section>/.",
		);
	}
	const stray = [...covered].filter(section => !STATEMENT_SECTIONS.includes(section));
	if (stray.length > 0) {
		throw new Error(
			`statements name sections the document does not have: ${stray.join(", ")}. ` +
				`Valid sections: ${STATEMENT_SECTIONS.join(", ")}. Their text would be assembled and never ` +
				"emitted, so the statement would read as shipped while no model ever sees it.",
		);
	}
}

/** The statements of one section, in order. */
export function statementsOf(section: string): readonly PromptStatementEntry[] {
	return PROMPT_STATEMENTS.filter(statement => statement.section === section);
}

/** The row for an id, or `undefined`. */
export function statementById(id: string): PromptStatementEntry | undefined {
	return PROMPT_STATEMENTS.find(statement => statement.id === id);
}

/**
 * Every template variable the statements depend on, deduplicated.
 *
 * This is what replaces regexing `system-prompt.md` to find out what the prompt gates on. A
 * reader, and a test, can ask the registry.
 */
export const STATEMENT_CONDITION_VARIABLES: readonly string[] = [
	...new Set(PROMPT_STATEMENTS.flatMap(statement => conditionVariables(statement.condition))),
];

/**
 * The context variables a condition reads.
 *
 * A standalone function taking the WIDE type, not an inline switch over a row's condition. Rows
 * currently use two of the four forms, so `as const` narrows a row's `condition` to those two and
 * an inline switch on the other cases fails to compile as unreachable. Reading the parameter
 * keeps all four handled, which is what the callers need: the test that checks the byte-identity
 * matrix covers every variable a converted statement depends on has to work for forms no row has
 * reached yet, or it would stop being a real check the moment one does.
 *
 * Exported because that test uses it, rather than restating the switch and drifting from it.
 */
export function conditionVariables(condition: StatementCondition): readonly string[] {
	switch (condition.kind) {
		case "always":
			return [];
		case "when":
			return [condition.variable];
		case "whenContains":
			return [condition.collection];
		case "whenAll":
		case "whenAny":
			return condition.conditions.flatMap(conditionVariables);
		case "not":
			return conditionVariables(condition.condition);
	}
}

/** The values a condition is evaluated against: the same context the template is rendered with. */
export type StatementContext = Readonly<Record<string, unknown>>;

/**
 * Whether `condition` holds in `context`.
 *
 * Truthiness matches Handlebars' `{{#if}}`, deliberately: an empty array and an empty string are
 * falsy there, and this has to agree with the template while both exist or the byte-identity gate
 * would be comparing two different rulesets rather than two spellings of one.
 */
export function conditionHolds(condition: StatementCondition, context: StatementContext): boolean {
	switch (condition.kind) {
		case "always":
			return true;
		case "when":
			return isTruthy(context[condition.variable]);
		case "whenContains": {
			const collection = context[condition.collection];
			if (Array.isArray(collection)) return collection.includes(condition.member);
			if (collection instanceof Map) return collection.has(condition.member);
			if (collection instanceof Set) return collection.has(condition.member);
			return false;
		}
		case "whenAll":
			// An empty `whenAll` is `always`, which is `Array.every`'s answer and the right one: a
			// statement gated on nothing is ungated. `statement-registry.test.ts` pins both empties
			// so this is a decision rather than an accident of which built-in was reached for.
			return condition.conditions.every(nested => conditionHolds(nested, context));
		case "whenAny":
			// And an empty `whenAny` is never, for the same reason read the other way.
			return condition.conditions.some(nested => conditionHolds(nested, context));
		case "not":
			return !conditionHolds(condition.condition, context);
	}
}

/** Handlebars' notion of truthy: `[]` and `""` are false, `0` is false, everything else is JS-truthy. */
function isTruthy(value: unknown): boolean {
	if (Array.isArray(value)) return value.length > 0;
	return Boolean(value);
}

/**
 * Assemble one section's text from its statements, banner included.
 *
 * Statements are concatenated with no separator, because each md file carries its own trailing
 * newline. That is what makes byte identity with the Handlebars render achievable at all:
 * Handlebars removes the line a standalone block helper sits on, so the bytes that survive are
 * exactly the block's contents, and a separator added here would be a byte the template never
 * emitted.
 *
 * THE ASSEMBLER OWNS THE BANNER, for every section, which removes an asymmetry
 * `section-registry.ts` records as a wart: template sections carried their banner inside
 * `system-prompt.md` because those banners doubled as the document's split points, while runtime
 * sections had no document to carry one and got theirs prepended. Two rules for one thing, and
 * the reason for the split was where the text happened to live. Statements have no document, so
 * the question disappears: a row declares a NAME through the section registry and
 * {@link renderBanner} turns it into bytes, in one place, at one width. A statement file therefore
 * never contains a banner, and `statement-registry.test.ts` refuses one that does.
 *
 * `conventions` has no name and gets no banner, which is why it is the preamble.
 *
 * THE RESULT IS TEMPLATE TEXT, NOT RENDERED TEXT, and that is the load-bearing decision in this
 * file. A statement's md still says `{{#each skills}}`, `{{toolRefs.task}}`, `{{#list globs
 * join=", "}}` and `{{#if label}}…{{else}}…{{/if}}` inside one bullet, and all of it keeps working
 * because what this returns is spliced into the document `system-prompt.ts` renders. The registry
 * decides which statements are PRESENT; Handlebars still decides what each one SAYS.
 *
 * Rendering here instead would have been the tempting mistake. `buildSystemPrompt` calls
 * `prompt.render` exactly once over the whole assembled document, and `render` ends with a global
 * `format` pass. A statement rendered on its own would be normalized once per statement rather than
 * once per document, so the number of normalization passes over a given line would depend on how the
 * statements happened to be split. The split is not allowed to make that difference, so it does not
 * get the chance to: one document, one render, one format, exactly as before this registry existed.
 */
export function assembleSection(
	section: string,
	context: StatementContext,
	overrides: StatementOverrides = {},
): string {
	let out = sectionBanner(section);
	for (const statement of statementsOf(section)) {
		if (!conditionHolds(statement.condition, context)) continue;
		// `Object.hasOwn`, not a truthiness check: `""` is a legitimate override meaning "keep the
		// statement present and say nothing", and it is distinct from `null`, which ablates the row.
		if (!Object.hasOwn(overrides, statement.id)) {
			out += statement.text;
			continue;
		}
		const replacement = overrides[statement.id];
		if (replacement !== null) out += replacement;
	}
	return out;
}

/**
 * A per-statement replacement map: statement id to replacement text, or `null` to ABLATE the row.
 *
 * WHY BOTH OPERATIONS SHARE ONE MAP. An eval that wants to know what a rule is worth has exactly two
 * questions, and they are the same experiment run two ways: remove the rule (does the model get
 * worse?) and reword it (does a different phrasing do better?). Splitting them into two mechanisms
 * would mean two precedence orders, two validation paths and two places to declare an arm, for one
 * concept: this row is not the shipped text.
 *
 * `null` ablates and `""` keeps the row present with no text. The difference is not academic. A
 * statement's neighbours are separated by the newlines the statements themselves carry, so ablating
 * the row removes its separation with it, while `""` keeps the separation and drops only the words.
 * An ablation arm wants the first; an arm testing "does this rule need saying at all" may want the
 * second, and collapsing them would silently pick one.
 *
 * A key naming no registered statement is rejected rather than ignored: see
 * {@link resolveStatementOverrides}. An eval arm that quietly did nothing would report the shipped
 * prompt's score as the arm's score, which is a false result with no signal that anything failed.
 */
export type StatementOverrides = Readonly<Record<string, string | null>>;

/**
 * Validate a raw `statement id -> replacement` map into a typed one, failing closed on every way it
 * could silently do nothing.
 *
 * Mirrors `resolveSectionOverrides` deliberately, down to the error wording, because the two are the
 * same instrument at two granularities and an operator who has used one should not have to learn the
 * other. The section version additionally requires a replacement to keep its banner; there is no
 * banner inside a statement, so the equivalent check here is only that the id exists.
 */
/**
 * Parse the raw JSON payload of a per-statement override into a validated map.
 *
 * Lives here rather than in `system-prompt.ts` for the same reason
 * `parseSectionOverridesJson` lives with the sections: the registry owns what a valid statement id
 * is, so it owns rejecting an invalid one. The builder's job is reading the environment and warning
 * about it, which is a different concern and the only part that differs between the two granularities.
 */
export function parseStatementOverridesJson(raw: string | undefined): StatementOverrides {
	if (raw === undefined || raw.trim() === "") return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new Error(`VEYYON_EVAL_SYSTEM_PROMPT_STATEMENTS is set but is not valid JSON: ${err}`);
	}
	if (!isRecord(parsed)) {
		throw new Error(
			"VEYYON_EVAL_SYSTEM_PROMPT_STATEMENTS must be a JSON object of statement id -> replacement text " +
				`(or null to ablate), got ${Array.isArray(parsed) ? "an array" : parsed === null ? "null" : typeof parsed}`,
		);
	}
	return resolveStatementOverrides(parsed);
}

export function resolveStatementOverrides(raw: Readonly<Record<string, unknown>> | undefined): StatementOverrides {
	if (!raw) return {};
	const out: Record<string, string | null> = {};
	for (const [id, value] of Object.entries(raw)) {
		if (statementById(id) === undefined) {
			// The id list is long, so the message names the section's rows rather than all 68: an
			// operator's typo is almost always inside the section they meant.
			const section = id.includes("/") ? id.slice(0, id.indexOf("/")) : "";
			const nearby = statementsOf(section).map(statement => statement.id);
			throw new Error(
				`statement override names unknown statement "${id}"` +
					(nearby.length > 0 ? `; statements in ${section}: ${nearby.join(", ")}` : "") +
					(nearby.length === 0 ? `; valid sections: ${STATEMENT_SECTIONS.join(", ")}` : ""),
			);
		}
		if (value !== null && typeof value !== "string") {
			throw new Error(
				`statement override for "${id}" must be a string or null (to ablate the statement), got ${typeof value}`,
			);
		}
		out[id] = value;
	}
	return out;
}

/**
 * The bytes a section contributes before any statement does: its banner, or nothing.
 *
 * Split out of {@link assembleSection} rather than inlined twice because `prompt-inspect` prices
 * each statement by assembling the section one statement at a time and measuring what each one
 * adds. That measurement has to start from the same prefix the real assembly starts from, and a
 * second copy of `registered?.name ? renderBanner(...)` would be a banner rule with two owners:
 * the width, the trailing newline and the no-name case would then all be places the two could
 * disagree, which is exactly the asymmetry the banner ownership note above describes ending.
 *
 * Returns "" for `conventions`, which has no name, and for a section the registry does not know.
 */
export function sectionBanner(section: string): string {
	const registered = SYSTEM_PROMPT_SECTIONS.find(entry => entry.id === section);
	return registered?.name ? `${renderBanner(registered.name)}\n` : "";
}

/**
 * A condition in one line of English, for the surfaces that show a reader why a statement is here.
 *
 * Lives with the condition type rather than in the inspection command because it has to stay
 * exhaustive over that type: a seventh condition form must fail to compile until this describes
 * it, which is what the `never` arm below enforces. A describer in the CLI would instead print
 * "unknown" for the new form and nobody would notice.
 */
export function describeCondition(condition: StatementCondition): string {
	switch (condition.kind) {
		case "always":
			return "always";
		case "when":
			return condition.variable;
		case "whenContains":
			return `${condition.collection} has ${condition.member}`;
		case "whenAll":
			return condition.conditions.length === 0
				? "always"
				: condition.conditions.map(describeCondition).join(" and ");
		case "whenAny":
			return condition.conditions.length === 0 ? "never" : condition.conditions.map(describeCondition).join(" or ");
		case "not": {
			// Parenthesised only where it changes the reading: `not (a and b)` is not `not a and b`.
			const inner = describeCondition(condition.condition);
			return inner.includes(" and ") || inner.includes(" or ") ? `not (${inner})` : `not ${inner}`;
		}
		default: {
			const unreachable: never = condition;
			throw new Error(`unhandled condition: ${JSON.stringify(unreachable)}`);
		}
	}
}
