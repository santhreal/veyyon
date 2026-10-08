/**
 * The one-line label a session tree prints for a tool call: `[read: src/app.ts]`, `[bash: git status]`.
 *
 * The terminal tree selector and the HTML export's tree both print this label, so a call reads the
 * same in an exported or shared transcript as in the terminal. The module imports nothing that
 * touches Node or a DOM: the export reaches it through the browser tool-views bundle. Home-directory
 * shortening is a parameter because the terminal has the real home directory and a browser does
 * not.
 *
 * Every registered tool has its own entry in {@link LABELS}; a name with no entry (an MCP tool, an
 * extension tool, a retired name) prints its arguments as a truncated JSON digest.
 */
import { collapseWhitespace } from "./collapse-whitespace";
import { truncate } from "./format";
import { editInputPaths, parseReadArgs, parseWriteArgs } from "./fs-tool-args";
import { isRecord } from "./type-guards";

/** Collapses a home-directory prefix to `~` for display. */
export type PathShortener = (path: string) => string;

/** Code-point budgets for the variable parts of a label. */
export const TOOL_CALL_LABEL_LIMITS = {
	/** A shell command (`bash`, `ssh`). */
	COMMAND: 50,
	/** Free text: a query, a question, a description, a message. */
	TEXT: 50,
	/** The JSON digest printed for a tool with no entry. */
	ARGS: 40,
	/** An identifier: an op, an action, a name, a host, a session id. */
	WORD: 40,
} as const;

type Args = Record<string, unknown>;
type Detail = (args: Args, shortenPath: PathShortener) => string;
type Labeler = (name: string, args: Args, shortenPath: PathShortener) => string;

