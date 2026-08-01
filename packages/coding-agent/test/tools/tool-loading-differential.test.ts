import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";
import { TOOL_LOAD_CASES, type ToolLoadOutcome, ToolLoadRunner } from "./tool-loading-differential.harness";

// `createAgentSession` opens `AgentStorage`, which resolves under the ACTIVE PROFILE's agent
// dir. Without this the suite writes into the developer's real `~/.veyyon` tree.
useIsolatedAgentDir();

/**
 * DIFFERENTIAL TEST for tool loading.
 *
 * WHAT THIS IS. Every literal below was CAPTURED from the pre-consolidation code by booting a
 * real `createAgentSession` for each matrix cell and recording two things: the exact ordered
 * list of active tool names, and the contents of the discoverable index. The consolidation in
 * `src/tools/loading/` then had to reproduce them byte for byte. That is the entire safety
 * argument for a refactor that touches the code path deciding whether the agent has `read`,
 * `bash` and `edit` at all.
 *
 * WHY THE WHOLE BOOT AND NOT THE POLICY FUNCTIONS. Testing the extracted pure functions against
 * inputs the refactor also chose would prove nothing: it would compare new code to new code.
 * Driving `createAgentSession` means the assertions are anchored to observable product
 * behavior, so a decision that moved and quietly changed its inputs still fails here.
 *
 * WHY ORDER IS ASSERTED. Tool order is prompt order and prompt order is prompt-cache identity,
 * so a reshuffle that leaves the SET intact is still a regression: it invalidates every cached
 * prefix. `toEqual` on an array is deliberate; do not relax it to a set comparison.
 *
 * MAINTENANCE. A literal here changes ONLY when the behavior change is intended. Re-record by
 * hand, state which cell moved and why in the commit, and update the doc comment on that cell.
 * A silent re-record defeats the point of the file.
 */
