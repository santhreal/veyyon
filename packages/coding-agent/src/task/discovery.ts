/**
 * Subagent discovery from filesystem.
 *
 * Discovers subagent definitions from veyyon-native roots:
 *   - `~/.veyyon/subagents/*.md` — user-authored, read by EVERY profile.
 *   - `<ext>/agents/*.md` for every veyyon extension package wired through
 *     `listVeyyonExtensionRoots` (CLI `--extension` roots, `extensions:` in
 *     settings, and enabled npm/link plugins under `<plugins>/node_modules/`).
 *     Mirrors the same sub-discovery convention applied to `skills/`,
 *     `hooks/`, `tools/`, etc. by `discovery/veyyon-plugins.ts`, and keeps the
 *     `agents/` spelling because that one is a published contract with plugin
 *     authors rather than a path the operator types.
 *
 * DISCOVERY IS GLOBAL, ENABLING IS PER-PROFILE. The definitions dir hangs off
 * the base config root ({@link getGlobalSubagentsDir}), not off the active
 * profile's agent dir, so an agent is authored once and every profile sees it;
 * `subagent.agents.<name>.enabled` is the per-profile answer to whether the
 * model may spawn it. The previous location was `<agentDir>/agents/`, which
 * made the same definition profile-private and spelled `agent/agents/` — two
 * unrelated meanings one path segment apart, inside the directory that also
 * holds `profiles/`.
 *
 * There is no project-level scope. A repository that could supply a definition
 * could SHADOW a bundled agent by name — its `reviewer` became the reviewer,
 * and first-run onboarding then offered that role as an ordinary row and wrote
 * it enabled into the operator's own config.
 *
 * Claude Code marketplace plugin agents are discovered separately via the
 * claude-plugins provider. Direct cross-harness roots such as .claude/agents
 * are intentionally skipped because their frontmatter schema is not the veyyon
 * task-agent contract.
 *
 * Agent files use markdown with YAML frontmatter.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getGlobalSubagentsDir, readdirIfPresent, reportFault } from "@veyyon/utils";
import { isProviderEnabled } from "../discovery/capability";
import { listClaudePluginRoots, pluginsRootFor } from "../discovery/helpers";
import { listVeyyonExtensionRoots } from "../discovery/veyyon-extension-roots";
import { isKnownToolName } from "../tools/builtin-names";
import { loadBundledAgents, parseAgent } from "./agents";
import { currentAgentName } from "./spawn-policy";
import type { AgentDefinition, AgentSource } from "./types";

/** Result of agent discovery */
export interface DiscoveryResult {
	agents: AgentDefinition[];
	projectAgentsDir: string | null;
}

/**
 * Names in a definition's `tools:` list that match no built-in and carry no
 * third-party namespace, i.e. almost certainly typos.
 *
 * They cannot simply be dropped: a subagent may legitimately be granted an MCP
 * proxy tool (`mcp__<server>__<tool>`) or a custom tool loaded from an
 * extension, and neither is a built-in name this process can enumerate at parse
 * time. So the rule is narrow — a bare, unnamespaced name that is not a
 * built-in — and the outcome is a report rather than a removal.
 *
 * Silence here is what made a typo invisible: `tools: [reed, serch]` normalizes
 * to two names that resolve to nothing, so the agent runs with no tools AND the
 * tool-gated statements drop out of its system prompt, which reads exactly like
 * a working agent that decided to do nothing.
 */
function unrecognizedToolNames(agent: AgentDefinition): string[] {
	return (agent.tools ?? []).filter(name => !isKnownToolName(name) && !name.includes("__"));
}

/**
 * Load agents from a directory.
 */
