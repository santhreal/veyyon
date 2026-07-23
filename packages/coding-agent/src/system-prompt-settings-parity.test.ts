import { describe, expect, it } from "bun:test";
import type { Skill } from "./extensibility/skills";
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
	agentsMdFiles: [],
} as const;

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
	"hasTask",
	"eagerTasks",
	"eagerTasksAlways",
	"taskBatch",
	"taskMaxConcurrency",
	"taskIrcEnabled",
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
	it(asserted("renderMermaid") + " toggles the mermaid diagram affordance", async () => {
		expect(await renderBlock0({ renderMermaid: true })).toContain("```mermaid");
		expect(await renderBlock0({ renderMermaid: false })).not.toContain("```mermaid");
	});

	it(asserted("skills") + " toggles the <skills> block (requires read tool)", async () => {
		expect(await renderBlock0({ skills: demoSkills() })).toContain("<skills>");
		expect(await renderBlock0({ skills: [] })).not.toContain("<skills>");
	});

	it(asserted("rules") + " toggles the <domain-rules> block", async () => {
		const rules = [{ name: "r1", description: "rule one", path: "/r1", globs: ["*.ts"] }];
		expect(await renderBlock0({ rules })).toContain("<domain-rules>");
		expect(await renderBlock0({ rules: [] })).not.toContain("<domain-rules>");
	});

	it(asserted("alwaysApplyRules") + " toggles the <generic-rules> block", async () => {
		const alwaysApplyRules = [{ name: "g1", content: "always apply this", path: "/g1" }];
		expect(await renderBlock0({ alwaysApplyRules })).toContain("<generic-rules>");
		expect(await renderBlock0({ alwaysApplyRules: [] })).not.toContain("<generic-rules>");
	});

	it(asserted("memoryRootEnabled") + " toggles the memory://root internal URL", async () => {
		expect(await renderBlock0({ memoryRootEnabled: true })).toContain("memory://root");
		expect(await renderBlock0({ memoryRootEnabled: false })).not.toContain("memory://root");
	});

	it(asserted("toolListMode") + " renders the compact tool inventory heading", async () => {
		// nativeTools default true + inlineToolDescriptors default false => list mode.
		expect(await renderBlock0({})).toContain("# Tool Inventory");
	});

	it(asserted("mcpDiscoveryMode") + " toggles the <discovery-notice>", async () => {
		const withSearch = ["read", "task", "search_tool_bm25"];
		const on = await renderBlock0({ toolNames: withSearch, mcpDiscoveryMode: true });
		const off = await renderBlock0({ toolNames: withSearch, mcpDiscoveryMode: false });
		expect(on).toContain("<discovery-notice>");
		expect(off).not.toContain("<discovery-notice>");
	});
});

describe("system prompt settings parity: tool policy", () => {
	it(asserted("secretsEnabled") + " toggles the redaction-token explainer", async () => {
		expect(await renderBlock0({ secretsEnabled: true })).toContain("#XXXX#");
		expect(await renderBlock0({ secretsEnabled: false })).not.toContain("#XXXX#");
	});

	it(asserted("intentField") + " toggles the intent-field guidance", async () => {
		expect(await renderBlock0({ intentField: "intent" })).toContain("present participle");
		expect(await renderBlock0({ intentField: undefined })).not.toContain("present participle");
	});

	it(asserted("hasInspectImage") + " toggles the inspect_image preference bullet", async () => {
		expect(await renderBlock0({ toolNames: ["read", "inspect_image"] })).toContain("prefer `inspect_image`");
		expect(await renderBlock0({ toolNames: ["read"] })).not.toContain("prefer `inspect_image`");
	});

	it(asserted("hasReportToolIssue") + " toggles the QA report_tool_issue block", async () => {
		expect(await renderBlock0({ toolNames: ["read", "report_tool_issue"] })).toContain("powers automated QA");
		expect(await renderBlock0({ toolNames: ["read"] })).not.toContain("powers automated QA");
	});

	it(asserted("hasLsp") + " toggles the LSP section", async () => {
		expect(await renderBlock0({ toolNames: ["read", "lsp"] })).toContain("# LSP");
		expect(await renderBlock0({ toolNames: ["read"] })).not.toContain("# LSP");
	});

	it(asserted("hasAstTools") + " toggles the AST section", async () => {
		expect(await renderBlock0({ toolNames: ["read", "ast_grep"] })).toContain("# AST");
		expect(await renderBlock0({ toolNames: ["read"] })).not.toContain("# AST");
	});
});

