/**
 * Rules Capability
 *
 * Project-specific rules from Cursor (.mdc), Windsurf (.md), and Cline formats.
 * Translated to a canonical shape regardless of source format.
 */
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

const CONDITION_GLOB_SCOPE_TOOLS = ["edit", "write"] as const;

/**
 * Provider id for the bundled default rules shipped with the agent.
 * Lowest priority, so any user/project/tool rule of the same name overrides
 * a bundled default. Also used to gate the whole bundled set via
 * `ttsr.builtinRules`.
 */
export const BUILTIN_DEFAULTS_PROVIDER_ID = "builtin-defaults";

/**
 * Parsed frontmatter from rule files.
 */
export interface RuleFrontmatter {
	description?: string;
	globs?: string[];
	alwaysApply?: boolean;
	/** New key for TTSR match conditions. */
	condition?: string | string[];
	/** TTSR match condition(s) expressed as ast-grep patterns (edit/write streams only). */
	astCondition?: string | string[];
	/** New key for TTSR stream scope. */
	scope?: string | string[];
	/** Per-rule TTSR interrupt mode override. */
	interruptMode?: "never" | "prose-only" | "tool-only" | "always";
	/** Restrict matching to paths outside / inside the session working directory. */
	pathScope?: "outside-cwd" | "inside-cwd";
	/** Per-rule repeat policy, overriding `ttsr.repeatMode`. */
	repeatMode?: "once" | "after-gap" | "per-compact";
	/** Messages before this rule may fire again, overriding `ttsr.repeatGap`. */
	repeatGap?: number;
	[key: string]: unknown;
}

/**
 * A rule providing project-specific guidance and constraints.
 */
export interface Rule {
	/** Rule name (derived from filename) */
	name: string;
	/** Absolute path to rule file */
	path: string;
	/** Rule content (after frontmatter stripped) */
	content: string;
	/** Globs this rule applies to (if any) */
	globs?: string[];
	/** Whether to always include this rule */
	alwaysApply?: boolean;
	/** Description (for agent-requested rules) */
	description?: string;
	/** Regex condition(s) that can trigger TTSR interruption. */
	condition?: string[];
	/** ast-grep pattern condition(s) that can trigger TTSR interruption (edit/write streams only). */
	astCondition?: string[];
	/** Optional stream scope tokens (for example: text, thinking, tool:edit(*.ts)). */
	scope?: string[];
	/** Per-rule TTSR interrupt mode override (falls back to global ttsr.interruptMode). */
	interruptMode?: "never" | "prose-only" | "tool-only" | "always";
	/**
	 * Require the text the condition matched to name a path outside (or inside) the session
	 * working directory.
	 *
	 * A regex cannot know the working directory, so a rule whose whole point is "this path is
	 * somewhere else" fires just as happily on a path inside the project — which is what made
	 * `cwd-reroot` advise re-rooting to the directory the session was already in. The check runs
	 * against the live working directory at match time, so it stays right after a `set_cwd`.
	 */
	pathScope?: "outside-cwd" | "inside-cwd";
	/**
	 * Per-rule repeat policy, overriding the global `ttsr.repeatMode`.
	 *
	 * The global default retires a rule after one injection per session, which suits a rule stating
	 * a convention and not one whose advice applies again to a different directory or file. A rule
	 * author knows which kind theirs is; the global setting is a preference about noise.
	 */
	repeatMode?: "once" | "after-gap" | "per-compact";
	/** Messages before this rule may fire again, overriding the global `ttsr.repeatGap`. */
	repeatGap?: number;
	/** Source metadata */
	_source: SourceMeta;
}

function normalizeRuleField(value: unknown): string[] | undefined {
	if (typeof value === "string") {
		const token = value.trim();
		return token.length > 0 ? [token] : undefined;
	}
	if (!Array.isArray(value)) {
		return undefined;
	}

	const tokens = value
		.filter((item): item is string => typeof item === "string")
		.map(item => item.trim())
		.filter(item => item.length > 0);
	return tokens.length > 0 ? tokens : undefined;
}

export function buildRuleFromMarkdown(
	name: string,
	content: string,
	filePath: string,
	_source: SourceMeta,
	options?: { stripNamePattern?: RegExp },
): Rule {
	const cleanName = options?.stripNamePattern ? name.replace(options.stripNamePattern, "") : name;
	const parsed = parseFrontmatter<RuleFrontmatter>(content);
	const interruptMode =
		parsed.data.interruptMode === "never" ||
		parsed.data.interruptMode === "prose-only" ||
		parsed.data.interruptMode === "tool-only" ||
		parsed.data.interruptMode === "always"
			? parsed.data.interruptMode
			: undefined;
	const pathScope =
		parsed.data.pathScope === "outside-cwd" || parsed.data.pathScope === "inside-cwd"
			? parsed.data.pathScope
			: undefined;
	const repeatMode =
		parsed.data.repeatMode === "once" || parsed.data.repeatMode === "after-gap" || parsed.data.repeatMode === "per-compact"
			? parsed.data.repeatMode
			: undefined;
	const repeatGap = typeof parsed.data.repeatGap === "number" && parsed.data.repeatGap > 0 ? parsed.data.repeatGap : undefined;

	return {
		name: cleanName,
		path: filePath,
		content: parsed.content,
		globs: parsed.data.globs,
		alwaysApply: parsed.data.alwaysApply,
		description: parsed.data.description,
		condition: normalizeRuleField(parsed.data.condition),
		astCondition: normalizeRuleField(parsed.data.astCondition),
		scope: normalizeRuleField(parsed.data.scope),
		interruptMode,
		pathScope,
		repeatMode,
		repeatGap,
		_source,
	};
}
