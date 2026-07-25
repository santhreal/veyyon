/**
 * A broken discoverable-tool inventory is announced and refused, never answered as "no tools".
 *
 * WHY THIS SUITE EXISTS. `search_tool_bm25` read the inventory through a `catch` that returned
 * `[]`, and its own doc comment said so: "Falls back to empty array on error". Two consequences,
 * both invisible:
 *
 *  - The tool DESCRIPTION is built from that inventory at prompt-build time. A session with fifteen
 *    discoverable tools whose inventory threw once described itself as having none, so the model
 *    read "no tools are currently discoverable" and stopped asking. Nothing failed; the capability
 *    simply disappeared for the rest of the conversation.
 *  - `execute` then searched an EMPTY index and returned a perfectly successful result with
 *    `match_count: 0`. "I searched and found nothing" and "I could not search" are different facts,
 *    and the model cannot tell them apart from that JSON. It concludes the tool it needs does not
 *    exist and routes around it, which is exactly the recall loss with no symptom that Law 10 bans.
 *
 * So the read is reported at warn level (an operator can find it) and `execute` FAILS CLOSED when
 * discovery is enabled and yet the index is empty: it throws, the refusal lands in the transcript,
 * and the model can try another route knowing this one is broken rather than empty.
 *
 * The distinction these tests are built around: an empty INDEX is a defect and must refuse; zero
 * MATCHES against a healthy index is an ordinary answer and must still succeed. A fix that made
 * both refuse would be as wrong as the one that made both succeed, so both are pinned here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import {
	buildDiscoverableToolSearchIndex,
	type DiscoverableTool,
	type DiscoverableToolSearchIndex,
} from "@veyyon/coding-agent/tool-discovery/tool-index";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { renderSearchToolBm25Description, SearchToolBm25Tool } from "@veyyon/coding-agent/tools/search-tool-bm25";
import { ToolError } from "@veyyon/coding-agent/tools/tool-errors";
import { logger } from "@veyyon/utils";

/** The exact refusal, so a reword that drops the reason from the transcript fails here. */
const REFUSAL =
	"The discoverable-tool inventory is empty, which should not happen while tool discovery is enabled. " +
	"The session log carries the reason. Use the tools already active, or ask the operator to check it.";

type DiscoveryToolSession = ToolSession & {
	isMCPDiscoveryEnabled: () => boolean;
	getDiscoverableTools: (filter?: { source?: DiscoverableTool["source"] }) => DiscoverableTool[];
	getDiscoverableToolSearchIndex?: () => DiscoverableToolSearchIndex;
	getSelectedMCPToolNames: () => string[];
	activateDiscoveredMCPTools: (toolNames: string[]) => Promise<string[]>;
	activations: string[][];
};

const HEALTHY_TOOLS: DiscoverableTool[] = [
	{
		name: "mcp__github_create_issue",
		label: "github/create_issue",
		summary: "Create a GitHub issue in the selected repository",
		source: "mcp",
		serverName: "github",
		mcpToolName: "create_issue",
		schemaKeys: ["owner", "repo", "title"],
	},
	{
		name: "mcp__slack_post_message",
		label: "slack/post_message",
		summary: "Post a message to a Slack channel",
		source: "mcp",
		serverName: "slack",
		mcpToolName: "post_message",
		schemaKeys: ["channel", "text"],
	},
];

function createSession(overrides: Partial<DiscoveryToolSession> = {}): DiscoveryToolSession {
	const selected: string[] = [];
	const activations: string[][] = [];
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "mcp.discoveryMode": true }),
		isMCPDiscoveryEnabled: () => true,
		getDiscoverableTools: () => HEALTHY_TOOLS,
		getSelectedMCPToolNames: () => [...selected],
		activateDiscoveredMCPTools: async (toolNames: string[]) => {
			activations.push([...toolNames]);
			for (const name of toolNames) if (!selected.includes(name)) selected.push(name);
			return toolNames;
		},
		activations,
		...overrides,
	} as DiscoveryToolSession;
}

