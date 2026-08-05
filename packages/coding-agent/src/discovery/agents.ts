/**
 * Agents (standard) Provider
 *
 * Loads skills, rules, prompts, commands, and context files from `~/.agent/`
 * and `~/.agents/`.
 *
 * There is no project scope. This provider used to walk up from cwd looking for
 * `.agent/` and `.agents/` at every ancestor, which made a cloned repository a
 * second directory vocabulary alongside `.veyyon` for installing rules,
 * commands, prompts and skills. A working tree contributes context files and
 * nothing else.
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

// Skills
async function loadSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	const results = await Promise.all(
		getUserPathCandidates(ctx, "skills").map(dir =>
			scanSkillsFromDir({ dir, providerId: PROVIDER_ID, level: "user" }),
		),
	);

	return {
		items: results.flatMap(r => r.items),
		warnings: results.flatMap(r => r.warnings ?? []),
	};
}

registerProvider<Skill>(skillCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load skills from ~/.agent/skills and ~/.agents/skills",
	priority: PRIORITY,
	load: loadSkills,
});

// Rules
async function loadRules(ctx: LoadContext): Promise<LoadResult<Rule>> {
	const results = await Promise.all(
		getUserPathCandidates(ctx, "rules").map(dir =>
			loadFilesFromDir<Rule>(dir, PROVIDER_ID, "user", {
				extensions: ["md", "mdc"],
				transform: (name, content, filePath, source) =>
					buildRuleFromMarkdown(name, content, filePath, source, { stripNamePattern: /\.(md|mdc)$/ }),
			}),
		),
	);

	return {
		items: results.flatMap(r => r.items),
		warnings: results.flatMap(r => r.warnings ?? []),
	};
}

registerProvider<Rule>(ruleCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load rules from ~/.agent/rules and ~/.agents/rules",
	priority: PRIORITY,
	load: loadRules,
});

// Prompts
async function loadPrompts(ctx: LoadContext): Promise<LoadResult<Prompt>> {
	const results = await Promise.all(
		getUserPathCandidates(ctx, "prompts").map(dir =>
			loadFilesFromDir<Prompt>(dir, PROVIDER_ID, "user", {
				extensions: ["md"],
				transform: (name, content, filePath, source) => ({
					name: name.replace(/\.md$/, ""),
					path: filePath,
					content,
					_source: source,
				}),
			}),
		),
	);

	return {
		items: results.flatMap(r => r.items),
		warnings: results.flatMap(r => r.warnings ?? []),
	};
}

registerProvider<Prompt>(promptCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load prompts from ~/.agent/prompts and ~/.agents/prompts",
	priority: PRIORITY,
	load: loadPrompts,
});

// Slash Commands
async function loadSlashCommands(ctx: LoadContext): Promise<LoadResult<SlashCommand>> {
	const results = await Promise.all(
		getUserPathCandidates(ctx, "commands").map(dir =>
			loadFilesFromDir<SlashCommand>(dir, PROVIDER_ID, "user", {
				extensions: ["md"],
				transform: (name, content, filePath, source) => ({
					name: name.replace(/\.md$/, ""),
					path: filePath,
					content,
					level: "user",
					_source: source,
				}),
			}),
		),
	);

	return {
		items: results.flatMap(r => r.items),
		warnings: results.flatMap(r => r.warnings ?? []),
	};
}

registerProvider<SlashCommand>(slashCommandCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load commands from ~/.agent/commands and ~/.agents/commands",
	priority: PRIORITY,
	load: loadSlashCommands,
});

/**
 * Load AGENTS.md from `~/.agent/` and `~/.agents/`.
 *
 * "user" here means the tool-neutral home directory, NOT veyyon's active
 * profile. The `.agent`/`.agents` convention has no profile concept at all, so
 * there is nothing here to map onto the profile scope, and GLOBAL scope does
 * not apply either: veyyon's global layer is its own
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
	const results = await Promise.all(
		getUserPathCandidates(ctx, "AGENTS.md").map(async (filePath): Promise<ContextFile | null> => {
			const { content, warning } = await readContextFile(filePath);
			if (warning) warnings.push(warning);
			if (!content) return null;
			return { path: filePath, content, level: "user", _source: createSourceMeta(PROVIDER_ID, filePath, "user") };
		}),
	);

	return { items: results.filter((r): r is ContextFile => r !== null), warnings };
}

registerProvider<ContextFile>(contextFileCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load AGENTS.md from ~/.agent and ~/.agents",
	priority: PRIORITY,
	load: loadContextFiles,
});
