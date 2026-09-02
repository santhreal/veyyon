/**
 * What the browser card shows, for any host.
 *
 * The tool half in `../browser.ts` decides what happened; this half decides what a reader is told,
 * and names no colour, glyph, width or component. A terminal draws it through
 * `src/modes/terminal/draw/draw-tool-view.ts`, and a second host writes its own mapping from the same value.
 *
 * The tool has three actions and two card shapes, and the split is the tool's own. `open` and
 * `close` report one operation on one tab, so they are a row: what was done, which tab, which
 * browser, which url, and whatever the tool printed under it. `run` reports a script, so it is a
 * panel: the javascript that was evaluated, the output it produced, and a note when the output was
 * cut short of what the model asked for.
 *
 * The code is stated as source in the language it is in, and never as coloured runs: a tool that
 * toned its own keywords would be writing a colour scheme. A row of the script's output is the other
 * case -- it is another program's screen, so a row carrying control sequences is marked captured and
 * every host decides how much of it it can replay.
 */

import type {
	FramedBlockView,
	HeadedBlockView,
	StatusRowView,
	ToolView,
	ToolViewContext,
	ToolViewRenderer,
	ViewLine,
	ViewSection,
} from "@veyyon/view";
import { formatTruncationMetaNotice, stripOutputNotice } from "../../core/output-notice";
import { replaceTabs, shortenPath } from "../../core/render-utils";
import type { BrowserToolDetails } from "../browser";

/** The tool's own mark, which a settled row is titled by instead of an outcome icon. */
const BROWSER_EMBLEM = "tool.browser";

/** The language the `run` action evaluates, which the host highlights the panel's source as. */
const RUN_LANGUAGE = "javascript";

/** Rows of the script, and rows of its output, a collapsed panel shows before it says what is left. */
const BROWSER_PREVIEW_LINES = 10;

/**
 * The ceiling an EXPANDED panel keeps.
 *
 * A card is a card rather than a file: a script or an output long enough to pass this is being read
 * in the wrong place, and the count of what is left is still stated. Kept where the collapsed
 * ceiling is, because both are decisions about how much a reader is shown and neither is a host's.
 */
const EXPANDED_MAX_LINES = 200;

/** The unit a held-back count is in, which the host words. */
const LINE_NOUN = { one: "line", many: "lines" } as const;

/** The call arguments a card reads, which are the tool's own input narrowed to what it shows. */
export interface BrowserViewArgs {
	action?: "open" | "close" | "run";
	name?: string;
	url?: string;
	code?: string;
	all?: boolean;
	kill?: boolean;
	app?: { path?: string; cdp_url?: string; target?: string; cmux?: boolean; surface?: string };
	viewport?: { width: number; height: number; scale?: number };
	timeout?: number;
}

/** The result a card reads, which is the tool's own result shape narrowed to what a card shows. */
export interface BrowserViewResult {
	content: Array<{ type: string; text?: string }>;
	details?: BrowserToolDetails;
	isError?: boolean;
}

/**
 * Which browser the tab is on, said in the words the call or the result gives.
 *
 * The arguments answer first, because a call card has no result to read and the model already named
 * the endpoint or the binary it asked for; the result's own tag answers for every launch the
 * arguments did not decide.
 */
function describeBrowser(args: BrowserViewArgs, details: BrowserToolDetails | undefined): string | undefined {
	const cdpUrl = typeof args.app?.cdp_url === "string" ? args.app.cdp_url : "";
	if (cdpUrl) return `connected ${cdpUrl}`;
	const appPath = typeof args.app?.path === "string" ? args.app.path : "";
	if (appPath) return `spawned ${shortenPath(appPath)}`;
	if (args.app?.cmux !== false && (args.app?.cmux === true || args.app?.surface)) {
		return args.app.surface ? `cmux ${args.app.surface}` : "cmux";
	}
	switch (details?.browser) {
		case "headless":
			return "headless";
		case "spawned":
			return "spawned";
		case "connected":
			return "connected";
		case "cmux":
			return "cmux";
		default:
			return undefined;
	}
}

/** The tab the card is about, quoted so a name with a space in it reads as one name. */
function tabLabel(args: BrowserViewArgs, details: BrowserToolDetails | undefined): string {
	const name = details?.name ?? args.name ?? "main";
	return `tab ${JSON.stringify(name)}`;
}

