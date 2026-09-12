/**
 * What the write card shows, for any host.
 *
 * The tool half in `write.ts` decides what was written and what the compiler said about it; this
 * half states what the card says and names no colour, no glyph, no gutter and no width. The file's
 * text is a code section — the language and the line numbers, never the highlighting — so a terminal
 * colours it and draws a gutter, an editor host hands the lines to its own tokenizer, and a
 * transcript export writes a fenced block.
 */

import { Ellipsis } from "@veyyon/natives";
import { formatCount } from "@veyyon/utils/format";
import { countLines, parseWriteArgs, parseWriteDetails } from "@veyyon/utils/fs-tool-args";
import { replaceTabs } from "@veyyon/utils/tab-width";
import type {
	FramedBlockView,
	StatusRowView,
	ToolView,
	ToolViewContext,
	ToolViewRenderer,
	ViewLine,
	ViewSection,
} from "@veyyon/view";
import { getLanguageFromPath } from "../../utils/lang-from-path";
import { diagnosticsSection } from "../core/diagnostics";
import { extractResultText } from "../core/output-notice";
import {
	errorSection,
	heldBack,
	LINE_NOUN,
	shortenPath,
	type ToolViewResult,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "../core/render-utils";
import type { WriteToolDetails } from "./write";

/** What every card of this tool is titled. */
const WRITE_TITLE = "Write";

/** The tool's own mark, which a settled card is titled by instead of an outcome icon. */
const WRITE_EMBLEM = "tool.write";

/** Lines of the file a collapsed settled card shows before it says how many it kept back. */
const WRITE_PREVIEW_LINES = 6;

export const WRITE_STREAMING_PREVIEW_LINES = 12;

export function normalizeDisplayText(text: unknown): string {
	let displayText = "";
	if (typeof text === "string") {
		displayText = text;
	} else if (text !== undefined && text !== null) {
		displayText = String(text);
	}
	return displayText.replace(/\r/g, "");
}

/**
 * Whether the text a call carries outgrows the window a streaming preview shows.
 *
 * A bounded newline scan rather than a split, because this runs on every live compose while the
 * model writes: the answer is whether the count passes the window, so the scan stops the moment it
 * does and never materializes the lines.
 */
export function writeContentExceedsStreamingWindow(args: unknown): boolean {
	if (args == null || typeof args !== "object" || !("content" in args)) return false;
	const content = args.content;
	if (typeof content !== "string" || !content) return false;
	let lines = 1;
	for (let index = content.indexOf("\n"); index !== -1; index = content.indexOf("\n", index + 1)) {
		if (++lines > WRITE_STREAMING_PREVIEW_LINES) return true;
	}
	return false;
}

/** The arguments the card reads off the call, which are the path under either name and the text. */
export interface WriteViewArgs {
	path?: unknown;
	file_path?: unknown;
	content?: unknown;
}

/** The result the card reads, which is the tool's own result shape narrowed to what a card shows. */
export interface WriteViewResult extends ToolViewResult<WriteToolDetails> {}

/**
 * The head row of every write card: the tool's subject is the file, so the file is the description.
 *
 * The readable path is the description and the absolute one the write resolved to is the target a
 * host opens, because the two differ — the model may send a relative path, and a `file://` URI built
 * from one points nowhere. The language is stated even when the extension names none, which is a
 * file whose language the tool could not tell rather than a row that names no file.
 */
function header(
	rawPath: string,
	options: {
		status?: StatusRowView["status"];
		emblem?: string;
		linkTarget?: string;
		meta?: readonly ViewLine[];
	},
): StatusRowView {
	const shortened = shortenPath(rawPath);
	return {
		kind: "statusRow",
		...(options.status === undefined ? {} : { status: options.status }),
		...(options.emblem === undefined ? {} : { emblem: options.emblem }),
		title: WRITE_TITLE,
		description: shortened || "…",
		descriptionTone: shortened ? "accent" : "output",
		...(shortened && options.linkTarget !== undefined ? { descriptionFile: options.linkTarget } : {}),
		language: rawPath ? (getLanguageFromPath(rawPath) ?? "") : "",
		...(options.meta === undefined ? {} : { meta: options.meta }),
	};
}

/** The file's text as a code section, numbered by where each line sits in the file. */
function codeSection(
	content: string,
	options: { language: string | undefined; visible: number | undefined; tailRows?: number },
): ViewSection | undefined {
	if (!content) return undefined;
	const lines = normalizeDisplayText(content).split("\n");
	const kept = options.visible === undefined ? lines : lines.slice(0, Math.min(lines.length, options.visible));
	const held = lines.length - kept.length;
	const hidden = heldBack(held, LINE_NOUN);
	return {
		lines: kept.map(line => [{ text: line }] as ViewLine),
		code: { language: options.language, firstLineNumber: 1, totalLines: lines.length },
		...(hidden === undefined ? {} : { hidden }),
		...(options.tailRows === undefined ? {} : { tail: { max: options.tailRows } }),
	};
}

/**
 * The trailing detail of a result card: how long the file is, and that it was made runnable.
 *
 * Entries rather than text written into the description, so the host puts its own separator between
 * them: the card states two facts about the write and never the dot between them. The length is
 * stated while the write is still arriving, because the text in hand is the file as far as it goes;
 * the execute bit is not, because it is set once the write finishes.
 */
function resultMeta(lineCount: number, madeExecutable: boolean): ViewLine[] {
	const meta: ViewLine[] = [];
	if (lineCount > 0) meta.push([{ text: formatCount("line", lineCount) }]);
	if (madeExecutable) meta.push([{ text: "made executable!", tone: "success" }]);
	return meta;
}

export const writeToolView: Required<ToolViewRenderer<WriteViewArgs, WriteViewResult>> = {
	/**
	 * The card while the model is still writing the file.
	 *
	 * No status icon: the head row is the head of a framed block, and a native-scrollback commit is
	 * prefix-only, so an animated glyph there would pin the commit boundary at the top of the block
	 * and a long preview could never scroll-append mid-stream. The block reports `running` instead,
	 * which the host says on a trailing row of its own.
	 *
	 * The section is the whole file with a window onto its end, because the reader is watching the
	 * streaming edge: the host cuts the front off to the rows it has, and an expanded card asks for
	 * the whole of it.
	 */
	renderCall(args, context: ToolViewContext): ToolView {
		// The path through the shared parser; the content straight from the args, because a runtime
		// that hands the tool an array or a number still shows its text here, coerced.
		const rawPath = parseWriteArgs(args).path ?? "";
		const content = normalizeDisplayText(args.content);
		const section = codeSection(content, {
			language: rawPath ? (getLanguageFromPath(rawPath) ?? "text") : "text",
			visible: undefined,
			tailRows: context.expanded ? undefined : WRITE_STREAMING_PREVIEW_LINES,
		});
		return {
			kind: "framedBlock",
			header: header(rawPath, {}),
			state: "running",
			sections: section === undefined ? [] : [section],
		};
	},

	renderResult(result, context: ToolViewContext, args): ToolView {
		const rawPath = parseWriteArgs(args).path ?? "";
		const linkTarget = result.details?.resolvedPath;
		const language = rawPath ? getLanguageFromPath(rawPath) : undefined;

		if (result.isError) {
			const text = extractResultText(result.content);
			return {
				kind: "framedBlock",
				header: header(rawPath, { status: "error", linkTarget }),
				state: "error",
				sections: [errorSection(text)],
			};
		}

		const partial = context.partial === true;
		const content = normalizeDisplayText(args?.content);
		const lineCount = countLines(content);
		const parsedDetails = parseWriteDetails(result.details);
		const section = codeSection(content, {
			language,
			visible: context.expanded ? undefined : WRITE_PREVIEW_LINES,
		});
		const sections: ViewSection[] = [];

		// While the result is still an update, the tool's own progress text leads the card: it says
		// which pass of a long write is running, and the file under it is what the pass has produced.
		const progress = partial ? extractResultText(result.content) : "";
		if (progress) {
			sections.push({
				lines: [
					[
						{
							text: truncateToWidth(replaceTabs(progress), TRUNCATE_LENGTHS.LINE, Ellipsis.Unicode),
							tone: "muted",
						},
					],
				],
			});
		}
		if (section !== undefined) sections.push(section);

		const diagnostics = partial ? undefined : result.details?.diagnostics;
		const diagnosed = diagnostics === undefined ? undefined : diagnosticsSection(diagnostics, context.expanded);
		if (diagnosed !== undefined) sections.push(diagnosed);

		const card: FramedBlockView = {
			kind: "framedBlock",
			header: header(rawPath, {
				...(partial ? { status: "running" } : { emblem: WRITE_EMBLEM }),
				linkTarget,
				meta: resultMeta(lineCount, !partial && parsedDetails.madeExecutable),
			}),
			// A partial result keeps the spinner in its head row, where the streaming call card has
			// none: the call card is the one that scroll-appends, and this one is replaced whole on
			// every update. So the block reports `pending` and the row reports what is running.
			state: partial ? "pending" : "success",
			sections,
		};
		return card;
	},
};
