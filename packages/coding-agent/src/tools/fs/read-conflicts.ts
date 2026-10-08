/**
 * Git merge-conflict blocks in read output: the warning a window with conflicts receives,
 * `conflict://<N>` regions, and the `:conflicts` index of a file.
 */

import type { AgentToolResult } from "@veyyon/agent-core";
import { recordFileSnapshot } from "../../edit/file-snapshot-store";
import type { ToolSession } from "../../sdk";
import { resolveFileDisplayMode } from "../../utils/file-display-mode";
import { formatPathRelativeToCwd } from "../core/path-utils";
import { ToolError, throwIfAborted } from "../core/tool-errors";
import { toolResult } from "../core/tool-result";
import {
	type ConflictEntry,
	type ConflictScope,
	formatConflictSummary,
	formatConflictWarning,
	getConflictHistory,
	renderConflictRegion,
	scanConflictLines,
	scanFileForConflicts,
} from "./conflict-detect";
import { formatTextWithMode, hashlineHeaderContext, prependHashlineHeader } from "./read-lines";
import type { ReadToolDetails } from "./read-types";

/**
 * The warning for the merge-conflict blocks a displayed window holds, each registered so
 * `conflict://<N>` reads it. The whole file is scanned only when the window already showed a
 * conflict, so a clean file pays nothing.
 */
export async function windowConflictWarning(
	session: ToolSession,
	absolutePath: string,
	lines: readonly string[],
	startLine: number,
): Promise<{ text: string; count: number } | undefined> {
	if (lines.length === 0) return undefined;
	const blocks = scanConflictLines(lines, startLine);
	if (blocks.length === 0) return undefined;
	const history = getConflictHistory(session);
	const displayPath = formatPathRelativeToCwd(absolutePath, session.cwd);
	const entries = blocks.map(block => history.register({ absolutePath, displayPath, ...block }));
	let totalInFile = entries.length;
	let scanTruncated = false;
	try {
		const fileScan = await scanFileForConflicts(absolutePath);
		totalInFile = Math.max(entries.length, fileScan.blocks.length);
		scanTruncated = fileScan.scanTruncated;
	} catch {
		// Best-effort enrichment; fall back to window-only count.
	}
	return {
		text: formatConflictWarning(entries, { totalInFile, displayPath, scanTruncated }),
		count: entries.length,
	};
}

/**
 * Render a `conflict://<N>` (or `conflict://<N>/<scope>`) region as
 * regular file content. The lines are emitted with their original
 * file line numbers so hashline anchors line up with the source
 * file, and no truncation footer is appended.
 */
export async function readConflictRegion(
	session: ToolSession,
	id: number,
	scope: ConflictScope | undefined,
): Promise<AgentToolResult<ReadToolDetails>> {
	const entry: ConflictEntry | undefined = getConflictHistory(session).get(id);
	if (!entry) {
		throw new ToolError(
			`Conflict #${id} not found. Conflict ids are registered when \`read\` surfaces a marker block; re-read the file to get a current id.`,
		);
	}

	const region = renderConflictRegion(entry, scope);
	const displayMode = resolveFileDisplayMode(session);
	const shouldAddHashLines = displayMode.hashLines;
	const shouldAddLineNumbers = shouldAddHashLines ? false : displayMode.lineNumbers;

	const rawText = region.lines.join("\n");
	const tag = shouldAddHashLines ? await recordFileSnapshot(session, entry.absolutePath) : undefined;
	const hashContext = tag
		? hashlineHeaderContext(formatPathRelativeToCwd(entry.absolutePath, session.cwd), tag)
		: undefined;
	const formattedBody = formatTextWithMode(rawText, region.startLine, shouldAddHashLines, shouldAddLineNumbers);
	const formattedText = prependHashlineHeader(formattedBody, hashContext);

	const details: ReadToolDetails = {
		resolvedPath: entry.absolutePath,
		displayContent: { text: rawText, startLine: region.startLine },
	};
	return toolResult<ReadToolDetails>(details).text(formattedText).sourcePath(entry.absolutePath).done();
}

/**
 * Implement the `<path>:conflicts` read selector: scan the whole file once, register
 * every block in the session's conflict history, and return a compact
 * `#N L_a-L_b` index instead of file content. Designed for heavily
 * conflicted files where dumping every body would be wasteful.
 */
export async function readFileConflicts(
	session: ToolSession,
	absolutePath: string,
	suffixResolution: { from: string; to: string } | undefined,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<ReadToolDetails>> {
	throwIfAborted(signal);
	const scan = await scanFileForConflicts(absolutePath);
	const displayPath = formatPathRelativeToCwd(absolutePath, session.cwd);
	const history = getConflictHistory(session);
	const entries = scan.blocks.map(block =>
		history.register({
			absolutePath,
			displayPath,
			...block,
		}),
	);

	const summary =
		entries.length === 0
			? `No unresolved git merge conflicts in ${displayPath}.`
			: formatConflictSummary(entries, { displayPath, scanTruncated: scan.scanTruncated });

	const details: ReadToolDetails = {
		resolvedPath: absolutePath,
		suffixResolution,
		conflictCount: entries.length,
	};
	return toolResult<ReadToolDetails>(details).text(summary).sourcePath(absolutePath).done();
}
