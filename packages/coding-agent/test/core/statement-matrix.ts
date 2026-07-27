/**
 * The gate combinations both statement suites compare under.
 *
 * ONE MATRIX, imported by both, because they ask different questions of the same points:
 * `statement-wiring.test.ts` renders the whole document at each point and
 * `statement-assembly.test.ts` compares one section at a time. Two hand-listed copies would drift,
 * and the assembly suite's coverage check would then be checking a matrix the wiring gate does not
 * actually run.
 *
 * A point exists for each ARM of each condition a converted statement reads, plus the extremes.
 * `statement-assembly.test.ts` fails when a converted statement names a variable no point sets,
 * which is what keeps this list following the migration instead of lagging it.
 */

const SKILLS = [{ name: "review", description: "how to review a diff" }];
const APPLY_RULES = [{ content: "always run the gate" }];
const DOMAIN_RULES = [{ name: "ts", description: "TypeScript rules", globs: ["*.ts"] }];
const TOOL_INFO = [{ name: "read", label: "Read" }, { name: "task" }];

/** Every tool the prompt names, so the tool-membership conditions can all be exercised. */
const ALL_TOOLS = [
	"task",
	"read",
	"edit",
	"write",
	"lsp",
	"grep",
	"glob",
	"bash",
	"inspect_image",
	"report_tool_issue",
	"ast_grep",
	"ast_edit",
];

/**
 * Resolved tool names, which the prompt interpolates rather than hardcoding.
 *
 * Every `{{toolRefs.x}}` has to resolve, or the rendered text would name a tool `""` and a comparison
 * between two prompts that both do that would pass while telling a model to call nothing.
 */
const TOOL_REFS: Record<string, string> = {
	...Object.fromEntries(ALL_TOOLS.map(name => [name, name])),
	search_tool_bm25: "search_tool_bm25",
};

