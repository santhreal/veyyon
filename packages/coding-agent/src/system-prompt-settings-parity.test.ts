import { describe, expect, it } from "bun:test";
import { Settings } from "./config/settings";
import type { Skill } from "./extensibility/skills";
import { buildSystemPrompt } from "./system-prompt";
import { RUNTIME_SECTIONS } from "./system-prompt-builder/section-registry";
import { PROMPT_STATEMENTS, type StatementCondition } from "./system-prompt-builder/statement-registry";
import { delegationEnabled } from "./task/subagent-settings";
import { AstGrepTool } from "./tools/ast-grep";
import { TOOL } from "./tools/builtin-names";
import { GlobTool } from "./tools/glob";
import { GrepTool } from "./tools/grep";
import type { ToolSession } from "./tools/index";
import { type BuiltinToolPermissionInputs, isBuiltinToolAllowed } from "./tools/loading/policy";
import type { ActiveRepoContext } from "./utils/active-repo-context";

/**
 * Settings-parity harness for the default system prompt.
 *
 * WHY THIS EXISTS: prompt experiments can alter or remove a statement condition.
 * A variant that silently drops a setting-backed condition renders that setting
 * useless with zero other failure. That is how delegation settings
 * (`taskIrcEnabled`, `eagerTasksAlways`) were once rendered dead: the setting
 * still parsed and reached prompt inputs, but no emitted statement consumed it.
 *
 * Each test below pins that toggling one user setting changes the rendered
 * prompt at a concrete anchor. If statement wiring stops honoring that setting,
 * the matching test fails.
 *
 * The final GATING_PROPS coverage test fails when a new gating setting enters
 * the enumerated contract without a parity assertion here.
 *
 * ANCHOR ON DATA AND HEADINGS, NOT ON COPIED SENTENCES. Every assertion here is an anchor string, and
 * the first version of the delegation block quoted whole clauses ("Spawn-one-then-wait is a bug", "The
 * listed agents are what the operator wants delegated"). A prose pass that compressed the same bullets
 * without touching a single gate turned eleven of these red at once, which teaches nothing and trains a
 * reader to re-anchor without checking whether the gate still holds. So prefer, in this order: the
 * VALUES the test itself supplied and the template interpolates back (`` (`scout`) ``, `` (`task`) ``,
 * "At most 3 subagents"), a section HEADING ("## Delegation gates:"), and a distinctive short phrase
 * only when neither is available. The sibling harness in `test/core/prompt-gate-inputs.test.ts` derives
 * its signatures from the statement text for the same reason; the same discipline by hand here.
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

/**
 * Render with one spawnable agent, which is what the delegation prose requires.
 *
 * `OMITTED_GATE_DEFAULTS.subagentNames` is empty, and the guidance is gated on
 * `hasSpawnableSubagent`: with nothing to spawn the whole block is suppressed on purpose, because
 * the agent-typing bullet interpolated that empty list and read "Only one agent type is enabled
 * here (``)" while telling the model to fan work out. A test about `taskBatch`, the concurrency
 * cap or the `irc` hint is not a test of that gate, so it declares the agent rather than asserting
 * into a section its own defaults switched off. Stated once here so the precondition has one home.
 */
async function renderDelegating(overrides: Parameters<typeof buildSystemPrompt>[0] = {}): Promise<string> {
	return renderBlock0({ subagentNames: ["task"], ...overrides });
}

/**
 * Render the WHOLE prompt: every block the model receives, joined.
 *
 * {@link renderBlock0} deliberately reads only `systemPrompt[0]`, and that is
 * precisely why the appended tier had no coverage — the harness could not see
 * past the rendered template no matter what it asserted. The appended-tier
 * contract below uses this instead, so a block that stops being emitted fails a
 * test rather than disappearing silently.
 */
async function renderAll(overrides: Parameters<typeof buildSystemPrompt>[0] = {}): Promise<string> {
	const result = await buildSystemPrompt({
		toolNames: DELEGATION_TOOLS,
		contextFiles: [],
		skills: [],
		rules: [],
		workspaceTree: EMPTY_TREE,
		activeRepoContext: null,
		...overrides,
	});
	return result.systemPrompt.join("\n");
}

