/**
 * Reads of internal URLs: `agent://`, `artifact://`, `memory://`, `skill://`, `rule://`,
 * `local://`, `mcp://` and the other schemes the internal URL router resolves.
 */

import type { AgentToolResult } from "@veyyon/agent-core";
import { readImageMetadata } from "@veyyon/utils/mime";
import { errorMessage } from "@veyyon/utils/type-guards";
import { InternalUrlRouter, resolveLocalUrlToFile } from "../../internal-urls";
import { parseInternalUrl } from "../../internal-urls/parse";
import type { InternalUrl } from "../../internal-urls/types";
import { truncateHeadBytes } from "../../session/streaming-output";
import { inlineBudgetFor } from "../core/output-artifact";
import type { ParsedSelector } from "../core/path-utils";
import { formatBytes } from "../core/render-utils";
import { ToolError } from "../core/tool-errors";
import { toolResult } from "../core/tool-result";
import { readArtifactFile } from "./read-artifact";
import { buildInMemoryResult } from "./read-in-memory";
import { loadImageContent } from "./read-media";
import type { ReadContext, ReadToolDetails } from "./read-types";

/**
 * Handle internal URLs (agent://, artifact://, memory://, skill://, rule://, local://, mcp://).
 * Supports pagination via offset/limit but rejects them when query extraction is used.
 */
export async function handleInternalUrl(
	ctx: ReadContext,
	url: string,
	parsedSel: ParsedSelector,
	signal?: AbortSignal,
): Promise<AgentToolResult<ReadToolDetails>> {
	const internalRouter = InternalUrlRouter.instance();

	// Check if URL has query extraction (agent:// only).
	// Use parseInternalUrl which handles colons in host (namespaced skills).
	let urlMeta: InternalUrl;
	try {
		urlMeta = parseInternalUrl(url);
	} catch (e) {
		throw new ToolError(errorMessage(e));
	}
	const scheme = urlMeta.protocol.replace(/:$/, "").toLowerCase();
	let hasExtraction = false;
	if (scheme === "agent") {
		const hasPathExtraction = urlMeta.pathname && urlMeta.pathname !== "/" && urlMeta.pathname !== "";
		const queryParam = urlMeta.searchParams.get("q");
		const hasQueryExtraction = queryParam !== null && queryParam !== "";
		hasExtraction = hasPathExtraction || hasQueryExtraction;
	}
	if (scheme === "artifact") {
		return readArtifactFile(ctx, urlMeta, parsedSel, signal);
	}

	// local:// files are real on-disk paths. Detect image files and emit a
	// decoded image block before the text-only resource contract UTF-8
	// decodes the binary into mojibake. The fast path returns null for
	// non-images, directories, listings, or any resolution failure, so the
	// text path below reproduces the router's not-found / symlink-escape
	// behavior unchanged.
	if (scheme === "local") {
		const imageResult = await tryReadLocalImage(ctx, urlMeta, signal);
		if (imageResult) return imageResult;
	}

	// Reject line selectors when query extraction is used
	if (hasExtraction && parsedSel.kind !== "none" && parsedSel.kind !== "raw") {
		throw new ToolError("Cannot combine query extraction with line selectors");
	}

	// Resolve the internal URL
	const resource = await internalRouter.resolve(url, {
		cwd: ctx.session.cwd,
		settings: ctx.session.settings,
		signal,
		localProtocolOptions: ctx.session.localProtocolOptions,
		skills: ctx.session.skills,
	});
	const details: ReadToolDetails = { resolvedPath: resource.sourcePath, contentType: resource.contentType };

	// An extracted field carries no line selector (rejected above), so nothing
	// pages it: bound it here and state the size, and the caller reads the
	// resource without extraction to page the rest.
	if (hasExtraction) {
		const budget = inlineBudgetFor(ctx.session);
		const totalBytes = Buffer.byteLength(resource.content, "utf-8");
		// Byte truncation, not line truncation: an extracted field is routinely
		// one long line, and a line-based cap drops it whole rather than
		// carrying the part that fits.
		const text =
			totalBytes > budget
				? `${truncateHeadBytes(resource.content, budget).text}\n[Extracted value reached the ${formatBytes(budget)} output budget; ${formatBytes(totalBytes)} in total. Read ${url} without the extraction to page it]`
				: resource.content;
		return toolResult(details).text(text).sourceInternal(url).done();
	}

	return buildInMemoryResult(ctx.session, resource.content, parsedSel, {
		details,
		sourcePath: resource.sourcePath,
		sourceInternal: url,
		entityLabel: "resource",
		ignoreResultLimits: scheme === "skill",
		immutable: resource.immutable,
	});
}

/**
 * Fast path for `local://` image files. Resolves the URL to its real
 * on-disk path with the same realpath + containment checks as
 * {@link LocalProtocolHandler.resolve} (via {@link resolveLocalUrlToFile}),
 * and — only when the target is a genuine image — emits a decoded image
 * block. Returns null for non-images, directories, listings, or any
 * resolution failure (not-found, symlink escape) so the caller falls back to
 * normal text resolution, which reproduces the router's errors. Errors from
 * a confirmed image (too large / unsupported) propagate rather than
 * degrading into a corrupted text read.
 */
async function tryReadLocalImage(
	ctx: ReadContext,
	url: InternalUrl,
	signal?: AbortSignal,
): Promise<AgentToolResult<ReadToolDetails> | null> {
	let file: { path: string; size: number } | null;
	try {
		file = await resolveLocalUrlToFile(url, {
			cwd: ctx.session.cwd,
			settings: ctx.session.settings,
			signal,
			localProtocolOptions: ctx.session.localProtocolOptions,
		});
	} catch {
		// Not found / containment escape / no session — let the text path
		// surface the router's canonical error.
		return null;
	}
	if (!file) return null;

	const imageMetadata = await readImageMetadata(file.path);
	const mimeType = imageMetadata?.mimeType;
	if (!mimeType) return null;

	const { content, details, sourcePath } = await loadImageContent(ctx, {
		readPath: url.href,
		absolutePath: file.path,
		mimeType,
		imageMetadata,
		fileSize: file.size,
	});
	const resultBuilder = toolResult(details).content(content).sourceInternal(url.href);
	if (sourcePath) resultBuilder.sourcePath(sourcePath);
	return resultBuilder.done();
}
