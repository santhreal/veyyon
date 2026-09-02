/**
 * What the read card shows, for any host.
 *
 * The tool half in `read.ts` decides what happened; this half states what a reader is told and names
 * no colour, glyph, gutter or width. A terminal draws it through `src/modes/terminal/draw/draw-tool-view.ts`, and a
 * host that formats documents itself draws the same card from the same value.
 *
 * The card's subject is the file, so the file is the row's description and the content is a section
 * the host lays out: source for a program, a document for Markdown, and neither for a picture, whose
 * card states what the read resolved rather than what it drew. A read of several windows onto one
 * file states the number of every line it shows, because the numbers jump and a first-line number
 * would make the second window read as a continuation of the first.
 *
 * A URL is not this card at all: the tool serves both a path and an address, and an address is the
 * read_url card, so this delegates to that view rather than restating it.
 */

import * as path from "node:path";
import { formatCount } from "@veyyon/utils/format";
import { hasUrlScheme } from "@veyyon/utils/url";
import type {
	FramedBlockView,
	StatusRowView,
	ToolView,
	ToolViewContext,
	ToolViewRenderer,
	ViewLine,
	ViewSection,
} from "@veyyon/view";
import { tryResolveInternalUrlSync } from "../../internal-urls/resolve-sync";
import { getLanguageFromPath } from "../../utils/lang-from-path";
import { stripOutputNotice } from "../core/output-meta";
// The notice module that owns the sentences, not `output-meta`, which forwards them through the
// tool wrapper: this file needs the words a truncation and an artifact are named by.
import { formatFullOutputReference, formatTruncationMetaNotice } from "../core/output-notice";
import { isReadableUrlPath, splitInternalUrlSel, splitPathAndSel } from "../core/path-utils";
import { formatBytes, replaceTabs, shortenPath } from "../core/render-utils";
import type { ReadUrlToolDetails } from "../web/fetch";
import { readUrlToolView } from "../web/fetch-view";
import { isRawSelector, parseSel, type ReadRenderArgs, type ReadToolDetails, readSourceFsPath } from "./read";

/** What every card of this tool is titled. */
const READ_TITLE = "Read";

/** Lines of the file a card shows before it says how many it kept back, at each disclosure state. */
const CONTENT_LINES = { collapsed: 12, expanded: 200 } as const;

/** Lines of the card's notices shown at each disclosure state, which is what `Output` holds. */
const NOTICE_LINES = { collapsed: 6, expanded: 200 } as const;

/** The unit a held-back count is in, which the host words. */
const LINE_NOUN = { one: "line", many: "lines" } as const;

/** The result a card reads, which is the tool's own result shape narrowed to what a card shows. */
export interface ReadViewResult {
	content?: Array<{ type: string; text?: string }>;
	details?: ReadToolDetails;
	isError?: boolean;
}

/** The path the call names, under either of the two argument names the model may send. */
function pathOf(args: ReadRenderArgs | undefined): string {
	if (typeof args?.file_path === "string") return args.file_path;
	if (typeof args?.path === "string") return args.path;
	return "";
}

/** The path and the selector after it, which are one argument the model sends as one string. */
function splitReadPath(rawPath: string): { path: string; sel?: string } {
	if (hasUrlScheme(rawPath)) {
		const internal = splitInternalUrlSel(rawPath);
		if (internal.sel) return internal;
	}
	return splitPathAndSel(rawPath);
}

/** The line a selector starts at, which is the line a host opens the file AT. */
function firstSelectorLine(sel: string | undefined): number | undefined {
	if (!sel) return undefined;
	try {
		const parsed = parseSel(sel);
		if (parsed.kind !== "lines") return undefined;
		return parsed.ranges[0].startLine;
	} catch {
		// A selector this card cannot parse names no line to open at. The call itself parses the same
		// selector and reports what is wrong with it; the card must not raise a second time.
		return undefined;
	}
}

/** The range an `offset`/`limit` pair names, as the selector suffix a reader recognises. */
function rangeSuffix(args: ReadRenderArgs | undefined): string {
	if (args?.offset === undefined && args?.limit === undefined) return "";
	const startLine = args.offset ?? 1;
	const endLine = args.limit === undefined ? "" : `-${startLine + args.limit - 1}`;
	return `:${startLine}${endLine}`;
}