function str(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function strList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function records(value: unknown): Args[] {
	return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** Free text on one line, cut to `max` code points. */
function text(value: unknown, max: number = TOOL_CALL_LABEL_LIMITS.TEXT): string {
	const s = str(value);
	return s === null ? "" : truncate(collapseWhitespace(s), max);
}

/** An identifier on one line, cut to {@link TOOL_CALL_LABEL_LIMITS.WORD} code points. */
function word(value: unknown): string {
	return text(value, TOOL_CALL_LABEL_LIMITS.WORD);
}

/** A path on one line, home prefix shortened, never cut. Spaces inside the path are kept. */
function pathOf(value: unknown, shortenPath: PathShortener): string {
	const s = str(value);
	return s ? shortenPath(s).replace(/[^\S ]+/g, " ") : "";
}

/** The non-empty parts, space-separated. */
function join(...parts: Array<string | null | undefined>): string {
	return parts.filter(part => part !== null && part !== undefined && part !== "").join(" ");
}

/** ` +N` for the entries after the first one a label prints. */
function more(count: number): string {
	return count > 1 ? `+${count - 1}` : "";
}

function firstLine(value: string | null): string {
	if (value === null) return "";
	for (const line of value.split("\n")) if (line.trim() !== "") return line;
	return "";
}

function labelled(detail: Detail): Labeler {
	return (name, args, shortenPath) => {
		const shown = detail(args, shortenPath);
		return shown ? `[${name}: ${shown}]` : `[${name}]`;
	};
}

const editLabel = labelled((args, shortenPath) => {
	const input = str(args.input);
	const paths = input === null ? [] : editInputPaths(input);
	if (paths.length === 0) return pathOf(str(args.path) ?? str(args.file_path), shortenPath);
	return join(pathOf(paths[0], shortenPath), more(paths.length));
});

const pathLabel = (key: string) => labelled((args, shortenPath) => pathOf(args[key], shortenPath));
const textLabel = (key: string) => labelled(args => text(args[key]));

/**
 * One entry per tool the agent can call, keyed by the tool's wire name. `apply_patch` is the edit
 * tool's alias; a transcript that recorded it prints its paths as `edit` does.
 */
const LABELS: Readonly<Record<string, Labeler>> = {
	apply_patch: editLabel,
	argot_load: pathLabel("folder_path"),
	argot_unload: pathLabel("folder_path"),
	ask: labelled(args => {
		const questions = records(args.questions);
		const first = questions[0]?.question ?? args.question;
		return join(text(first), more(questions.length));
	}),
	ast_edit: labelled((args, shortenPath) => {
		const paths = strList(args.paths);
		return join(pathOf(paths[0], shortenPath), more(paths.length));
	}),
	bash: labelled(args => text(args.command, TOOL_CALL_LABEL_LIMITS.COMMAND)),
	browser: labelled(args => join(word(args.action), word(args.name), text(args.url))),
	checkpoint: textLabel("goal"),
	debug: labelled((args, shortenPath) =>
		join(word(args.action), pathOf(args.program, shortenPath) || pathOf(args.file, shortenPath)),
	),
	edit: editLabel,
	eval: labelled(args => {
		const cells = Array.isArray(args.cells) ? records(args.cells) : [args];
		const first = cells[0];
		if (!first) return "";
		const title = str(first.title) || firstLine(str(first.code) ?? str(first.input));
		return join(word(first.language), text(title), more(cells.length));
	}),
	github: labelled(args => {
		const number = args.pullNumber ?? args.issueNumber;
		return join(word(args.op), word(args.repo), typeof number === "number" ? `#${number}` : null);
	}),
	goal: labelled(args => join(word(args.op), text(args.objective))),
	inspect_image: labelled((args, shortenPath) => pathOf(args.path, shortenPath) || text(args.url)),
	irc: labelled(args => join(word(args.op), word(args.to))),
	job: labelled(args => {
		const cancel = strList(args.cancel).map(word);
		const poll = strList(args.poll).map(word);
		return join(
			args.list === true ? "list" : null,
			cancel.length > 0 ? `cancel ${cancel.join(", ")}` : null,
			poll.length > 0 ? `poll ${poll.join(", ")}` : null,
		);
	}),
	launch: labelled(args => join(word(args.op), word(args.name) || word(args.application))),
	learn: textLabel("memory"),
	lsp: labelled((args, shortenPath) =>
		join(word(args.action), pathOf(args.file, shortenPath), text(args.symbol) || text(args.query)),
	),
	manage_skill: labelled(args => join(word(args.action), word(args.name))),
	memory_edit: labelled(args => join(word(args.op), word(args.id))),
	read: labelled((args, shortenPath) => {
		const { path, sel } = parseReadArgs(args);
		const shown = pathOf(path, shortenPath);
		return shown && sel ? `${shown}:${word(sel)}` : shown;
	}),
	recall: textLabel("query"),
	reflect: textLabel("query"),
	report_finding: textLabel("title"),
	report_tool_issue: labelled(args => join(word(args.tool), text(args.report))),
	resolve: labelled(args => join(word(args.action), text(args.reason))),
	retain: labelled(args => {
		const items = records(args.items);
		return join(text(items[0]?.content), more(items.length));
	}),
	rewind: textLabel("report"),
	search: (name, args, shortenPath) => {
		const scopes = typeof args.path === "string" ? [args.path] : strList(args.path);
		const scope = scopes.map(scopePath => pathOf(scopePath, shortenPath)).join(", ");
		return `[${name}:${join(word(args.type) || "?", text(args.input), scope ? `in ${scope}` : null)}]`;
	},
	search_tool_bm25: textLabel("query"),
	set_cwd: pathLabel("path"),
	ssh: labelled(args => join(word(args.host), text(args.command, TOOL_CALL_LABEL_LIMITS.COMMAND))),
	task: labelled(args => {
		const tasks = records(args.tasks);
		const first = tasks[0];
		return join(word(args.agent), text(first?.description ?? first?.id), more(tasks.length));
	}),
	todo: labelled(args => {
		const ops = records(args.ops);
		const first = ops[0];
		return join(word(first?.op), text(first?.task ?? first?.phase), more(ops.length));
	}),
	vibe_kill: labelled(args => word(args.session)),
	vibe_list: labelled(() => ""),
	vibe_send: labelled(args => join(word(args.session), text(args.message))),
	vibe_spawn: labelled(args => join(word(args.cli), word(args.name), text(args.prompt))),
	vibe_wait: labelled(args => strList(args.sessions).map(word).join(", ")),
	web_search: textLabel("query"),
	write: labelled((args, shortenPath) => pathOf(parseWriteArgs(args).path, shortenPath)),
	yield: labelled(args => {
		const result = isRecord(args.result) ? args.result : null;
		return result && result.error !== undefined ? join("error", text(result.error)) : "";
	}),
};

/** The tool names with their own label entry, sorted. Any other name prints the JSON digest. */
export const LABELLED_TOOL_NAMES: readonly string[] = Object.keys(LABELS).sort();

/** The JSON digest printed for a tool with no entry, or for arguments that are not an object. */
function argsDigest(args: unknown): string {
	let raw: string;
	if (typeof args === "string") raw = args;
	else {
		try {
			raw = JSON.stringify(args ?? {}) ?? "";
		} catch {
			raw = String(args);
		}
	}
	return truncate(collapseWhitespace(raw), TOOL_CALL_LABEL_LIMITS.ARGS);
}

/**
 * The tree label for a call to `name` with `args`.
 *
 * `shortenPath` collapses the home directory in every path the label prints: the terminal passes
 * the real home directory, a browser the `/home/<user>` and `/Users/<user>` conventions.
 */
export function formatToolCallLabel(name: string, args: unknown, shortenPath: PathShortener): string {
	if (Object.hasOwn(LABELS, name) && isRecord(args)) return LABELS[name]!(name, args, shortenPath);
	return `[${collapseWhitespace(name)}: ${argsDigest(args)}]`;
}
