/** Agent discovery from filesystem. Discovers agent definitions from veyyon-native task-agent roots: */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readdirIfPresent, reportFault } from "@veyyon/utils";
import { isProviderEnabled } from "../capability";
import { getConfigDirs } from "../config";
import { listClaudePluginRoots, pluginsRootFor } from "../discovery/helpers";
import { listVeyyonExtensionRoots } from "../discovery/veyyon-extension-roots";
import { loadBundledAgents, parseAgent } from "./agents";
import { currentAgentName } from "./spawn-policy";
import type { AgentDefinition, AgentSource } from "./types";

const TASK_AGENT_CONFIG_SOURCE = ".veyyon";

/** Result of agent discovery */
export interface DiscoveryResult {
	agents: AgentDefinition[];
	projectAgentsDir: string | null;
}

/**
 * Load agents from a directory.
 */
async function loadAgentsFromDir(dir: string, source: AgentSource): Promise<AgentDefinition[]> {
	// Agent directories are optional at every level (no `.veyyon/agents`, no project dir), so a MISSING one
	// contributes no agents and says nothing. One that exists and cannot be listed is a different thing --
	// the user's subagents disappear from `/agents` with no sign of why -- and the shared owner reports it.
	const entries = await readdirIfPresent(dir, "agent definitions");
	const files = entries
		.filter(entry => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md"))
		.sort((a, b) => a.name.localeCompare(b.name))
		.map(file => {
			const filePath = path.join(dir, file.name);
			return fs
				.readFile(filePath, "utf-8")
				.then(content => parseAgent(filePath, content, source, "warn"))
				.catch(error => {
					// A FILE that exists and cannot be read or parsed is the same loss as the directory case above, one agent at a time: the user wrote `.veyyon/agents/reviewer.md`, it is
					reportFault({
						source: "agents",
						text: `${filePath} could not be read as an agent definition, so that agent is not available in this run. Check its permissions and its YAML frontmatter, which must set both name and description.`,
						context: { filePath, error: String(error) },
					});
					return null;
				});
		});

	return (await Promise.all(files)).filter(Boolean) as AgentDefinition[];
}

/** Discover agents from filesystem and merge with bundled agents. Precedence (highest wins): project `.veyyon/agents`, user `.veyyon/agents`, */
export async function discoverAgents(
	cwd: string,
	home: string = os.homedir(),
	agentDir?: string,
): Promise<DiscoveryResult> {
	const resolvedCwd = path.resolve(cwd);

	// A subagent definition carries a system prompt, a tool allowlist, a model and a `spawns` field, so a repository that could supply one could SHADOW a
	const userDirs = agentDir
		? [{ path: path.resolve(agentDir, "agents"), source: TASK_AGENT_CONFIG_SOURCE, level: "user" as const }]
		: getConfigDirs("agents", { project: false })
				.filter(entry => entry.source === TASK_AGENT_CONFIG_SOURCE)
				.map(entry => ({
					...entry,
					path: path.resolve(entry.path),
				}));

	const orderedDirs: Array<{ dir: string; source: AgentSource }> = [];
	const user = userDirs[0];
	if (user) orderedDirs.push({ dir: user.path, source: "user" });

	// veyyon extension-package agents/ dirs. `listVeyyonExtensionRoots` returns roots in source-precedence order (CLI > user `extensions:` settings > installed npm/link
	const extensionRoots = isProviderEnabled("veyyon-plugins")
		? await listVeyyonExtensionRoots({ cwd: resolvedCwd, home, repoRoot: null }, { agentDir })
		: [];
	for (const root of extensionRoots) {
		orderedDirs.push({ dir: path.join(root.path, "agents"), source: root.level });
	}

	// Load agents from Claude Code marketplace plugins (respects disabledProviders). The registry is profile-scoped, so a named agent dir reads THAT profile's
	const { roots: pluginRoots } = isProviderEnabled("claude-plugins")
		? await listClaudePluginRoots(home, resolvedCwd, agentDir ? pluginsRootFor(agentDir) : undefined, agentDir)
		: { roots: [] };
	for (const plugin of pluginRoots.filter(root => root.scope !== "project")) {
		orderedDirs.push({ dir: path.join(plugin.path, "agents"), source: "user" });
	}

	const seen = new Set<string>();
	const loadedAgents = (await Promise.all(orderedDirs.map(({ dir, source }) => loadAgentsFromDir(dir, source))))
		.flat()
		.filter(agent => {
			if (seen.has(agent.name)) return false;
			seen.add(agent.name);
			return true;
		});

	const bundledAgents = loadBundledAgents().filter(agent => {
		if (seen.has(agent.name)) return false;
		seen.add(agent.name);
		return true;
	});

	// Always null: there is no project agents dir any more. The field stays on
	// `DiscoveryResult` because ~30 call sites in `task/index.ts` plumb it into
	// `TaskToolDetails` for display; retiring it is a separate mechanical pass.
	return { agents: loadedAgents.concat(bundledAgents), projectAgentsDir: null };
}

/** Get an agent by name from discovered agents. A literal match wins, so a user who writes their own `task.md` gets their own */
export function getAgent(agents: readonly AgentDefinition[], name: string): AgentDefinition | undefined {
	const exact = agents.find(a => a.name === name);
	if (exact) return exact;
	const current = currentAgentName(name);
	return current === name ? undefined : agents.find(a => a.name === current);
}