/**
 * What the row says it read, and the file a host opens for it.
 *
 * The words are the path as the reader wrote it, shortened against the home directory and carrying
 * its selector; the target is the absolute path the read resolved to, because a host cannot open a
 * relative one and the two differ whenever the model sent a relative path or an internal URL.
 */
function describeTarget(
	rawPath: string,
	options: {
		resolvedPath?: string;
		sourcePath?: string;
		suffixResolution?: { from: string; to: string };
		offset?: number;
		fallbackLabel?: string;
	},
): { label: string; target?: string; line?: number } {
	const split = splitReadPath(rawPath);
	const basePath = split.path || rawPath;
	const selectorSuffix = split.sel ? `:${split.sel}` : "";
	const plain = options.suffixResolution
		? shortenPath(options.suffixResolution.to)
		: shortenPath(basePath || options.resolvedPath || options.fallbackLabel || rawPath);
	const absoluteInput = path.isAbsolute(basePath) ? basePath : undefined;
	const target = options.resolvedPath ?? options.sourcePath ?? tryResolveInternalUrlSync(basePath) ?? absoluteInput;
	const line = firstSelectorLine(split.sel) ?? options.offset;
	return {
		label: `${plain}${selectorSuffix}`,
		...(target === undefined ? {} : { target }),
		...(line === undefined ? {} : { line }),
	};
}

/**
 * The head row of a read card: the tool is the title and the file is the description.
 *
 * The file the row names is the target a host opens, and the line the selector starts at is the
 * position inside it, so following the row lands where the read did rather than at the top of the
 * file.
 */
function header(
	rawPath: string,
	args: ReadRenderArgs | undefined,
	options: {
		status?: StatusRowView["status"];
		resolvedPath?: string;
		sourcePath?: string;
		suffixResolution?: { from: string; to: string };
		fallbackLabel?: string;
		meta?: readonly ViewLine[];
	},
): StatusRowView {
	const described = describeTarget(rawPath, {
		...(options.resolvedPath === undefined ? {} : { resolvedPath: options.resolvedPath }),
		...(options.sourcePath === undefined ? {} : { sourcePath: options.sourcePath }),
		...(options.suffixResolution === undefined ? {} : { suffixResolution: options.suffixResolution }),
		...(args?.offset === undefined ? {} : { offset: args.offset }),
		...(options.fallbackLabel === undefined ? {} : { fallbackLabel: options.fallbackLabel }),
	});
	const description = `${described.label}${rangeSuffix(args)}`;
	return {
		kind: "statusRow",
		...(options.status === undefined ? {} : { status: options.status }),
		title: READ_TITLE,
		...(description
			? {
					description,
					...(described.target === undefined ? {} : { descriptionFile: described.target }),
					...(described.line === undefined ? {} : { descriptionFileLine: described.line }),
				}
			: {}),
		...(options.meta === undefined || options.meta.length === 0 ? {} : { meta: options.meta }),
	};
}

/**
 * Trailing detail of a settled read: the correction it made, and what it could not show whole.
 *
 * Entries rather than words written into the title, so the host puts its own separator between them:
 * a read that corrected a suffix, elided spans of a summary and found conflict markers states three
 * facts about one file and never the punctuation between them.
 */
function resultMeta(details: ReadToolDetails | undefined): ViewLine[] {
	const meta: ViewLine[] = [];
	const suffix = details?.suffixResolution;
	if (suffix) meta.push([{ text: `corrected from ${shortenPath(suffix.from)}`, tone: "dim" }]);
	if (details?.summary) {
		meta.push([{ text: `summary: ${formatCount("elided span", details.summary.elidedSpans)}` }]);
	}
	if (details?.conflictCount !== undefined && details.conflictCount > 0) {
		meta.push([{ text: `warn ${formatCount("conflict", details.conflictCount)}`, tone: "warning" }]);
	}
	return meta;
}

/**
 * Text as the rows a screen would have shown.
 *
 * A carriage return inside a line is a cursor sent back to column one, so what a reader saw is
 * whatever was written after the last one: the same reading the terminal's own cells give, made here
 * because the rows a card states are rows and not a stream of control characters. Tabs are left
 * alone, because how wide a tab is belongs to the host.
 */
function screenRows(text: string): string[] {
	return text.split(/\r?\n/).map(row => {
		const at = row.lastIndexOf("\r");
		return at < 0 ? row : row.slice(at + 1);
	});
}

