/**
 * Reads of `artifact://` URLs: artifact files paged by line range without loading the whole file.
 */

import type { AgentToolResult } from "@veyyon/agent-core";
import { formatMoreLines } from "@veyyon/utils/format";
import { SNAPSHOT_MAX_BYTES } from "../../edit/file-snapshot-store";
import { type ResolvedArtifactFile, resolveArtifactFile } from "../../internal-urls/artifact-protocol";
import type { InternalUrl } from "../../internal-urls/types";
import { DEFAULT_MAX_BYTES, type TruncationResult, truncationSummary } from "../../session/streaming-output";
import { resolveFileDisplayMode } from "../../utils/file-display-mode";
import type { TruncationOptions } from "../core/output-meta";
import { isRawSelector, type ParsedSelector } from "../core/path-utils";
import { formatBytes, shortenPath } from "../core/render-utils";
import { toolResult } from "../core/tool-result";
import type { ReadDisplayContent } from "./read-display";
import { isMultiRange, selToOffsetLimit } from "./read-in-memory";
import { formatTextWithMode } from "./read-lines";
import { readLocalFileMultiRange } from "./read-local-file";
import type { ReadContext, ReadToolDetails } from "./read-types";
import {
	computeRangeWindow,
	formatContextPaddingNotice,
	formatOutOfBoundsMessage,
	streamLinesFromFile,
} from "./read-window";

const MAX_ARTIFACT_RAW_INLINE_BYTES = DEFAULT_MAX_BYTES;

function formatArtifactWorkflowNotice(artifact: ResolvedArtifactFile, artifactUrl: string): string {
	const displayPath = shortenPath(artifact.path);
	return `Artifact storage: ${displayPath} (${formatBytes(artifact.size)}). Use ${artifactUrl}:N-M to page, ${artifactUrl}:raw:N-M for verbatim chunks, and the artifact file path for search/copy workflows.`;
}

function formatRawArtifactBlockedNotice(artifact: ResolvedArtifactFile, artifactUrl: string): string {
	const displayPath = shortenPath(artifact.path);
	return `Unbounded raw read blocked for ${artifactUrl} (${formatBytes(
		artifact.size,
	)}). Reading the whole artifact verbatim can exhaust memory. Use ${artifactUrl}:raw:1-3000 for bounded verbatim chunks, ${artifactUrl}:1-3000 for numbered exploration, and the artifact file path for search/copy workflows: ${displayPath}`;
}