async function loadAgentsFromDir(dir: string, source: AgentSource): Promise<AgentDefinition[]> {
	// Subagent directories are optional (no `~/.veyyon/subagents`, no extension roots), so a MISSING one
	// contributes no agents and says nothing. One that exists and cannot be listed is a different thing --
	// the user's subagents disappear from `/agents` with no sign of why -- and the shared owner reports it.
	const entries = await readdirIfPresent(dir, "subagent definitions");
	const files = entries
		.filter(entry => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md"))
		.sort((a, b) => a.name.localeCompare(b.name))
		.map(file => {
			const filePath = path.join(dir, file.name);
			return fs
				.readFile(filePath, "utf-8")
				.then(content => {
					const agent = parseAgent(filePath, content, source, "warn");
					if (agent) {
						const unknown = unrecognizedToolNames(agent);
						if (unknown.length > 0) {
							reportFault({
								source: "agents",
								text: `${filePath} lists ${unknown.length === 1 ? "a tool" : "tools"} veyyon does not recognize (${unknown.join(", ")}), so ${unknown.length === 1 ? "it grants" : "they grant"} nothing and the matching guidance is left out of the agent's system prompt. Check the spelling against the built-in tool names, or namespace a third-party tool as mcp__<server>__<tool>.`,
								context: { filePath, tools: unknown },
							});
						}
					}
					return agent;
				})
				.catch(error => {
					// A FILE that exists and cannot be read or parsed is the same loss as the directory
					// case above, one agent at a time: the user wrote `.veyyon/agents/reviewer.md`, it is
					// absent from `/agents` and from `task`, and the run reports nothing. This used to be
					// a `logger.warn`, which the default transport set writes to a file and nowhere else
					// (see `utils/fault-sink.ts`), so the sibling failure five lines up reached an
					// operator and this one did not. Still soft: the remaining agents load.
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

/**
 * Discover agents from filesystem and merge with bundled agents.
 * Precedence (highest wins): project `.veyyon/agents`, user `.veyyon/agents`,
 * veyyon extension-package agents in `listVeyyonExtensionRoots` source order
 * (CLI roots > project `extensions:` settings > user `extensions:` settings >
 * installed npm/link plugins), Claude marketplace plugin agents (project
 * scope before user), then bundled.
 *
 * THREE of those sources are PROFILE scoped, and `agentDir` selects the profile for
 * all three at once: the user `agents/` dir, the user `extensions:` settings plus that
 * profile's installed plugins, and that profile's marketplace registry. Leave it
 * undefined and each source resolves the process-active profile exactly as before.
 *
 * Why this matters more than the sibling skill and rule leaks: an agent definition
 * carries a system prompt and a tool list, so reading another profile's marketplace
 * silently changes what a spawned agent IS and what it is allowed to do.
 *
 * `undefined` is the honest default and not a fallback dressed up as one: `ToolSession`
 * carries no agent dir today, so the tool-side callers (`task`, `eval`, `vibe`, the
 * settings selector, the setup wizard) have no session value to pass and the active
 * profile is the only answer available to them. A caller that DOES know the profile it
 * is loading for (an SDK host built with an explicit `agentDir`, anything routing for
 * another profile) must pass it, and the moment `ToolSession` grows the field the
 * tool-side callers must pass it too.
 *
 * @param cwd - Current working directory, for extension and marketplace scopes
 * @param home - Home directory for user-scope resolution
 * @param agentDir - Profile agent dir whose extension and marketplace scopes load
 */
export async function discoverAgents(
	cwd: string,
	home: string = os.homedir(),
	agentDir?: string,
): Promise<DiscoveryResult> {
	const resolvedCwd = path.resolve(cwd);

	// The user-authored definitions dir is GLOBAL and therefore does not consult
	// `agentDir`: switching profile changes which agents are ENABLED, never which
	// ones exist. `getGlobalSubagentsDir()` reads the base config root, so
	// `VEYYON_CONFIG_DIR` still isolates it — that is the seam the suites use.
	const orderedDirs: Array<{ dir: string; source: AgentSource }> = [{ dir: getGlobalSubagentsDir(), source: "user" }];

	// veyyon extension-package agents/ dirs. `listVeyyonExtensionRoots` returns roots in
	// source-precedence order (CLI > user `extensions:` settings > installed npm/link
	// plugins, with marketplace installs already excluded by realpath) — consume that
	// order verbatim so the `task` agent surface dedups identically to the sibling
	// skills/hooks/tools surface in `discovery/veyyon-plugins.ts`. Gate on
	// `veyyon-plugins` so disabledProviders suppresses the whole extension-package
	// surface.
	const extensionRoots = isProviderEnabled("veyyon-plugins")
		? await listVeyyonExtensionRoots({ cwd: resolvedCwd, home, repoRoot: null }, { agentDir })
		: [];
	for (const root of extensionRoots) {
		orderedDirs.push({ dir: path.join(root.path, "agents"), source: root.level });
	}

	// Load agents from Claude Code marketplace plugins (respects disabledProviders).
	// The registry is profile-scoped, so a named agent dir reads THAT profile's
	// installs. Reading the active profile's here handed a spawned agent whichever
	// system prompt and tool list the booted profile's marketplace happened to ship.
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
	return { agents: [...loadedAgents, ...bundledAgents], projectAgentsDir: null };
}

/**
 * Get an agent by name from discovered agents.
 *
 * A literal match wins, so a user who writes their own `task.md` gets their own
 * agent. Only when nothing matches does a retired name fall through to the one
 * that replaced it, which is what keeps an old `agent: "task"` working.
 */
export function getAgent(agents: readonly AgentDefinition[], name: string): AgentDefinition | undefined {
	const exact = agents.find(a => a.name === name);
	if (exact) return exact;
	const current = currentAgentName(name);
	return current === name ? undefined : agents.find(a => a.name === current);
}