/**
 * The lines a card holds back at this disclosure, and how many that leaves unsaid.
 *
 * The ceiling is the tool's, because the tool knows what the section IS: a file gets more rows than a
 * notice, and both get the same two hundred once a reader has asked for the whole card.
 */
function window(rows: string[], expanded: boolean, limits: { collapsed: number; expanded: number }) {
	const max = expanded ? limits.expanded : limits.collapsed;
	const kept = rows.slice(0, Math.min(rows.length, max));
	return { kept, held: rows.length - kept.length };
}

/**
 * The file's text as the section a host draws it as: source it colours and numbers, or a document it
 * formats.
 *
 * A Markdown read is the second, and a raw one is the first: `:raw` and `raw: true` both state that
 * the reader asked for the bytes, and bytes are source however the file is written. The numbers come
 * from the read when it reports them one per line, which is what a multi-range window and a
 * structural summary are, and from the window's own start line otherwise.
 */
function contentSection(
	content: string,
	options: { language: string | undefined; markdown: boolean; expanded: boolean; details?: ReadToolDetails },
): ViewSection | undefined {
	if (!content) return undefined;
	const rows = screenRows(content);
	const { kept, held } = window(rows, options.expanded, CONTENT_LINES);
	const lines = kept.map(row => [{ text: row }] as ViewLine);
	const hidden = held > 0 ? { hidden: { count: held, noun: LINE_NOUN, revealable: !options.expanded } } : {};
	if (options.markdown) return { lines, markdown: true, ...hidden };
	const display = options.details?.displayContent;
	const numbers = display?.lineNumbers?.slice(0, kept.length);
	return {
		lines,
		code: {
			...(options.language === undefined ? {} : { language: options.language }),
			...(numbers === undefined
				? display?.startLine === undefined
					? {}
					: { firstLineNumber: display.startLine }
				: { lineNumbers: numbers }),
		},
		...hidden,
	};
}

/**
 * What the read has to say about itself beside the file: where it resolved to, and what it could not
 * deliver whole.
 *
 * A truncated first line is its own sentence, because the bound it hit is a byte ceiling rather than
 * a line count and the artifact holding the rest is the only way to see it.
 */
function noticeLines(details: ReadToolDetails | undefined): ViewLine[] {
	const lines: ViewLine[] = [];
	if (details?.resolvedPath) {
		lines.push([{ text: `Resolved path: ${shortenPath(details.resolvedPath)}`, tone: "dim" }]);
	}
	const truncation = details?.meta?.truncation;
	if (!truncation) return lines;
	const fallback = details?.truncation;
	if (fallback?.firstLineExceedsLimit) {
		const limit = formatBytes(fallback.outputBytes ?? fallback.totalBytes);
		const reference = truncation.artifactId ? `. ${formatFullOutputReference(truncation.artifactId)}` : "";
		lines.push([{ text: `First line exceeds ${limit} limit${reference}`, tone: "warning" }]);
		return lines;
	}
	lines.push([{ text: formatTruncationMetaNotice(truncation), tone: "warning" }]);
	return lines;
}

/** The card's notices as their own group, or nothing when the read had none to state. */
function noticeSection(details: ReadToolDetails | undefined, expanded: boolean): ViewSection | undefined {
	const lines = noticeLines(details);
	if (lines.length === 0) return undefined;
	const max = expanded ? NOTICE_LINES.expanded : NOTICE_LINES.collapsed;
	const held = Math.max(0, lines.length - max);
	return {
		label: "Output",
		lines: lines.slice(0, Math.min(lines.length, max)),
		...(held > 0 ? { hidden: { count: held, noun: LINE_NOUN, revealable: !expanded } } : {}),
	};
}

/** The text parts of a result, which is everything a card shows of what the tool returned. */
function textOf(content: Array<{ type: string; text?: string }> | undefined): string {
	if (!content) return "";
	return content
		.filter(part => part.type === "text")
		.map(part => part.text ?? "")
		.join("\n");
}

/** Whether the result carries a picture, which is a card that states the read and draws no source. */
function hasImage(result: ReadViewResult): boolean {
	return result.content?.some(part => part.type === "image") === true;
}

/** Whether the reader asked for the file's bytes, which is source however the file is written. */
function rawRequested(rawPath: string, args: ReadRenderArgs | undefined): boolean {
	if (args?.raw === true) return true;
	try {
		return isRawSelector(parseSel(splitReadPath(rawPath).sel));
	} catch {
		// A selector the card cannot parse states no mode, so the file is shown as what it is.
		return false;
	}
}

