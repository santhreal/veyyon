// WHY: `search_tool_bm25` activated every ranked match, up to a default limit
// of 8, which is the entire hidden set under `tools.discoveryMode: "all"`. An
// activation is not a one-off cost: the activated tool's schema joins the
// request and is re-sent on every later request of the session. So a single
// natural-language query put back most of what the mode removed, silently.
// Measured on the real hidden set of this build, "keep track of what is left to
// do" activated `todo` plus `set_cwd`, `task` and `web_search` and cost 2,239
// tokens a request where `todo` alone costs 1,048; "run a command on another
// machine" activated `ssh`, `debug` and `todo` for 2,390 where `ssh` alone
// costs 434. Across eight such queries the tail was 3,319 of 7,349 tokens.
//
// The class this closes: an activation decided by rank order rather than by
// match strength, on any query and any inventory. A match at least half as
// strong as the best one still activates, because a fuzzy query whose right
// answer is rank two is what this tool is for; anything weaker is reported in
// `also_matched` and a second query naming it activates it for ~20 tokens. The
// recall sweep is derived from the live discoverable inventory at run time, so a
// new discoverable tool is covered without being listed here, and goes red if
// the band ever hides a tool from a query that names it.
//
// What it does not catch: the floor is a ratio, and BM25 scores cannot be
// engineered to land exactly on it, so `>=` against `>` at the floor itself is
// unproven — every other mutation of the comparison is covered. It also does not
// price the extra turn a dropped match costs when the model wanted it.
import { describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { getDiscoverableTool } from "@veyyon/coding-agent/discovery/tool-index";
import {
	computeEssentialBuiltinNames,
	createTools,
	type DiscoverableTool,
	type ToolSession,
} from "@veyyon/coding-agent/tools";
import {
	resolveDiscoveryAllForceActive,
	resolveInitialActiveToolNames,
} from "@veyyon/coding-agent/tools/loading/policy";
import { SearchToolBm25Tool } from "@veyyon/coding-agent/tools/search-tool-bm25";
import { makeToolSession } from "../helpers/tool-session";

interface DiscoveryResult {
	readonly activated: readonly string[];
	readonly alsoMatched: readonly string[];
	readonly scores: ReadonlyMap<string, number>;
	readonly text: string;
}

/**
 * A session whose discoverable inventory is `inventory`, wired through the
 * generic discovery hooks the production path uses.
 */
function discoverySession(inventory: readonly DiscoverableTool[]): ToolSession {
	const selected: string[] = [];
	return {
		...makeToolSession({ settings: Settings.isolated({ "tools.discoveryMode": "all" }) }),
		isToolDiscoveryEnabled: () => true,
		getDiscoverableTools: () => inventory.filter(tool => !selected.includes(tool.name)),
		getSelectedDiscoveredToolNames: () => [...selected],
		activateDiscoveredTools: async (toolNames: string[]) => {
			for (const name of toolNames) if (!selected.includes(name)) selected.push(name);
			return toolNames;
		},
	};
}

async function discover(session: ToolSession, query: string, limit?: number): Promise<DiscoveryResult> {
	const tool = SearchToolBm25Tool.createIf(session);
	if (!tool) throw new Error("search_tool_bm25 refused to construct on a discovery-enabled session");
	const result = await tool.execute("probe", limit === undefined ? { query } : { query, limit });
	const text = result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && "text" in part)
		.map(part => part.text)
		.join("\n");
	return {
		activated: result.details?.activated_tools ?? [],
		alsoMatched: result.details?.also_matched ?? [],
		scores: new Map((result.details?.tools ?? []).map(match => [match.name, match.score])),
		text,
	};
}