const FROZEN_OUTCOMES: Record<string, ToolLoadOutcome> = {
	"discovery-auto-under-threshold": {
		active: [
			"read",
			"bash",
			"launch",
			"edit",
			"ast_grep",
			"ast_edit",
			"debug",
			"eval",
			"glob",
			"grep",
			"browser",
			"task",
			"job",
			"irc",
			"todo",
			"web_search",
			"set_cwd",
			"write",
			"resolve",
		],
		discoverable: [],
	},
	"discovery-off": {
		active: [
			"read",
			"bash",
			"launch",
			"edit",
			"ast_grep",
			"ast_edit",
			"debug",
			"eval",
			"glob",
			"grep",
			"browser",
			"task",
			"job",
			"irc",
			"todo",
			"web_search",
			"set_cwd",
			"write",
			"resolve",
		],
		discoverable: [],
	},
	"discovery-mcp-only": {
		active: [
			"read",
			"bash",
			"launch",
			"edit",
			"ast_grep",
			"ast_edit",
			"debug",
			"eval",
			"glob",
			"grep",
			"browser",
			"task",
			"job",
			"irc",
			"todo",
			"web_search",
			"search_tool_bm25",
			"set_cwd",
			"write",
			"resolve",
		],
		discoverable: [],
	},
	"discovery-all": {
		active: ["read", "bash", "launch", "edit", "eval", "glob", "task", "search_tool_bm25", "write", "resolve"],
		discoverable: [
			"builtin:ast_grep",
			"builtin:ast_edit",
			"builtin:debug",
			"builtin:grep",
			"builtin:browser",
			"builtin:job",
			"builtin:irc",
			"builtin:todo",
			"builtin:web_search",
			"builtin:set_cwd",
		],
	},
	"discovery-all-essential-override": {
		active: [
			"read",
			"bash",
			"launch",
			"edit",
			"eval",
			"glob",
			"grep",
			"task",
			"search_tool_bm25",
			"write",
			"resolve",
		],
		discoverable: [
			"builtin:ast_grep",
			"builtin:ast_edit",
			"builtin:debug",
			"builtin:browser",
			"builtin:job",
			"builtin:irc",
			"builtin:todo",
			"builtin:web_search",
			"builtin:set_cwd",
		],
	},
	"browser-disabled": {
		active: [
			"read",
			"bash",
			"launch",
			"edit",
			"ast_grep",
			"ast_edit",
			"debug",
			"eval",
			"glob",
			"grep",
			"task",
			"job",
			"irc",
			"todo",
			"web_search",
			"set_cwd",
			"write",
			"resolve",
		],
		discoverable: [],
	},
	"browser-disabled-discovery-all": {
		active: ["read", "bash", "launch", "edit", "eval", "glob", "task", "search_tool_bm25", "write", "resolve"],
		discoverable: [
			"builtin:ast_grep",
			"builtin:ast_edit",
			"builtin:debug",
			"builtin:grep",
			"builtin:job",
			"builtin:irc",
			"builtin:todo",
			"builtin:web_search",
			"builtin:set_cwd",
		],
	},
	"explicit-tool-names": {
		active: ["read", "grep", "glob"],
		discoverable: [],
	},
	"explicit-tool-names-discovery-all": {
		active: ["read", "grep", "glob"],
		discoverable: ["builtin:ast_grep"],
	},
	"eval-backends-disabled": {
		active: [
			"read",
			"bash",
			"launch",
			"edit",
			"ast_grep",
			"ast_edit",
			"debug",
			"glob",
			"grep",
			"browser",
			"task",
			"job",
			"irc",
			"todo",
			"web_search",
			"set_cwd",
			"write",
			"resolve",
		],
		discoverable: [],
	},
	"harness-profile-tool-allowlist": {
		active: ["read", "grep", "todo"],
		discoverable: [],
	},
	"restored-selection-discovery-all": {
		active: [
			"read",
			"bash",
			"launch",
			"edit",
			"eval",
			"glob",
			"browser",
			"task",
			"todo",
			"search_tool_bm25",
			"write",
			"resolve",
		],
		discoverable: [
			"builtin:ast_grep",
			"builtin:ast_edit",
			"builtin:debug",
			"builtin:grep",
			"builtin:job",
			"builtin:irc",
			"builtin:web_search",
			"builtin:set_cwd",
		],
	},
	"force-active-todo-discovery-all": {
		active: [
			"read",
			"bash",
			"launch",
			"edit",
			"eval",
			"glob",
			"task",
			"todo",
			"search_tool_bm25",
			"write",
			"resolve",
		],
		discoverable: [
			"builtin:ast_grep",
			"builtin:ast_edit",
			"builtin:debug",
			"builtin:grep",
			"builtin:browser",
			"builtin:job",
			"builtin:irc",
			"builtin:web_search",
			"builtin:set_cwd",
		],
	},
	"delegation-off-discovery-all": {
		active: ["read", "bash", "launch", "edit", "eval", "glob", "search_tool_bm25", "write", "resolve"],
		discoverable: [
			"builtin:ast_grep",
			"builtin:ast_edit",
			"builtin:debug",
			"builtin:grep",
			"builtin:browser",
			"builtin:job",
			"builtin:todo",
			"builtin:web_search",
			"builtin:set_cwd",
		],
	},
	"auto-at-threshold": {
		active: [
			"read",
			"bash",
			"launch",
			"edit",
			"ast_grep",
			"ast_edit",
			"debug",
			"eval",
			"glob",
			"grep",
			"browser",
			"task",
			"job",
			"irc",
			"todo",
			"web_search",
			"set_cwd",
			"write",
			"resolve",
			"bulk_0",
			"bulk_1",
			"bulk_2",
			"bulk_3",
			"bulk_4",
			"bulk_5",
			"bulk_6",
			"bulk_7",
			"bulk_8",
			"bulk_9",
			"bulk_10",
			"bulk_11",
			"bulk_12",
			"bulk_13",
			"bulk_14",
			"bulk_15",
		],
		discoverable: [],
	},
	"auto-over-threshold": {
		active: [
			"read",
			"bash",
			"launch",
			"edit",
			"ast_grep",
			"ast_edit",
			"debug",
			"eval",
			"glob",
			"grep",
			"browser",
			"task",
			"job",
			"irc",
			"todo",
			"web_search",
			"set_cwd",
			"write",
			"resolve",
			"bulk_0",
			"bulk_1",
			"bulk_2",
			"bulk_3",
			"bulk_4",
			"bulk_5",
			"bulk_6",
			"bulk_7",
			"bulk_8",
			"bulk_9",
			"bulk_10",
			"bulk_11",
			"bulk_12",
			"bulk_13",
			"bulk_14",
			"bulk_15",
			"bulk_16",
			"search_tool_bm25",
		],
		discoverable: [],
	},
};

