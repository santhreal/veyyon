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
	{ label: "tools listed natively", context: { hasTools: true, toolListMode: true } },
	{
		label: "tools as descriptor text, the else arm",
		context: { hasTools: true, toolListMode: false, toolInventory: "DESCRIPTOR TEXT" },
	},
	{
		label: "tools plus MCP discovery",
		context: {
			hasTools: true,
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
		context: {
			tools: ALL_TOOLS,
			toolRefs: TOOL_REFS,
			subagentNames: ["scout"],
			hasSpawnableSubagent: true,
			eagerTasks: true,
		},
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
			hasTools: true,
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
			hasInvestigativeSubagent: true,
			hasSpawnableSubagent: true,
			hasSubagentSpecialists: true,
			useCodexTaskPrompt: false,
			personality: "Be terse.",
		},
	},
];
