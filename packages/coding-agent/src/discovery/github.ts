/**
 * GitHub Copilot Provider
 *
 * Loads configuration from GitHub Copilot's config directories.
 * Priority: 30 (shared standard provider)
 *
 * Sources:
 * - Project: .github/ (repo-local Copilot config)
 * - User: ~/.copilot/ (user-global Copilot CLI config; relocatable via COPILOT_HOME)
 * - Extra: directories listed in COPILOT_CUSTOM_INSTRUCTIONS_DIRS
 *
 * Capabilities:
 * - context-files: copilot-instructions.md in .github/ and ~/.copilot/; AGENTS.md in each COPILOT_CUSTOM_INSTRUCTIONS_DIRS
 * - rules: *.instructions.md under .github/instructions/ and <dir>/.github/instructions/ for each custom dir (applyTo frontmatter)
 * - prompts: *.prompt.md in .github/prompts/ (VS Code Copilot prompt files)
 * - skills: <name>/SKILL.md in .github/skills/ (GitHub Agent Skills layout)
 */
import * as path from "node:path";
import { parseFrontmatter } from "@veyyon/utils";
import { registerProvider } from "../capability";
import { type ContextFile, contextFileCapability } from "../capability/context-file";
import { type Instruction, instructionCapability } from "../capability/instruction";
import type { Prompt } from "../capability/prompt";
import { type Rule, ruleCapability } from "../capability/rule";
import type { LoadContext, LoadResult, SourceMeta } from "../capability/types";

import {
	buildRuleFromMarkdown,
	createSourceMeta,
	loadFilesFromDir,
	parseCSV,
	readContextFile,
	resolveCopilotHome,
} from "./helpers";

const PROVIDER_ID = "github";
const DISPLAY_NAME = "GitHub Copilot";
const PRIORITY = 30;

// =============================================================================
// Context Files
// =============================================================================

/**
 * Load GitHub Copilot context files.
 *
 * Scopes: PROJECT (`<cwd>/.github/copilot-instructions.md`) and a home-level
 * layer emitted as `level: "user"` (`<copilotHome>/copilot-instructions.md`
 * plus an `AGENTS.md` from each `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` entry).
 *
 * GLOBAL and PROFILE scope do not apply. Copilot has no profile concept, so
 * there is no per-profile file to read, and veyyon's global layer
 * (`<globalConfigRoot>/AGENTS.md`) belongs to the native provider. The
 * home-level entries share veyyon's single home slot with the active profile's
 * AGENTS.md and lose to it on priority (native 100 against 30).
 */
async function loadContextFiles(ctx: LoadContext): Promise<LoadResult<ContextFile>> {
	const items: ContextFile[] = [];
	const warnings: string[] = [];

	// User-global instructions (~/.copilot/copilot-instructions.md), applied across all repos.
	const userInstructionsPath = path.join(resolveCopilotHome(ctx.home), "copilot-instructions.md");
	const user = await readContextFile(userInstructionsPath);
	if (user.warning) warnings.push(user.warning);
	if (user.content) {
		items.push({
			path: userInstructionsPath,
			content: user.content,
			level: "user",
			_source: createSourceMeta(PROVIDER_ID, userInstructionsPath, "user"),
		});
	}

	// Each COPILOT_CUSTOM_INSTRUCTIONS_DIRS entry contributes an AGENTS.md (Copilot CLI
	// searches these dirs for AGENTS.md + .github/instructions/**; the latter is handled
	// by loadInstructions). copilot-instructions.md is NOT part of the custom-dir spec.
	for (const dir of copilotCustomInstructionDirs()) {
		const agentsMdPath = path.join(dir, "AGENTS.md");
		const { content, warning } = await readContextFile(agentsMdPath);
		if (warning) warnings.push(warning);
		if (content) {
			items.push({
				path: agentsMdPath,
				content,
				level: "user",
				_source: createSourceMeta(PROVIDER_ID, agentsMdPath, "user"),
			});
		}
	}
	return { items, warnings };
}

// =============================================================================
// Instructions
// =============================================================================

