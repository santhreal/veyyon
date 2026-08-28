import {
	containsRecognizableHashlineOperations,
	type PatchSection as HashlineInputSection,
	Patch as HashlinePatch,
	type SnapshotStore,
} from "@veyyon/hashline";
import { errorMessage } from "@veyyon/utils";
import type { Theme } from "../modes/theme/theme";
import { type EditMode, resolveEditMode } from "../utils/edit-mode";
import {
	ABORT_MARKER,
	ADD_FILE_MARKER,
	BEGIN_PATCH_MARKER,
	DELETE_FILE_MARKER,
	END_PATCH_MARKER,
	EOF_MARKER,
	MOVE_TO_MARKER,
	UPDATE_FILE_MARKER,
} from "./apply-patch/markers";
import { computeEditDiff, type DiffError, type DiffResult } from "./diff";
import { computeHashlineDiff, computeHashlineSectionDiff } from "./hashline/diff";
import { type ApplyPatchEntry, expandApplyPatchToEntries, expandApplyPatchToPreviewEntries } from "./modes/apply-patch";
import { computePatchDiff, type PatchEditEntry } from "./modes/patch";
import type { ReplaceEditEntry } from "./modes/replace";

export interface PerFileDiffPreview {
	path: string;
	diff?: string;
	firstChangedLine?: number;
	error?: string;
}

export interface StreamingDiffContext {
	cwd: string;
	signal: AbortSignal;
	snapshots: SnapshotStore;
	fuzzyThreshold?: number;
	allowFuzzy?: boolean;
	isStreaming?: boolean;
}

export interface EditMatcherEntry {
	readonly path: string;
	readonly digest: string;
}

export interface EditStreamingStrategy<Args = unknown> {
	extractCompleteEdits(args: Args, partialJson: string | undefined): Args;
	computeDiffPreview(args: Args, ctx: StreamingDiffContext): Promise<PerFileDiffPreview[] | null>;
	renderStreamingFallback(args: Args, uiTheme: Theme): string;
	matcherDigest(args: Args): string | undefined;
	matcherPaths(args: Args): readonly string[] | undefined;
	matcherEntries(args: Args): readonly EditMatcherEntry[] | undefined;
}

