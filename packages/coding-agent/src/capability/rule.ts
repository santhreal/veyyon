/**
 * Rules Capability
 *
 * Project-specific rules from Cursor (.mdc), Windsurf (.md), and Cline formats.
 * Translated to a canonical shape regardless of source format.
 */

// The owner, not the `@veyyon/utils` barrel: 1 module against 81.
import { parseFrontmatter } from "@veyyon/utils/frontmatter";
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
	/** Transcript resets a `per-compact` rule waits out before firing again. */
	repeatCompactions?: number;
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
	/**
	 * Transcript resets a `per-compact` rule waits out before it may fire again.
	 *
	 * Defaults to 1, which is what `per-compact` meant on its own. A rule whose
	 * subject is a standing STATE rather than an event raises it: the condition is
	 * true again the instant the rule is re-armed, so the period is the only thing
	 * deciding how often the model hears it.
	 */
	repeatCompactions?: number;
	/**
	 * Which group this rule belongs to on screen.
	 *
	 * A bundled rule gets the directory it ships in; anything discovered has no
	 * directory of ours to read, so it is grouped by where it came from instead.
	 * Absent means ungrouped, which is a display fact and never a gating one.
	 */
	section?: string;
	/**
	 * Ships off until the operator names it in `ttsr.experimentalRules`.
	 *
	 * Set from the section rather than from frontmatter: a rule file cannot be
	 * allowed to declare itself stable while sitting in the experimental
	 * directory, and the directory is the thing a reviewer sees.
	 */
	experimental?: boolean;
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
	if (tokens.length === 0) {
		return undefined;
	}

	return Array.from(new Set(tokens));
}

function splitScopeTokens(value: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let parenDepth = 0;
	let bracketDepth = 0;
	let braceDepth = 0;
	let quote: '"' | "'" | undefined;
	for (let i = 0; i < value.length; i++) {
		const char = value[i];
		if (quote) {
			current += char;
			if (char === quote && value[i - 1] !== "\\") {
				quote = undefined;
			}
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			current += char;
			continue;
		}
		if (char === "(") {
			parenDepth++;
			current += char;
			continue;
		}
		if (char === ")") {
			parenDepth = Math.max(0, parenDepth - 1);
			current += char;
			continue;
		}
		if (char === "[") {
			bracketDepth++;
			current += char;
			continue;
		}
		if (char === "]") {
			bracketDepth = Math.max(0, bracketDepth - 1);
			current += char;
			continue;
		}
		if (char === "{") {
			braceDepth++;
			current += char;
			continue;
		}
		if (char === "}") {
			braceDepth = Math.max(0, braceDepth - 1);
			current += char;
			continue;
		}
		if (char === "," && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
			const token = current.trim();
			if (token.length > 0) {
				tokens.push(token);
			}
			current = "";
			continue;
		}
		current += char;
	}

	const tail = current.trim();
	if (tail.length > 0) {
		tokens.push(tail);
	}

	return tokens;
}

function normalizeScopeField(value: unknown): string[] | undefined {
	const normalized = normalizeRuleField(value);
	if (!normalized) {
		return undefined;
	}

	const tokens = normalized.flatMap(splitScopeTokens).filter(item => item.length > 0);
	if (tokens.length === 0) {
		return undefined;
	}
	return Array.from(new Set(tokens));
}

function isLikelyFileGlob(value: string): boolean {
	const token = value.trim();
	if (token.length === 0) {
		return false;
	}
	if (/[\\^$+|()]/.test(token)) {
		return false;
	}
	if (!/[?*[\]{}]/.test(token)) {
		return false;
	}
	if (token.includes("/")) {
		return true;
	}
	return /^\*\.[^\s/]+$/.test(token);
}

export function parseRuleConditionAndScope(
	frontmatter: RuleFrontmatter,
): Pick<Rule, "condition" | "astCondition" | "scope"> {
	const rawCondition = frontmatter.condition ?? frontmatter.ttsr_trigger ?? frontmatter.ttsrTrigger;
	const parsedCondition = normalizeRuleField(rawCondition);
	const astCondition = normalizeRuleField(frontmatter.astCondition);
	const parsedScope = normalizeScopeField(frontmatter.scope);

	const inferredScope: string[] = [];
	const condition: string[] = [];
	for (const token of parsedCondition ?? []) {
		if (isLikelyFileGlob(token)) {
			for (const toolName of CONDITION_GLOB_SCOPE_TOOLS) {
				inferredScope.push(`tool:${toolName}(${token})`);
			}
			continue;
		}
		condition.push(token);
	}

	if (condition.length === 0 && inferredScope.length > 0) {
		condition.push(".*");
	}

	const scope = [...(parsedScope ?? []), ...inferredScope];
	return {
		condition: condition.length > 0 ? Array.from(new Set(condition)) : undefined,
		astCondition,
		scope: scope.length > 0 ? Array.from(new Set(scope)) : undefined,
	};
}

let activeRules: readonly Rule[] = [];

export function getActiveRules(): readonly Rule[] {
	return activeRules;
}

export function setActiveRules(value: readonly Rule[]): void {
	activeRules = value;
}

export function resetActiveRulesForTests(): void {
	activeRules = [];
}

export function buildRuleFromMarkdown(
	name: string,
	content: string,
	filePath: string,
	_source: SourceMeta,
	options?: { stripNamePattern?: RegExp },
): Rule {
	const cleanName = options?.stripNamePattern ? name.replace(options.stripNamePattern, "") : name;
	// `parseFrontmatter` returns `{ frontmatter, body }` and is not generic; the
	// shape it is asked for is asserted here rather than at each of the eleven reads.
	const { frontmatter, body } = parseFrontmatter(content);
	const data = frontmatter as RuleFrontmatter;
	const { condition, astCondition, scope } = parseRuleConditionAndScope(data);
	const interruptMode =
		data.interruptMode === "never" ||
		data.interruptMode === "prose-only" ||
		data.interruptMode === "tool-only" ||
		data.interruptMode === "always"
			? data.interruptMode
			: undefined;
	const pathScope = data.pathScope === "outside-cwd" || data.pathScope === "inside-cwd" ? data.pathScope : undefined;
	const repeatMode =
		data.repeatMode === "once" || data.repeatMode === "after-gap" || data.repeatMode === "per-compact"
			? data.repeatMode
			: undefined;
	const repeatGap = typeof data.repeatGap === "number" && data.repeatGap > 0 ? data.repeatGap : undefined;
	const repeatCompactions =
		typeof data.repeatCompactions === "number" && data.repeatCompactions > 0 ? data.repeatCompactions : undefined;

	return {
		name: cleanName,
		path: filePath,
		content: body,
		globs: data.globs,
		alwaysApply: data.alwaysApply,
		description: data.description,
		condition,
		astCondition,
		scope,
		interruptMode,
		pathScope,
		repeatMode,
		repeatGap,
		repeatCompactions,
		_source,
	};
}

export const ruleCapability = defineCapability<Rule>({
	id: "rules",
	displayName: "Rules",
	description: "Project-specific rules and constraints (Cursor MDC, Windsurf, Cline formats)",
	key: rule => rule.name,
	toExtensionId: rule => `rule:${rule.name}`,
	validate: rule => {
		if (!rule.name) return "Missing rule name";
		if (!rule.path) return "Missing rule path";
		if (!rule.content || typeof rule.content !== "string") return "Rule must have content";
		return undefined;
	},
});
