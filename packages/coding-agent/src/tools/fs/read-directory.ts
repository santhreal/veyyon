/**
 * Directory listings: the concise top-level listing, the recursive tree, and the line-range slice
 * of either.
 */

import type { AgentToolResult } from "@veyyon/agent-core";
import { formatMoreLines } from "@veyyon/utils/format";
import { errorMessage } from "@veyyon/utils/type-guards";
import type { ToolSession } from "../../sdk";
import { truncateHead, truncationSummary } from "../../session/streaming-output";
import { buildDirectoryTree, buildTopLevelDirectoryListing, type DirectoryTree } from "../../workspace-tree";
import { inlineBudgetFor } from "../core/output-artifact";
import { ToolError, throwIfAborted } from "../core/tool-errors";
import { toolResult } from "../core/tool-result";
import type { ReadToolDetails } from "./read-types";
import { formatOutOfBoundsMessage } from "./read-window";

/** Read directory contents as a formatted listing */
export async function readDirectory(
	session: ToolSession,
	absolutePath: string,
	offset: number | undefined,
	limit: number | undefined,
	directory: { depth?: number; entryLimit?: number },
	signal?: AbortSignal,
): Promise<AgentToolResult<ReadToolDetails>> {
	const READ_DIRECTORY_MAX_DEPTH = 2;
	const READ_DIRECTORY_CHILD_LIMIT = 12;
	// Top-level cap for the concise listing. Generous enough that an ordinary
	// directory fits whole; a monorepo root gets the omission notice naming
	// how to see the rest.
	const TOP_LEVEL_LISTING_ENTRY_LIMIT = 100;

	throwIfAborted(signal);
	// A selector-free directory read is orientation, so it answers at the top
	// level: every entry with each subdirectory's direct-child count beside
	// it. The second level is a default nobody asked for, and it is expensive
	// because the result is re-sent on every later request of the session —
	// `packages/coding-agent/src` of this repository costs 8,163 tokens at
	// depth 2 against 962 at its top level, and the recursive listing also
	// caps each directory's fanout at READ_DIRECTORY_CHILD_LIMIT, so it hides
	// entries the concise listing shows. A named `depth` or `limit` is a
	// request and is honored in full.
	const conciseTopLevel = directory.depth === undefined && directory.entryLimit === undefined;

	let tree: DirectoryTree;
	let rootFooter: string | undefined;
	// Both listing paths report a failure the same way. The concise path used
	// to have no handler at all, so a scan that could not run reached line
	// 3629 as a zero-line tree and was rendered "(empty directory)" — the
	// answer a genuinely empty directory gets.
	try {
		if (conciseTopLevel) {
			const listing = await buildTopLevelDirectoryListing(absolutePath, {
				entryLimit: TOP_LEVEL_LISTING_ENTRY_LIMIT,
			});
			if (listing.totalLines > 1) {
				rootFooter =
					listing.omittedTopLevel > 0
						? `[${listing.omittedTopLevel} more top-level entries not shown (capped at ${TOP_LEVEL_LISTING_ENTRY_LIMIT}). Re-issue read with depth: 1 for every entry, depth: 2 for the recursive listing, or read a subdirectory by name.]`
						: "[Top-level listing. Re-issue read with depth: 2 for the recursive listing, or read a subdirectory by name.]";
			}
			tree = listing;
		} else {
			tree = await buildDirectoryTree(absolutePath, {
				maxDepth: directory.depth ?? READ_DIRECTORY_MAX_DEPTH,
				perDirLimit: READ_DIRECTORY_CHILD_LIMIT,
				rootLimit: null,
				// `lineCap` truncates the rendered tree itself, so apply it only when the caller
				// did not request an offset — otherwise we'd cap the first N lines before slicing.
				lineCap: offset === undefined && limit !== undefined ? limit : null,
			});
		}
	} catch (error) {
		throw new ToolError(`Cannot read directory: ${errorMessage(error)}`);
	}
	throwIfAborted(signal);

	let output = tree.totalLines <= 1 ? "(empty directory)" : tree.rendered;
	let listingTruncated = tree.truncated;

	// The `limit` argument caps the number of returned entries head-first.
	// The notice names the cap, the omission count, and the arguments that
	// reveal the rest — never a bare ellipsis.
	if (directory.entryLimit !== undefined && tree.totalLines > 1) {
		const [rootLine, ...entryLines] = output.split("\n");
		if (entryLines.length > directory.entryLimit) {
			const omitted = entryLines.length - directory.entryLimit;
			const notice = `[${omitted} ${omitted === 1 ? "entry" : "entries"} omitted (limit: ${directory.entryLimit}). Re-issue read with a higher limit (at least ${entryLines.length}) or no limit to see every entry.]`;
			output = [rootLine, ...entryLines.slice(0, directory.entryLimit), "", notice].join("\n");
			listingTruncated = true;
		}
	}

	const details: ReadToolDetails = {
		isDirectory: true,
		resolvedPath: tree.rootPath,
	};

	// Slice the rendered listing when the caller passed an offset/limit. We do this
	// instead of passing the selector down to `buildDirectoryTree` because the tree
	// builder lays out entries hierarchically (per-dir caps, recent-then-elided
	// summaries); line-based slicing operates on the formatted text and matches what
	// users expect from `:N-M` on long listings.
	const wantsSlice = offset !== undefined || limit !== undefined;
	if (wantsSlice) {
		const allLines = output.split("\n");
		const start = offset ? Math.max(0, offset - 1) : 0;
		if (start >= allLines.length) {
			return toolResult(details)
				.text(formatOutOfBoundsMessage(start, allLines.length, "listing"))
				.sourcePath(tree.rootPath)
				.done();
		}
		const end = limit !== undefined ? Math.min(start + limit, allLines.length) : allLines.length;
		// A sliced listing is a tool result like any other: the caller's line count says how many
		// entries it wants, the budget says how many it may carry. Without this the slice was the
		// one read path with no byte bound at all.
		const bounded = truncateHead(allLines.slice(start, end).join("\n"), {
			maxBytes: inlineBudgetFor(session),
			maxLines: Number.MAX_SAFE_INTEGER,
		});
		if (bounded.truncated) listingTruncated = true;
		const shownLines = bounded.content.length === 0 ? 0 : bounded.content.split("\n").length;
		const resultBuilder = toolResult(details).sourcePath(tree.rootPath);
		let text = bounded.content;
		const nextLine = start + shownLines + 1;
		if (nextLine <= allLines.length) {
			const remaining = allLines.length - nextLine + 1;
			text += `\n\n[${formatMoreLines(remaining)} in listing. Use :${nextLine} to continue]`;
		}
		if (rootFooter) text += `\n\n${rootFooter}`;
		resultBuilder.text(text);
		if (listingTruncated) {
			resultBuilder.limits({ resultLimit: 1 });
		}
		return resultBuilder.done();
	}

	const truncation = truncateHead(rootFooter ? `${output}\n\n${rootFooter}` : output, {
		maxBytes: inlineBudgetFor(session),
		maxLines: Number.MAX_SAFE_INTEGER,
	});
	const resultBuilder = toolResult(details).text(truncation.content).sourcePath(tree.rootPath);
	if (listingTruncated) {
		resultBuilder.limits({ resultLimit: 1 });
	}
	if (truncation.truncated) {
		resultBuilder.truncation(truncation, { direction: "head" });
		details.truncation = truncationSummary(truncation);
	}

	return resultBuilder.done();
}
