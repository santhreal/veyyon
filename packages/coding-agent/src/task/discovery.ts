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

export interface DiscoveryResult {
	agents: AgentDefinition[];
	projectAgentsDir: string | null;
}

async function loadAgentsFromDir(dir: string, source: AgentSource): Promise<AgentDefinition[]> {
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

export async function discoverAgents(
	cwd: string,
	home: string = os.homedir(),
	agentDir?: string,
): Promise<DiscoveryResult> {
	const resolvedCwd = path.resolve(cwd);

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

	const extensionRoots = isProviderEnabled("veyyon-plugins")
		? await listVeyyonExtensionRoots({ cwd: resolvedCwd, home, repoRoot: null }, { agentDir })
		: [];
	for (const root of extensionRoots) {
		orderedDirs.push({ dir: path.join(root.path, "agents"), source: root.level });
	}

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

	return { agents: loadedAgents.concat(bundledAgents), projectAgentsDir: null };
}

export function getAgent(agents: readonly AgentDefinition[], name: string): AgentDefinition | undefined {
	const exact = agents.find(a => a.name === name);
	if (exact) return exact;
	const current = currentAgentName(name);
	return current === name ? undefined : agents.find(a => a.name === current);
}