/** The url the card names, which the result knows and a call card takes from the arguments. */
function urlOf(args: BrowserViewArgs, details: BrowserToolDetails | undefined): string {
	if (typeof details?.url === "string") return details.url;
	return typeof args.url === "string" ? args.url : "";
}

/** Text with the blank tail a script or an output ends in dropped, so the panel ends where it does. */
function withoutTrailingBlanks(text: string): string {
	return text.replace(/\s+$/, "");
}

/**
 * Text as the rows a screen would have shown.
 *
 * A carriage return inside a row is a cursor sent back to column one, which is how every progress
 * bar draws itself, so the row is what was left standing after the last one. Done here rather than
 * left to a host: the rows are what the card SAYS, and a host that split on `\n` alone would be
 * shown one row holding four states of the same progress bar.
 */
function screenRows(text: string): string[] {
	return text.split(/\r?\n/).map(row => {
		const restart = row.lastIndexOf("\r");
		return restart < 0 ? row : row.slice(restart + 1);
	});
}

/** How many rows of a section a reader is shown, which the disclosure decides. */
function ceiling(expanded: boolean): number {
	return expanded ? EXPANDED_MAX_LINES : BROWSER_PREVIEW_LINES;
}

/** The script as source in the language it is in, cut to the rows this disclosure shows. */
function codeSection(code: string, expanded: boolean): ViewSection | undefined {
	if (!code) return undefined;
	const rows = screenRows(code);
	const kept = rows.slice(0, Math.min(rows.length, ceiling(expanded)));
	const held = rows.length - kept.length;
	return {
		lines: kept.map(row => [{ text: row }] as ViewLine),
		code: { language: RUN_LANGUAGE },
		...(held > 0 ? { hidden: { count: held, noun: LINE_NOUN, revealable: !expanded } } : {}),
	};
}

/**
 * What the script printed, as its own group under the source.
 *
 * A row that carries control sequences is the program's own screen row and is marked as one, so a
 * terminal replays the styles it trusts and a host that can replay none keeps the words. Every other
 * row is output the card colours as output, which is the tool stating what the row IS.
 */
function outputSection(output: string, expanded: boolean, label: string | undefined): ViewSection | undefined {
	if (!output) return undefined;
	const rows = screenRows(output);
	const kept = rows.slice(0, Math.min(rows.length, ceiling(expanded)));
	const held = rows.length - kept.length;
	return {
		...(label === undefined ? {} : { label }),
		lines: kept.map(row => outputRow(row)),
		...(held > 0 ? { hidden: { count: held, noun: LINE_NOUN, revealable: !expanded } } : {}),
	};
}

/** One row of output, verbatim when it is a screen row and toned as output when it is text. */
function outputRow(row: string): ViewLine {
	const text = replaceTabs(row);
	return row.includes("\x1b[") ? [{ text, captured: true }] : [{ text, tone: "output" }];
}

/**
 * That the output in hand is not all of it, which the tool knows and the reader would not.
 *
 * Its own group at the end of the panel rather than a row appended below the card: the notice is
 * about the output above it, and a host that frames a card would have drawn it outside the frame it
 * belongs to.
 */
function truncationSection(details: BrowserToolDetails | undefined): ViewSection | undefined {
	const truncation = details?.meta?.truncation;
	if (!truncation) return undefined;
	return { lines: [[{ text: formatTruncationMetaNotice(truncation), tone: "warning" }]] };
}

/** The head row of the `run` panel: the tab is the subject, the url and the browser are asides. */
function runHeader(
	args: BrowserViewArgs,
	details: BrowserToolDetails | undefined,
	options: { status?: StatusRowView["status"] },
): StatusRowView {
	const url = urlOf(args, details);
	const browser = describeBrowser(args, details);
	return {
		kind: "statusRow",
		...(options.status === undefined ? {} : { status: options.status }),
		title: tabLabel(args, details),
		titleTone: "title",
		...(url ? { description: shortenPath(url), descriptionTone: "accent" as const, descriptionLink: url } : {}),
		...(browser === undefined ? {} : { meta: [[{ text: browser }]] }),
	};
}

