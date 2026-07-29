import { describe, expect, it } from "bun:test";
import type { Skill } from "./extensibility/skills";
import { buildSystemPrompt } from "./system-prompt";
import { RUNTIME_SECTIONS } from "./system-prompt-builder/section-registry";
import { PROMPT_STATEMENTS, type StatementCondition } from "./system-prompt-builder/statement-registry";
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
	"hasSubagentSpecialists",
	"investigativeSubagentNames",
	"hasInvestigativeSubagent",
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
		expect(on).toContain("Delegation is preferred");
		expect(off).not.toContain("Delegation is preferred");
		expect(off).not.toContain("Delegation is the default");
	});

	it(`${asserted("eagerTasksAlways")} escalates preferred delegation to mandatory`, async () => {
		const always = await renderBlock0({ eagerTasks: true, eagerTasksAlways: true });
		const preferred = await renderBlock0({ eagerTasks: true, eagerTasksAlways: false });
		expect(always).toContain("Delegation is the default here, not the exception");
		expect(always).toContain("MUST fan the work out");
		expect(preferred).toContain("Delegation is preferred");
		expect(preferred).not.toContain("Delegation is the default");
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
	 * The delegation prose may name a specialist only when this session can spawn
	 * it. Bundled specialists ship unadvertised (`subagent.agents.*`), so a prompt
	 * that hard-codes `scout` tells the model to route research to an agent absent
	 * from the `task` description — an instruction it can only fail to follow.
	 */
	it(`${asserted("subagentNames")} names the read-only agent only when one is on offer`, async () => {
		const withScout = await renderBlock0({
			subagentNames: ["task", "scout"],
			investigativeSubagentNames: ["scout"],
		});
		const workerOnly = await renderBlock0({ subagentNames: ["task"], investigativeSubagentNames: [] });
		expect(withScout).toContain("read-only agent (`scout`)");
		// The BACKTICKED name, not the bare word: the no-agent branch ends "...exist to execute, not
		// scout", using the word in its ordinary sense, so a bare substring check fails on English
		// prose while the gate is working perfectly. What must be absent is the agent REFERENCE.
		expect(workerOnly).not.toContain("`scout`");
		// The rule the clause hangs off must survive either way, or the gate has
		// swallowed the whole bullet rather than just the specialist reference.
		expect(workerOnly).toContain("## Delegation gates:");
	});

	/**
	 * The clause is gated on the ROLE, not on the name `scout`.
	 *
	 * It used to be `{{#has subagentNames "scout"}}`, which named one bundled agent as the yardstick for
	 * every other, so a user-authored read-only agent could never satisfy it however plainly its
	 * `tools:` line said what it was. The role is derived from that tool grant
	 * (`task/agent-role.ts`), so a differently-named read-only agent gets named here.
	 */
	it(`${asserted("investigativeSubagentNames")} names a read-only agent that is not called scout`, async () => {
		const custom = await renderBlock0({
			subagentNames: ["task", "auditor"],
			investigativeSubagentNames: ["auditor"],
		});

		expect(custom).toContain("read-only agent (`auditor`)");
		expect(custom).not.toContain("`scout`");
	});

	/**
	 * AUDIT DELEGATION IS OFF WITH NO AGENT TYPED FOR IT, which is the other half of the fix the
	 * `hasSubagentSpecialists` doc below describes.
	 *
	 * That pass removed the hardcoded "INVESTIGATIONS MUST be delegated" category list, and three
	 * ungated bullets survived it in `delegation-subagent-value.md`: "Use `task` to map unknown code
	 * instead of reading file after file yourself", the bulk-reading rationale, and "multi-subsystem
	 * investigation". So every session was still told to delegate audits, by a different sentence. On a
	 * stock install the only enabled agent is `task`, a worker with full edit capability, so the prompt
	 * pointed audits at an agent that exists to change code.
	 *
	 * Both directions asserted, because a gate that is always true reads the same in the source.
	 */
	it(`${asserted("hasInvestigativeSubagent")} toggles whether audits may be delegated`, async () => {
		const withReadOnly = await renderBlock0({
			subagentNames: ["task", "scout"],
			investigativeSubagentNames: ["scout"],
		});
		const executorsOnly = await renderBlock0({
			subagentNames: ["task", "sonic"],
			investigativeSubagentNames: [],
		});

		expect(withReadOnly).toContain("read-only agent (`scout`)");
		expect(withReadOnly).not.toContain("audits inline");

		expect(executorsOnly).toContain("audits inline");
		expect(executorsOnly).not.toContain("read-only agent");
		expect(executorsOnly).not.toContain("`scout`");
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
		const nothingSpawnable = await renderBlock0({ subagentNames: [], investigativeSubagentNames: [] });
		const oneWorker = await renderBlock0({ subagentNames: ["task"], investigativeSubagentNames: [] });

		expect(nothingSpawnable).not.toContain("(``)");
		expect(nothingSpawnable).not.toContain("## Delegation gates:");
		expect(nothingSpawnable).not.toContain("One agent type is enabled");
		expect(nothingSpawnable).not.toContain("separate context");

		expect(oneWorker).toContain("One agent type is enabled** (`task`)");
		expect(oneWorker).toContain("## Delegation gates:");
		expect(oneWorker).toContain("separate context");
	});

	/**
	 * The enabled agents ARE the delegation policy, and this is the bullet that says
	 * so, so it has to say the right thing in both directions.
	 *
	 * The prompt used to carry a hardcoded category list ("...tests, INVESTIGATIONS
	 * — MUST be decomposed and delegated"), which meant every session was told to
	 * delegate audits whether or not an agent suited to that work existed. A
	 * hardcoded list cannot follow a setting, so it was wrong in every session that
	 * did not happen to match it. The list is gone and this gate replaces it: with
	 * specialists enabled the operator has named what belongs to a subagent, and
	 * with only the worker there is no agent TYPE to choose, so the model is told to
	 * delegate for parallelism and context rather than to hand off a kind of work.
	 *
	 * Both branches are asserted because the `{{else}}` is the half that stops the
	 * model inventing a specialist policy from nothing.
	 */
	it(`${asserted("hasSubagentSpecialists")} toggles the agent-typing gate`, async () => {
		const specialists = await renderBlock0({
			subagentNames: ["task", "reviewer"],
			investigativeSubagentNames: ["reviewer"],
		});
		const workerOnly = await renderBlock0({ subagentNames: ["task"], investigativeSubagentNames: [] });

		expect(specialists).toContain("Match agent types");
		expect(specialists).not.toContain("One agent type is enabled");

		expect(workerOnly).toContain("One agent type is enabled** (`task`)");
		expect(workerOnly).not.toContain("Match agent types");
	});

	/**
	 * A SECOND EXECUTOR OPENS THIS GATE AND NOT THE AUDIT ONE.
	 *
	 * The predicate was `subagentNames.some(name => name !== DEFAULT_ENABLED_BUNDLED_AGENT)`, which asked
	 * "is anything other than `task` enabled" and named one agent as the yardstick for all the others:
	 * `sonic`, another executor, satisfied it and made the prompt claim a kind-of-work specialist
	 * existed. It counts now, because the gate is about having more than one TYPE to match a slice to.
	 *
	 * `sonic` legitimately does give the model that second type, and legitimately does not make handing
	 * off an audit sensible, so the two gates must disagree here. This is the case that proves they are
	 * two questions rather than one asked twice.
	 */
	it("opens type-matching for a second executor while audits stay inline", async () => {
		const twoExecutors = await renderBlock0({
			subagentNames: ["task", "sonic"],
			investigativeSubagentNames: [],
		});

		expect(twoExecutors).toContain("Match agent types");
		expect(twoExecutors).toContain("audits inline");
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
		const required = await renderBlock0({ eagerTasks: true, eagerTasksAlways: true });
		const preferred = await renderBlock0({ eagerTasks: true, eagerTasksAlways: false });

		for (const rendered of [required, preferred]) {
			expect(rendered).not.toContain("investigations—MUST be decomposed");
			expect(rendered).not.toContain("tests, and investigations are strong candidates");
		}
		// The surrounding guidance must survive: a gate that swallowed the whole
		// paragraph would pass the two checks above for the wrong reason.
		//
		// Anchored on "MUST be delegated" and not on the older "MUST be decomposed and delegated":
		// the sentence now reads "Everything else that clears the delegation gates ... MUST be
		// delegated", because naming the gates is what replaced the hardcoded category list. The
		// shorter anchor is a substring of both wordings, so it survives that edit and still fails if
		// the paragraph disappears.
		expect(required).toContain("MUST be delegated");
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
	hasSubagentSpecialists: "hasSubagentSpecialists",
	investigativeSubagentNames: "investigativeSubagentNames",
	hasInvestigativeSubagent: "hasInvestigativeSubagent",
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
