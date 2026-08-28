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

/** Tools that EDIT THE WORKSPACE, which is what separates work from investigation. is for: `scout` grants `read, grep, glob, web_search` and `reviewer` grants those plus `bash`, `lsp` */
export const WORKSPACE_WRITING_TOOL_NAMES = ["edit", "write", "ast_edit", "memory_edit", "manage_skill"] as const;

export type WorkspaceWritingToolName = (typeof WORKSPACE_WRITING_TOOL_NAMES)[number];

const WORKSPACE_WRITING_TOOL_SET: ReadonlySet<string> = new Set(WORKSPACE_WRITING_TOOL_NAMES);

/** Whether `name` is a tool that edits the workspace. Alias-tolerant via {@link normalizeToolNames}. */
export function isWorkspaceWritingTool(name: string): boolean {
	return WORKSPACE_WRITING_TOOL_SET.has(normalizeToolNames([name])[0] ?? name);
}

/** Tools that exist but are not offered by default: they are added by a caller that knows it needs them, or by a mode that turns one on. */
export const HIDDEN_TOOL_NAMES = ["yield", "report_finding", "report_tool_issue", "resolve", "goal"] as const;

export type HiddenToolName = (typeof HIDDEN_TOOL_NAMES)[number];

export type ToolNameLiteral = BuiltinToolName | HiddenToolName;

// Declared here and not beside `isWorkspaceWritingTool`, which is its only caller's neighbour, because
// it reads `HIDDEN_TOOL_NAMES` and a module-level `const` that names a `const` declared further down
// the file throws on import rather than resolving to it.
const KNOWN_TOOL_NAME_SET: ReadonlySet<string> = new Set<string>([...BUILTIN_TOOL_NAMES, ...HIDDEN_TOOL_NAMES]);

/** Whether this tool is one THIS BUILD ships, so something can be said about what it does. The complement is the interesting half: an MCP tool (`mcp__<server>__<tool>`) or a plugin-provided */
export function isKnownToolName(name: string): boolean {
	return KNOWN_TOOL_NAME_SET.has(normalizeToolNames([name])[0] ?? name);
}

/** Every tool name, as a named constant. compares one: `requestedTools.includes("yield")`, `name === "retain"`, `["grep", "glob"]`. A */
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