export const MATRIX: readonly { readonly label: string; readonly context: Record<string, unknown> }[] = [
	{ label: "nothing set, so every gate falls to its default", context: {} },
	{ label: "renderMermaid on", context: { renderMermaid: true } },
	{ label: "renderMermaid off", context: { renderMermaid: false } },
	{ label: "skills loaded", context: { skills: SKILLS } },
	{ label: "always-apply rules only", context: { alwaysApplyRules: APPLY_RULES } },
	{ label: "domain rules only", context: { rules: DOMAIN_RULES } },
	{
		label: "skills and domain rules, with the block between them absent",
		context: { skills: SKILLS, rules: DOMAIN_RULES },
	},
	{
		label: "all three rule blocks",
		context: { skills: SKILLS, alwaysApplyRules: APPLY_RULES, rules: DOMAIN_RULES },
	},
	{ label: "a memory root, so the memory URL is real", context: { hasMemoryRoot: true } },
	{ label: "an Obsidian vault", context: { hasObsidian: true } },
	{ label: "both optional URL schemes", context: { hasMemoryRoot: true, hasObsidian: true } },
	{ label: "tools listed natively", context: { toolInfo: TOOL_INFO, toolListMode: true } },
	{
		label: "tools as descriptor text, the else arm",
		context: { toolInfo: TOOL_INFO, toolListMode: false, toolInventory: "DESCRIPTOR TEXT" },
	},
	{
		label: "tools plus MCP discovery",
		context: {
			toolInfo: TOOL_INFO,
			toolListMode: true,
			mcpDiscoveryMode: true,
			hasMCPDiscoveryServers: true,
			mcpDiscoveryServerSummaries: ["srv"],
			toolRefs: TOOL_REFS,
		},
	},
	{ label: "list mode on but no tools built", context: { toolListMode: true } },
	{ label: "MCP discovery on but no tools built", context: { mcpDiscoveryMode: true } },

	// TOOL POLICY arms. `tools` is the membership collection every `{{#has tools "x"}}` reads.
	{ label: "no tools at all", context: { tools: [], toolRefs: TOOL_REFS } },
	{ label: "every tool, delegation off", context: { tools: ALL_TOOLS, toolRefs: TOOL_REFS } },
	{
		label: "every tool, delegation required",
		context: {
			tools: ALL_TOOLS,
			toolRefs: TOOL_REFS,
			eagerTasks: true,
			eagerTasksAlways: true,
			taskBatch: true,
			MAX_CONCURRENCY: 4,
			taskIrcEnabled: true,
		},
	},
	{
		label: "every tool, delegation preferred",
		context: {
			tools: ALL_TOOLS,
			toolRefs: TOOL_REFS,
			eagerTasks: true,
			eagerTasksAlways: false,
			taskBatch: false,
			MAX_CONCURRENCY: 4,
		},
	},
	{
		label: "Codex wording with eager tasks on",
		context: { tools: ALL_TOOLS, toolRefs: TOOL_REFS, useCodexTaskPrompt: true, eagerTasks: true },
	},
	{
		label: "Codex wording with eager tasks off",
		context: { tools: ALL_TOOLS, toolRefs: TOOL_REFS, useCodexTaskPrompt: true, eagerTasks: false },
	},
	{
		label: "the task tool alone",
		context: {
			tools: ["task"],
			toolRefs: TOOL_REFS,
			eagerTasks: true,
			eagerTasksAlways: true,
			MAX_CONCURRENCY: 2,
		},
	},
	{ label: "a language server and nothing else", context: { tools: ["lsp"], toolRefs: TOOL_REFS } },
	{ label: "structural search only", context: { tools: ["ast_grep"], toolRefs: TOOL_REFS } },
	{ label: "structural edit only", context: { tools: ["ast_edit"], toolRefs: TOOL_REFS } },
	{ label: "the tool-issue reporter only", context: { tools: ["report_tool_issue"], toolRefs: TOOL_REFS } },
	{
		label: "intent tracing and secret redaction",
		context: {
			tools: ALL_TOOLS,
			toolRefs: TOOL_REFS,
			intentTracing: true,
			intentField: "intent",
			secretsEnabled: true,
		},
	},
	{
		label: "delegation on with no concurrency cap",
		context: { tools: ALL_TOOLS, toolRefs: TOOL_REFS, eagerTasks: true, MAX_CONCURRENCY: 0 },
	},
	{
		label: "a scout among the spawnable agents",
		context: { tools: ALL_TOOLS, toolRefs: TOOL_REFS, subagentNames: ["scout"], eagerTasks: true },
	},
	{
		label: "specialists enabled",
		context: { tools: ALL_TOOLS, toolRefs: TOOL_REFS, hasSubagentSpecialists: true, eagerTasks: true },
	},
	{ label: "a personality configured", context: { personality: "Be terse." } },
	{
		label: "everything on at once",
		context: {
			renderMermaid: true,
			skills: SKILLS,
			alwaysApplyRules: APPLY_RULES,
			rules: DOMAIN_RULES,
			hasMemoryRoot: true,
			hasObsidian: true,
			toolInfo: TOOL_INFO,
			toolListMode: true,
			mcpDiscoveryMode: true,
			hasMCPDiscoveryServers: true,
			mcpDiscoveryServerSummaries: ["srv"],
			tools: ALL_TOOLS,
			toolRefs: TOOL_REFS,
			intentTracing: true,
			intentField: "intent",
			secretsEnabled: true,
			eagerTasks: true,
			eagerTasksAlways: true,
			taskBatch: true,
			taskIrcEnabled: true,
			MAX_CONCURRENCY: 4,
			subagentNames: ["scout"],
			hasSubagentSpecialists: true,
			useCodexTaskPrompt: false,
			personality: "Be terse.",
		},
	},
];

/**
 * The matrix points whose rendered prompt differs from the template's by BLANK LINES ONLY.
 *
 * The value is the byte delta, recorded per case because they are not all the same sign or size. The
 * reason these exist is in `SECTION_FIDELITY`: the template interleaves UNCONDITIONAL blank lines
 * between conditional blocks, `format` deletes a run of 2+ blank lines entirely and keeps a single
 * one, so the template's spacing between two present blocks depends on how many UNRELATED blocks are
 * absent. A statement's bytes appear only when its condition holds, so a statement cannot own an
 * unconditional blank line. Statements own the separation around themselves instead, and the spacing
 * stops depending on unrelated gates.
 *
 * THERE IS ONE MECHANISM BEHIND ALL OF THEM, which is what makes the numbers reviewable rather than
 * a wall of magic constants. A one-line conditional bullet, `{{#has tools "ask"}}- ...{{/has}}`, is
 * not a standalone block-helper line as far as Handlebars is concerned, because the line has content
 * after the open tag. So when the condition is false the line collapses to an EMPTY LINE rather than
 * disappearing, and what happens next depends on its neighbours:
 *
 *   - Next to an existing blank line it makes a run of two, and `format` deletes runs of two
 *     entirely. The heading that followed is then glued to the bullet above it. Today a session with
 *     no task tool reads `- SHOULD parallelize independent calls.# Tool I/O`.
 *   - Alone in the middle of a bullet list it survives as a stray blank, splitting the list. Today a
 *     session with no `ask` tool gets a blank line between two Implement bullets, and one without
 *     `ast_edit` gets one in the middle of the AST list.
 *
 * A statement cannot reproduce either, because its bytes exist only when its condition holds, and it
 * should not want to: both are defects. The statement version puts exactly one blank line before a
 * heading and none inside a list, whatever the gates say. That is why the deltas run in both
 * directions: positive where the template lost a blank it needed, negative where it gained one it did
 * not. NOT ONE WORD DIFFERS at any point, which is the assertion that actually guards the migration.
 *
 * The list is EXHAUSTIVE and asserted to be: a new whitespace difference fails, and so does one of
 * these becoming identical, because both mean the spacing changed again without anyone looking.
 */
