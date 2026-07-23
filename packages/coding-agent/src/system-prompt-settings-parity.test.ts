import { describe, expect, it } from "bun:test";
import type { Skill } from "./extensibility/skills";
import systemPromptTemplate from "./prompts/system/system-prompt.md" with { type: "text" };
import { buildSystemPrompt } from "./system-prompt";

/**
 * Settings-parity harness for the default system prompt.
 *
 * WHY THIS EXISTS: prompt experiments edit the monolithic template
 * (`prompts/system/system-prompt.md`) by hand. A variant that silently drops a
 * `{{#if <setting>}}` branch renders that setting useless with ZERO other test
 * failure. That is exactly how delegation settings (`taskIrcEnabled`,
 * `eagerTasksAlways`) were rendered dead during prompt experiments: the setting
 * still parsed, still flowed into the render data, but the template no longer
 * had a branch that consumed it.
 *
 * Each test below pins that a specific user setting, when toggled, changes the
 * rendered prompt at a concrete anchor string lifted verbatim from the template.
 * If the shipped template stops honoring a setting (a dropped branch in an
 * experiment, a bad merge, a refactor regression), the matching test goes red.
 *
 * The final GATING_PROPS coverage test fails if a new gating setting is added
 * to the enumerated contract without a parity assertion here, so the harness
 * cannot silently fall behind the template.
 */

/** Empty workspace tree so the builder skips discovery and stays deterministic. */
const EMPTY_TREE = {
	rootPath: import.meta.dir,
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [] as string[],
};

/** Tool set that unlocks the delegation section and the specialized-tool bullets. */
const DELEGATION_TOOLS = ["read", "edit", "write", "bash", "grep", "glob", "task"];

/**
 * Render the default template's static block (systemPrompt[0]) with pre-loaded
 * props so no async discovery or probes run. `toolNames` drives the `{{#has
 * tools ...}}` gates; every other setting comes from `overrides`.
 */
async function renderBlock0(overrides: Parameters<typeof buildSystemPrompt>[0] = {}): Promise<string> {
	const result = await buildSystemPrompt({
		toolNames: DELEGATION_TOOLS,
		contextFiles: [],
		skills: [],
		rules: [],
		workspaceTree: EMPTY_TREE,
		activeRepoContext: null,
		...overrides,
	});
	return result.systemPrompt[0];
}

/** Minimal skill shaped for the `<skills>` block; template reads name/description/hide. */
function demoSkills(): Skill[] {
	return [{ name: "demo-skill", description: "a demo skill", hide: false }] as unknown as Skill[];
}

/**
 * The enumerated set of user settings that gate distinct text in the default
 * template. Each MUST have a toggle assertion below (tracked in ASSERTED).
 * Environment-derived gates that are not caller options (e.g. `hasObsidian`,
 * which reads the live vault registry) are intentionally excluded and noted.
 */
const GATING_PROPS = [
	"renderMermaid",
	"secretsEnabled",
	"intentField",
	"personality",
	"memoryRootEnabled",
	"skills",
	"rules",
	"alwaysApplyRules",
	"toolListMode",
	"mcpDiscoveryMode",
	"hasMCPDiscoveryServers",
	"hasTask",
	"eagerTasks",
	"eagerTasksAlways",
	"taskBatch",
	"taskMaxConcurrency",
	"taskIrcEnabled",
	"hasRead",
	"hasEdit",
	"hasWrite",
	"hasGrep",
	"hasGlob",
	"hasBash",
	"hasAsk",
	"hasInspectImage",
	"hasReportToolIssue",
	"hasLsp",
	"hasAstTools",
	"useCodexTaskPrompt",
] as const;

/** Props with a toggle assertion in this file; kept in sync with GATING_PROPS. */
const ASSERTED = new Set<(typeof GATING_PROPS)[number]>();
function asserted(name: (typeof GATING_PROPS)[number]): (typeof GATING_PROPS)[number] {
	ASSERTED.add(name);
	return name;
}