export async function readArtifactFile(
	ctx: ReadContext,
	url: InternalUrl,
	parsedSel: ParsedSelector,
	signal?: AbortSignal,
): Promise<AgentToolResult<ReadToolDetails>> {
	const artifact = await resolveArtifactFile(url, {
		cwd: ctx.session.cwd,
		settings: ctx.session.settings,
		signal,
		localProtocolOptions: ctx.session.localProtocolOptions,
		skills: ctx.session.skills,
	});
	const artifactUrl = `artifact://${artifact.id}`;
	const details: ReadToolDetails = {
		resolvedPath: artifact.path,
		contentType: "text/plain",
	};

	if (parsedSel.kind === "raw" && artifact.size > MAX_ARTIFACT_RAW_INLINE_BYTES) {
		return toolResult<ReadToolDetails>(details)
			.text(formatRawArtifactBlockedNotice(artifact, artifactUrl))
			.sourcePath(artifact.path)
			.sourceInternal(url.href)
			.done();
	}

	const rawSelector = isRawSelector(parsedSel);
	const displayMode = resolveFileDisplayMode(ctx.session, {
		raw: rawSelector,
		immutable: true,
		ranged: parsedSel.kind === "lines",
	});
	if (isMultiRange(parsedSel) && parsedSel.kind === "lines") {
		const read = await readLocalFileMultiRange(
			ctx,
			artifact.path,
			parsedSel.ranges,
			artifact.size,
			parsedSel,
			displayMode,
			undefined,
			signal,
			false,
		);
		if (read.bridgeResult) return read.bridgeResult;
		if (read.displayContent) details.displayContent = read.displayContent;
		let text = read.outputText;
		if (!rawSelector && artifact.size > MAX_ARTIFACT_RAW_INLINE_BYTES) {
			text = text
				? `${text}\n\n[${formatArtifactWorkflowNotice(artifact, artifactUrl)}]`
				: formatArtifactWorkflowNotice(artifact, artifactUrl);
		}
		const resultBuilder = toolResult<ReadToolDetails>(details)
			.text(text)
			.sourcePath(artifact.path)
			.sourceInternal(url.href);
		if (read.columnTruncated > 0) resultBuilder.limits({ columnMax: read.columnTruncated });
		return resultBuilder.done();
	}

	const { offset, limit } = selToOffsetLimit(parsedSel);
	const { requestedStart, startLine, startLineDisplay, maxLinesToCollect, selectedLineLimit, maxBytesForRead } =
		computeRangeWindow(offset, limit, rawSelector, ctx.defaultLimit, ctx.session);
	const streamResult = await streamLinesFromFile(
		artifact.path,
		startLine,
		maxLinesToCollect,
		maxBytesForRead,
		selectedLineLimit,
		signal,
		artifact.size > SNAPSHOT_MAX_BYTES,
	);
	const {
		lines: collectedLines,
		totalFileLines,
		collectedBytes,
		stoppedByByteLimit,
		firstLinePreview,
		firstLineByteLength,
		reachedEof,
	} = streamResult;

	if (requestedStart >= totalFileLines) {
		return toolResult<ReadToolDetails>(details)
			.text(formatOutOfBoundsMessage(requestedStart, totalFileLines, "artifact", `${artifactUrl}:`))
			.sourcePath(artifact.path)
			.sourceInternal(url.href)
			.done();
	}

	const shouldAddLineNumbers = rawSelector ? false : displayMode.hashLines ? false : displayMode.lineNumbers;
	const selectedContent = collectedLines.join("\n");
	const totalSelectedLines = totalFileLines - startLine;
	const wasTruncated = collectedLines.length < totalSelectedLines || stoppedByByteLimit;
	const firstLineExceedsLimit = firstLineByteLength !== undefined && firstLineByteLength > maxBytesForRead;
	const truncation: TruncationResult = {
		content: selectedContent,
		truncated: wasTruncated,
		truncatedBy: stoppedByByteLimit ? "bytes" : wasTruncated ? "lines" : undefined,
		totalLines: totalSelectedLines,
		totalBytes: collectedBytes,
		outputLines: collectedLines.length,
		outputBytes: collectedBytes,
		lastLinePartial: false,
		firstLineExceedsLimit,
	};

	let displayContent: ReadDisplayContent | undefined;
	const formatText = (text: string, startNum: number): string => {
		displayContent = { text, startLine: startNum };
		return formatTextWithMode(text, startNum, false, shouldAddLineNumbers);
	};

	let outputText: string;
	let truncationInfo: { result: TruncationResult; options: TruncationOptions } | undefined;
	if (truncation.firstLineExceedsLimit) {
		const firstLineBytes = firstLineByteLength ?? 0;
		const snippet = firstLinePreview ?? { text: "", bytes: 0 };
		outputText =
			snippet.text.length > 0
				? formatText(snippet.text, startLineDisplay)
				: `[Line ${startLineDisplay} is ${formatBytes(
						firstLineBytes,
					)}, exceeds ${formatBytes(maxBytesForRead)} limit. Unable to display a valid UTF-8 snippet.]`;
		truncationInfo = {
			result: truncation,
			options: {
				direction: "head",
				startLine: startLineDisplay,
				totalFileLines: reachedEof ? totalFileLines : undefined,
				totalLinesUnknown: !reachedEof,
			},
		};
	} else {
		outputText = formatText(truncation.content, startLineDisplay);
		if (truncation.truncated) {
			truncationInfo = {
				result: truncation,
				options: {
					direction: "head",
					startLine: startLineDisplay,
					totalFileLines: reachedEof ? totalFileLines : undefined,
					totalLinesUnknown: !reachedEof,
				},
			};
		} else if (startLine + collectedLines.length < totalFileLines || !reachedEof) {
			const nextOffset = startLine + collectedLines.length + 1;
			outputText += reachedEof
				? `\n\n[${formatMoreLines(totalFileLines - (startLine + collectedLines.length))} in artifact. Use ${artifactUrl}:${nextOffset} to continue]`
				: `\n\n[More lines in artifact (${formatBytes(artifact.size)} total; not scanned to EOF). Use ${artifactUrl}:${nextOffset} to continue]`;
		}
	}

	const paddingNotice = formatContextPaddingNotice({
		requestedFirstLine: requestedStart + 1,
		requestedLastLine: limit !== undefined ? requestedStart + limit : undefined,
		displayedFirstLine: startLineDisplay,
		displayedLastLine: startLineDisplay + Math.max(0, collectedLines.length - 1),
	});
	if (paddingNotice) outputText += `\n\n${paddingNotice}`;

	if (!rawSelector && artifact.size > MAX_ARTIFACT_RAW_INLINE_BYTES) {
		outputText += `\n\n[${formatArtifactWorkflowNotice(artifact, artifactUrl)}]`;
	}
	if (displayContent) details.displayContent = displayContent;
	if (truncationInfo) details.truncation = truncationSummary(truncationInfo.result);
	const resultBuilder = toolResult<ReadToolDetails>(details)
		.text(outputText)
		.sourcePath(artifact.path)
		.sourceInternal(url.href);
	if (truncationInfo) resultBuilder.truncation(truncationInfo.result, truncationInfo.options);
	return resultBuilder.done();
}