describe("tool loading resolves to identical outcomes after consolidation", () => {
	const runner = new ToolLoadRunner();

	beforeAll(async () => {
		await runner.setup();
	});

	afterAll(() => {
		runner.teardown();
	});

	async function expectFrozenOutcome(caseName: string): Promise<void> {
		const testCase = TOOL_LOAD_CASES.find(entry => entry.name === caseName);
		if (!testCase) throw new Error(`No matrix case named ${caseName}`);
		const expected = FROZEN_OUTCOMES[caseName];
		if (!expected) throw new Error(`No frozen outcome for ${caseName}`);
		const actual = await runner.run(testCase);
		expect(actual.active).toEqual(expected.active);
		expect(actual.discoverable).toEqual(expected.discoverable);
	}

	/**
	 * The matrix and the frozen outcomes describe the same set of cases.
	 *
	 * LOCKS OUT: a new matrix cell added with no recorded outcome (it would silently never
	 * run), and a frozen outcome left behind after its cell was deleted (it would silently
	 * assert nothing).
	 */
	it("covers every matrix case exactly once", () => {
		expect(TOOL_LOAD_CASES.map(entry => entry.name).sort()).toEqual(Object.keys(FROZEN_OUTCOMES).sort());
	});

	/**
	 * Default configuration: `tools.discoveryMode: "auto"` with a registry below the auto
	 * threshold resolves to `off`.
	 *
	 * LOCKS OUT: any change that makes the shipped default start hiding tools — a threshold
	 * that counts differently, an `auto` arm that stops falling through to `off`, or a
	 * built-in silently dropped from (or added to) the default slate. The list is ORDERED,
	 * so a reordering of `BUILTIN_TOOLS` also fails here: tool order is prompt order, and
	 * prompt order is prompt-cache identity.
	 */
	it("discovery-auto-under-threshold", async () => {
		await expectFrozenOutcome("discovery-auto-under-threshold");
	});

	/**
	 * Explicit `tools.discoveryMode: "off"`.
	 *
	 * LOCKS OUT: `off` and under-threshold `auto` diverging. They must produce the same set,
	 * and neither may register `search_tool_bm25` — a discovery tool present under `off` is
	 * the mode setting failing to mean what it says.
	 */
	it("discovery-off", async () => {
		await expectFrozenOutcome("discovery-off");
	});

	/**
	 * `tools.discoveryMode: "mcp-only"`, with no MCP servers connected.
	 *
	 * LOCKS OUT: `mcp-only` leaking into local-tool hiding. It must add `search_tool_bm25`
	 * at its registry position and change nothing else, even though there is nothing for the
	 * search tool to find. The discoverable index stays empty because local tools are only
	 * indexed under `all`.
	 */
	it("discovery-mcp-only", async () => {
		await expectFrozenOutcome("discovery-mcp-only");
	});

	/**
	 * `tools.discoveryMode: "all"` — the only mode that reads a tool's declared `loadMode`.
	 *
	 * LOCKS OUT: a regression in `filterInitialToolsForDiscoveryAll`. Exactly the tools with
	 * `loadMode: "essential"` survive, plus `task` (force-active because
	 * `subagent.delegation` defaults to `preferred`), `search_tool_bm25`, and the
	 * unconditionally-appended `resolve`. Every hidden tool must reappear in the
	 * discoverable index — hidden-and-unfindable is the failure mode this guards.
	 */
	it("discovery-all", async () => {
		await expectFrozenOutcome("discovery-all");
	});

	/**
	 * `tools.essentialOverride: ["read", "grep"]` under discovery-all.
	 *
	 * LOCKS OUT: the override being read as a REPLACEMENT for per-tool `loadMode`. It is
	 * additive: `bash`, `launch`, `edit`, `eval`, `glob` and `write` stay active through
	 * their declared `loadMode: "essential"` even though the override does not name them,
	 * and `grep` is rescued from hiding by the override alone.
	 */
	it("discovery-all-essential-override", async () => {
		await expectFrozenOutcome("discovery-all-essential-override");
	});

	/**
	 * A per-tool enable flag turned off (`browser.enabled: false`), default discovery mode.
	 *
	 * LOCKS OUT: a per-tool flag degrading from "the tool does not exist" to "the tool is
	 * hidden". `browser` is absent from the active list, and every other name keeps its
	 * position — a disable must not perturb ordering.
	 */
	it("browser-disabled", async () => {
		await expectFrozenOutcome("browser-disabled");
	});

	/**
	 * `browser.enabled: false` combined with discovery-all.
	 *
	 * LOCKS OUT: the worst version of the previous failure — a disabled tool that vanishes
	 * from the prompt but shows up in the discoverable index, where the model can activate
	 * it through `search_tool_bm25` and route around the setting entirely.
	 */
	it("browser-disabled-discovery-all", async () => {
		await expectFrozenOutcome("browser-disabled-discovery-all");
	});

	/**
	 * An explicit `toolNames` whitelist.
	 *
	 * LOCKS OUT: the whitelist being widened. The caller asked for three tools and gets
	 * exactly three, in the order given — no `resolve` (dropped from an explicit list by
	 * `createTools` and re-added only when nothing named `resolve` was constructed, which
	 * is not this case), and no `ast_grep` even though `grep` pulls it into the registry.
	 */
	it("explicit-tool-names", async () => {
		await expectFrozenOutcome("explicit-tool-names");
	});

	/**
	 * An explicit whitelist under discovery-all.
	 *
	 * LOCKS OUT: discovery-all overriding an explicit request. `grep` declares
	 * `loadMode: "discoverable"` and would be hidden, but naming it keeps it active. The
	 * companion `ast_grep` — added to the registry on `grep`'s behalf, never requested by
	 * name — is correctly hidden into the index instead.
	 */
	it("explicit-tool-names-discovery-all", async () => {
		await expectFrozenOutcome("explicit-tool-names-discovery-all");
	});

	/**
	 * Every `eval` backend disallowed removes the tool entirely.
	 *
	 * LOCKS OUT: `resolveEvalToolAvailability` degrading into "always available". `eval.py`
	 * and `eval.js` default TRUE, so this is the only cell where the rule's answer is `false`
	 * — without it, hardcoding `return true` passes the whole suite. Compare against
	 * `discovery-auto-under-threshold`: identical list minus `eval`, which also proves the
	 * removal does not disturb the order of anything around it.
	 */
	it("eval-backends-disabled", async () => {
		await expectFrozenOutcome("eval-backends-disabled");
	});

	/**
	 * A harness profile's `tools` allowlist trims the resolved active set.
	 *
	 * LOCKS OUT: the pipeline's final stage being skipped or reordered. The allowlist runs
	 * LAST, after discovery-all hiding, so it can remove a tool that every earlier rule kept
	 * — including essentials like `bash` and `write`, absent here. Ordering follows the
	 * incoming list, not the allowlist.
	 */
	it("harness-profile-tool-allowlist", async () => {
		await expectFrozenOutcome("harness-profile-tool-allowlist");
	});

	/**
	 * A persisted selection restored from the session branch, under discovery-all.
	 *
	 * LOCKS OUT: losing the documented back-compat path where built-in activations are
	 * persisted under `selectedMCPToolNames`. `browser` and `todo` were hidden in the
	 * plain discovery-all case above; restoring them re-activates both and removes them
	 * from the discoverable index.
	 */
	it("restored-selection-discovery-all", async () => {
		await expectFrozenOutcome("restored-selection-discovery-all");
	});

	/**
	 * `todo.eager: "always"` under discovery-all.
	 *
	 * LOCKS OUT: a provider 400. Eager todos force a NAMED `tool_choice` on the first turn,
	 * and a named choice that references a tool absent from the request is rejected outright.
	 * `todo` must therefore be force-active despite `loadMode: "discoverable"`, and must
	 * drop out of the discoverable index because it is active.
	 */
	it("force-active-todo-discovery-all", async () => {
		await expectFrozenOutcome("force-active-todo-discovery-all");
	});

	/**
	 * `subagent.delegation: "off"` under discovery-all.
	 *
	 * LOCKS OUT: a session that cannot delegate still shipping the delegation surface.
	 * `task` loses its force-active exemption AND its permission, so it is neither active
	 * nor discoverable; `irc` derives from the same spawn capability and disappears with
	 * it. Compare against `discovery-all`, where both are present.
	 */
	it("delegation-off-discovery-all", async () => {
		await expectFrozenOutcome("delegation-off-discovery-all");
	});

	/**
	 * Exactly `TOOL_DISCOVERY_AUTO_THRESHOLD` tools under `auto`.
	 *
	 * LOCKS OUT: an off-by-one at the boundary. The comparison is strictly greater-than, so
	 * a registry of exactly 40 non-`search_tool_bm25` tools stays `off` and no discovery
	 * tool is registered.
	 */
	it("auto-at-threshold", async () => {
		await expectFrozenOutcome("auto-at-threshold");
	});

	/**
	 * One tool past `TOOL_DISCOVERY_AUTO_THRESHOLD` under `auto`.
	 *
	 * LOCKS OUT: the other side of the same off-by-one, and the ordering dependency behind
	 * it. 41 tools flips `auto` to `mcp-only`, which registers `search_tool_bm25` at the
	 * END of the list (it is appended after the registry is complete, not woven into
	 * built-in order). Local tools stay active because `mcp-only` never hides them.
	 */
	it("auto-over-threshold", async () => {
		await expectFrozenOutcome("auto-over-threshold");
	});
});