describe("an inventory read that throws", () => {
	let warnings: Array<{ message: string; fields: Record<string, unknown> }>;

	beforeEach(() => {
		warnings = [];
		vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
			warnings.push({ message, fields: fields ?? {} });
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("does not take the session down when the description is built", () => {
		// The description is rendered while the system prompt is assembled. Throwing there
		// fails the whole turn, which is worse than describing an empty inventory, so the
		// error is caught. The rest of this suite is about it not being caught SILENTLY.
		const tool = new SearchToolBm25Tool(
			createSession({
				getDiscoverableTools: () => {
					throw new Error("inventory socket closed");
				},
			}),
		);

		expect(() => tool.description).not.toThrow();
		expect(tool.description).not.toContain("Total discoverable tools available");
	});

	it("warns with the underlying error, which is the only trace an operator gets", () => {
		// `logger.debug` was what this used to be; a debug line is off by default and so
		// the capability vanished with no record anywhere the operator looks.
		const tool = new SearchToolBm25Tool(
			createSession({
				getDiscoverableTools: () => {
					throw new Error("inventory socket closed");
				},
			}),
		);

		void tool.description;

		expect(warnings.length).toBe(1);
		expect(warnings[0]?.message).toBe(
			"Discoverable tool inventory could not be read; search_tool_bm25 is describing an empty inventory",
		);
		expect(warnings[0]?.fields).toEqual({ error: "inventory socket closed" });
	});

	it("refuses the search instead of reporting zero matches", async () => {
		// The heart of it. Before the fix this resolved with `{"match_count":0,...}` and the
		// model learned there was nothing to find.
		const tool = new SearchToolBm25Tool(
			createSession({
				getDiscoverableTools: () => {
					throw new Error("inventory socket closed");
				},
			}),
		);

		const failure = await tool.execute("call-broken", { query: "github issue" }).then(
			result => ({ ok: true as const, result }),
			(error: unknown) => ({ ok: false as const, error }),
		);

		expect(failure.ok).toBe(false);
		if (failure.ok) return;
		expect(failure.error).toBeInstanceOf(ToolError);
		expect((failure.error as ToolError).message).toBe(REFUSAL);
	});

	it("refuses before activating anything", async () => {
		// A refusal that had already mutated the session's active tool set would leave the
		// session in a state the transcript does not describe.
		const session = createSession({
			getDiscoverableTools: () => {
				throw new Error("inventory socket closed");
			},
		});
		const tool = new SearchToolBm25Tool(session);

		await expect(tool.execute("call-broken", { query: "github" })).rejects.toThrow(ToolError);
		expect(session.activations).toEqual([]);
		expect(session.getSelectedMCPToolNames()).toEqual([]);
	});
});

describe("a cached search index that throws", () => {
	let warnings: Array<{ message: string; fields: Record<string, unknown> }>;

	beforeEach(() => {
		warnings = [];
		vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
			warnings.push({ message, fields: fields ?? {} });
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("is reported and then rebuilt, so the search still answers", async () => {
		// This one IS a legitimate fallback: the cache is a cache, and the inventory behind
		// it is intact, so recall is fully preserved and the rebuild costs one index build.
		// What was wrong was the bare `catch {}` that hid a throwing cache forever.
		const session = createSession({
			getDiscoverableToolSearchIndex: () => {
				throw new Error("index cache poisoned");
			},
		});
		const tool = new SearchToolBm25Tool(session);

		const result = await tool.execute("call-rebuild", { query: "github issue" });

		expect(result.details?.tools.map(match => match.name)).toEqual(["mcp__github_create_issue"]);
		expect(result.details?.total_tools).toBe(2);
		expect(warnings.map(entry => entry.message)).toEqual([
			"Cached discoverable-tool search index threw; rebuilding it for this call",
		]);
		expect(warnings[0]?.fields).toEqual({ error: "index cache poisoned" });
	});

	it("stays quiet when the session offers no cached index at all", async () => {
		// A cache MISS is not a fallback and must not warn: a legacy MCP-discovery session
		// does not implement the getter, so the index is built per call by design. A warning
		// here would train operators to ignore the one that matters.
		const session = createSession();
		const tool = new SearchToolBm25Tool(session);

		const result = await tool.execute("call-miss", { query: "slack" });

		expect(result.details?.tools.map(match => match.name)).toEqual(["mcp__slack_post_message"]);
		expect(warnings).toEqual([]);
	});

	it("refuses when both the cache and the inventory behind it are broken", async () => {
		// The rebuild reads the same inventory, so a double failure ends at the refusal
		// rather than at a successful empty answer. Both warnings are on the record.
		const session = createSession({
			getDiscoverableToolSearchIndex: () => {
				throw new Error("index cache poisoned");
			},
			getDiscoverableTools: () => {
				throw new Error("inventory socket closed");
			},
		});
		const tool = new SearchToolBm25Tool(session);

		await expect(tool.execute("call-both", { query: "github" })).rejects.toThrow(REFUSAL);
		expect(warnings.map(entry => entry.fields.error)).toEqual(["index cache poisoned", "inventory socket closed"]);
	});
});

describe("an index that is empty without anything having thrown", () => {
	it("still refuses, because discovery being enabled means there should be tools", async () => {
		// The fail-closed check is on the index, not on whether a read threw: an inventory
		// that returns `[]` for a reason of its own (a registry that never populated, a
		// catalog that was cleared mid-session) produces the identical invisible loss.
		const tool = new SearchToolBm25Tool(createSession({ getDiscoverableTools: () => [] }));

		await expect(tool.execute("call-empty", { query: "github" })).rejects.toThrow(REFUSAL);
	});

	it("is not reached when discovery is disabled, which has its own refusal", async () => {
		// Disabled discovery is a configuration, not a defect, and its message tells the
		// operator which setting to turn on. The empty-index refusal must not shadow it.
		const tool = new SearchToolBm25Tool(
			createSession({
				getDiscoverableTools: () => [],
				isMCPDiscoveryEnabled: () => false,
				settings: Settings.isolated({ "mcp.discoveryMode": false }),
			}),
		);

		await expect(tool.execute("call-off", { query: "github" })).rejects.toThrow(
			"Tool discovery is disabled. Enable tools.discoveryMode or mcp.discoveryMode to use search_tool_bm25.",
		);
	});

	it("is not reached before the input checks, so a bad query still says so", async () => {
		// Order matters for the model reading the error: "your query was empty" is
		// actionable, "the inventory is broken" would send it chasing a non-problem.
		const tool = new SearchToolBm25Tool(createSession({ getDiscoverableTools: () => [] }));

		await expect(tool.execute("call-blank", { query: "   " })).rejects.toThrow(
			"Query is required and must not be empty.",
		);
	});
});

describe("a healthy inventory", () => {
	let warnings: Array<{ message: string; fields: Record<string, unknown> }>;

	beforeEach(() => {
		warnings = [];
		vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
			warnings.push({ message, fields: fields ?? {} });
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("answers zero matches as a success, which is what the refusal must not swallow", async () => {
		// The negative twin of the whole suite. A query that matches nothing against a real
		// index is an ordinary answer: the model needs to see `match_count: 0` with a real
		// `total_tools` and conclude "not this query", not "this tool is broken".
		const tool = new SearchToolBm25Tool(createSession());

		const result = await tool.execute("call-nomatch", { query: "zzzzzzz-no-such-capability" });

		expect(result.details?.tools).toEqual([]);
		expect(result.details?.total_tools).toBe(2);
		expect(result.content).toEqual([
			{
				type: "text",
				text: JSON.stringify({
					query: "zzzzzzz-no-such-capability",
					activated_tools: [],
					match_count: 0,
					total_tools: 2,
				}),
			},
		]);
	});

	it("describes the tools it has and warns about nothing", () => {
		const tool = new SearchToolBm25Tool(createSession());

		expect(tool.description).toContain("Total discoverable tools available: 2.");
		expect(warnings).toEqual([]);
	});

	it("renders the same description the tool exposes, from the same inventory", () => {
		// The renderer is exported and used by the prompt builder too; if the two ever
		// disagreed, the description the model reads would not be the one under test here.
		const tool = new SearchToolBm25Tool(createSession());

		expect(tool.description).toBe(renderSearchToolBm25Description(HEALTHY_TOOLS));
	});

	it("searches the cached index when the session has one, without touching the inventory", async () => {
		// The reason a broken cache is only a warning: on the ordinary path the inventory is
		// never read during execution, so the cache is the only thing that can fail.
		let inventoryReads = 0;
		const index = buildDiscoverableToolSearchIndex(HEALTHY_TOOLS);
		const session = createSession({
			getDiscoverableToolSearchIndex: () => index,
			getDiscoverableTools: () => {
				inventoryReads++;
				return HEALTHY_TOOLS;
			},
		});
		const tool = new SearchToolBm25Tool(session);

		const result = await tool.execute("call-cached", { query: "slack channel" });

		expect(result.details?.tools.map(match => match.name)).toEqual(["mcp__slack_post_message"]);
		expect(inventoryReads).toBe(0);
		expect(warnings).toEqual([]);
	});
});
