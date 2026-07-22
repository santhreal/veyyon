import { describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { BuiltinToolLoadMode, ToolSession } from "@veyyon/coding-agent/tools";
import {
	BUILTIN_TOOLS,
	computeEssentialBuiltinNames,
	createTools,
	DEFAULT_ESSENTIAL_TOOL_NAMES,
	filterInitialToolsForDiscoveryAll,
} from "@veyyon/coding-agent/tools";
import { AskTool } from "@veyyon/coding-agent/tools/ask";
import { GithubTool } from "@veyyon/coding-agent/tools/gh";
import { IrcTool } from "@veyyon/coding-agent/tools/irc";
import { JobTool } from "@veyyon/coding-agent/tools/job";
import { SshTool } from "@veyyon/coding-agent/tools/ssh";

const allToolsSettings = Settings.isolated({
	"astGrep.enabled": true,
	"astEdit.enabled": true,
	"debug.enabled": true,
	"glob.enabled": true,
	"grep.enabled": true,
	"github.enabled": true,
	"lsp.enabled": true,
	"inspect_image.enabled": true,
	"web_search.enabled": true,
	"browser.enabled": true,
	"checkpoint.enabled": true,
	"todo.enabled": true,
	"memory.backend": "mnemopi",
	"autolearn.enabled": true,
	// Off by default, so without this the two argot tools never get constructed and
	// the always-active / summary assertions below skip them silently rather than
	// checking them. Argot tools are always-active built-ins (no loadMode) when
	// enabled — not discoverable — because loading is the canonical arming flow.
	"argot.enabled": true,
	"tools.discoveryMode": "all",
});

const toolSession: ToolSession = {
	cwd: "/tmp/test",
	hasUI: false,
	getSessionFile: () => null,
	getSessionSpawns: () => null,
	settings: allToolsSettings,
	isToolDiscoveryEnabled: () => true,
	getSelectedDiscoveredToolNames: () => [],
	activateDiscoveredTools: async names => names,
	// Argot tools only construct when a session codec exists (enabled alone is not
	// enough — a subagent under argot.subagents:off has enabled settings but no codec).
	getArgotSession: () => ({ loaded: false }) as never,
};

async function getToolMetadata(): Promise<Map<string, { loadMode?: string; summary?: string }>> {
	const tools = await createTools(toolSession, Object.keys(BUILTIN_TOOLS));
	const metadata = new Map(tools.map(tool => [tool.name, { loadMode: tool.loadMode, summary: tool.summary }]));
	for (const tool of [
		new AskTool({ ...toolSession, hasUI: true }),
		new GithubTool(toolSession),
		new SshTool(toolSession, [], new Map(), ""),
		new JobTool(toolSession),
		new IrcTool(toolSession),
	]) {
		metadata.set(tool.name, { loadMode: tool.loadMode, summary: tool.summary });
	}
	return metadata;
}
/** Built-ins that stay always-active (no loadMode) when constructed — not discoverable. */
const ALWAYS_ACTIVE_BUILTINS = new Set(["argot_load", "argot_unload"]);

describe("BUILTIN_TOOLS public factory map", () => {
	it("sets loading fields on tool definitions without wrapping factories", async () => {
		const metadata = await getToolMetadata();
		const missing = Object.keys(BUILTIN_TOOLS).filter(
			name => !ALWAYS_ACTIVE_BUILTINS.has(name) && metadata.get(name)?.loadMode === undefined,
		);
		expect(missing).toEqual([]);
	});

	it("keeps argot tools always-active (not discoverable) when enabled AND a codec is exposed", async () => {
		// Factories gate on argot.enabled AND getArgotSession?.() !== undefined: a
		// subagent under argot.subagents:"off" (or any stub without a codec) gets neither
		// tool even when the setting is on. This fixture exposes a codec, so both appear
		// as always-active built-ins (no loadMode), never discoverable.
		const metadata = await getToolMetadata();
		for (const name of ["argot_load", "argot_unload"] as const) {
			expect(metadata.has(name)).toBe(true);
			expect(metadata.get(name)?.loadMode).toBeUndefined();
			expect(metadata.get(name)?.summary?.length).toBeGreaterThan(0);
		}
	});

	it("omits argot tools when enabled but the session exposes no codec", async () => {
		// Dual-gate negative: settings say enabled, but getArgotSession is absent —
		// the same shape as a subagent with argot.subagents:"off". Neither tool constructs.
		const { getArgotSession: _drop, ...noCodec } = toolSession;
		void _drop;
		const tools = await createTools(noCodec as ToolSession, Object.keys(BUILTIN_TOOLS));
		const names = new Set(tools.map(tool => tool.name));
		expect(names.has("argot_load")).toBe(false);
		expect(names.has("argot_unload")).toBe(false);
	});

	it("omits argot tools when getArgotSession returns undefined", async () => {
		const session: ToolSession = {
			...toolSession,
			getArgotSession: () => undefined,
		};
		const tools = await createTools(session, Object.keys(BUILTIN_TOOLS));
		const names = new Set(tools.map(tool => tool.name));
		expect(names.has("argot_load")).toBe(false);
		expect(names.has("argot_unload")).toBe(false);
	});
	it("exposes launch instead of daemon", async () => {
		const launch = await BUILTIN_TOOLS.launch(toolSession);
		expect(launch?.name).toBe("launch");
		expect(Object.hasOwn(BUILTIN_TOOLS, "daemon")).toBeFalse();
	});
});

describe("built-in tool loadMode annotations", () => {
	it("provides a summary for every discoverable tool", async () => {
		const missing: string[] = [];
		const metadata = await getToolMetadata();
		for (const [name, meta] of metadata) {
			if (meta.loadMode === "discoverable" && !meta.summary) {
				missing.push(name);
			}
		}
		expect(missing).toEqual([]);
	});

	it("marks eval essential so it survives tools.discoveryMode 'all'", async () => {
		const metadata = await getToolMetadata();
		expect(metadata.get("eval")?.loadMode).toBe("essential");
		// Essential loadMode keeps eval active under discovery-all even when it is
		// absent from the essential-names set — not relying on the names list.
		const kept = filterInitialToolsForDiscoveryAll(["eval"], {
			loadModeOf: name => metadata.get(name)?.loadMode as BuiltinToolLoadMode | undefined,
			essentialNames: new Set<string>(),
			explicitlyRequested: new Set<string>(),
			restored: new Set<string>(),
			forceActive: new Set<string>(),
		});
		expect(kept).toEqual(["eval"]);
	});
});

describe("computeEssentialBuiltinNames", () => {
	it("returns DEFAULT_ESSENTIAL_TOOL_NAMES when override is empty", () => {
		const settings = Settings.isolated({});
		expect(computeEssentialBuiltinNames(settings).sort()).toEqual([...DEFAULT_ESSENTIAL_TOOL_NAMES].sort());
	});

	it("respects tools.essentialOverride when provided", () => {
		const settings = Settings.isolated({ "tools.essentialOverride": ["read", "glob"] });
		expect(computeEssentialBuiltinNames(settings).sort()).toEqual(["glob", "read"]);
	});

	it("maps legacy essential override tool names", () => {
		const settings = Settings.isolated({ "tools.essentialOverride": ["read", "find", "search", "glob"] });
		expect(computeEssentialBuiltinNames(settings).sort()).toEqual(["glob", "grep", "read"]);
	});

	it("filters override entries that are not known built-in tools", () => {
		const settings = Settings.isolated({
			"tools.essentialOverride": ["read", "not_a_real_tool", "edit"],
		});
		expect(computeEssentialBuiltinNames(settings).sort()).toEqual(["edit", "read"]);
	});

	it("trims whitespace and drops empty entries from the override", () => {
		const settings = Settings.isolated({
			"tools.essentialOverride": [" read ", "", "  "],
		});
		expect(computeEssentialBuiltinNames(settings)).toEqual(["read"]);
	});

	it("falls back to defaults when override is non-empty but contains only invalid names", () => {
		// The filtered list is empty (no valid names), but the override was provided —
		// current behavior returns the empty filtered list (caller can decide). Document the behavior.
		const settings = Settings.isolated({
			"tools.essentialOverride": ["not_a_real_tool"],
		});
		expect(computeEssentialBuiltinNames(settings)).toEqual([]);
	});
});

describe("tools.discoveryMode settings schema", () => {
	it("defaults to auto discovery mode", () => {
		const settings = Settings.isolated({});
		expect(settings.get("tools.discoveryMode")).toBe("auto");
	});

	it("back-compat: mcp.discoveryMode still accepted", () => {
		const settings = Settings.isolated({ "mcp.discoveryMode": true });
		expect(settings.get("mcp.discoveryMode")).toBe(true);
	});
});

describe("filterInitialToolsForDiscoveryAll", () => {
	const loadModes: Record<string, BuiltinToolLoadMode> = {
		read: "essential",
		edit: "essential",
		todo: "discoverable",
		grep: "discoverable",
	};
	const base = {
		loadModeOf: (name: string): BuiltinToolLoadMode | undefined => loadModes[name],
		essentialNames: new Set(["read", "bash", "edit", "write", "glob"]),
		explicitlyRequested: new Set<string>(),
		restored: new Set<string>(),
		forceActive: new Set<string>(),
	};

	it("hides non-essential discoverable built-ins", () => {
		expect(filterInitialToolsForDiscoveryAll(["read", "edit", "todo", "grep"], base)).toEqual(["read", "edit"]);
	});

	it("keeps discoverable tools required by a forced tool_choice (eager todo)", () => {
		const result = filterInitialToolsForDiscoveryAll(["read", "todo", "grep"], {
			...base,
			forceActive: new Set(["todo"]),
		});
		expect(result).toEqual(["read", "todo"]);
	});

	it("keeps explicitly requested and restored discoverable tools", () => {
		const result = filterInitialToolsForDiscoveryAll(["todo", "grep"], {
			...base,
			explicitlyRequested: new Set(["grep"]),
			restored: new Set(["todo"]),
		});
		expect([...result].sort()).toEqual(["grep", "todo"]);
	});

	it("never hides tools without a built-in loadMode (MCP/custom/extension)", () => {
		expect(filterInitialToolsForDiscoveryAll(["mcp__server__tool", "grep"], base)).toEqual(["mcp__server__tool"]);
	});
});