/**
 * The `run` card: the script, what it printed, and what was held back of either.
 *
 * The panel reports `running` while the result is still arriving and states no icon in its head row,
 * because an animated glyph at the head of a block pins a native-scrollback commit boundary there
 * and a growing panel could then never scroll-append. The host says what is running on a row of its
 * own instead.
 */
function runCard(
	args: BrowserViewArgs,
	details: BrowserToolDetails | undefined,
	context: ToolViewContext,
	output: string,
	isError: boolean,
): FramedBlockView {
	const partial = context.partial === true;
	const sections: ViewSection[] = [];
	const code = codeSection(withoutTrailingBlanks(args.code ?? ""), context.expanded);
	if (code !== undefined) sections.push(code);
	const printed = outputSection(output, context.expanded, "Output");
	if (printed !== undefined) sections.push(printed);
	const cut = truncationSection(details);
	if (cut !== undefined) sections.push(cut);
	return {
		kind: "framedBlock",
		header: runHeader(args, details, { status: partial ? undefined : isError ? "error" : "done" }),
		state: partial ? "running" : isError ? "error" : "success",
		sections,
	};
}

/**
 * The `open` and `close` card: one row for the operation, with whatever the tool printed under it.
 *
 * A settled row is titled by the tool's own mark and a failed or still-running one by its outcome,
 * which is what every row in this transcript does: the mark says which tool the row belongs to, and
 * an icon is spent only when the row has something else to report.
 */
function tabCard(
	args: BrowserViewArgs,
	details: BrowserToolDetails | undefined,
	context: ToolViewContext,
	output: string,
	isError: boolean,
): StatusRowView | HeadedBlockView {
	const partial = context.partial === true;
	const action = details?.action ?? args.action ?? "open";
	const meta: ViewLine[] = [];
	const browser = describeBrowser(args, details);
	if (browser !== undefined) meta.push([{ text: browser }]);
	const url = urlOf(args, details);
	if (url) meta.push([{ text: shortenPath(url), link: url }]);

	let title: string;
	if (action === "close") {
		const all = args.all === true || (args.name === undefined && details?.name === undefined);
		title = all ? "Close all tabs" : `Close ${tabLabel(args, details)}`;
		if (args.kill) title += " (kill)";
	} else {
		title = `Open ${tabLabel(args, details)}`;
	}

	const header: StatusRowView = {
		kind: "statusRow",
		...(partial
			? { status: "running" as const }
			: isError
				? { status: "error" as const }
				: { emblem: BROWSER_EMBLEM }),
		title,
		...(meta.length > 0 ? { meta } : {}),
	};
	const printed = outputSection(output, context.expanded, undefined);
	if (printed === undefined) return header;
	return {
		kind: "headedBlock",
		header,
		lines: printed.lines,
		...(printed.hidden === undefined ? {} : { hidden: printed.hidden }),
	};
}

/** The text parts of a result, which is everything a card shows of what the tool returned. */
function textOf(content: Array<{ type: string; text?: string }> | undefined): string {
	if (!content) return "";
	return withoutTrailingBlanks(
		content
			.filter(part => part.type === "text")
			.map(part => part.text ?? "")
			.join("\n"),
	);
}

export const browserToolView: Required<ToolViewRenderer<BrowserViewArgs, BrowserViewResult>> = {
	/**
	 * The card while the call is still arriving.
	 *
	 * A `run` describes its panel from the arguments alone, so the script appears as the model writes
	 * it; the other two actions have nothing to show beyond the operation, which is the row.
	 */
	renderCall(args, context: ToolViewContext): ToolView {
		if (args.action === "run") return runCard(args, undefined, context, "", false);
		return tabCard(args, undefined, context, "", false);
	},

	renderResult(result, context: ToolViewContext, args): ToolView {
		const called = args ?? {};
		const details = result.details;
		const isError = result.isError === true;
		// The notice the tool appended for the model is stated by the card as its own group, so the
		// reader is not shown the same sentence twice in two voices.
		const output = stripOutputNotice(textOf(result.content), details?.meta);
		if ((details?.action ?? called.action) === "run") return runCard(called, details, context, output, isError);
		return tabCard(called, details, context, output, isError);
	},
};