export const SPACING_DIFFERS: Readonly<Record<string, number>> = {
	"nothing set, so every gate falls to its default": 0,
	"renderMermaid on": 0,
	"renderMermaid off": 0,
	"skills loaded": 2,
	"always-apply rules only": 0,
	"domain rules only": 1,
	"skills and domain rules, with the block between them absent": 2,
	"all three rule blocks": 1,
	"a memory root, so the memory URL is real": 0,
	"an Obsidian vault": 0,
	"both optional URL schemes": 0,
	"tools listed natively": 0,
	"tools as descriptor text, the else arm": 0,
	"tools plus MCP discovery": 0,
	"list mode on but no tools built": 0,
	"MCP discovery on but no tools built": 0,
	"no tools at all": 0,
	"every tool, delegation off": -1,
	"every tool, delegation required": -1,
	"every tool, delegation preferred": -1,
	"Codex wording with eager tasks on": -1,
	"Codex wording with eager tasks off": -1,
	"the task tool alone": -2,
	"a language server and nothing else": 1,
	"structural search only": -2,
	"structural edit only": -2,
	"the tool-issue reporter only": 1,
	"intent tracing and secret redaction": -1,
	"delegation on with no concurrency cap": -1,
	"a scout among the spawnable agents": -1,
	"specialists enabled": -1,
	"a personality configured": 0,
};

/**
 * The one place the statements deliberately differ from the template in a way that is NOT whitespace,
 * because the template was wrong.
 *
 * In `system-prompt.md` the strong-delegation arm ends at an inline `{{else}}` on line 161, so
 * Handlebars emits no newline after it and the bullet that follows is glued to the end of the
 * sentence. Today's shipped prompt says, to every non-Codex session with delegation set to required:
 *
 *     MUST be decomposed and delegated.- A subagent's value is a SEPARATE CONTEXT
 *
 * `delegated.-` is one token. Reproducing that to keep a byte gate green would have meant shipping a
 * known defect for the sake of the gate, so the statement ends with a newline.
 *
 * ONE REPAIR RULE, not one per matrix point, because what precedes the glue varies: with `taskBatch`
 * on the sentence ends `...run concurrently.` and without it `...delegated.`. Keying on the bullet
 * that follows covers both and cannot be quietly narrowed to the case someone happened to test.
 * `statement-wiring.test.ts` applies it to the TEMPLATE side of the comparison, so every other word in
 * the same prompt is still held to byte equality, and separately asserts the defect really is in the
 * template for the points that trigger it. Both directions matter: a repair that stopped being needed
 * would mean the template was fixed elsewhere, and this should be revisited rather than left applying
 * to nothing.
 */
export const GLUED_BULLET_REPAIR = {
	wasInTemplate: ".- A subagent's value",
	isInStatements: ".\n- A subagent's value",
} as const;

/** The matrix points whose rendered prompt actually contains the glued bullet. */
export const GLUED_BULLET_POINTS: readonly string[] = [
	"every tool, delegation required",
	"the task tool alone",
	"everything on at once",
];

/** The template's text with the glued bullet repaired, which is a no-op where the defect is absent. */
export function repairGluedBullet(text: string): string {
	return text.split(GLUED_BULLET_REPAIR.wasInTemplate).join(GLUED_BULLET_REPAIR.isInStatements);
}

/**
 * Collapse every run of blank lines to a single newline.
 *
 * A WHITESPACE-ONLY line counts as blank, which a plain `\n+` collapse misses and did: the template
 * indents one conditional (`  {{#has tools "lsp"}}`), so when that condition is false Handlebars
 * leaves a line holding two spaces rather than an empty line. Without this, a blank-line difference
 * reads as a content difference and the gate points at the wrong thing.
 */
export function collapseBlankLines(text: string): string {
	return text.replace(/(?:\n[ \t]*)+/g, "\n");
}

/** Collapse every whitespace run so only the words are compared. */
export function words(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}