async function loadInstructions(_ctx: LoadContext): Promise<LoadResult<Instruction>> {
	const items: Instruction[] = [];
	const warnings: string[] = [];

	// Each COPILOT_CUSTOM_INSTRUCTIONS_DIRS entry contributes <dir>/.github/instructions/**/*.instructions.md.
	for (const dir of copilotCustomInstructionDirs()) {
		const customInstructionsDir = path.join(dir, ".github", "instructions");
		const result = await loadFilesFromDir<Instruction>(customInstructionsDir, PROVIDER_ID, "user", {
			extensions: ["md"],
			transform: transformInstruction,
			recursive: true,
		});
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	return { items, warnings };
}

function transformInstruction(name: string, content: string, filePath: string, source: SourceMeta): Instruction | null {
	// Only process .instructions.md files
	if (!name.endsWith(".instructions.md")) {
		return null;
	}

	const { frontmatter, body } = parseFrontmatter(content, { source: filePath });

	// Extract applyTo glob pattern from frontmatter
	const applyTo = typeof frontmatter.applyTo === "string" ? frontmatter.applyTo : undefined;

	// Derive name from filename (strip .instructions.md suffix)
	const instructionName = path.basename(name, ".instructions.md");

	return {
		name: instructionName,
		path: filePath,
		content: body,
		applyTo,
		_source: source,
	};
}

// =============================================================================
// Rules
// =============================================================================

async function loadRules(_ctx: LoadContext): Promise<LoadResult<Rule>> {
	const items: Rule[] = [];
	const warnings: string[] = [];

	const load = async (dir: string, level: "user") => {
		const applyToWarnings: string[] = [];
		const result = await loadFilesFromDir<Rule>(dir, PROVIDER_ID, level, {
			extensions: ["md"],
			transform: (name, content, filePath, source) =>
				transformInstructionRule(name, content, filePath, source, applyToWarnings),
			recursive: true,
		});
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
		warnings.push(...applyToWarnings);
	};

	for (const dir of copilotCustomInstructionDirs()) {
		await load(path.join(dir, ".github", "instructions"), "user");
	}

	return { items, warnings };
}

function transformInstructionRule(
	name: string,
	content: string,
	filePath: string,
	source: SourceMeta,
	warnings: string[],
): Rule | null {
	if (!name.endsWith(".instructions.md")) {
		return null;
	}

	const { frontmatter } = parseFrontmatter(content, { source: filePath });
	const applyToGlobs = normalizeApplyToGlobs(frontmatter.applyTo);
	if (!applyToGlobs) {
		warnings.push(`Missing applyTo in ${filePath}; loaded without GitHub glob scoping.`);
	}

	const rule = buildRuleFromMarkdown(name, content, filePath, source, {
		stripNamePattern: /\.instructions\.md$/,
	});
	if (applyToGlobs?.some(isAlwaysApplyGlob)) {
		return { ...rule, alwaysApply: true, globs: undefined };
	}

	const description = rule.description ?? describeInstructionRule(applyToGlobs);
	return { ...rule, alwaysApply: false, globs: applyToGlobs, description };
}

function normalizeApplyToGlobs(value: unknown): string[] | undefined {
	// GitHub documents applyTo as a single comma-separated string (e.g.
	// "**/*.ts,**/*.tsx"); also tolerate a YAML array of such strings.
	const raw = Array.isArray(value) ? value : [value];
	const globs = raw.flatMap(item => (typeof item === "string" ? parseCSV(item) : []));
	return globs.length > 0 ? globs : undefined;
}

function isAlwaysApplyGlob(glob: string): boolean {
	// GitHub treats "*", "**", and "**/*" as matching every file.
	return glob === "*" || glob === "**" || glob === "**/*";
}

function describeInstructionRule(globs: string[] | undefined): string {
	if (!globs) return "GitHub Copilot instructions without applyTo metadata";
	return `GitHub Copilot instructions for ${globs.join(", ")}`;
}

// =============================================================================

function transformPrompt(name: string, content: string, filePath: string, source: SourceMeta): Prompt | null {
	// Prompt files are `*.prompt.md`; ignore other markdown that may share the dir.
	if (!name.endsWith(".prompt.md")) return null;

	const { frontmatter, body } = parseFrontmatter(content, { source: filePath });
	const promptName =
		typeof frontmatter.name === "string" && frontmatter.name ? frontmatter.name : path.basename(name, ".prompt.md");

	return { name: promptName, path: filePath, content: body, _source: source };
}

/** Directories listed in the COPILOT_CUSTOM_INSTRUCTIONS_DIRS env var (comma-separated). */
function copilotCustomInstructionDirs(): string[] {
	const raw = process.env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS;
	return raw ? parseCSV(raw) : [];
}

// =============================================================================
// Provider Registration
// =============================================================================

registerProvider(contextFileCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description:
		"Load copilot-instructions.md from .github/ and ~/.copilot/; AGENTS.md from COPILOT_CUSTOM_INSTRUCTIONS_DIRS",
	priority: PRIORITY,
	load: loadContextFiles,
});

registerProvider(instructionCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load *.instructions.md from .github/instructions/ and COPILOT_CUSTOM_INSTRUCTIONS_DIRS",
	priority: PRIORITY,
	load: loadInstructions,
});

registerProvider<Rule>(ruleCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load *.instructions.md from .github/instructions/ as Copilot-scoped rules",
	priority: PRIORITY,
	load: loadRules,
});
