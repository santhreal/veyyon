import { ARGOT_LOAD_TOOL, ARGOT_UNLOAD_TOOL } from "argot";

// The two Argot tool names come from the SDK constants (ONE PLACE): the tool
// classes name themselves from the same constants, so the registry key, the
// class `name`, and the preamble that teaches them can never drift.
export const BUILTIN_TOOL_NAMES = [
	"read",
	"bash",
	"launch",
	"edit",
	"ast_grep",
	"ast_edit",
	"ask",
	"debug",
	"eval",
	"ssh",
	"github",
	"glob",
	"grep",
	"lsp",
	"inspect_image",
	"browser",
	"checkpoint",
	"rewind",
	"task",
	"job",
	"irc",
	"todo",
	"web_search",
	"search_tool_bm25",
	"set_cwd",
	"write",
	"memory_edit",
	"retain",
	"recall",
	"reflect",
	"learn",
	"manage_skill",
	ARGOT_LOAD_TOOL,
	ARGOT_UNLOAD_TOOL,
] as const;

export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

/**
 * Tools that exist but are not offered by default: they are added by a caller that knows it needs
 * them, or by a mode that turns one on.
 *
 * Listed here rather than derived from `HIDDEN_TOOLS` in `tools/index.ts` because that registry maps
 * each name to a factory that dynamic-imports the tool module, and the whole point of that
 * indirection is that selecting tools does not load them. A name has to be nameable without paying
 * for the thing it names.
 */
export const HIDDEN_TOOL_NAMES = ["yield", "report_finding", "report_tool_issue", "resolve", "goal"] as const;

export type HiddenToolName = (typeof HIDDEN_TOOL_NAMES)[number];

export type ToolNameLiteral = BuiltinToolName | HiddenToolName;

/**
 * Every tool name, as a named constant.
 *
 * WHY THIS EXISTS. Tool names were bare string literals at every site that selects, appends or
 * compares one: `requestedTools.includes("yield")`, `name === "retain"`, `["grep", "glob"]`. A
 * rename kept compiling and quietly stopped matching, which is precisely how the `yield` handler
 * broke, and it is a class of failure no test catches by accident because the code still runs and
 * simply does less.
 *
 * Derived from the two lists above rather than written out a third time, so there is one place a
 * name is spelled. Renaming a tool removes the key, and every site that used it stops compiling,
 * which is the entire point: the compiler cannot notice a literal going stale, and it cannot miss a
 * property that is gone.
 *
 * `TOOL.grep` has the literal type `"grep"`, not `string`, so it still satisfies the places that
 * want a narrow union.
 */
export const TOOL = Object.fromEntries([...BUILTIN_TOOL_NAMES, ...HIDDEN_TOOL_NAMES].map(name => [name, name])) as {
	[K in ToolNameLiteral]: K;
};

const LEGACY_BUILTIN_TOOL_NAME_ALIASES: ReadonlyMap<string, BuiltinToolName> = new Map([
	["search", "grep"],
	["find", "glob"],
]);

/** Return the canonical tool name for current and legacy built-in tool IDs. */
export function normalizeToolName(name: string): string {
	const normalized = name.toLowerCase();
	return LEGACY_BUILTIN_TOOL_NAME_ALIASES.get(normalized) ?? normalized;
}

/** Normalize and deduplicate tool names while preserving first-seen order. */
export function normalizeToolNames(names: Iterable<string>): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const name of names) {
		const normalized = normalizeToolName(name);
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		out.push(normalized);
	}
	return out;
}