/** The discoverable built-ins this build actually hides under `discoveryMode: "all"`. */
async function liveHiddenTools(): Promise<readonly DiscoverableTool[]> {
	const settings = Settings.isolated({ "tools.discoveryMode": "all" });
	const tools = await createTools(makeToolSession({ settings }));
	const names = tools.map(tool => tool.name);
	const { initialToolNames } = resolveInitialActiveToolNames({
		explicitToolNames: undefined,
		requestedToolNames: names,
		goalEnabled: settings.get("goal.enabled"),
		hasRegistryTool: (name: string) => names.includes(name),
		defaultInactiveToolNames: new Set<string>(),
		mcpDiscoveryEnabled: false,
		discoveryDefaultServerToolNames: [],
		persistedSelectedMCPToolNames: [],
		hasPersistedMCPToolSelection: false,
		alwaysIncludeToolNames: [],
		effectiveDiscoveryMode: "all",
		loadModeOf: (name: string) => tools.find(tool => tool.name === name)?.loadMode,
		essentialToolNames: computeEssentialBuiltinNames(settings),
		forceActiveToolNames: resolveDiscoveryAllForceActive({
			todoEager: settings.get("todo.eager"),
			todoEnabled: settings.get("todo.enabled"),
			hasTodoTool: names.includes("todo"),
			delegationStrength: settings.get("subagent.delegation"),
			hasTaskTool: names.includes("task"),
		}),
		harnessToolAllowlist: undefined,
	});
	return tools
		.filter(tool => !initialToolNames.includes(tool.name))
		.map(tool => getDiscoverableTool(tool))
		.filter((tool): tool is DiscoverableTool => tool !== null);
}

/** A synthetic inventory: one strong answer and a long weak tail on one shared word. */
const SYNTHETIC: readonly DiscoverableTool[] = [
	{
		name: "ticket_close",
		label: "tickets/close",
		summary: "Close a support ticket and notify the reporter of the resolution.",
		source: "mcp",
		serverName: "tickets",
		mcpToolName: "close",
		schemaKeys: ["ticket_id", "resolution"],
	},
	...Array.from({ length: 6 }, (_, index) => ({
		name: `unrelated_${index}`,
		label: `misc/unrelated_${index}`,
		summary: `Perform maintenance step ${index} on a queue, a cache, a mailbox and a ticket.`,
		source: "mcp" as const,
		serverName: "misc",
		mcpToolName: `unrelated_${index}`,
		schemaKeys: ["target", "dry_run"],
	})),
];

describe("a discovery call activates only what it matched well", () => {
	it("keeps a weak tail match out of the activation and reports it instead", async () => {
		const result = await discover(discoverySession(SYNTHETIC), "close a support ticket for the reporter");
		expect(result.activated).toEqual(["ticket_close"]);
		expect(result.alsoMatched.length).toBeGreaterThan(0);
		// Nothing is lost: every ranked match is either activated or named.
		expect([...result.activated, ...result.alsoMatched].sort()).toEqual([...result.scores.keys()].sort());
	});

	it("activates a reported tail match when a later query names it", async () => {
		const session = discoverySession(SYNTHETIC);
		const first = await discover(session, "close a support ticket for the reporter");
		const dropped = first.alsoMatched[0];
		expect(dropped).toBeDefined();
		const second = await discover(session, dropped as string);
		expect(second.activated).toContain(dropped);
	});

	it("activates every match at least half as strong as the best one, and no other", async () => {
		const result = await discover(discoverySession(SYNTHETIC), "ticket queue cache mailbox");
		const best = Math.max(...result.scores.values());
		for (const name of result.activated) {
			expect(result.scores.get(name)).toBeGreaterThanOrEqual(best * 0.5);
		}
		for (const name of result.alsoMatched) {
			expect(result.scores.get(name)).toBeLessThan(best * 0.5);
		}
	});

	it("never activates more tools than the caller's limit allows", async () => {
		const result = await discover(discoverySession(SYNTHETIC), "ticket queue cache mailbox", 2);
		expect(result.scores.size).toBeLessThanOrEqual(2);
		expect(result.activated.length).toBeLessThanOrEqual(2);
	});

	it("says nothing about a tail that does not exist", async () => {
		const result = await discover(discoverySession(SYNTHETIC), "resolution reporter");
		expect(result.alsoMatched).toEqual([]);
		expect(result.text).not.toContain("also_matched");
	});

	it("names the tail it withheld in the text the model reads", async () => {
		const result = await discover(discoverySession(SYNTHETIC), "close a support ticket for the reporter");
		const parsed: unknown = JSON.parse(result.text);
		expect(parsed).toMatchObject({ also_matched: [...result.alsoMatched] });
	});

	it("still activates any discoverable built-in a query names outright", async () => {
		const inventory = await liveHiddenTools();
		expect(inventory.length).toBeGreaterThan(0);
		for (const tool of inventory) {
			const result = await discover(discoverySession(inventory), tool.name);
			expect(result.activated).toContain(tool.name);
		}
	});
});