/** A resolved single-child-repo context, the one input that opens `repo-context`. */
function demoRepoContext(): ActiveRepoContext {
	return { cwd: "/tmp/outside", repoRoot: "/tmp/outside/sub", relativeRepoRoot: "sub" } as ActiveRepoContext;
}

/** Minimal skill shaped for the `<skills>` block; template reads name/description/hide. */
function demoSkills(): Skill[] {
	return [{ name: "demo-skill", description: "a demo skill", hide: false }] as unknown as Skill[];
}

/**
 * Any word a tool description would use to state delegation policy. Not global,
 * so `test` does not carry a lastIndex between cells.
 */
const DELEGATION_MENTION = /delegat|subagent|task tool|`task`/i;

/**
 * The three search tools' live descriptions under one subagent configuration.
 *
 * A tool description describes the tool: its inputs, its results, its usage
 * hints. Delegation is policy, it belongs to the prompt's Delegation section,
 * and these three carried it anyway (`grep` and `ast_grep` behind a
 * master-switch-only `canDelegate` gate, `glob` behind no gate at all), so they
 * ordered a handoff to a `task` subagent in states where the section itself was
 * correctly suppressed. The settings are varied here to prove the descriptions
 * no longer read the delegation settings at all.
 */
function searchToolDescriptions(subagentsEnabled: boolean, delegation: string): string[] {
	const session = {
		cwd: import.meta.dir,
		settings: Settings.isolated({ "subagent.enabled": subagentsEnabled, "subagent.delegation": delegation }),
	} as unknown as ToolSession;
	return [new GrepTool(session).description, new GlobTool(session).description, new AstGrepTool(session).description];
}

/**
 * Whether the `task` tool is offered, through the real permission table.
 *
 * Presence answers to `subagent.enabled` alone: delegation STRENGTH must never
 * remove the tool, or the operator loses the ability to ask for delegation
 * outright at the lower levels. Only the `task` branch of the table is
 * exercised, so the remaining inputs are irrelevant and the object is cast
 * rather than filled in.
 */