export function dropIncompleteLastEdit<T>(edits: readonly T[], partialJson: string | undefined, listKey: string): T[] {
	if (!Array.isArray(edits) || edits.length === 0) return (edits ?? []).slice();
	if (!partialJson) return edits.slice();

	const keyMarker = `"${listKey}"`;
	const keyIdx = partialJson.indexOf(keyMarker);
	if (keyIdx === -1) return edits.slice();

	let i = partialJson.indexOf("[", keyIdx + keyMarker.length);
	if (i === -1) return edits.slice();
	i++;

	let depth = 0;
	let inString = false;
	let escaped = false;
	let lastClose = -1;
	for (; i < partialJson.length; i++) {
		const ch = partialJson[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			if (inString) escaped = true;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (ch === "{" || ch === "[") {
			depth++;
		} else if (ch === "}" || ch === "]") {
			depth--;
			if (ch === "}" && depth === 0) {
				lastClose = i;
			}
			if (ch === "]" && depth === -1) {
				break;
			}
		}
	}

	const tail = lastClose === -1 ? partialJson.slice(i) : partialJson.slice(lastClose + 1);
	const sawNewObjectAfterLastClose = /\{/.test(tail);
	const listIsStillOpen = depth >= 0;

	if (lastClose === -1 || (listIsStillOpen && sawNewObjectAfterLastClose)) {
		return edits.slice(0, -1);
	}
	return edits.slice();
}

function groupApplyPatchEntriesByPath(entries: readonly ApplyPatchEntry[]): Map<string, ApplyPatchEntry[]> {
	const groups = new Map<string, ApplyPatchEntry[]>();

	for (const entry of entries) {
		let bucket = groups.get(entry.path);
		if (!bucket) {
			bucket = [];
			groups.set(entry.path, bucket);
		}
		bucket.push(entry);
	}
	return groups;
}

function extractAddedLines(text: string, fallbackToWhole: boolean): string {
	const added: string[] = [];
	let lineStart = 0;
	while (lineStart <= text.length) {
		let lineEnd = text.indexOf("\n", lineStart);
		if (lineEnd === -1) lineEnd = text.length;
		if (text.charCodeAt(lineStart) === 43 /* + */ && !text.startsWith("+++ ", lineStart)) {
			added.push(text.slice(lineStart + 1, lineEnd));
		}
		lineStart = lineEnd + 1;
	}
	if (added.length === 0) return fallbackToWhole ? text : "";
	return added.join("\n");
}

function extractHashlineHeaderPaths(input: string): string[] {
	const paths: string[] = [];
	const re = /^\s*\[([^\]\r\n]+?)(?:#[0-9a-fA-F]{4})?\]\s*$/gm;
	for (const match of input.matchAll(re)) {
		const candidate = stripApplyPatchPathNoise(match[1]).trim();
		if (candidate.length > 0) paths.push(candidate);
	}
	return paths;
}

function stripApplyPatchPathNoise(value: string): string {
	return value
		.replace(/^\s*\*{3}\s*(?:Add|Update|Delete)\s+File\s*:\s*/i, "")
		.replace(/^\s*\*{3}\s*Move\s+to\s*:\s*/i, "");
}

function extractApplyPatchEnvelopePaths(input: string): string[] {
	const paths: string[] = [];
	const re = /^\s*\*{3}\s+(?:Add|Update|Delete)\s+File\s*:\s*(\S.*?)\s*$/gm;
	for (const match of input.matchAll(re)) {
		const candidate = match[1].trim();
		if (candidate.length > 0) paths.push(candidate);
	}
	return paths;
}

function splitHashlinePerFile(input: string): EditMatcherEntry[] {
	const headerRe = /^\s*\[([^\]\r\n]+?)(?:#[0-9a-fA-F]{4})?\]\s*$/gm;
	const sections: { path: string; headerStart: number; bodyStart: number }[] = [];
	let match: RegExpExecArray | null = headerRe.exec(input);
	while (match !== null) {
		const candidate = stripApplyPatchPathNoise(match[1]).trim();
		if (candidate.length > 0) {
			sections.push({ path: candidate, headerStart: match.index, bodyStart: headerRe.lastIndex });
		}
		match = headerRe.exec(input);
	}
	if (sections.length === 0) return [];

	const byPath = new Map<string, string>();
	for (let i = 0; i < sections.length; i++) {
		const { path: sectionPath, bodyStart } = sections[i];
		const bodyEnd = i + 1 < sections.length ? sections[i + 1].headerStart : input.length;
		const added = extractAddedLines(input.slice(bodyStart, bodyEnd), false);
		if (added.length === 0) continue;
		const existing = byPath.get(sectionPath);
		byPath.set(sectionPath, existing === undefined ? added : `${existing}\n${added}`);
	}
	return Array.from(byPath, ([path, digest]) => ({ path, digest }));
}

function splitApplyPatchPerFile(input: string): EditMatcherEntry[] {
	let entries: ApplyPatchEntry[];
	try {
		entries = expandApplyPatchToEntries({ input });
	} catch {
		try {
			entries = expandApplyPatchToPreviewEntries({ input });
		} catch {
			return [];
		}
	}
	const byPath = new Map<string, string>();
	for (const entry of entries) {
		if (typeof entry.diff !== "string") continue;
		const added = extractAddedLines(entry.diff, false);
		if (added.length === 0) continue;
		const existing = byPath.get(entry.path);
		byPath.set(entry.path, existing === undefined ? added : `${existing}\n${added}`);
	}
	return Array.from(byPath, ([path, digest]) => ({ path, digest }));
}

interface ReplaceArgs {
	path?: string;
	edits?: ReplaceEditEntry[];
	__partialJson?: string;
}

const replaceStrategy: EditStreamingStrategy<ReplaceArgs> = {
	extractCompleteEdits(args, partialJson) {
		if (!args?.edits) return args;
		return { ...args, edits: dropIncompleteLastEdit(args.edits, partialJson, "edits") };
	},
	async computeDiffPreview(args, ctx) {
		if (!args.path) return null;
		const first = args.edits?.[0];
		if (!first || first.old_text === undefined || first.new_text === undefined) return null;
		ctx.signal.throwIfAborted();
		const result = await computeEditDiff(args.path, first.old_text, first.new_text, ctx.cwd, {
			fuzzy: ctx.allowFuzzy ?? true,
			all: first.all,
			threshold: ctx.fuzzyThreshold,
			streaming: ctx.isStreaming,
		});
		ctx.signal.throwIfAborted();
		return [toPerFilePreview(args.path, result)];
	},
	renderStreamingFallback() {
		return "";
	},
	matcherDigest(args) {
		const edits = args?.edits;
		if (!Array.isArray(edits)) return undefined;
		let digest: string | undefined;
		for (const edit of edits) {
			if (typeof edit?.new_text !== "string") continue;
			digest = digest === undefined ? edit.new_text : `${digest}\n${edit.new_text}`;
		}
		return digest;
	},
	matcherPaths(args) {
		return typeof args?.path === "string" && args.path.length > 0 ? [args.path] : undefined;
	},
	matcherEntries(args) {
		const path = args?.path;
		if (typeof path !== "string" || path.length === 0) return undefined;
		const digest = replaceStrategy.matcherDigest(args);
		return digest === undefined ? undefined : [{ path, digest }];
	},
};

interface PatchArgs {
	path?: string;
	edits?: PatchEditEntry[];
	__partialJson?: string;
}

const patchStrategy: EditStreamingStrategy<PatchArgs> = {
	extractCompleteEdits(args, partialJson) {
		if (!args?.edits) return args;
		return { ...args, edits: dropIncompleteLastEdit(args.edits, partialJson, "edits") };
	},
	async computeDiffPreview(args, ctx) {
		if (!args.path) return null;
		const first = args.edits?.[0];
		if (!first) return null;
		ctx.signal.throwIfAborted();
		const result = await computePatchDiff(
			{ path: args.path, op: first.op ?? "update", rename: first.rename, diff: first.diff },
			ctx.cwd,
			{ fuzzyThreshold: ctx.fuzzyThreshold, allowFuzzy: ctx.allowFuzzy, allowCreateOverwrite: true },
		);
		ctx.signal.throwIfAborted();
		return [toPerFilePreview(args.path, result)];
	},
	renderStreamingFallback() {
		return "";
	},
	matcherDigest(args) {
		const edits = args?.edits;
		if (!Array.isArray(edits)) return undefined;
		let digest: string | undefined;
		for (const edit of edits) {
			if (typeof edit?.diff !== "string") continue;
			const added = extractAddedLines(edit.diff, true);
			digest = digest === undefined ? added : `${digest}\n${added}`;
		}
		return digest;
	},
	matcherPaths(args) {
		return typeof args?.path === "string" && args.path.length > 0 ? [args.path] : undefined;
	},
	matcherEntries(args) {
		const path = args?.path;
		if (typeof path !== "string" || path.length === 0) return undefined;
		const digest = patchStrategy.matcherDigest(args);
		return digest === undefined ? undefined : [{ path, digest }];
	},
};

interface HashlineArgs {
	input?: string;
	_input?: string;
	__partialJson?: string;
}

function hashlineEditText(args: HashlineArgs | undefined): string | undefined {
	return args?.input ?? args?._input;
}

function trimTrailingPartialLine(text: string, isStreaming: boolean | undefined): string {
	if (!isStreaming) return text;
	const idx = text.lastIndexOf("\n");
	if (idx === -1) return "";
	return text.slice(0, idx + 1);
}

function buildApplyPatchNaturalOrderPreviews(input: string): PerFileDiffPreview[] | null {
	const lines = input.split("\n");
	const groups = new Map<string, string[]>();
	let currentPath: string | undefined;
	const ensure = (path: string): string[] => {
		let bucket = groups.get(path);
		if (!bucket) {
			bucket = [];
			groups.set(path, bucket);
		}
		return bucket;
	};
	for (const raw of lines) {
		const trimmedEnd = raw.trimEnd();
		if (trimmedEnd === BEGIN_PATCH_MARKER || trimmedEnd === END_PATCH_MARKER || trimmedEnd === ABORT_MARKER) {
			continue;
		}
		if (trimmedEnd.startsWith(ADD_FILE_MARKER)) {
			currentPath = trimmedEnd.slice(ADD_FILE_MARKER.length).trimStart();
			ensure(currentPath);
			continue;
		}
		if (trimmedEnd.startsWith(DELETE_FILE_MARKER)) {
			currentPath = trimmedEnd.slice(DELETE_FILE_MARKER.length).trimStart();
			ensure(currentPath);
			continue;
		}
		if (trimmedEnd.startsWith(UPDATE_FILE_MARKER)) {
			currentPath = trimmedEnd.slice(UPDATE_FILE_MARKER.length).trimStart();
			ensure(currentPath);
			continue;
		}
		if (trimmedEnd.startsWith(MOVE_TO_MARKER) || trimmedEnd.startsWith(EOF_MARKER)) {
			continue;
		}
		if (!currentPath) continue;
		if (raw.startsWith("+") || raw.startsWith("-") || raw.startsWith(" ") || raw.startsWith("@@")) {
			ensure(currentPath).push(raw);
		}
	}
	if (groups.size === 0) return null;
	const previews: PerFileDiffPreview[] = [];
	for (const [path, body] of groups) {
		if (body.length === 0) continue;
		previews.push({ path, diff: body.join("\n") });
	}
	return previews.length > 0 ? previews : null;
}

const hashlineStrategy: EditStreamingStrategy<HashlineArgs> = {
	extractCompleteEdits(args) {
		return args;
	},
	async computeDiffPreview(args, ctx) {
		const input = hashlineEditText(args);
		if (typeof input !== "string" || input.length === 0) return null;
		ctx.signal.throwIfAborted();

		let sections: readonly HashlineInputSection[];
		try {
			sections = HashlinePatch.parse(input, { cwd: ctx.cwd }).sections;
		} catch {
			if (ctx.isStreaming) return null;
			const result = await computeHashlineDiff({ input }, ctx.cwd, ctx.snapshots);
			ctx.signal.throwIfAborted();
			return [toPerFilePreview("", result)];
		}
		if (sections.length === 0) return null;

		const lastIndex = sections.length - 1;
		const trailingIncomplete =
			sections.length > 1 && !containsRecognizableHashlineOperations(sections[lastIndex].diff);
		const sectionsToProcess = trailingIncomplete ? sections.slice(0, -1) : sections;
		const trailingProcessedIndex = sectionsToProcess.length - 1;

		const previews: PerFileDiffPreview[] = [];
		for (let i = 0; i < sectionsToProcess.length; i++) {
			ctx.signal.throwIfAborted();
			const section = sectionsToProcess[i];
			const result = await computeHashlineSectionDiff(section, ctx.cwd, ctx.snapshots, {
				streaming: ctx.isStreaming,
				skipHashValidation: ctx.isStreaming === true,
			});
			ctx.signal.throwIfAborted();
			if ((ctx.isStreaming || sectionsToProcess.length > 1) && i === trailingProcessedIndex && "error" in result) {
				continue;
			}
			previews.push(toPerFilePreview(section.path, result));
		}
		return previews.length > 0 ? previews : null;
	},
	renderStreamingFallback() {
		return "";
	},
	matcherDigest(args) {
		const input = hashlineEditText(args);
		if (typeof input !== "string") return undefined;
		return extractAddedLines(input, false);
	},
	matcherPaths(args) {
		const input = hashlineEditText(args);
		if (typeof input !== "string" || input.length === 0) return undefined;
		const paths = extractHashlineHeaderPaths(input);
		return paths.length > 0 ? paths : undefined;
	},
	matcherEntries(args) {
		const input = hashlineEditText(args);
		if (typeof input !== "string" || input.length === 0) return undefined;
		const entries = splitHashlinePerFile(input);
		return entries.length > 0 ? entries : undefined;
	},
};

interface ApplyPatchArgs {
	input?: string;
}

const applyPatchStrategy: EditStreamingStrategy<ApplyPatchArgs> = {
	extractCompleteEdits(args) {
		return args;
	},
	async computeDiffPreview(args, ctx) {
		if (typeof args.input !== "string" || args.input.length === 0) return null;
		const input = trimTrailingPartialLine(args.input, ctx.isStreaming);
		if (input.length === 0) return null;
		if (ctx.isStreaming) {
			return buildApplyPatchNaturalOrderPreviews(input);
		}
		let entries: ApplyPatchEntry[];
		try {
			entries = expandApplyPatchToEntries({ input });
		} catch {
			try {
				entries = expandApplyPatchToPreviewEntries({ input });
			} catch (err) {
				return [{ path: "", error: errorMessage(err) }];
			}
		}
		const groups = groupApplyPatchEntriesByPath(entries);
		if (groups.size === 0) return null;
		const previews: PerFileDiffPreview[] = [];
		for (const [path, fileEntries] of groups) {
			const first = fileEntries[0];
			if (!first) continue;
			ctx.signal.throwIfAborted();
			const result = await computePatchDiff(
				{ path, op: first.op ?? "update", rename: first.rename, diff: first.diff },
				ctx.cwd,
				{ fuzzyThreshold: ctx.fuzzyThreshold, allowFuzzy: ctx.allowFuzzy },
			);
			ctx.signal.throwIfAborted();
			previews.push(toPerFilePreview(path, result));
		}
		return previews.length > 0 ? previews : null;
	},
	renderStreamingFallback() {
		return "";
	},
	matcherDigest(args) {
		const input = args?.input;
		if (typeof input !== "string") return undefined;
		return extractAddedLines(input, false);
	},
	matcherPaths(args) {
		const input = args?.input;
		if (typeof input !== "string" || input.length === 0) return undefined;
		const paths = extractApplyPatchEnvelopePaths(input);
		return paths.length > 0 ? paths : undefined;
	},
	matcherEntries(args) {
		const input = args?.input;
		if (typeof input !== "string" || input.length === 0) return undefined;
		const entries = splitApplyPatchPerFile(input);
		return entries.length > 0 ? entries : undefined;
	},
};
export const EDIT_MODE_STRATEGIES: Record<EditMode, EditStreamingStrategy<unknown>> = {
	replace: replaceStrategy as EditStreamingStrategy<unknown>,
	patch: patchStrategy as EditStreamingStrategy<unknown>,
	hashline: hashlineStrategy as EditStreamingStrategy<unknown>,
	apply_patch: applyPatchStrategy as EditStreamingStrategy<unknown>,
};

export { resolveEditMode };

function toPerFilePreview(path: string, result: DiffResult | DiffError): PerFileDiffPreview {
	if ("error" in result) {
		return { path, error: result.error };
	}
	return { path, diff: result.diff, firstChangedLine: result.firstChangedLine };
}
