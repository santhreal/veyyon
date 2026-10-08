import * as fs from "node:fs";
import * as path from "node:path";
import { type SettingPath, Settings } from "../../src/config/settings";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { BUILTIN_TOOLS, HIDDEN_TOOLS, type Tool, type ToolSession } from "../../src/tools";

/** Every setting a built-in factory reads before it returns a tool, turned on. */
const EVERY_TOOL_ENABLED: Partial<Record<SettingPath, unknown>> = {
	"astEdit.enabled": true,
	"debug.enabled": true,
	"github.enabled": true,
	"lsp.enabled": true,
	"inspect_image.enabled": true,
	"web_search.enabled": true,
	"browser.enabled": true,
	"checkpoint.enabled": true,
	"todo.enabled": true,
	"goal.enabled": true,
	"memory.backend": "mnemopi",
	"autolearn.enabled": true,
	"argot.enabled": true,
	"tools.discoveryMode": "all",
};

/**
 * Calls every built-in and hidden factory and hands each tool it returns to `visit`; returns the
 * names that returned none. `dir` is the sweep's profile and working directory: `ssh` registers only
 * with a host in the profile's `ssh.json`, and `debug` only with an adapter in the working
 * directory's `dap.json`.
 */
export async function visitEveryFirstPartyTool(dir: string, visit: (tool: Tool) => void): Promise<string[]> {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "ssh.json"), JSON.stringify({ hosts: { probe: { host: "127.0.0.1" } } }));
	fs.writeFileSync(
		path.join(dir, "dap.json"),
		JSON.stringify({ adapters: { probe: { command: process.execPath, languages: ["javascript"] } } }),
	);
	const toolSession: ToolSession = {
		cwd: dir,
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: await Settings.loadIsolated({ cwd: dir, agentDir: dir, inMemory: true, overrides: EVERY_TOOL_ENABLED }),
		isToolDiscoveryEnabled: () => true,
		getSelectedDiscoveredToolNames: () => [],
		activateDiscoveredTools: async names => names,
		getArgotSession: () => ({ loaded: false }) as never,
		agentRegistry: new AgentRegistry(),
		getAgentId: () => "Main",
	};
	const unbuilt: string[] = [];
	for (const [name, factory] of Object.entries({ ...BUILTIN_TOOLS, ...HIDDEN_TOOLS })) {
		const tool = await factory(toolSession);
		if (tool) visit(tool);
		else unbuilt.push(name);
	}
	return unbuilt.sort();
}