function taskToolOffered(subagentsEnabled: boolean, delegation: string): boolean {
	const settings = Settings.isolated({ "subagent.enabled": subagentsEnabled, "subagent.delegation": delegation });
	return isBuiltinToolAllowed(TOOL.task, {
		delegationEnabled: delegationEnabled(settings),
		canSpawnAtDepth: true,
	} as BuiltinToolPermissionInputs);
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
	"subagentNames",
	"hasSpawnableSubagent",
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
	"hasTodo",
	"hasAstTools",
	"hasBrowser",
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

	it(`${asserted("toolListMode")} omits inline descriptors when native schemas carry tools`, async () => {
		const listMode = await renderBlock0({ nativeTools: true, inlineToolDescriptors: false });
		const inlineMode = await renderBlock0({ nativeTools: true, inlineToolDescriptors: true });

		expect(listMode).not.toContain("# Tool: read");
		expect(inlineMode).toContain("# Tool: read");
		expect(inlineMode).toContain("Parameters:");
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

	it(`${asserted("hasTodo")} toggles the todo batching rule`, async () => {
		expect(await renderBlock0({ toolNames: ["read", "todo"] })).toContain("Todo calls NEVER travel alone");
		expect(await renderBlock0({ toolNames: ["read"] })).not.toContain("Todo calls NEVER travel alone");
	});

	it(`${asserted("hasAstTools")} toggles the AST section`, async () => {
		expect(await renderBlock0({ toolNames: ["read", "ast_grep"] })).toContain("# AST");
		expect(await renderBlock0({ toolNames: ["read"] })).not.toContain("# AST");
	});

	it(`${asserted("hasBrowser")} toggles the browser verification bullet`, async () => {
		expect(await renderBlock0({ toolNames: ["read", "browser"] })).toContain("driven with the `browser` tool");
		expect(await renderBlock0({ toolNames: ["read"] })).not.toContain("driven with the `browser` tool");
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
		expect(await renderDelegating({ toolNames: DELEGATION_TOOLS })).toContain("# Delegation");
		expect(
			await renderBlock0({
				toolNames: ["read", "edit"],
				subagentNames: ["task"],
			}),
		).not.toContain("# Delegation");
	});

	/**
	 * The three `subagent.delegation` levels as the builder sees them (`eagerTasks`
	 * is `preferred`-or-stronger, `eagerTasksAlways` is `required`), each with the
	 * one sentence it must produce. Shared by both tables below so a level cannot
	 * gain a sentence in one table and be forgotten in the other, which is how
	 * `allowed` came to render the Delegation heading, its gates and its
	 * subagent-value bullets with nothing saying when spawning is appropriate.
	 */
	const STRENGTHS = [
		{
			level: "allowed",
			eagerTasks: false,
			eagerTasksAlways: false,
			marker: "Delegation is available, not asked for",
		},
		{ level: "preferred", eagerTasks: true, eagerTasksAlways: false, marker: "Delegation is preferred" },
		{ level: "required", eagerTasks: true, eagerTasksAlways: true, marker: "Delegation is the default here" },
	] as const;

	it(`${asserted("eagerTasks")} toggles the delegation-mode paragraph`, async () => {
		const on = await renderDelegating({ eagerTasks: true, eagerTasksAlways: false });
		const off = await renderDelegating({ eagerTasks: false });
		expect(on).toContain("Delegation is preferred");
		expect(on).not.toContain("Delegation is available, not asked for");
		expect(off).not.toContain("Delegation is preferred");
		expect(off).not.toContain("Delegation is the default");
		// `allowed` is a strength, not the absence of one: the ability stays and an
		// explicit request is what triggers it.
		expect(off).toContain("Delegation is available, not asked for");
	});

	it(`${asserted("eagerTasksAlways")} escalates preferred delegation to mandatory`, async () => {
		const always = await renderDelegating({ eagerTasks: true, eagerTasksAlways: true });
		const preferred = await renderDelegating({ eagerTasks: true, eagerTasksAlways: false });
		expect(always).toContain("Delegation is the default here, not the exception");
		expect(always).toContain("MUST delegate substantial work");
		expect(preferred).toContain("Delegation is preferred");
		expect(preferred).not.toContain("Delegation is the default");
	});

	it("applies delegation strength to matching concrete roles", async () => {
		const roles = { subagentNames: ["reviewer"] };
		const preferred = await renderBlock0({ ...roles, eagerTasks: true, eagerTasksAlways: false });
		const required = await renderBlock0({ ...roles, eagerTasks: true, eagerTasksAlways: true });

		expect(preferred).toContain("when an enabled agent role matches");
		expect(preferred).toContain("Take the cheapest lane, or do it yourself.");
		expect(preferred).toContain("`reviewer`");
		expect(required).toContain("MUST delegate substantial work when an enabled agent role matches");
		expect(required).toContain("No enabled role's description matches the work");
		expect(required).not.toContain("executing");
		expect(required).not.toContain("investigative");
	});

	/**
	 * All strength and role-set combinations preserve concrete names. This matrix
	 * catches a branch that reintroduces inferred capability categories in only
	 * one delegation mode.
	 */
	it("renders the concrete role policy across all twelve settings combinations", async () => {
		const roleSets: Array<{ names: string[]; routing: string | null }> = [
			{ names: [], routing: null },
			{ names: ["task"], routing: "Take the cheapest lane, or do it yourself." },
			{ names: ["designer", "reviewer"], routing: "Take the cheapest lane, or do it yourself." },
			{ names: ["task", "designer", "reviewer"], routing: "Take the cheapest lane, or do it yourself." },
		];
		const strengths = STRENGTHS;

		for (const roles of roleSets) {
			for (const strength of strengths) {
				const rendered = await renderBlock0({ subagentNames: roles.names, ...strength });
				if (roles.routing === null) {
					expect(rendered).not.toContain("# Delegation");
					continue;
				}
				expect(rendered).toContain(roles.routing);
				expect(rendered).toContain(`Enabled agent types: \`${roles.names.join(", ")}\``);
				expect(rendered).not.toContain("Executing agents");
				expect(rendered).not.toContain("Investigative agents");
				for (const other of STRENGTHS) {
					if (other.level === strength.level) {
						expect(rendered).toContain(other.marker);
					} else {
						expect(rendered).not.toContain(other.marker);
					}
				}
			}
		}
	});

	/**
	 * THE NINE CELLS: {subagents off, on with zero enabled agent types, on with
	 * one} x {allowed, preferred, required}, rendered as one table so every cell is
	 * visible at once and a diff names the cell that moved.
	 *
	 * Two invariants, and both were violated. No cell may order delegation while
	 * nothing can be spawned: the search tools carried a "hand it to a `task`
	 * subagent" line gated only on the master switch, so with every agent type
	 * disabled the Delegation section was correctly absent and the tool
	 * descriptions still ordered a handoff to nothing. And no cell may render the
	 * section without a strength sentence, which is what `allowed` did. Tool
	 * descriptions now describe the tool only: delegation policy lives in the
	 * Delegation section and nowhere else, in all nine cells.
	 */
	it("keeps every subagent-enablement x delegation-strength cell self-consistent", async () => {
		const enablement = [
			{
				label: "subagents off",
				toolNames: DELEGATION_TOOLS.filter(name => name !== "task"),
				subagentNames: [] as string[],
				subagentsEnabled: false,
			},
			{ label: "on, no agent type enabled", toolNames: DELEGATION_TOOLS, subagentNames: [], subagentsEnabled: true },
			{
				label: "on, one agent type enabled",
				toolNames: DELEGATION_TOOLS,
				subagentNames: ["task"],
				subagentsEnabled: true,
			},
		];

		const rows: string[] = [];
		for (const state of enablement) {
			for (const strength of STRENGTHS) {
				const rendered = await renderBlock0({
					toolNames: state.toolNames,
					subagentNames: state.subagentNames,
					eagerTasks: strength.eagerTasks,
					eagerTasksAlways: strength.eagerTasksAlways,
				});
				const sentences = STRENGTHS.filter(candidate => rendered.includes(candidate.marker)).map(
					candidate => candidate.level,
				);
				const mentions = searchToolDescriptions(state.subagentsEnabled, strength.level).filter(description =>
					DELEGATION_MENTION.test(description),
				);
				rows.push(
					`${state.label} @ ${strength.level}: section=${rendered.includes("# Delegation") ? "yes" : "no"} strength=${sentences.join("+") || "none"} taskTool=${taskToolOffered(state.subagentsEnabled, strength.level) ? "offered" : "absent"} toolDescriptionsNamingDelegation=${mentions.length}`,
				);
			}
		}

		expect(rows).toEqual([
			"subagents off @ allowed: section=no strength=none taskTool=absent toolDescriptionsNamingDelegation=0",
			"subagents off @ preferred: section=no strength=none taskTool=absent toolDescriptionsNamingDelegation=0",
			"subagents off @ required: section=no strength=none taskTool=absent toolDescriptionsNamingDelegation=0",
			"on, no agent type enabled @ allowed: section=no strength=none taskTool=offered toolDescriptionsNamingDelegation=0",
			"on, no agent type enabled @ preferred: section=no strength=none taskTool=offered toolDescriptionsNamingDelegation=0",
			"on, no agent type enabled @ required: section=no strength=none taskTool=offered toolDescriptionsNamingDelegation=0",
			"on, one agent type enabled @ allowed: section=yes strength=allowed taskTool=offered toolDescriptionsNamingDelegation=0",
			"on, one agent type enabled @ preferred: section=yes strength=preferred taskTool=offered toolDescriptionsNamingDelegation=0",
			"on, one agent type enabled @ required: section=yes strength=required taskTool=offered toolDescriptionsNamingDelegation=0",
		]);
	});

	it(`${asserted("taskBatch")} selects the batched vs parallel-calls call shape`, async () => {
		const batched = await renderDelegating({ taskBatch: true });
		const parallel = await renderDelegating({ taskBatch: false });
		expect(batched).toContain("`tasks[]`");
		expect(batched).not.toContain("parallel calls");
		expect(parallel).toContain("parallel calls");
		expect(parallel).not.toContain("`tasks[]`");
	});

	it(`${asserted("taskMaxConcurrency")} toggles the concurrency cap and renders the number`, async () => {
		const capped = await renderDelegating({ taskMaxConcurrency: 3 });
		const uncapped = await renderDelegating({ taskMaxConcurrency: 0 });
		expect(capped).toContain("Concurrency cap:");
		expect(capped).toContain("At most 3 subagents");
		expect(uncapped).not.toContain("Concurrency cap:");
	});

	it(`${asserted("taskIrcEnabled")} toggles the irc cross-agent coordination hint`, async () => {
		expect(await renderDelegating({ taskIrcEnabled: true })).toContain("ask A via `irc`");
		expect(await renderDelegating({ taskIrcEnabled: false })).not.toContain("ask A via `irc`");
	});

	/**
	 * The prompt names the exact enabled roles. It does not derive a second
	 * classification from their tool grants or replace their own descriptions.
	 */
	it(`${asserted("subagentNames")} names every enabled concrete role`, async () => {
		const rendered = await renderBlock0({
			subagentNames: ["task", "designer", "reviewer"],
		});

		expect(rendered).toContain("Enabled agent types: `task, designer, reviewer`");
		expect(rendered).toContain("Pick by how much is unknown and how large the change is");
		expect(rendered).not.toContain("`scout`");
		expect(rendered).not.toContain("`sonic`");
		expect(rendered).not.toContain("Executing agents");
		expect(rendered).not.toContain("Investigative agents");
	});

	/**
	 * WITH NOTHING SPAWNABLE THE DELEGATION GUIDANCE IS NOT EMITTED AT ALL.
	 *
	 * The task tool is built whenever `subagent.enabled` is on, and it stays built with every agent
	 * row disabled on purpose: an ephemeral `/` command naming an agent grants it for that turn. So
	 * `contains("tools", "task")` was true while `subagentNames` was empty, and the agent-typing
	 * bullet interpolated the empty list into a sentence that stated a falsehood and pointed at
	 * nothing: "**Only one agent type is enabled here** (``), so delegate for parallel execution".
	 * The rest of the block told the model to fan work out to agents it could not name.
	 *
	 * Asserted on the literal empty-backticks render, because that exact string is the bug: a
	 * `not.toContain("Only one agent type")` alone would also pass if the gate merely swapped which
	 * wrong sentence appeared. The positive direction pins that a real agent still gets the guidance,
	 * since suppressing delegation prose for everyone would satisfy the negative half by itself.
	 */
	it(`${asserted("hasSpawnableSubagent")} suppresses delegation prose when no agent can be spawned`, async () => {
		const nothingSpawnable = await renderBlock0({ subagentNames: [] });
		const taskOnly = await renderBlock0({ subagentNames: ["task"] });

		expect(nothingSpawnable).not.toContain("(``)");
		expect(nothingSpawnable).not.toContain("## Delegation gates:");
		expect(nothingSpawnable).not.toContain("separate context");
		expect(nothingSpawnable).not.toContain("# Delegation");

		expect(taskOnly).toContain("Take the cheapest lane, or do it yourself.");
		expect(taskOnly).toContain("## Delegation gates:");
		expect(taskOnly).toContain("separate context");
	});

	/**
	 * The retired category list must not come back, in either wording.
	 *
	 * This is the regression itself rather than a proxy for it: "investigations" in
	 * the MUST-delegate list is what sent the main agent off to delegate audits, and
	 * the same sentence appears twice in the template (the `required` branch and the
	 * softer `preferred` one), so a fix applied to one and not the other would leave
	 * the bug live for half of all sessions. Both strengths are rendered.
	 */
	it(`${asserted("eagerTasks")} never names investigations as work that must be delegated`, async () => {
		const required = await renderDelegating({ eagerTasks: true, eagerTasksAlways: true });
		const preferred = await renderDelegating({ eagerTasks: true, eagerTasksAlways: false });

		for (const rendered of [required, preferred]) {
			expect(rendered).not.toContain("investigations—MUST be decomposed");
			expect(rendered).not.toContain("tests, and investigations are strong candidates");
		}
		// The surrounding guidance must survive: a gate that swallowed the whole
		// paragraph would pass the two checks above for the wrong reason.
		//
		// The surrounding guidance must survive: removing the whole paragraph
		// would make the negative checks pass for the wrong reason.
		expect(required).toContain("MUST delegate substantial work");
		expect(preferred).toContain("Delegation is preferred");
	});

	/**
	 * And the reason to delegate is stated as context preservation, not as a cheaper
	 * or lesser model. A subagent usually runs the model the session is on, so prose
	 * implying otherwise teaches the model to reserve real work for itself and hand
	 * out scraps — the opposite of what delegation is for.
	 */
	it("frames a subagent as a separate context rather than a lesser model", async () => {
		const rendered = await renderDelegating({});

		expect(rendered).toContain("separate context");
		expect(rendered).toContain("not because work is lesser");
	});

	it(`${asserted("useCodexTaskPrompt")} switches delegation to the Codex policy for gpt-5.6`, async () => {
		const codexEager = await renderDelegating({ model: "openai/gpt-5.6", eagerTasks: true });
		const codexQuiet = await renderDelegating({ model: "openai/gpt-5.6", eagerTasks: false });
		expect(codexEager).toContain("Proactive multi-agent delegation is active");
		expect(codexQuiet).toContain("Do not spawn sub-agents unless");
		// Non-codex model must NOT use the Codex phrasing.
		expect(await renderDelegating({ eagerTasks: true })).not.toContain("Proactive multi-agent delegation is active");
	});
});

describe("system prompt settings parity: delivery contract", () => {
	it(`${asserted("personality")} toggles the <personality> block`, async () => {
		expect(await renderBlock0({ personality: "default" })).toContain("<personality>");
		expect(await renderBlock0({ personality: "none" })).not.toContain("<personality>");
	});
});

/**
 * Extract wording-level Handlebars gates from statement modules.
 *
 * Whole-statement conditions are structured registry data and are added by
 * {@link addConditionIdentifiers}. Statement Markdown still owns intra-statement
 * `{{#if}}`, `{{#unless}}`, `{{#when}}`, and tool-presence checks.
 *
 * `{{#each}}` and `{{#list}}` are content renderers rather than branches. Toggle
 * tests assert their rendered item values separately.
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

/** Add the registry identifier for every leaf in one whole-statement condition. */
function addConditionIdentifiers(condition: StatementCondition, ids: Set<string>): void {
	switch (condition.kind) {
		case "always":
			return;
		case "when":
			ids.add(condition.variable);
			return;
		case "whenContains":
			ids.add(`${condition.collection}:${condition.member}`);
			return;
		case "whenAll":
		case "whenAny":
			for (const nested of condition.conditions) addConditionIdentifiers(nested, ids);
			return;
		case "not":
			addConditionIdentifiers(condition.condition, ids);
	}
}

/**
 * Maps each statement gating identifier to the enumerated GATING_PROP it belongs
 * to. Aliases resolve structured conditions and wording-level Handlebars names
 * to the caller option that controls them.
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
	subagentNames: "subagentNames",
	hasSpawnableSubagent: "hasSpawnableSubagent",
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
	"tools:todo": "hasTodo",
	"tools:inspect_image": "hasInspectImage",
	"tools:report_tool_issue": "hasReportToolIssue",
	"tools:ast_grep": "hasAstTools",
	"tools:ast_edit": "hasAstTools",
	"tools:browser": "hasBrowser",
};

/**
 * Gating identifiers that are intentionally NOT parity-tested, each with the
 * reason. These are not caller-supplied settings, so a toggle test does not
 * apply. Anything not here and not in IDENTIFIER_TO_PROP is an unaccounted gate.
 */
const EXCLUDED_IDENTIFIERS: Record<string, string> = {
	hasObsidian: "env-derived from the live Obsidian vault registry, not a buildSystemPrompt caller option",
	label: "loop-local variable inside {{#each tools}}, not a global gating setting",
	hasTools: "structural: gates tool-dependent runtime guidance, entangled with the asserted toolListMode",
};

describe("system prompt settings parity: coverage contract", () => {
	/**
	 * Every enumerated gating setting MUST have a toggle assertion above. Adding a
	 * new statement gate without extending both GATING_PROPS and a parity test
	 * fails here, so the harness cannot fall behind the prompt.
	 */
	it("asserts a parity test for every enumerated gating setting", () => {
		const missing = GATING_PROPS.filter(name => !ASSERTED.has(name));
		expect(missing).toEqual([]);
	});

	/**
	 * Account for every gate in both modular sources: structured statement
	 * conditions and wording-level Handlebars inside statement Markdown.
	 */
	it("accounts for every gating identifier in the statement modules", () => {
		const found = extractGatingIdentifiers(PROMPT_STATEMENTS.map(statement => statement.text).join("\n"));
		for (const statement of PROMPT_STATEMENTS) addConditionIdentifiers(statement.condition, found);

		// Guard against an extractor or registry traversal returning only a narrow
		// subset, which would make the unaccounted check pass vacuously.
		expect(found.has("taskIrcEnabled")).toBe(true);
		expect(found.has("hasMCPDiscoveryServers")).toBe(true);
		expect(found.has("tools:task")).toBe(true);
		expect(found.has("MAX_CONCURRENCY")).toBe(true);
		expect(found.size).toBeGreaterThanOrEqual(25);

		const unaccounted = [...found].filter(id => !(id in IDENTIFIER_TO_PROP) && !(id in EXCLUDED_IDENTIFIERS)).sort();
		expect(unaccounted).toEqual([]);
	});

	/** Every identifier mapping must point at a real, enumerated gating prop. */
	it("maps every statement identifier to an enumerated gating prop", () => {
		for (const prop of Object.values(IDENTIFIER_TO_PROP)) {
			expect(GATING_PROPS).toContain(prop);
		}
	});

	/**
	 * Every mapped prop must also carry a toggle assertion. Combined with the
	 * modular-source scan above, this closes the loop: statement gate, mapped
	 * prop, asserted toggle.
	 */
	it("has a toggle assertion for every prop a statement identifier maps to", () => {
		const mappedProps = new Set(Object.values(IDENTIFIER_TO_PROP));
		const unasserted = [...mappedProps].filter(prop => !ASSERTED.has(prop));
		expect(unasserted).toEqual([]);
	});
});

/**
 * Blocks with an appended-tier parity assertion below, keyed by registry id.
 * The coverage test at the end requires this to cover every registered block.
 */
const APPENDED_ASSERTED = new Set<string>();
function assertedBlock(id: string): string {
	APPENDED_ASSERTED.add(id);
	return id;
}

describe("system prompt parity: runtime sections", () => {
	/**
	 * WHY THIS SECTION EXISTS. Everything above gates on `{{#if <setting>}}`
	 * conditionals inside the template, and reads only `systemPrompt[0]`. Four
	 * blocks are concatenated AFTER that template, gated by plain TypeScript
	 * `if`s in the assembler. They were invisible to this harness in both
	 * respects: not conditionals it scans, and not in the block it renders. A
	 * deleted push or a flipped guard would have removed real instruction text
	 * from every prompt with ZERO test failure — the same silent-drop class the
	 * tier-1 harness exists to stop, relocated to where it could not look.
	 */

	it(`${assertedBlock("project")} is always emitted, and lands after the template`, async () => {
		// Unconditional: no setting gates it, so the contract is that it is ALWAYS
		// present. Deleting its entry from the registry or its push turns this red.
		const all = await renderAll();
		expect(all).toContain("<workstation>");
		// It must come from the appended tier, not the template. If this text ever
		// migrated into block 0, the assertion above would still pass while the
		// tier lost a member, so pin where it actually lives.
		expect(await renderBlock0()).not.toContain("<workstation>");
	});

	it("the merged active-repo clause appears in the project section only when a single child repo was resolved", async () => {
		// This used to be its own `repo-context` block. It is the SAME concern as the
		// project framing by every measure that matters — same input (the cwd), same
		// lifetime, same invalidation — and splitting it meant two things to remember
		// on a working-directory change. Exactly one of them got remembered, which is
		// how the prompt kept describing the previous project after a `/cd`.
		const on = await renderAll({ activeRepoContext: demoRepoContext() });
		expect(on).toContain("<active-repo-context>");
		// Assert the interpolated repo path, not just the wrapper: a dropped
		// template body would leave an empty block a wrapper-only check passes.
		expect(on).toContain("Paths under `sub/` are the active project");
		expect(await renderAll({ activeRepoContext: null })).not.toContain("<active-repo-context>");

		// It must ride inside the project section, not as a section of its own.
		const projectStart = on.indexOf("PROJECT\n==");
		const clauseAt = on.indexOf("<active-repo-context>");
		expect(projectStart).toBeGreaterThanOrEqual(0);
		expect(clauseAt).toBeGreaterThan(projectStart);
	});

	it(`${assertedBlock("shorthand")} is taught only when the caller opens the encode gate`, async () => {
		// The caller resolves the gate (model allowlist + context cutoff) and passes
		// the rendered block, so parity here is presence/absence of that input.
		const marker = "<<SHORTHAND-NOTATION-PREAMBLE-MARKER>>";
		expect(await renderAll({ argotPreamble: marker })).toContain(marker);
		expect(await renderAll({ argotPreamble: undefined })).not.toContain(marker);
	});

	it(`${assertedBlock("shorthand-handles")} carries the handle table when a project is loaded`, async () => {
		// Without this block the model is taught the notation but never learns a
		// single handle, which is the difference between an encode arm that can
		// possibly adopt shorthand and one that provably cannot.
		const marker = "<<SHORTHAND-HANDLE-TABLE-MARKER>>";
		expect(await renderAll({ argotHandles: marker })).toContain(marker);
		expect(await renderAll({ argotHandles: undefined })).not.toContain(marker);
	});

	it(`${assertedBlock("available-secrets")} lists spendable credentials only when the caller supplies an inventory`, async () => {
		// The vault outlives a session, so this block is the only thing that tells a
		// fresh session a credential exists at all. It must also stay absent when the
		// caller passes nothing: protection off and an empty vault both arrive here as
		// `undefined`, and an "AVAILABLE SECRETS" banner over nothing would advertise a
		// capability the session does not have.
		const marker = "<<AVAILABLE-SECRETS-MARKER>>";
		expect(await renderAll({ secretInventory: marker })).toContain(marker);
		expect(await renderAll({ secretInventory: undefined })).not.toContain(marker);
		expect(await renderAll({ secretInventory: undefined })).not.toContain("AVAILABLE SECRETS");
	});

	it("emits appended blocks in registry order", async () => {
		// Order is declared data in the registry; assert the model actually receives
		// it that way, so a reordered assembly cannot pass unnoticed.
		const all = await renderAll({
			activeRepoContext: demoRepoContext(),
			argotPreamble: "<<PREAMBLE>>",
			argotHandles: "<<HANDLES>>",
		});
		const positions = [
			all.indexOf("<workstation>"),
			all.indexOf("<active-repo-context>"),
			all.indexOf("<<PREAMBLE>>"),
			all.indexOf("<<HANDLES>>"),
		];
		expect(positions.every(p => p >= 0)).toBe(true);
		expect(positions).toEqual([...positions].sort((a, b) => a - b));
	});

	/**
	 * The coverage contract for tier 2, mirroring the tier-1 one. Registering a new
	 * appended block without a presence/absence assertion here fails, so the
	 * harness cannot fall behind the assembler the way it did for four blocks.
	 */
	it("asserts parity for every registered runtime section", () => {
		const missing = RUNTIME_SECTIONS.map(s => s.id).filter(id => !APPENDED_ASSERTED.has(id));
		expect(missing).toEqual([]);
	});
});
