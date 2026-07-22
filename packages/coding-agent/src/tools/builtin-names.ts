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
