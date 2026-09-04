import path from "node:path";

import { buildPathTree, isUrlLikePath, type PathTreeInput, walkPathTree } from "@veyyon/utils/path-tree";

// =============================================================================
// Grouped file output (grep / ast-grep / ast-edit / lsp diagnostics)
// =============================================================================

/**
 * One file's contribution to a grouped file output. The header itself is generated
 * by `formatGroupedFiles` (one `#` per nesting level); use `headerSuffix` to tack
 * on extras like ` (1 replacement)`.
 */
export interface GroupedFileSection {
	/** Optional suffix appended to the file header. */
	headerSuffix?: string;
	/** Body lines emitted into the textual model output. */
	modelLines: string[];
	/** Body lines emitted into the display output. Defaults to `modelLines`. */
	displayLines?: string[];
	/** When true, the file (and its header) is omitted entirely. */
	skip?: boolean;
}

export interface GroupedFilesOutput {
	model: string[];
	display: string[];
}

/**
 * Render a list of files as a multi-level, prefix-folded directory tree shared by
 * grep, ast-grep, ast-edit, and the LSP diagnostic formatter.
 *
 * Layout (one `#` per level; the shared prefix folds into the top header):
 *   # packages/pkg/src/
 *   ## root.ts
 *   …body…
 *   ## nested/
 *   ### child.ts
 *   …body…
 *
 * Files in the (folded) project root become single-`#` headers with no parent
 * directory line. A blank line precedes every directory header and every
 * root-level file so the renderers can split the output into collapsible groups.
 */
export function formatGroupedFiles(
	files: string[],
	renderFile: (filePath: string) => GroupedFileSection,
): GroupedFilesOutput {
	const sections = new Map<string, GroupedFileSection>();
	const inputs: PathTreeInput[] = [];
	for (const filePath of files) {
		if (sections.has(filePath)) continue;
		const section = renderFile(filePath);
		if (section.skip) continue;
		sections.set(filePath, section);
		inputs.push({ path: filePath, isDir: false, key: filePath });
	}

	const tree = buildPathTree(inputs);
	const model: string[] = [];
	const display: string[] = [];
	let emitted = false;

	for (const event of walkPathTree(tree)) {
		const hashes = "#".repeat(event.depth + 1);
		const needsSeparator = emitted && (event.depth === 0 || event.kind === "dir");
		if (needsSeparator) {
			model.push("");
			display.push("");
		}
		emitted = true;
		if (event.kind === "dir") {
			const header = `${hashes} ${event.name}/`;
			model.push(header);
			display.push(header);
			continue;
		}
		const section = sections.get(event.key)!;
		const header = `${hashes} ${event.name}${section.headerSuffix ?? ""}`;
		model.push(header, ...section.modelLines);
		display.push(header, ...(section.displayLines ?? section.modelLines));
	}

	return { model, display };
}

// =============================================================================
// Parsing grouped output back into per-line context (TUI renderers)
// =============================================================================

const GROUPED_HEADER_RE = /^(#+)\s+(.*)$/;
const HEADER_SUFFIX_RE = /\s+\([^)]*\)\s*$/;
const HEADER_HASH_TAG_RE = /#[0-9a-f]+$/i;

/** Per-line classification of grouped output, used by renderers for hyperlinks. */
export interface GroupedLineContext {
	/** Directory header, file header, or any non-header body/content line. */
	kind: "dir" | "file" | "content";
	/** Number of leading `#` for headers; 0 for content lines. */
	depth: number;
	/** Resolved absolute path of the dir/file a header points at (when resolvable). */
	headerPath?: string;
	/** For content lines, the absolute path of the owning file (line hyperlinks). */
	filePath?: string;
	/** Header is an internal/url-like target the caller resolves itself. */
	isUrl?: boolean;
}

function resolveGroupedPath(parent: string | undefined, name: string): string | undefined {
	if (parent === undefined) return undefined;
	if (name === "" || name === ".") return parent;
	// `path.resolve` keeps an absolute `name` intact (out-of-cwd results) while
	// joining a relative folded chain (`packages/pkg/src`) onto the parent.
	return path.resolve(parent, name);
}

/**
 * Walk grouped output lines, tracking a directory stack keyed by header depth, so
 * each header and body line can be linked back to its absolute filesystem path.
 * Reconstruction is stack-based (not per-blank-group) so nested directory headers
 * resolve correctly across the whole output.
 *
 * `headerBase` is the directory the displayed (folded) header paths are relative
 * to — for grep/ast tools that is the session cwd, since display paths are
 * formatted relative to cwd regardless of the (sub)directory the search was
 * scoped to. `fileScope` is the initial owning file for body lines that appear
 * before any header (single-file scopes have no `#` headers); it defaults to
 * `headerBase` and should be passed the scoped file's absolute path.
 */