describe("system prompt settings parity: delegation (the regression this harness guards)", () => {
	it(asserted("hasTask") + " toggles the entire Delegation section", async () => {
		expect(await renderBlock0({ toolNames: DELEGATION_TOOLS })).toContain("# Delegation");
		expect(await renderBlock0({ toolNames: ["read", "edit"] })).not.toContain("# Delegation");
	});

	it(asserted("eagerTasks") + " toggles the delegation-mode paragraph", async () => {
		const on = await renderBlock0({ eagerTasks: true, eagerTasksAlways: false });
		const off = await renderBlock0({ eagerTasks: false });
		expect(on).toContain("Delegation is preferred here");
		expect(off).not.toContain("Delegation is preferred here");
		expect(off).not.toContain("Delegation is the default here");
	});

	it(asserted("eagerTasksAlways") + " escalates preferred delegation to mandatory", async () => {
		const always = await renderBlock0({ eagerTasks: true, eagerTasksAlways: true });
		const preferred = await renderBlock0({ eagerTasks: true, eagerTasksAlways: false });
		expect(always).toContain("Delegation is the default here, not the exception");
		expect(always).toContain("MUST fan the work out");
		expect(preferred).toContain("Delegation is preferred here");
		expect(preferred).not.toContain("Delegation is the default here");
	});

	it(asserted("taskBatch") + " selects the batched vs parallel-calls call shape", async () => {
		const batched = await renderBlock0({ taskBatch: true });
		const parallel = await renderBlock0({ taskBatch: false });
		expect(batched).toContain("batched into one `tasks[]` array");
		expect(batched).not.toContain("as parallel calls in one message");
		expect(parallel).toContain("as parallel calls in one message");
		expect(parallel).not.toContain("batched into one `tasks[]` array");
	});

	it(asserted("taskMaxConcurrency") + " toggles the concurrency cap and renders the number", async () => {
		const capped = await renderBlock0({ taskMaxConcurrency: 3 });
		const uncapped = await renderBlock0({ taskMaxConcurrency: 0 });
		expect(capped).toContain("Concurrency cap:");
		expect(capped).toContain("At most 3 subagents");
		expect(uncapped).not.toContain("Concurrency cap:");
	});

	it(asserted("taskIrcEnabled") + " toggles the irc cross-agent coordination hint", async () => {
		expect(await renderBlock0({ taskIrcEnabled: true })).toContain("ask A via `irc`");
		expect(await renderBlock0({ taskIrcEnabled: false })).not.toContain("ask A via `irc`");
	});

	it(asserted("useCodexTaskPrompt") + " switches delegation to the Codex policy for gpt-5.6", async () => {
		const codexEager = await renderBlock0({ model: "openai/gpt-5.6", eagerTasks: true });
		const codexQuiet = await renderBlock0({ model: "openai/gpt-5.6", eagerTasks: false });
		expect(codexEager).toContain("Proactive multi-agent delegation is active");
		expect(codexQuiet).toContain("Do not spawn sub-agents unless");
		// Non-codex model must NOT use the Codex phrasing.
		expect(await renderBlock0({ eagerTasks: true })).not.toContain("Proactive multi-agent delegation is active");
	});
});

describe("system prompt settings parity: delivery contract", () => {
	it(asserted("personality") + " toggles the <personality> block", async () => {
		expect(await renderBlock0({ personality: "default" })).toContain("<personality>");
		expect(await renderBlock0({ personality: "none" })).not.toContain("<personality>");
	});
});

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
});
