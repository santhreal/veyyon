/**
 * Reads of a member inside a container file: an archive entry or directory, or a SQLite table, row
 * or query.
 */

import { Database } from "bun:sqlite";
import type { AgentToolResult } from "@veyyon/agent-core";
import type { TextContent } from "@veyyon/ai";
import { isProbablyBinaryHeader } from "@veyyon/utils/binary";
import type { ToolSession } from "../../sdk";
import { DEFAULT_MAX_LINES, truncateHead, truncationSummary } from "../../session/streaming-output";
import { type ArchiveReader, formatArchiveEntryLines, openArchive } from "../../utils/zip";
import { applyListLimit } from "../core/list-limit";
import { inlineBudgetFor } from "../core/output-artifact";
import { isRawSelector, type ParsedSelector, parseSel } from "../core/path-utils";
import { formatBytes } from "../core/render-utils";
import {
	executeReadQuery,
	getRowByKey,
	getRowByRowId,
	getTableSchema,
	listTables,
	MAX_RAW_QUERY_ROWS,
	parseSqliteSelector,
	queryRows,
	renderRow,
	renderSchema,
	renderTable,
	renderTableList,
	resolveTableRowLookup,
} from "../core/sqlite-reader";
import { ToolError, throwIfAborted, toolFailure } from "../core/tool-errors";
import { toolResult } from "../core/tool-result";
import { buildInMemoryResult, isMultiRange, selToOffsetLimit } from "./read-in-memory";
import { prependSuffixResolutionNotice, type ResolvedArchiveReadPath, type ResolvedSqliteReadPath } from "./read-paths";
import type { ReadToolDetails } from "./read-types";

function decodeUtf8Text(bytes: Uint8Array): string | null {
	if (isProbablyBinaryHeader(bytes)) return null;

	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		// Invalid UTF-8 is the same answer as the header sniff above: this is not text. `null` means
		// "treat as binary", which the caller reports to the model as a binary file rather than handing
		// it replacement characters and pretending they are content.
		return null;
	}
}

async function readArchiveDirectory(
	session: ToolSession,
	archive: ArchiveReader,
	archivePath: string,
	subPath: string,
	offset: number | undefined,
	limit: number | undefined,
	details: ReadToolDetails,
	signal?: AbortSignal,
): Promise<AgentToolResult<ReadToolDetails>> {
	const DEFAULT_LIMIT = 500;
	const effectiveLimit = limit ?? DEFAULT_LIMIT;
	const allEntries = archive.listDirectory(subPath);
	// `offset` is 1-indexed (line-selector semantics): `a.zip:dir:50` starts
	// the listing at the 50th entry instead of being silently ignored.
	const entries = offset !== undefined && offset > 1 ? allEntries.slice(offset - 1) : allEntries;

	const listLimit = applyListLimit(entries, { limit: effectiveLimit });
	const limitedEntries = listLimit.items;
	const limitMeta = listLimit.meta;

	throwIfAborted(signal);
	const results = formatArchiveEntryLines(limitedEntries);

	const output = results.length > 0 ? results.join("\n") : "(empty archive directory)";
	const text = prependSuffixResolutionNotice(output, details.suffixResolution);
	const truncation = truncateHead(text, {
		maxBytes: inlineBudgetFor(session),
		maxLines: Number.MAX_SAFE_INTEGER,
	});
	const directoryDetails: ReadToolDetails = { ...details, isDirectory: true };
	const resultBuilder = toolResult<ReadToolDetails>(directoryDetails).text(truncation.content);
	resultBuilder.sourcePath(archivePath).limits({ resultLimit: limitMeta.resultLimit?.reached });
	if (truncation.truncated) {
		directoryDetails.truncation = truncationSummary(truncation);
		resultBuilder.truncation(truncation, { direction: "head" });
	}
	return resultBuilder.done();
}

export async function readArchive(
	session: ToolSession,
	readPath: string,
	parsedSel: ParsedSelector,
	resolvedArchivePath: ResolvedArchiveReadPath,
	signal?: AbortSignal,
): Promise<AgentToolResult<ReadToolDetails>> {
	throwIfAborted(signal);
	const archive = await openArchive(resolvedArchivePath.absolutePath);
	throwIfAborted(signal);

	const details: ReadToolDetails = {
		resolvedPath: resolvedArchivePath.absolutePath,
		suffixResolution: resolvedArchivePath.suffixResolution,
	};

	let archiveSubPath = resolvedArchivePath.archiveSubPath;
	let sel = parsedSel;
	let node = archive.getNode(archiveSubPath);
	if (!node && archiveSubPath) {
		// `archive.zip:500` / `archive.zip:raw`: the whole subPath is a
		// selector on the archive root, not a member name. Member names take
		// precedence (getNode above); fall back to root + selector.
		const wholeSel = parseSel(archiveSubPath);
		if (wholeSel.kind !== "none") {
			node = archive.getNode("");
			archiveSubPath = "";
			sel = wholeSel;
		}
	}
	if (!node) {
		throw new ToolError(`Path '${readPath}' not found inside archive`);
	}

	if (node.isDirectory) {
		if (isMultiRange(sel)) {
			throw new ToolError("Multi-range line selectors are not supported for archive directory listings.");
		}
		const { offset, limit } = selToOffsetLimit(sel);
		return readArchiveDirectory(
			session,
			archive,
			resolvedArchivePath.absolutePath,
			archiveSubPath,
			offset,
			limit,
			details,
			signal,
		);
	}

	const entry = await archive.readFile(archiveSubPath);
	const text = decodeUtf8Text(entry.bytes);
	if (text === null) {
		return toolResult<ReadToolDetails>({ ...details, contentUnavailable: { reason: "binary" } })
			.text(
				prependSuffixResolutionNotice(
					`[Cannot read binary archive entry '${entry.path}' (${formatBytes(entry.size)})]`,
					resolvedArchivePath.suffixResolution,
				),
			)
			.sourcePath(resolvedArchivePath.absolutePath)
			.done();
	}

	// Archive members are immutable: there is no edit path for bytes inside
	// an archive, and a hashline tag keyed to the archive file would invite
	// (and fail) edits while clobbering sibling members' snapshots.
	const raw = isRawSelector(sel);
	const result = buildInMemoryResult(session, text, sel, {
		details,
		sourcePath: resolvedArchivePath.absolutePath,
		entityLabel: "archive entry",
		raw,
		immutable: true,
	});
	const firstText = result.content.find((content): content is TextContent => content.type === "text");
	if (firstText) {
		firstText.text = prependSuffixResolutionNotice(firstText.text, resolvedArchivePath.suffixResolution);
	}
	return result;
}

