/**
 * Agents (standard) Provider
 *
 * Loads skills, rules, prompts, commands, and context files from .agent/ and
 * .agents/ directories at both user (~/) and project levels.
 * Project-level discovery walks up from cwd to repoRoot.
 */
import * as path from "node:path";
import { registerProvider } from "../capability";
import { type ContextFile, contextFileCapability } from "../capability/context-file";
import { type Prompt, promptCapability } from "../capability/prompt";
import { type Rule, ruleCapability } from "../capability/rule";
import { type Skill, skillCapability } from "../capability/skill";
import { type SlashCommand, slashCommandCapability } from "../capability/slash-command";
import type { LoadContext, LoadResult } from "../capability/types";
import {
	buildRuleFromMarkdown,
	calculateDepth,
	createSourceMeta,
	loadFilesFromDir,
	readContextFile,
	scanSkillsFromDir,
} from "./helpers";

const PROVIDER_ID = "agents";
const DISPLAY_NAME = "Agents (standard)";
const PRIORITY = 70;
const AGENT_DIR_CANDIDATES = [".agent", ".agents"] as const;

/** User-level paths: ~/.agent/<segments> and ~/.agents/<segments>. */
function getUserPathCandidates(ctx: LoadContext, ...segments: string[]): string[] {
	return AGENT_DIR_CANDIDATES.map(baseDir => path.join(ctx.home, baseDir, ...segments));
}

/**
 * Project-level paths: walk up from cwd to repoRoot, returning `.agent/<segments>`
 * and `.agents/<segments>` at each ancestor.
 *
 * The user home directory is skipped: `~/.agent[s]/` is by definition
 * user-level config and is already enumerated by {@link getUserPathCandidates}.
 * Without this guard, any cwd under `$HOME` (with no closer git repoRoot) would
 * walk up to home and yield duplicate project+user entries for the same
 * directory.
 */
export function getProjectPathCandidates(ctx: LoadContext, ...segments: string[]): string[] {
	const paths: string[] = [];
	let current = ctx.cwd;
	while (true) {
		if (current !== ctx.home) {
			for (const baseDir of AGENT_DIR_CANDIDATES) {
				paths.push(path.join(current, baseDir, ...segments));
			}
		}
		if (current === (ctx.repoRoot ?? ctx.home)) break;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return paths;
}

// Skills
async function loadSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	const projectScans = getProjectPathCandidates(ctx, "skills").map(dir =>
		scanSkillsFromDir({ dir, providerId: PROVIDER_ID, level: "project" }),
	);
	const userScans = getUserPathCandidates(ctx, "skills").map(dir =>
		scanSkillsFromDir({ dir, providerId: PROVIDER_ID, level: "user" }),
	);

	const results = await Promise.all([...projectScans, ...userScans]);

	return {
		items: results.flatMap(r => r.items),
		warnings: results.flatMap(r => r.warnings ?? []),
	};
}

registerProvider<Skill>(skillCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load skills from .agent/skills and .agents/skills (project walk-up + user home)",
	priority: PRIORITY,
	load: loadSkills,
});

// Rules
async function loadRules(ctx: LoadContext): Promise<LoadResult<Rule>> {
	const load = (dir: string, level: "user" | "project") =>
		loadFilesFromDir<Rule>(dir, PROVIDER_ID, level, {
			extensions: ["md", "mdc"],
			transform: (name, content, filePath, source) =>
				buildRuleFromMarkdown(name, content, filePath, source, { stripNamePattern: /\.(md|mdc)$/ }),
		});

	const results = await Promise.all([
		...getProjectPathCandidates(ctx, "rules").map(dir => load(dir, "project")),
		...getUserPathCandidates(ctx, "rules").map(dir => load(dir, "user")),
	]);

	return {
		items: results.flatMap(r => r.items),
		warnings: results.flatMap(r => r.warnings ?? []),
	};
}

registerProvider<Rule>(ruleCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load rules from .agent/rules and .agents/rules (project walk-up + user home)",
	priority: PRIORITY,
	load: loadRules,
});

