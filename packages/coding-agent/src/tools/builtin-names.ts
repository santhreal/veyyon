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
 * Tools that EDIT THE WORKSPACE, which is what separates work from investigation.
 *
 * WHY THIS LIST AND NOT ANOTHER. An agent's tool grant is the honest statement of what kind of work it
 * is for: `scout` grants `read, grep, glob, web_search` and `reviewer` grants those plus `bash`, `lsp`
 * and `ast_grep`, and neither can change a file. `task`, `sonic` and `designer` restrict nothing and
 * are expected to edit. So "may this agent write to the tree" derives the investigative/executing
 * distinction from data the agent already declares, rather than from a hardcoded roster of names that
 * a user-authored agent could never join.
 *
 * `bash` IS DELIBERATELY ABSENT, and it is the entry that decides whether this list is useful. `bash`
 * can obviously write, so a "can it possibly mutate" reading would put it in and then classify
 * `reviewer` and `librarian` as executing agents, which is the opposite of what they are: both grant
 * `bash` to RUN things while reading, an lsp query or a grep or a test. This predicate answers what an
 * agent is FOR, as declared by its file-editing grant. It is not a security boundary and must never be
 * used as one; that is what the sandbox is for.
 *
 * NOT the same question as `MID_RUN_TODO_NUDGE_MUTATING_TOOLS` in `session/agent-session.ts`, which
 * counts what has LANDED as work and therefore does include `bash`. Two lists because there are two
 * questions; each is named for its own, and neither is a copy of the other.
 *
 * `rewind` IS ABSENT FOR A DIFFERENT REASON THAN `bash`, and it is worth stating so the next reader
 * does not add it. It restores the workspace to a checkpoint, so it plainly writes; but `RewindTool`
 * and `CheckpointTool` both `createIf` only for a top-level session (`tools/checkpoint.ts:73,119`), so
 * a SUBAGENT cannot receive either one however its `tools:` line reads. Putting it here would classify
 * an agent by a grant that never takes effect.
 */
export const WORKSPACE_WRITING_TOOL_NAMES = ["edit", "write", "ast_edit", "memory_edit", "manage_skill"] as const;

export type WorkspaceWritingToolName = (typeof WORKSPACE_WRITING_TOOL_NAMES)[number];

const WORKSPACE_WRITING_TOOL_SET: ReadonlySet<string> = new Set(WORKSPACE_WRITING_TOOL_NAMES);

/** Whether `name` is a tool that edits the workspace. Alias-tolerant via {@link normalizeToolNames}. */
export function isWorkspaceWritingTool(name: string): boolean {
	return WORKSPACE_WRITING_TOOL_SET.has(normalizeToolNames([name])[0] ?? name);
}

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

// Declared here and not beside `isWorkspaceWritingTool`, which is its only caller's neighbour, because
// it reads `HIDDEN_TOOL_NAMES` and a module-level `const` that names a `const` declared further down
// the file throws on import rather than resolving to it.
const KNOWN_TOOL_NAME_SET: ReadonlySet<string> = new Set<string>([...BUILTIN_TOOL_NAMES, ...HIDDEN_TOOL_NAMES]);

/**
 * Whether this tool is one THIS BUILD ships, so something can be said about what it does.
 *
 * The complement is the interesting half: an MCP tool (`mcp__<server>__<tool>`) or a plugin-provided
 * tool is a name whose capabilities live in another process. `mcp__github__create_pull_request` and
 * `mcp__github__list_issues` are indistinguishable from here, so any classifier that reasons about what
 * an agent can DO has to treat an unknown name as unknown rather than as harmless. `task/agent-role.ts`
 * uses it for exactly that.
 *
 * Alias-tolerant for the same reason as its neighbours: `search` and `find` are legacy spellings of
 * tools this build still ships, and reading them as unknown third-party tools would be wrong.
 */
export function isKnownToolName(name: string): boolean {
	return KNOWN_TOOL_NAME_SET.has(normalizeToolNames([name])[0] ?? name);
}

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
