import { ARGOT_LOAD_TOOL, ARGOT_UNLOAD_TOOL } from "argot/constants";

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

export const WORKSPACE_WRITING_TOOL_NAMES = ["edit", "write", "ast_edit", "memory_edit", "manage_skill"] as const;

export const HIDDEN_TOOL_NAMES = ["yield", "report_finding", "report_tool_issue", "resolve", "goal"] as const;

export type HiddenToolName = (typeof HIDDEN_TOOL_NAMES)[number];

export type ToolNameLiteral = BuiltinToolName | HiddenToolName;

const KNOWN_TOOL_NAME_SET: ReadonlySet<string> = new Set<string>([...BUILTIN_TOOL_NAMES, ...HIDDEN_TOOL_NAMES]);

export function isKnownToolName(name: string): boolean {
	return KNOWN_TOOL_NAME_SET.has(normalizeToolNames([name])[0] ?? name);
}

export const TOOL = Object.fromEntries([...BUILTIN_TOOL_NAMES, ...HIDDEN_TOOL_NAMES].map(name => [name, name])) as {
	[K in ToolNameLiteral]: K;
};

const LEGACY_BUILTIN_TOOL_NAME_ALIASES: ReadonlyMap<string, BuiltinToolName> = new Map([
	["search", "grep"],
	["find", "glob"],
]);

export function normalizeToolName(name: string): string {
	const normalized = name.toLowerCase();
	return LEGACY_BUILTIN_TOOL_NAME_ALIASES.get(normalized) ?? normalized;
}

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