export function classifyGroupedLines(
	lines: readonly string[],
	headerBase: string | undefined,
	fileScope: string | undefined = headerBase,
): GroupedLineContext[] {
	const result: GroupedLineContext[] = [];
	const dirAtDepth = new Map<number, string>();
	// Body lines before any header (single-file scopes) link to the scoped file.
	let currentFile = fileScope;

	const clearDeeper = (depth: number) => {
		for (const key of dirAtDepth.keys()) {
			if (key >= depth) dirAtDepth.delete(key);
		}
	};

	for (const line of lines) {
		const match = GROUPED_HEADER_RE.exec(line);
		if (!match) {
			result.push({ kind: "content", depth: 0, filePath: currentFile });
			continue;
		}
		const depth = match[1]!.length;
		const rest = match[2]!.trimEnd();
		if (isUrlLikePath(rest)) {
			clearDeeper(depth);
			currentFile = undefined;
			result.push({ kind: "file", depth, isUrl: true });
			continue;
		}
		const parent = depth > 1 ? dirAtDepth.get(depth - 1) : headerBase;
		if (rest.endsWith("/")) {
			const name = rest.slice(0, -1).replace(HEADER_SUFFIX_RE, "");
			const abs = resolveGroupedPath(parent, name);
			clearDeeper(depth);
			if (abs !== undefined) dirAtDepth.set(depth, abs);
			currentFile = undefined;
			result.push({ kind: "dir", depth, headerPath: abs });
			continue;
		}
		const name = rest.replace(HEADER_SUFFIX_RE, "").replace(HEADER_HASH_TAG_RE, "");
		const abs = name ? resolveGroupedPath(parent, name) : undefined;
		currentFile = abs;
		result.push({ kind: "file", depth, headerPath: abs });
	}

	return result;
}

/**
 * Split line indices into blank-line-separated groups, mirroring
 * `splitGroupsByBlankLine`: when any blank line is present, break on runs of
 * blanks; otherwise return a single group of the non-empty lines. Returning
 * indices lets callers slice parallel arrays (raw lines, styled lines, contexts).
 */
export function groupLineIndicesByBlank(rawLines: readonly string[]): number[][] {
	const hasSeparators = rawLines.some(line => line.trim().length === 0);
	const groups: number[][] = [];
	if (hasSeparators) {
		let current: number[] = [];
		for (let i = 0; i < rawLines.length; i++) {
			if (rawLines[i]!.trim().length === 0) {
				if (current.length > 0) {
					groups.push(current);
					current = [];
				}
				continue;
			}
			current.push(i);
		}
		if (current.length > 0) groups.push(current);
	} else {
		const current: number[] = [];
		for (let i = 0; i < rawLines.length; i++) {
			if (rawLines[i]!.trim().length > 0) current.push(i);
		}
		if (current.length > 0) groups.push(current);
	}
	return groups;
}

// Regex: split on the first `:digits:digits` boundary to separate path from the rest
const DIAG_PATH_RE = /^(.+?):(\d+:\d+\s+.*)$/;

/**
 * Reformat pre-formatted diagnostic messages into a multi-level, prefix-folded
 * directory/file grouping (see `formatGroupedFiles`).
 * Input:  ["path:line:col [sev] msg", ...]
 * Output: "# pkg/src/\n## file.ts\n  line:col [sev] msg"
 *
 * Messages that don't match the expected format are appended ungrouped at the end.
 */
export function formatGroupedDiagnosticMessages(messages: string[]): string {
	const diagnosticsByFile = new Map<string, string[]>();
	const fileOrder: string[] = [];
	const ungrouped: string[] = [];

	for (const msg of messages) {
		const match = DIAG_PATH_RE.exec(msg);
		if (!match) {
			ungrouped.push(msg);
			continue;
		}

		const [, rawFilePath, rest] = match;
		const filePath = rawFilePath.replace(/\\/g, "/");
		if (!diagnosticsByFile.has(filePath)) {
			diagnosticsByFile.set(filePath, []);
			fileOrder.push(filePath);
		}
		diagnosticsByFile.get(filePath)?.push(rest);
	}

	if (diagnosticsByFile.size === 0) {
		return ungrouped.join("\n");
	}

	const grouped = formatGroupedFiles(fileOrder, filePath => ({
		modelLines: (diagnosticsByFile.get(filePath) ?? []).map(diagnostic => `  ${diagnostic}`),
	}));
	const lines: string[] = grouped.model;

	if (ungrouped.length > 0) {
		lines.push("");
		for (const msg of ungrouped) {
			lines.push(msg);
		}
	}

	return lines.join("\n");
}
