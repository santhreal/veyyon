import type { Rule } from "./rule";

/**
 * ONE PLACE: the TTSR rule scope grammar — the `tool:<name>(<glob>)` /
 * `<name>(<glob>)` scope-token syntax and the rule-level glob list compile.
 * Shared by the live TTSR engine (export/ttsr.ts) and the offline scan CLI
 * (cli/ttsr-cli.ts) so both always agree on which rules apply to which
 * tools/paths.
 */

/** One parsed `scope:` token. `pathPattern` keeps the raw glob text for diagnostics. */
export interface ToolScopeToken {
	toolName?: string;
	pathPattern?: string;
	pathGlob?: Bun.Glob;
}

const TOOL_SCOPE_TOKEN_RE =
	/^(?:(?<prefix>tool)(?::(?<tool>[a-z0-9_-]+))?|(?<bare>[a-z0-9_-]+))(?:\((?<path>[^)]+)\))?$/i;

/** Parse a `tool` / `tool:<name>` / `<name>` scope token with an optional `(<glob>)` path filter. */
export function parseToolScopeToken(token: string): ToolScopeToken | undefined {
	const match = TOOL_SCOPE_TOKEN_RE.exec(token);
	if (!match) return undefined;
	const groups = match.groups;
	const hasToolPrefix = groups?.prefix !== undefined;
	const toolName = (groups?.tool ?? (hasToolPrefix ? undefined : groups?.bare))?.trim().toLowerCase();
	const pathPattern = groups?.path?.trim();
	if (!pathPattern) return { toolName };
	return { toolName, pathPattern, pathGlob: new Bun.Glob(pathPattern) };
}

/** Compile a rule's `globs:` list, dropping blanks; `undefined` when nothing survives. */
export function compileRulePathGlobs(globs: Rule["globs"]): Bun.Glob[] | undefined {
	if (!globs || globs.length === 0) return undefined;
	const compiled = globs
		.map(glob => glob.trim())
		.filter(glob => glob.length > 0)
		.map(glob => new Bun.Glob(glob));
	return compiled.length > 0 ? compiled : undefined;
}