export const readToolView: Required<ToolViewRenderer<ReadRenderArgs, ReadViewResult>> = {
	/** The card while the read is still running: the tool, and the file it was asked for. */
	renderCall(args, context: ToolViewContext): ToolView {
		const rawPath = pathOf(args);
		if (isReadableUrlPath(rawPath)) {
			return readUrlToolView.renderCall(
				{ path: rawPath, ...(args.raw === undefined ? {} : { raw: args.raw }) },
				context,
			);
		}
		return header(rawPath, args, { status: "pending", fallbackLabel: "…" });
	},

	renderResult(result, context: ToolViewContext, args): ToolView {
		const rawPath = pathOf(args);
		const urlDetails = result.details as ReadUrlToolDetails | undefined;
		if (urlDetails?.kind === "url" || isReadableUrlPath(rawPath)) {
			return readUrlToolView.renderResult(
				{
					content: result.content ?? [],
					...(urlDetails === undefined ? {} : { details: urlDetails }),
					...(result.isError === undefined ? {} : { isError: result.isError }),
				},
				context,
				{ path: rawPath, ...(args?.raw === undefined ? {} : { raw: args.raw }) },
			);
		}

		const details = result.details;

		if (result.isError === true) {
			const text = (textOf(result.content) || "Unknown error").replace(/^Error:\s*/, "");
			return {
				kind: "framedBlock",
				header: header(rawPath, args, {
					status: "error",
					...(readSourceFsPath(details) === undefined ? {} : { sourcePath: readSourceFsPath(details) }),
				}),
				state: "error",
				// A message a failed read carries often embeds file content, and a tab in a plain row opens
				// a hole in the card rather than a column: the rows of a code section are widened by the
				// host's own highlighter, and a row of prose is widened here.
				sections: [
					{ lines: screenRows(text).map(row => [{ text: replaceTabs(row), tone: "error" as const }] as ViewLine) },
				],
			};
		}

		// The structured display text when the read reported one, so the card shows the file's own
		// lines rather than the hashline anchors the model reads; the notice appended for the model is
		// stated by the card as its own group, so a reader is not told the same thing twice.
		const content = details?.displayContent?.text ?? stripOutputNotice(textOf(result.content), details?.meta);
		const suffix = details?.suffixResolution;
		const sourcePath = readSourceFsPath(details);
		const sections: ViewSection[] = [];

		if (hasImage(result)) {
			const detail = screenRows(content)
				.filter(row => row.length > 0)
				.map(row => [{ text: replaceTabs(row), tone: "output" as const }] as ViewLine);
			const notices = noticeLines(details);
			const lines = [...detail, ...notices];
			sections.push({
				label: "Details",
				lines: lines.length > 0 ? lines : [[{ text: "(image)", tone: "dim" }]],
			});
			return {
				kind: "framedBlock",
				header: header(rawPath, args, {
					status: suffix ? "warning" : "success",
					...(details?.resolvedPath === undefined ? {} : { resolvedPath: details.resolvedPath }),
					...(sourcePath === undefined ? {} : { sourcePath }),
					...(suffix === undefined ? {} : { suffixResolution: suffix }),
					fallbackLabel: "image",
					meta: resultMeta(details),
				}),
				state: "success",
				sections,
			};
		}

		const language = getLanguageFromPath(splitReadPath(rawPath).path);
		const markdown = details?.contentType === "text/markdown" && !rawRequested(rawPath, args);
		const body = contentSection(content, {
			language,
			markdown,
			expanded: context.expanded,
			...(details === undefined ? {} : { details }),
		});
		if (body !== undefined) sections.push(body);
		const notices = noticeSection(details, context.expanded);
		if (notices !== undefined) sections.push(notices);

		const card: FramedBlockView = {
			kind: "framedBlock",
			header: header(rawPath, args, {
				status: "done",
				...(details?.resolvedPath === undefined ? {} : { resolvedPath: details.resolvedPath }),
				...(sourcePath === undefined ? {} : { sourcePath }),
				...(suffix === undefined ? {} : { suffixResolution: suffix }),
				meta: resultMeta(details),
			}),
			state: "success",
			sections,
		};
		return card;
	},
};