export async function readSqlite(
	session: ToolSession,
	resolvedSqlitePath: ResolvedSqliteReadPath,
	signal?: AbortSignal,
): Promise<AgentToolResult<ReadToolDetails>> {
	throwIfAborted(signal);

	const selectorInput = {
		subPath: resolvedSqlitePath.sqliteSubPath,
		queryString: resolvedSqlitePath.queryString,
	};
	const selector = parseSqliteSelector(selectorInput.subPath, selectorInput.queryString);
	const details: ReadToolDetails = {
		resolvedPath: resolvedSqlitePath.absolutePath,
		suffixResolution: resolvedSqlitePath.suffixResolution,
	};

	let db: Database | null = null;
	try {
		db = new Database(resolvedSqlitePath.absolutePath, { readonly: true, strict: true });
		db.run("PRAGMA busy_timeout = 3000");
		throwIfAborted(signal);

		// Every selector's rendered output is a tool result, so it takes the byte budget every
		// other result takes. One wide TEXT or BLOB cell, or a raw query over many columns,
		// used to arrive whole whatever `tools.artifactSpillThreshold` said: the row and column
		// caps below bound how many rows are rendered, never how many bytes a row carries.
		let output: string;
		let resultLimitReached: number | undefined;
		switch (selector.kind) {
			case "list": {
				const listLimit = applyListLimit(listTables(db), { limit: 500 });
				output = renderTableList(listLimit.items);
				resultLimitReached = listLimit.meta.resultLimit?.reached;
				break;
			}
			case "schema": {
				const sampleRows = queryRows(db, selector.table, { limit: selector.sampleLimit, offset: 0 });
				output = renderSchema(getTableSchema(db, selector.table), {
					columns: sampleRows.columns,
					rows: sampleRows.rows,
				});
				if (sampleRows.rows.length < sampleRows.totalCount) {
					const remaining = sampleRows.totalCount - sampleRows.rows.length;
					output += `\n[${remaining} more rows; append :${selector.table}?limit=20&offset=${sampleRows.rows.length} to the database path to continue]`;
				}
				break;
			}
			case "row": {
				const lookup = resolveTableRowLookup(db, selector.table);
				const row =
					lookup.kind === "pk"
						? getRowByKey(db, selector.table, lookup, selector.key)
						: getRowByRowId(db, selector.table, selector.key);
				output = row ? renderRow(row) : `No row found in table '${selector.table}' for key '${selector.key}'.`;
				break;
			}
			case "query": {
				const page = queryRows(db, selector.table, selector);
				output = renderTable(page.columns, page.rows, {
					totalCount: page.totalCount,
					offset: selector.offset,
					limit: selector.limit,
					table: selector.table,
					dbPath: resolvedSqlitePath.absolutePath,
				});
				break;
			}
			case "raw": {
				const result = executeReadQuery(db, selector.sql);
				output = renderTable(result.columns, result.rows, {
					totalCount: result.rows.length,
					offset: 0,
					limit: result.rows.length || DEFAULT_MAX_LINES,
					table: "query",
					dbPath: resolvedSqlitePath.absolutePath,
				});
				if (result.truncated) {
					output += `\n[Output capped at ${MAX_RAW_QUERY_ROWS} rows; add a LIMIT/OFFSET clause to the query to page through more]`;
				}
				break;
			}
			default:
				throw new ToolError("Unsupported SQLite selector");
		}

		const truncation = truncateHead(prependSuffixResolutionNotice(output, resolvedSqlitePath.suffixResolution), {
			maxBytes: inlineBudgetFor(session),
			maxLines: Number.MAX_SAFE_INTEGER,
		});
		details.truncation = truncation.truncated ? truncationSummary(truncation) : undefined;
		const resultBuilder = toolResult<ReadToolDetails>(details)
			.text(truncation.content)
			.sourcePath(resolvedSqlitePath.absolutePath)
			.limits({ resultLimit: resultLimitReached });
		if (truncation.truncated) {
			resultBuilder.truncation(truncation, { direction: "head" });
		}
		return resultBuilder.done();
	} catch (error) {
		if (error instanceof ToolError) {
			throw error;
		}
		throw toolFailure(error);
	} finally {
		db?.close();
	}
}
