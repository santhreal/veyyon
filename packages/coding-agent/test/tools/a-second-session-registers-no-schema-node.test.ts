/**
 * WHY: ArkType registers every node a `type(...)` call builds in a process-global table,
 * `$ark.nodesByRegisteredId`, and never releases it. `eval` built its session-scoped parameter
 * schema per tool instance, and the default language set (py, js) is a strict subset of the four
 * languages, so every session and every spawned agent added 18 nodes that outlived it.
 * `report_tool_issue` did the same with 11. A long session that spawns agents grew the table by
 * one schema per agent for the life of the process.
 *
 * Class closed: a tool factory that builds a parameter schema per session instead of per distinct
 * shape. Swept over every factory in `BUILTIN_TOOLS` and `HIDDEN_TOOLS`, read from the registry
 * at run time, under two tool-session shapes whose union constructs every factory, and under every
 * subset of eval languages, since the language list is the input eval keys its schema on. After a
 * first session has built each shape once, a second session building the same tools and their
 * wire schemas must register no node.
 *
 * Not caught: a schema built per call inside `execute`, or keyed on an input with an unbounded
 * value space (a cache per session id would pass here and still grow). Tools registered outside
 * the built-in tables (MCP, extensions) are not swept.
 */
import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadArktype } from "@veyyon/ai/utils/schema/arktype";
import { toolWireSchema } from "@veyyon/ai/utils/schema/wire";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import { BUILTIN_TOOLS, HIDDEN_TOOLS, type Tool, type ToolSession } from "@veyyon/coding-agent/tools";
import { EVAL_LANGUAGE_ORDER } from "@veyyon/coding-agent/tools/shell/eval";
import { TempDir } from "@veyyon/utils";
import { ArgotSession } from "argot";
import { makeToolSession } from "../helpers/tool-session";

/** A profile with one SSH host, which is what makes the `ssh` factory construct its tool. */
const profile = TempDir.createSync("@schema-node-profile-");
fs.writeFileSync(path.join(profile.path(), "ssh.json"), JSON.stringify({ hosts: { build: { host: "192.0.2.10" } } }));
afterAll(() => profile.removeSync());

// ArkType creates `$ark` when it evaluates, which the module tools import it through defers to the
// first schema built.
loadArktype();
const registry = (globalThis as unknown as { $ark: { nodesByRegisteredId: Record<string, unknown> } }).$ark;
const registeredNodes = (): number => Object.keys(registry.nodesByRegisteredId).length;

const FACTORIES = { ...BUILTIN_TOOLS, ...HIDDEN_TOOLS };

const EVAL_LANGUAGE_SETTING = { py: "eval.py", js: "eval.js", rb: "eval.rb", jl: "eval.jl" } as const;

/** Every subset of eval languages, as the settings that select it. */
function evalLanguageSubsets(): Record<string, boolean>[] {
	const subsets: Record<string, boolean>[] = [];
	for (let mask = 0; mask < 1 << EVAL_LANGUAGE_ORDER.length; mask++) {
		subsets.push(
			Object.fromEntries(
				EVAL_LANGUAGE_ORDER.map((lang, bit) => [EVAL_LANGUAGE_SETTING[lang], (mask & (1 << bit)) !== 0]),
			),
		);
	}
	return subsets;
}

/**
 * The session a top-level interactive run hands its tools. Constructs every factory gated on a
 * top-level session (checkpoint, rewind).
 */
function topLevelSession(overrides: Record<string, unknown>): ToolSession {
	return makeToolSession({ getSessionSpawns: () => "*", settings: Settings.isolated(overrides) });
}

/**
 * A spawned agent's session with every optional capability present and every opt-in feature on.
 * Constructs every factory gated on a UI, the agent registry, memory, autolearn, LSP, tool
 * discovery, Argot or a configured SSH host.
 */
function capableSession(overrides: Record<string, unknown>): ToolSession {
	const settings = Settings.isolated({
		"lsp.enabled": true,
		"lsp.tool": true,
		"autolearn.enabled": true,
		"memory.backend": "mnemopi",
		"tools.discoveryMode": "all",
		"argot.enabled": true,
		...overrides,
	});
	settings.getAgentDir = () => profile.path();
	return makeToolSession({
		hasUI: true,
		taskDepth: 1,
		getSessionSpawns: () => "*",
		getAgentId: () => "0-Main",
		agentRegistry: new AgentRegistry(),
		getArgotSession: () => new ArgotSession(),
		isToolDiscoveryEnabled: () => true,
		getSelectedDiscoveredToolNames: () => [],
		activateDiscoveredTools: async () => [],
		settings,
	});
}

const SHAPES: Record<string, (overrides: Record<string, unknown>) => ToolSession> = {
	"a top-level session": topLevelSession,
	"a capable spawned session": capableSession,
};

/** Build every tool a session shape constructs, with the wire schema a request sends. */
async function buildTools(session: ToolSession): Promise<string[]> {
	const built: string[] = [];
	for (const [name, factory] of Object.entries(FACTORIES)) {
		const tool = (await factory(session)) as Tool | null;
		if (!tool) continue;
		toolWireSchema(tool);
		built.push(name);
	}
	return built;
}

/** Nodes each tool registers while a fresh session of the shape builds it. */
async function nodesPerTool(session: ToolSession): Promise<Record<string, number>> {
	const grown: Record<string, number> = {};
	for (const [name, factory] of Object.entries(FACTORIES)) {
		const before = registeredNodes();
		const tool = (await factory(session)) as Tool | null;
		if (!tool) continue;
		toolWireSchema(tool);
		const added = registeredNodes() - before;
		if (added !== 0) grown[name] = added;
	}
	return grown;
}

describe("a second session registers no schema node", () => {
	it("constructs every built-in and hidden tool under one of the session shapes", async () => {
		const constructed = new Set<string>();
		for (const shape of Object.values(SHAPES)) {
			for (const name of await buildTools(shape({}))) constructed.add(name);
		}
		// A factory neither shape constructs is a hole in every sweep below, not a pass.
		expect(Object.keys(FACTORIES).filter(name => !constructed.has(name))).toEqual([]);
	});

	for (const [shapeName, shape] of Object.entries(SHAPES)) {
		it(`builds each tool of ${shapeName} without registering a node`, async () => {
			await buildTools(shape({}));
			expect(await nodesPerTool(shape({}))).toEqual({});
		});

		it(`builds eval under every language subset of ${shapeName} without registering a node`, async () => {
			const subsets = evalLanguageSubsets();
			expect(subsets).toHaveLength(2 ** EVAL_LANGUAGE_ORDER.length);
			for (const subset of subsets) await buildTools(shape(subset));
			const grown: Record<string, Record<string, number>> = {};
			for (const subset of subsets) {
				const added = await nodesPerTool(shape(subset));
				if (Object.keys(added).length > 0) grown[JSON.stringify(subset)] = added;
			}
			expect(grown).toEqual({});
		});
	}
});