describe("system prompt settings parity: role & runtime", () => {
	it(`${asserted("renderMermaid")} toggles the mermaid diagram affordance`, async () => {
		expect(await renderBlock0({ renderMermaid: true })).toContain("```mermaid");
		expect(await renderBlock0({ renderMermaid: false })).not.toContain("```mermaid");
	});

	it(`${asserted("skills")} toggles the <skills> block AND renders each skill's name/description`, async () => {
		// Assert the {{#each skills}} body content, not just the <skills> wrapper:
		// a dropped loop body would leave an empty wrapper and a wrapper-only
		// assertion would pass falsely (silent content loss).
		const on = await renderBlock0({ skills: demoSkills() });
		expect(on).toContain("<skills>");
		expect(on).toContain("demo-skill: a demo skill");
		expect(await renderBlock0({ skills: [] })).not.toContain("<skills>");
	});

	it(`${asserted("rules")} toggles <domain-rules> AND renders each rule's name/globs/description`, async () => {
		const rules = [{ name: "r1", description: "rule one", path: "/r1", globs: ["*.ts"] }];
		const on = await renderBlock0({ rules });
		expect(on).toContain("<domain-rules>");
		// {{#each rules}}- {{name}} ({{#list globs}}...): {{description}} — assert the loop body.
		expect(on).toContain("r1");
		expect(on).toContain("*.ts");
		expect(on).toContain("rule one");
		expect(await renderBlock0({ rules: [] })).not.toContain("<domain-rules>");
	});

	it(`${asserted("alwaysApplyRules")} toggles <generic-rules> AND renders each rule's content`, async () => {
		const alwaysApplyRules = [{ name: "g1", content: "always apply this", path: "/g1" }];
		const on = await renderBlock0({ alwaysApplyRules });
		expect(on).toContain("<generic-rules>");
		// {{#each alwaysApplyRules}}{{content}} — assert the loop body renders.
		expect(on).toContain("always apply this");
		expect(await renderBlock0({ alwaysApplyRules: [] })).not.toContain("<generic-rules>");
	});

	it(`${asserted("memoryRootEnabled")} toggles the memory://root internal URL`, async () => {
		expect(await renderBlock0({ memoryRootEnabled: true })).toContain("memory://root");
		expect(await renderBlock0({ memoryRootEnabled: false })).not.toContain("memory://root");
	});

	it(`${asserted("toolListMode")} renders the compact tool inventory heading AND a tool row`, async () => {
		// nativeTools default true + inlineToolDescriptors default false => list mode.
		// Assert a row follows the heading, so a dropped {{#each toolInfo}} body
		// (heading with no rows) is caught, not just the heading gate.
		const out = await renderBlock0({});
		expect(out).toContain("# Tool Inventory");
		expect(out).toMatch(/# Tool Inventory\n- /);
	});

	it(`${asserted("mcpDiscoveryMode")} toggles the <discovery-notice>`, async () => {
		const withSearch = ["read", "task", "search_tool_bm25"];
		const on = await renderBlock0({ toolNames: withSearch, mcpDiscoveryMode: true });
		const off = await renderBlock0({ toolNames: withSearch, mcpDiscoveryMode: false });
		expect(on).toContain("<discovery-notice>");
		expect(off).not.toContain("<discovery-notice>");
	});

	it(`${asserted("hasMCPDiscoveryServers")} toggles the live discoverable-server list`, async () => {
		// hasMCPDiscoveryServers is derived: mcpDiscoveryServerSummaries.length > 0.
		// It is nested inside the discovery-notice, so mcpDiscoveryMode must be on.
		const withSearch = ["read", "task", "search_tool_bm25"];
		const withServers = await renderBlock0({
			toolNames: withSearch,
			mcpDiscoveryMode: true,
			mcpDiscoveryServerSummaries: ["github (repos, issues)"],
		});
		const noServers = await renderBlock0({
			toolNames: withSearch,
			mcpDiscoveryMode: true,
			mcpDiscoveryServerSummaries: [],
		});
		expect(withServers).toContain("Discoverable MCP servers this session:");
		expect(withServers).toContain("github (repos, issues)");
		expect(noServers).not.toContain("Discoverable MCP servers this session:");
	});
});

describe("system prompt settings parity: tool policy", () => {
	it(`${asserted("secretsEnabled")} toggles the redaction-token explainer`, async () => {
		expect(await renderBlock0({ secretsEnabled: true })).toContain("#XXXX#");
		expect(await renderBlock0({ secretsEnabled: false })).not.toContain("#XXXX#");
	});

	it(`${asserted("intentField")} toggles the intent-field guidance`, async () => {
		expect(await renderBlock0({ intentField: "intent" })).toContain("present participle");
		expect(await renderBlock0({ intentField: undefined })).not.toContain("present participle");
	});

	it(`${asserted("hasInspectImage")} toggles the inspect_image preference bullet`, async () => {
		expect(await renderBlock0({ toolNames: ["read", "inspect_image"] })).toContain("prefer `inspect_image`");
		expect(await renderBlock0({ toolNames: ["read"] })).not.toContain("prefer `inspect_image`");
	});

	it(`${asserted("hasReportToolIssue")} toggles the QA report_tool_issue block`, async () => {
		expect(await renderBlock0({ toolNames: ["read", "report_tool_issue"] })).toContain("powers automated QA");
		expect(await renderBlock0({ toolNames: ["read"] })).not.toContain("powers automated QA");
	});

	it(`${asserted("hasLsp")} toggles the LSP section`, async () => {
		expect(await renderBlock0({ toolNames: ["read", "lsp"] })).toContain("# LSP");
		expect(await renderBlock0({ toolNames: ["read"] })).not.toContain("# LSP");
	});

	it(`${asserted("hasAstTools")} toggles the AST section`, async () => {
		expect(await renderBlock0({ toolNames: ["read", "ast_grep"] })).toContain("# AST");
		expect(await renderBlock0({ toolNames: ["read"] })).not.toContain("# AST");
	});

	// Foundational-tool bullets: each `{{#has tools "X"}}` gates one line of the
	// tool-selection matrix. A dropped bullet is a silent loss of the routing
	// instruction for that tool, the same failure class as a dropped setting.
	it(`${asserted("hasRead")} toggles the read-tool routing bullet`, async () => {
		expect(await renderBlock0({ toolNames: ["read", "edit"] })).toContain("File or directory reads");
		expect(await renderBlock0({ toolNames: ["edit"] })).not.toContain("File or directory reads");
	});

	it(`${asserted("hasEdit")} toggles the edit-tool routing bullet`, async () => {
		expect(await renderBlock0({ toolNames: ["read", "edit"] })).toContain("Surgical edits");
		expect(await renderBlock0({ toolNames: ["read"] })).not.toContain("Surgical edits");
	});

	it(`${asserted("hasWrite")} toggles the write-tool routing bullet`, async () => {
		expect(await renderBlock0({ toolNames: ["read", "write"] })).toContain("Create or overwrite");
		expect(await renderBlock0({ toolNames: ["read"] })).not.toContain("Create or overwrite");
	});

	it(`${asserted("hasGrep")} toggles the grep-tool routing bullet`, async () => {
		expect(await renderBlock0({ toolNames: ["read", "grep"] })).toContain("Regex search");
		expect(await renderBlock0({ toolNames: ["read"] })).not.toContain("Regex search");
	});

	it(`${asserted("hasGlob")} toggles the glob-tool routing bullet`, async () => {
		expect(await renderBlock0({ toolNames: ["read", "glob"] })).toContain("Globbing");
		expect(await renderBlock0({ toolNames: ["read"] })).not.toContain("Globbing");
	});

	it(`${asserted("hasBash")} toggles the bash-tool routing bullet`, async () => {
		expect(await renderBlock0({ toolNames: ["read", "bash"] })).toContain("real binaries and short fact pipelines");
		expect(await renderBlock0({ toolNames: ["read"] })).not.toContain("real binaries and short fact pipelines");
	});

	it(`${asserted("hasAsk")} selects the ask-vs-no-ask destructive-command clause`, async () => {
		// This gate is a ternary: with `ask` the agent is told to ask first;
		// without it, the flat prohibition. Dropping the branch would silently
		// change the destructive-command policy.
		const withAsk = await renderBlock0({ toolNames: ["read", "ask"] });
		const withoutAsk = await renderBlock0({ toolNames: ["read"] });
		expect(withAsk).toContain("Ask before destructive commands");
		expect(withAsk).not.toContain("Don't run destructive git commands");
		expect(withoutAsk).toContain("Don't run destructive git commands");
		expect(withoutAsk).not.toContain("Ask before destructive commands");
	});
});

describe("system prompt settings parity: delegation (the regression this harness guards)", () => {
	it(`${asserted("hasTask")} toggles the entire Delegation section`, async () => {
		expect(await renderBlock0({ toolNames: DELEGATION_TOOLS })).toContain("# Delegation");
		expect(await renderBlock0({ toolNames: ["read", "edit"] })).not.toContain("# Delegation");
	});

	it(`${asserted("eagerTasks")} toggles the delegation-mode paragraph`, async () => {
		const on = await renderBlock0({ eagerTasks: true, eagerTasksAlways: false });
		const off = await renderBlock0({ eagerTasks: false });
		expect(on).toContain("Delegation is preferred here");
		expect(off).not.toContain("Delegation is preferred here");
		expect(off).not.toContain("Delegation is the default here");
	});

	it(`${asserted("eagerTasksAlways")} escalates preferred delegation to mandatory`, async () => {
		const always = await renderBlock0({ eagerTasks: true, eagerTasksAlways: true });
		const preferred = await renderBlock0({ eagerTasks: true, eagerTasksAlways: false });
		expect(always).toContain("Delegation is the default here, not the exception");
		expect(always).toContain("MUST fan the work out");
		expect(preferred).toContain("Delegation is preferred here");
		expect(preferred).not.toContain("Delegation is the default here");
	});

	it(`${asserted("taskBatch")} selects the batched vs parallel-calls call shape`, async () => {
		const batched = await renderBlock0({ taskBatch: true });
		const parallel = await renderBlock0({ taskBatch: false });
		expect(batched).toContain("batched into one `tasks[]` array");
		expect(batched).not.toContain("as parallel calls in one message");
		expect(parallel).toContain("as parallel calls in one message");
		expect(parallel).not.toContain("batched into one `tasks[]` array");
	});

	it(`${asserted("taskMaxConcurrency")} toggles the concurrency cap and renders the number`, async () => {
		const capped = await renderBlock0({ taskMaxConcurrency: 3 });
		const uncapped = await renderBlock0({ taskMaxConcurrency: 0 });
		expect(capped).toContain("Concurrency cap:");
		expect(capped).toContain("At most 3 subagents");
		expect(uncapped).not.toContain("Concurrency cap:");
	});

	it(`${asserted("taskIrcEnabled")} toggles the irc cross-agent coordination hint`, async () => {
		expect(await renderBlock0({ taskIrcEnabled: true })).toContain("ask A via `irc`");
		expect(await renderBlock0({ taskIrcEnabled: false })).not.toContain("ask A via `irc`");
	});

	it(`${asserted("useCodexTaskPrompt")} switches delegation to the Codex policy for gpt-5.6`, async () => {
		const codexEager = await renderBlock0({ model: "openai/gpt-5.6", eagerTasks: true });
		const codexQuiet = await renderBlock0({ model: "openai/gpt-5.6", eagerTasks: false });
		expect(codexEager).toContain("Proactive multi-agent delegation is active");
		expect(codexQuiet).toContain("Do not spawn sub-agents unless");
		// Non-codex model must NOT use the Codex phrasing.
		expect(await renderBlock0({ eagerTasks: true })).not.toContain("Proactive multi-agent delegation is active");
	});
});

describe("system prompt settings parity: delivery contract", () => {
	it(`${asserted("personality")} toggles the <personality> block`, async () => {
		expect(await renderBlock0({ personality: "default" })).toContain("<personality>");
		expect(await renderBlock0({ personality: "none" })).not.toContain("<personality>");
	});
});

/**
 * Extract every gating identifier the template actually branches on, straight
 * from the shipped template text. Covers `{{#if}}`/`{{#unless}}`/`{{#when}}`/
 * `{{#ifAny}}` bare identifiers (with a trailing `.length` stripped) and every
 * `tools "X"` presence check (from both `#has` and `includes`), keyed as
 * `tools:X`. Quoted strings and helper keywords are dropped so only real gate
 * inputs remain.
 *
 * `{{#each}}` and `{{#list}}` are deliberately NOT scanned as gates: they are
 * content renderers, not boolean branches, and each is wrapped in an `{{#if
 * X.length}}` that IS scanned (skills/rules/alwaysApplyRules/toolInfo/
 * mcpDiscoveryServerSummaries). A dropped loop BODY is caught instead by the
 * toggle tests asserting the item content renders (skill name, rule name/glob,
 * generic-rule content, discoverable-server name), not by this scan.
 */
function extractGatingIdentifiers(template: string): Set<string> {
	const ids = new Set<string>();
	// Tool-presence gates: `#has tools "X"` and `(includes tools "X")`.
	for (const m of template.matchAll(/tools\s+"([^"]+)"/g)) ids.add(`tools:${m[1]}`);
	// Block-open conditionals; scan their argument list for bare identifiers.
	const keywords = new Set(["includes", "tools", "join", "this", "and", "or", "not"]);
	for (const m of template.matchAll(/\{\{#(?:if|unless|when|ifAny)\s+([^}]*)\}\}/g)) {
		const args = m[1].replace(/"[^"]*"/g, " ").replace(/[()]/g, " ");
		for (const t of args.matchAll(/[A-Za-z_][\w.]*/g)) {
			const id = t[0].replace(/\.length$/, "");
			if (!keywords.has(id)) ids.add(id);
		}
	}
	return ids;
}

/**
 * Maps each template gating identifier to the enumerated GATING_PROP it belongs
 * to. Aliases are resolved here (the template branches on `intentTracing` but
 * the caller option is `intentField`; `hasMemoryRoot` <- `memoryRootEnabled`;
 * `MAX_CONCURRENCY` <- `taskMaxConcurrency`; `tools:X` <- `hasX`).
 */
const IDENTIFIER_TO_PROP: Record<string, (typeof GATING_PROPS)[number]> = {
	renderMermaid: "renderMermaid",
	secretsEnabled: "secretsEnabled",
	intentTracing: "intentField",
	personality: "personality",
	hasMemoryRoot: "memoryRootEnabled",
	skills: "skills",
	rules: "rules",
	alwaysApplyRules: "alwaysApplyRules",
	toolListMode: "toolListMode",
	mcpDiscoveryMode: "mcpDiscoveryMode",
	hasMCPDiscoveryServers: "hasMCPDiscoveryServers",
	eagerTasks: "eagerTasks",
	eagerTasksAlways: "eagerTasksAlways",
	taskBatch: "taskBatch",
	MAX_CONCURRENCY: "taskMaxConcurrency",
	taskIrcEnabled: "taskIrcEnabled",
	useCodexTaskPrompt: "useCodexTaskPrompt",
	"tools:read": "hasRead",
	"tools:edit": "hasEdit",
	"tools:write": "hasWrite",
	"tools:grep": "hasGrep",
	"tools:glob": "hasGlob",
	"tools:bash": "hasBash",
	"tools:ask": "hasAsk",
	"tools:task": "hasTask",
	"tools:lsp": "hasLsp",
	"tools:inspect_image": "hasInspectImage",
	"tools:report_tool_issue": "hasReportToolIssue",
	"tools:ast_grep": "hasAstTools",
	"tools:ast_edit": "hasAstTools",
};

/**
 * Gating identifiers that are intentionally NOT parity-tested, each with the
 * reason. These are not caller-supplied settings, so a toggle test does not
 * apply. Anything not here and not in IDENTIFIER_TO_PROP is an unaccounted gate.
 */
const EXCLUDED_IDENTIFIERS: Record<string, string> = {
	hasObsidian: "env-derived from the live Obsidian vault registry, not a buildSystemPrompt caller option",
	label: "loop-local variable inside {{#each tools}}, not a global gating setting",
	toolInfo: "structural: gates whether the tool-inventory renders at all, entangled with the asserted toolListMode",
};

describe("system prompt settings parity: coverage contract", () => {
	/**
	 * Every enumerated gating setting MUST have a toggle assertion above. Adding a
	 * new `{{#if <setting>}}` to the template without extending both GATING_PROPS
	 * and a parity test fails here, so the harness cannot fall behind the prompt.
	 */
	it("asserts a parity test for every enumerated gating setting", () => {
		const missing = GATING_PROPS.filter(name => !ASSERTED.has(name));
		expect(missing).toEqual([]);
	});

	/**
	 * The strong guard: scan the SHIPPED template for every gating identifier it
	 * actually branches on, and require each to be either mapped to a tested
	 * GATING_PROP or explicitly excluded with a reason. This is what catches the
	 * hole the enumerated-list test cannot: a conditional added to the template
	 * that nobody remembered to enumerate. Without this, a setting like
	 * `hasMCPDiscoveryServers` could gate real text with ZERO coverage and ZERO
	 * failure — exactly the silent-drop class this whole harness exists to stop.
	 */
	it("accounts for every gating identifier present in the shipped template", () => {
		const found = extractGatingIdentifiers(systemPromptTemplate);
		// Guard against an extractor regression silently returning nothing, which
		// would make the "unaccounted" check pass vacuously. These gates are known
		// to exist in the template; if the extractor stops finding them it is broken.
		expect(found.has("taskIrcEnabled")).toBe(true);
		expect(found.has("hasMCPDiscoveryServers")).toBe(true);
		expect(found.has("tools:task")).toBe(true);
		expect(found.has("MAX_CONCURRENCY")).toBe(true);
		expect(found.size).toBeGreaterThanOrEqual(25);

		const unaccounted = [...found].filter(id => !(id in IDENTIFIER_TO_PROP) && !(id in EXCLUDED_IDENTIFIERS)).sort();
		expect(unaccounted).toEqual([]);
	});

	/** Every identifier mapping must point at a real, enumerated gating prop. */
	it("maps every template identifier to an enumerated gating prop", () => {
		for (const prop of Object.values(IDENTIFIER_TO_PROP)) {
			expect(GATING_PROPS).toContain(prop);
		}
	});

	/**
	 * Every mapped prop must also carry a toggle assertion. Combined with the
	 * template scan above, this closes the loop: template gate -> mapped prop ->
	 * asserted toggle, with no link allowed to be missing.
	 */
	it("has a toggle assertion for every prop a template identifier maps to", () => {
		const mappedProps = new Set(Object.values(IDENTIFIER_TO_PROP));
		const unasserted = [...mappedProps].filter(prop => !ASSERTED.has(prop));
		expect(unasserted).toEqual([]);
	});
});