// Prompts
async function loadPrompts(ctx: LoadContext): Promise<LoadResult<Prompt>> {
	const load = (dir: string, level: "user" | "project") =>
		loadFilesFromDir<Prompt>(dir, PROVIDER_ID, level, {
			extensions: ["md"],
			transform: (name, content, filePath, source) => ({
				name: name.replace(/\.md$/, ""),
				path: filePath,
				content,
				_source: source,
			}),
		});

	const results = await Promise.all([
		...getProjectPathCandidates(ctx, "prompts").map(dir => load(dir, "project")),
		...getUserPathCandidates(ctx, "prompts").map(dir => load(dir, "user")),
	]);

	return {
		items: results.flatMap(r => r.items),
		warnings: results.flatMap(r => r.warnings ?? []),
	};
}

registerProvider<Prompt>(promptCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load prompts from .agent/prompts and .agents/prompts (project walk-up + user home)",
	priority: PRIORITY,
	load: loadPrompts,
});

// Slash Commands
async function loadSlashCommands(ctx: LoadContext): Promise<LoadResult<SlashCommand>> {
	const load = (dir: string, level: "user" | "project") =>
		loadFilesFromDir<SlashCommand>(dir, PROVIDER_ID, level, {
			extensions: ["md"],
			transform: (name, content, filePath, source) => ({
				name: name.replace(/\.md$/, ""),
				path: filePath,
				content,
				level,
				_source: source,
			}),
		});

	const results = await Promise.all([
		...getProjectPathCandidates(ctx, "commands").map(dir => load(dir, "project")),
		...getUserPathCandidates(ctx, "commands").map(dir => load(dir, "user")),
	]);

	return {
		items: results.flatMap(r => r.items),
		warnings: results.flatMap(r => r.warnings ?? []),
	};
}

registerProvider<SlashCommand>(slashCommandCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load commands from .agent/commands and .agents/commands (project walk-up + user home)",
	priority: PRIORITY,
	load: loadSlashCommands,
});

/**
 * Load AGENTS.md from `.agent/` and `.agents/` directories.
 *
 * Scopes: PROJECT (walk up from cwd to the repo root) and a home-level layer
 * emitted as `level: "user"`.
 *
 * "user" here means `~/.agent[s]/AGENTS.md`, the tool-neutral home directory,
 * NOT veyyon's active profile. The `.agent`/`.agents` convention has no profile
 * concept at all, so there is nothing here to map onto the profile scope, and
 * GLOBAL scope does not apply either: veyyon's global layer is its own
 * `<globalConfigRoot>/AGENTS.md`, owned by the native provider.
 *
 * The two nonetheless share the capability's single home-level slot. That is
 * resolved by priority, not by accident: the native provider is priority 100
 * and this one is 70, so a real profile AGENTS.md always wins, and
 * `~/.agent[s]/AGENTS.md` is only consulted as a fallback by a user who
 * deliberately turned `discovery.importForeignConfig` on.
 */
async function loadContextFiles(ctx: LoadContext): Promise<LoadResult<ContextFile>> {
	const warnings: string[] = [];
	const load = async (filePath: string, level: "user" | "project"): Promise<ContextFile | null> => {
		const { content, warning } = await readContextFile(filePath);
		if (warning) warnings.push(warning);
		if (!content) return null;
		// filePath is <ancestor>/.agent(s)/AGENTS.md, so go up past the config dir to the ancestor
		const ancestorDir = path.dirname(path.dirname(filePath));
		const depth = level === "project" ? calculateDepth(ctx.cwd, ancestorDir, path.sep) : undefined;
		return { path: filePath, content, level, depth, _source: createSourceMeta(PROVIDER_ID, filePath, level) };
	};

	const results = await Promise.all([
		...getProjectPathCandidates(ctx, "AGENTS.md").map(p => load(p, "project")),
		...getUserPathCandidates(ctx, "AGENTS.md").map(p => load(p, "user")),
	]);

	return { items: results.filter((r): r is ContextFile => r !== null), warnings };
}

registerProvider<ContextFile>(contextFileCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load AGENTS.md from .agent and .agents (project walk-up + user home)",
	priority: PRIORITY,
	load: loadContextFiles,
});
