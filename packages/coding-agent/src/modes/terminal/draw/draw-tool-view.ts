/**
 * How the terminal draws a host-agnostic tool view.
 *
 * A tool that returns a `ToolView` states what its output means and names no colour, glyph or
 * component. This module is the terminal's answer to that value: it maps a tone to a theme colour, a
 * status to a theme glyph, and a status row to the status line every other tool header already uses.
 * A second host writes its own mapping from the same view and needs nothing from here.
 *
 * The mappings are exhaustive records rather than casts, so adding a tone or a status to the contract
 * fails to compile here until the terminal says how it draws it. That is the point: a host that
 * silently falls back to plain text for an unknown tone loses the meaning the tool sent.
 */

import { Ellipsis } from "@veyyon/natives";
import { type Component, Markdown, renderInlineMarkdown, TERMINAL, Text } from "@veyyon/tui";
import { pluralize } from "@veyyon/utils/format";
import { padding } from "@veyyon/utils/padding";
import { sliceWithWidth, truncateToWidth, visibleWidth } from "@veyyon/utils/width";
import { wrapTextWithAnsi } from "@veyyon/utils/wrap";
import type {
	FramedBlockView,
	HeadedBlockView,
	LineToolView,
	NoticeView,
	StatusRowView,
	TextBlockView,
	ToolView,
	ToolViewContext,
	ToolViewRenderer,
	ViewCodeLines,
	ViewDiffLines,
	ViewDiffSide,
	ViewHiddenCount,
	ViewLine,
	ViewSpan,
	ViewStatus,
	ViewTailWindow,
	ViewTone,
	ViewTreeLines,
} from "@veyyon/view";
import type { RenderResultOptions } from "../../../extensibility/custom-tools/types";
import { highlightCode } from "../../../theme/highlight";
import { getMarkdownTheme } from "../../../theme/markdown-theme";
import { shimmerEnabled, shimmerText } from "../../../theme/shimmer";
import { type SymbolKey, UNICODE_SYMBOLS } from "../../../theme/symbols";
import type { Theme, ThemeColor } from "../../../theme/theme";
import {
	formatBadge,
	formatExpandHint,
	formatStatusIcon,
	previewWindowRows,
	replaceTabs,
} from "../../../tools/core/render-utils";
import type { ToolUIStatus } from "../../../tools/core/tool-ui-status";
import type { FirstResultViewportRepaint } from "../../../tools/renderers";
import { paintHotTail, shimmerPhase } from "../components/chrome/follow";
import { renderDiff } from "../components/transcript/diff";
import { fileHyperlink, urlHyperlink } from "./hyperlink";
import { framedBlock, outputBlockContentWidth } from "./output-block";
import { renderStatusLine } from "./status-line";
import { styleTerminalRow } from "./terminal-row";
import { renderTreeList } from "./tree-list";
import type { State } from "./types";
import { createCachedComponent, padToWidth } from "./utils";
import { wrapDiffRow } from "./wrap-diff-row";

/**
 * The theme colour each tone draws as.
 *
 * Two tones may share a colour; a tone is a meaning, not a palette entry. `info` takes `infoAccent`
 * rather than plain `accent` so an informational span stays distinguishable from the subject of the
 * row.
 */
const TONE_COLORS: Record<ViewTone, ThemeColor> = {
	title: "toolTitle",
	accent: "accent",
	link: "mdLinkUrl",
	output: "toolOutput",
	muted: "muted",
	dim: "dim",
	diffAdded: "toolDiffAdded",
	diffRemoved: "toolDiffRemoved",
	success: "success",
	warning: "warning",
	error: "error",
	info: "infoAccent",
	cost: "statusLineCost",
	text: "text",
};

/**
 * The terminal status each view status draws as.
 *
 * The two unions carry the same eight names today, and this record is what keeps that a fact rather
 * than an assumption: it is total in `ViewStatus` and typed as `ToolUIStatus`, so either union
 * growing a member breaks the build here instead of drawing the wrong glyph.
 */
const STATUS_ICONS: Record<ViewStatus, ToolUIStatus> = {
	success: "success",
	done: "done",
	error: "error",
	warning: "warning",
	info: "info",
	pending: "pending",
	running: "running",
	aborted: "aborted",
};

/**
 * The block state each view status frames as, and the rail colour that goes with it.
 *
 * A block has five states and a view has eight statuses, so this is a reduction rather than a
 * mapping: `done` frames like `success`, `info` and `aborted` frame like `pending`. The rail is
 * `borderMuted` for everything but a failure, which is the settled look every framed tool in this
 * tree already asks for by hand; a tool that returns a view names no colour at all, so the reduction
 * lives here and a second host writes its own.
 */
const BLOCK_STATES: Record<ViewStatus, { state: State; rail: ThemeColor }> = {
	success: { state: "success", rail: "borderMuted" },
	done: { state: "success", rail: "borderMuted" },
	error: { state: "error", rail: "error" },
	warning: { state: "warning", rail: "borderMuted" },
	info: { state: "pending", rail: "borderMuted" },
	pending: { state: "pending", rail: "borderMuted" },
	running: { state: "running", rail: "borderMuted" },
	aborted: { state: "pending", rail: "borderMuted" },
};

/**
 * The colour a reasoning level is drawn in, when a span names one and states no tone of its own.
 *
 * A `thinking.<level>` symbol is the one glyph family whose meaning IS a scale: the six levels are
 * told apart by colour on the model selector, the composer chip and the agent roster, and a card
 * that drew them all in one tone would be reporting that every agent thinks alike. The scale is the
 * terminal's, so a tool names the level and this resolves the colour; a browser guest reads the same
 * symbol and picks its own. `theme.getThinkingBorderColor` owns the same table for the surfaces that
 * take a colouring function rather than a `ThemeColor`.
 */
const THINKING_COLORS: Readonly<Record<string, ThemeColor>> = {
	"thinking.minimal": "thinkingMinimal",
	"thinking.low": "thinkingLow",
	"thinking.medium": "thinkingMedium",
	"thinking.high": "thinkingHigh",
	"thinking.xhigh": "thinkingXhigh",
	"thinking.max": "thinkingXhigh",
};

/**
 * One span as terminal bytes.
 *
 * Emphasis is applied INSIDE the colour, which is the order every hand-written renderer here already
 * used (`theme.fg("toolTitle", theme.bold(name))`). Keeping it means a renderer converted to a view
 * emits the same bytes it did before. A span with no tone is raw text, so a caller can place a
 * literal separator between two styled runs without the host colouring it.
 *
 * A span naming a symbol this terminal has draws the glyph in the span's tone and nothing else: the
 * glyph replaces the text rather than joining it, which is what `theme.styledSymbol` already returns
 * for every hand-written row that marks a line. Emphasis is dropped on a glyph, since no renderer
 * here bolds one. A reasoning level with no tone stated takes the colour of that level and every
 * other untoned symbol takes `accent`. A symbol this build has never heard of falls back to `text`,
 * so an extension naming an unknown mark loses the mark and never the line.
 *
 * A span with a link is wrapped in OSC 8 AFTER it is styled, which is the order every hand-written
 * renderer used (`urlHyperlink(url, theme.fg("mdLinkUrl", url))`): the escape that opens the link
 * carries no colour, so a colour started inside it ends inside it.
 *
 * A markdown run is rendered through the inline half of the terminal's own document renderer, over
 * the span's tone: the words take the tone and the syntax takes the markdown theme, which is what
 * every hand-written row that offered a person's own label already drew. A run cut to fit is cut on
 * its SOURCE, so a cut that lands inside a `**` renders the asterisks; the alternative is measuring
 * a rendered string whose bytes are not the ones the cut is counted in.
 *
 * A captured run is another program's own output, so it is replayed rather than styled: the theme
 * supplies the colour the row sits on and `styleTerminalRow` keeps whichever of the program's styles
 * this terminal can reproduce. Tone and emphasis are ignored there, because a tool that observed a
 * screen states what it saw and not how the screen should look.
 *
 * A status run is the same mark a status row carries, through the same helper, so a row inside a card
 * and the card's own header report a state identically. The frame reaches it for the one state that
 * moves: `running` draws the spinner glyph at the frame the surface is on, and every other state is a
 * settled glyph that ignores it.
 *
 * A badge run is set off in the theme's own bracket pair, through the same helper every hand-written
 * row that marked one used, so a label inside a card and a label on its header bracket identically.
 * The tone colours the whole of it, brackets included, which is what a badge already was.
 *
 * A live run is drawn as a shimmer sweep, which is the treatment every hand-written row that reported
 * something in flight already used. It needs two things the span does not carry: a frame, so the
 * sweep plays only on a surface that repaints, and the reader's own setting, since shimmer is
 * switchable. Without either the run is drawn exactly as a settled one, so a still capture and a
 * transcript export carry the words and no motion.
 */
export function drawSpan(span: ViewSpan, theme: Theme, frame?: number): string {
	if (span.symbol !== undefined && Object.hasOwn(UNICODE_SYMBOLS, span.symbol)) {
		const color = span.tone === undefined ? (THINKING_COLORS[span.symbol] ?? "accent") : TONE_COLORS[span.tone];
		return linked(span, theme.styledSymbol(span.symbol as SymbolKey, color));
	}
	if (span.status !== undefined) {
		return linked(
			span,
			formatStatusIcon(STATUS_ICONS[span.status], theme, span.status === "running" ? frame : undefined),
		);
	}
	if (span.badge === true) {
		return linked(span, formatBadge(span.text, TONE_COLORS[span.tone ?? "accent"], theme));
	}
	if (span.captured) return styleTerminalRow(span.text, theme.getFgAnsi(TONE_COLORS.output));
	// A live run of ANOTHER PROGRAM's output is the follow rather than a shimmer: the newest
	// characters of a stream grade up to the accent and cool back into the output colour, which is the
	// treatment every live tool row on this host already had. A shimmer sweeps a whole run, which
	// reads as one word arriving rather than as a stream still pouring, and it would sweep a build's
	// last line end to end. The run is toned first, so the head of the row keeps the output colour the
	// trail cools into. Truecolor only, and the helper returns the row untouched without it.
	if (span.live === true && span.tone === "output") {
		return linked(
			span,
			paintHotTail(
				theme.fg(TONE_COLORS.output, span.text),
				theme,
				TERMINAL.trueColor,
				"toolOutput",
				shimmerPhase(performance.now()),
			),
		);
	}
	// The sweep paints its own three tiers across the run, so it REPLACES the tone rather than
	// layering over it: a shimmer opened inside a colour ends its last tier in that colour's reset and
	// leaves the rest of the run drawn in whatever the row opened with.
	if (span.live === true && frame !== undefined && shimmerEnabled()) {
		return linked(span, shimmerText(span.text, theme));
	}
	const ground = span.tone === undefined ? undefined : TONE_COLORS[span.tone];
	// A markdown run is rendered rather than styled: the tone is the ground its words sit on, and
	// whatever the source asks for -- a code span, a link, emphasis -- takes the markdown theme's own
	// appearance for that. Emphasis flags are dropped, because the source is what carries emphasis
	// here and a tool that set both would be answering the same question twice.
	if (span.markdown) {
		const rendered = renderInlineMarkdown(
			span.text,
			getMarkdownTheme(),
			ground === undefined ? undefined : text => theme.fg(ground, text),
		);
		return linked(span, rendered);
	}
	let text = span.text;
	if (span.bold) text = theme.bold(text);
	if (span.italic) text = theme.italic(text);
	if (span.strike) text = theme.strikethrough(text);
	const drawn = linked(span, ground === undefined ? text : theme.fg(ground, text));
	// The badge sits outside the link, because it names the file rather than being part of the target
	// a reader follows, and the theme owns both the glyph and the space after it.
	return span.language === undefined ? drawn : `${theme.langBadge(span.language)}${drawn}`;
}

/**
 * The drawn run, reachable when the span named a target and this terminal offers hyperlinks.
 *
 * A path and a URL are two targets rather than one: `fileHyperlink` resolves a relative path against
 * the working directory and percent-encodes it into a `file://` URI, which `urlHyperlink` refuses
 * outright since it accepts http and https alone. A run naming both is drawn as its file, because a
 * terminal opens that directly and the URL beside it is the same thing at one remove. A line inside
 * that file reaches the link as the `line` query parameter `fileHyperlink` writes into the URI.
 */
function linked(span: ViewSpan, drawn: string): string {
	if (span.file !== undefined) {
		return span.fileLine === undefined
			? fileHyperlink(span.file, drawn)
			: fileHyperlink(span.file, drawn, { line: span.fileLine });
	}
	return span.link === undefined ? drawn : urlHyperlink(span.link, drawn);
}

/** Every span concatenated, with no separator the tool did not ask for. */
export function drawSpans(spans: readonly ViewSpan[], theme: Theme, frame?: number): string {
	let line = "";
	for (const span of spans) line += drawSpan(span, theme, frame);
	return line;
}

/**
 * The glyph a row's emblem resolves to, or nothing when this terminal has no entry for it.
 *
 * The membership test is against the symbol table rather than a cast: an emblem is a string a tool
 * chose, so an extension can name one this build has never heard of, and the row must survive that
 * with its status icon instead of a blank column where a glyph should be.
 */
function drawEmblem(emblem: string | undefined, tone: ViewTone | undefined, theme: Theme): string | undefined {
	if (emblem === undefined) return undefined;
	if (!Object.hasOwn(UNICODE_SYMBOLS, emblem)) return undefined;
	return theme.styledSymbol(emblem as SymbolKey, tone === undefined ? "accent" : TONE_COLORS[tone]);
}

/**
 * A status row through the shared status line, so a view-returning tool sits in the same column as
 * every tool that builds its header by hand.
 *
 * The row's metadata spans are drawn first and handed over as strings, which is how the existing
 * callers of `renderStatusLine` already pass styled metadata. A description that names a target is
 * wrapped in OSC 8 before the status line colours it, so the link covers the description and nothing
 * around it.
 */
export function drawStatusRow(view: StatusRowView, theme: Theme, spinnerFrame?: number): string {
	const emblem = drawEmblem(view.emblem, view.emblemTone, theme);
	// The badge and the space after it are one value the theme owns, so a preset with no glyph for
	// the language leaves no gap where one would have been.
	const badge = view.language === undefined ? "" : theme.langBadge(view.language);
	// The tone is applied INSIDE the link and inside the status line's own colouring of the
	// description, which is the order every hand-written header used: the escape that opens the link
	// carries no colour, and the row's secondary colour is the ground a toned run sits on.
	const toned =
		view.description === undefined || view.descriptionTone === undefined
			? view.description
			: theme.fg(TONE_COLORS[view.descriptionTone], view.description);
	const described =
		toned === undefined
			? undefined
			: view.descriptionLink !== undefined
				? urlHyperlink(view.descriptionLink, toned)
				: view.descriptionFile !== undefined
					? fileHyperlink(
							view.descriptionFile,
							toned,
							view.descriptionFileLine === undefined ? undefined : { line: view.descriptionFileLine },
						)
					: toned;
	const description = described === undefined ? (badge === "" ? undefined : badge) : `${badge}${described}`;
	return renderStatusLine(
		{
			icon: view.status === undefined ? undefined : STATUS_ICONS[view.status],
			iconOverride: emblem,
			spinnerFrame,
			title: view.title,
			titleColor: view.titleTone === undefined ? undefined : TONE_COLORS[view.titleTone],
			description,
			badge: view.badge === undefined ? undefined : { label: view.badge.label, color: TONE_COLORS[view.badge.tone] },
			meta: view.meta?.map(entry => drawSpans(entry, theme, spinnerFrame)),
		},
		theme,
	);
}

/** A text block as one styled string. */
export function drawTextBlock(view: TextBlockView, theme: Theme, frame?: number): string {
	return drawSpans(view.spans, theme, frame);
}

/** Every kind of view this host draws, which is every kind the contract declares. */
export const VIEW_KINDS_DRAWN: Record<ToolView["kind"], true> = {
	statusRow: true,
	textBlock: true,
	headedBlock: true,
	framedBlock: true,
	notice: true,
};

/** A one-line view as the terminal string that draws it. */
export function drawToolViewText(view: LineToolView, theme: Theme, spinnerFrame?: number): string {
	switch (view.kind) {
		case "statusRow":
			return drawStatusRow(view, theme, spinnerFrame);
		case "textBlock":
			return drawTextBlock(view, theme, spinnerFrame);
	}
}

/**
 * A markdown section as the rows the terminal's own document renderer lays out.
 *
 * The width is the block's content width, so the document wraps inside the frame rather than against
 * the terminal's edge, and a resize re-lays it out. A section whose source is blank draws nothing at
 * all rather than one empty row, which is what a document with no text is.
 *
 * A tone is the ground the document's ordinary text sits on, which the section states by toning the
 * span that carries the source: a question put to a reader is the subject of its card, where a file's
 * contents are body text. Everything the source itself asks for -- a heading, a code span, a link --
 * still takes the markdown theme's own colours.
 */
function drawMarkdownRows(source: string, width: number, theme: Theme, tone: ViewTone | undefined): readonly string[] {
	if (!source.trim()) return [];
	const ground = tone === undefined ? undefined : { color: (text: string) => theme.fg(TONE_COLORS[tone], text) };
	return new Markdown(source, 0, 0, getMarkdownTheme(), ground).render(Math.max(1, width));
}

/** The rail glyph, the space after it and one column of air, which a header row never spends. */
const HEADER_CHROME = 3;

/**
 * The row that heads a block, with its description cut to the columns the block has when the card
 * asked for that and left whole when it did not.
 *
 * The description is where a card names what it acted on, which is a path, and a path is cut in the
 * MIDDLE: the end of one is the file, which is the part a reader is looking for, and an end-cut
 * header states a directory and nothing else. The title is left whole — it is a word — and the row
 * is redrawn from the shortened description rather than cut as bytes, so the link, the colours and
 * the trailing counts survive the cut.
 *
 * `descriptionFits` is what asks for it, and a row that does not set it is returned untouched for
 * the block to clip at its own edge. Fitting every header instead would be the terminal deciding
 * something the card owns: a search card states its query and then counts what it found, and cutting
 * the query to `…` to keep counts that already fit loses the one fact the row was read for.
 */
function drawFittedHeader(view: StatusRowView, theme: Theme, width: number, frame?: number): string {
	const drawn = drawStatusRow(view, theme, frame);
	const description = view.description;
	if (description === undefined || view.descriptionFits !== true) return drawn;
	const overflow = visibleWidth(drawn) - Math.max(0, width - HEADER_CHROME);
	if (overflow <= 0) return drawn;
	const descriptionWidth = visibleWidth(description);
	const fitted = Math.max(1, descriptionWidth - overflow);
	if (fitted >= descriptionWidth) return drawn;
	const head = Math.floor((fitted - 1) / 2);
	const tail = fitted - 1 - head;
	const shortened =
		fitted <= 1
			? "…"
			: `${sliceWithWidth(description, 0, head, true).text}…${
					sliceWithWidth(description, Math.max(0, descriptionWidth - tail), tail, true).text
				}`;
	return drawStatusRow({ ...view, description: shortened }, theme, frame);
}

/**
 * A framed block as the self-framing component the card renders flush.
 *
 * The width arrives from the host and never from the tool, which is the whole reason this kind
 * exists: the block re-reads it on every frame through `framedBlock`'s closure, so a terminal resize
 * re-wraps the same view rather than asking the tool to lay itself out again.
 *
 * A section label is the terminal's chrome, so it is drawn in the tool-title colour here rather than
 * arriving styled: `renderOutputBlock` takes a label's colour from its caller, and this is that
 * caller for every view-returning tool.
 *
 * The state shows in ONE place, and the view says which: a card of fetched data leaves the plate
 * alone and takes the rail colour the outcome asks for, and a card that is itself a report keeps the
 * settled muted rail and carries the outcome across the plate.
 */
export function drawFramedBlock(view: FramedBlockView, theme: Theme, spinnerFrame?: number): Component {
	const header = view.header;
	const frame = view.state === undefined ? undefined : BLOCK_STATES[view.state];
	const sections = view.sections.map(section => {
		// A section states source, a change or a document, never two of them: a `-` row means nothing
		// once it is drawn as source or as Markdown, so a tool that marked its lines as more than one
		// is drawn as the change, and after that as code.
		const diff = section.code === undefined ? section.diff : undefined;
		const markdown = section.code === undefined && diff === undefined && section.markdown === true;
		const tree = section.code === undefined && diff === undefined && !markdown ? section.tree : undefined;
		const drawnHere =
			section.list || section.code !== undefined || diff !== undefined || markdown || tree !== undefined;
		return {
			label: section.label === undefined ? undefined : theme.fg("toolTitle", section.label),
			separator: section.separator === true,
			lines: section.list
				? drawItemList(section.lines, section.hidden, theme, spinnerFrame)
				: section.code !== undefined
					? drawCodeLines(section.lines, section.code, theme)
					: diff !== undefined
						? drawDiffLines(section.lines, diff, theme)
						: tree !== undefined
							? drawTreeLines(section.lines, tree, theme, spinnerFrame)
							: [],
			// A change wraps in its own gutter rather than as prose, and the gutter is measured against
			// the columns the block has, so the rows are re-broken inside the closure below.
			diff: diff !== undefined,
			// A document is laid out at the host's width, so its rows are composed inside the closure
			// below from the source the section carries rather than drawn once here.
			markdown: markdown ? section.lines.map(line => line.map(span => span.text).join("")).join("\n") : undefined,
			// The ground the document's own text sits on, which the section states by toning the span it
			// carries the source in. Read from the first toned span, so a document stated as several
			// spans of one line is one document with one ground rather than a run-by-run palette.
			markdownTone: markdown ? section.lines.flat().find(span => span.tone !== undefined)?.tone : undefined,
			// A plain section's rows, drawn here when the whole row is its subject and left as spans when
			// it carries a trailing run: a tail sits at the END of the row, so the words before it are cut
			// to what the tail leaves and the gap between the two is whatever columns are left. That is
			// the host's width, so those rows are drawn inside the closure below and the rest are not
			// re-drawn on every frame.
			rows: drawnHere ? undefined : section.lines.map(line => plainRow(line, theme, spinnerFrame)),
			// Held back by the TOOL, so it stands outside the window the host cuts: a section that says
			// what it dropped must keep saying it however few rows are left. A list states the same count
			// on its own closing branch, so the note is already among its rows.
			note: section.hidden === undefined || section.list ? undefined : drawHiddenNote(section.hidden, theme),
			// Which of the drawn rows is a verbatim capture of another program's screen row. A row the card
			// composed itself ends where the columns end, because the words on it were chosen to fit; a
			// captured row that lost its tail has to say so, or a screen cut at the right margin reads as
			// the program having printed exactly that. Resolved here, where the spans are still in hand.
			captured: drawnHere ? undefined : section.lines.map(line => line.some(span => span.captured === true)),
			tail: section.tail,
			clip: section.clip === true,
		};
	});
	// A block that reports `running` is a card still arriving, which the terminal says on a trailing
	// row rather than in the header: an animating glyph in the head row pins the native-scrollback
	// commit boundary at the top of the block, so a long preview could never scroll-append while it
	// streams. A row that reports `running` still animates its own icon, which is the other case —
	// the last thing that happened is running, and the card itself is settled.
	const arriving =
		view.state === "running"
			? `${spinnerFrame === undefined ? "" : `${formatStatusIcon("running", theme, spinnerFrame)} `}${theme.fg(
					"dim",
					"… (streaming)",
				)}`
			: undefined;
	// A body that carries its own gutter sits flush against the rail: the marker column IS the
	// indent, and a pad in front of it is a second margin the rows were never measured with.
	const contentPaddingLeft = view.gutter === true ? 0 : undefined;
	return framedBlock(theme, width => ({
		...(contentPaddingLeft === undefined ? {} : { contentPaddingLeft }),
		header: header === undefined ? undefined : drawFittedHeader(header, theme, width, spinnerFrame),
		sections: [
			...sections.map(section => {
				const contentWidth = outputBlockContentWidth(width, contentPaddingLeft);
				const drawn =
					section.markdown !== undefined
						? drawMarkdownRows(section.markdown, contentWidth, theme, section.markdownTone)
						: section.rows === undefined
							? section.lines
							: section.rows.map(row =>
									row.tail === undefined
										? row.drawn
										: drawRowWithTail(row.lead, row.tail, theme, contentWidth, spinnerFrame),
								);
				// A clipped section is rows rather than prose, so a row that runs out of columns ends
				// there. Without the cut the block WRAPS it, and one long path becomes two rows of a
				// listing whose every other entry is one.
				//
				// The cut comes BEFORE the window for the same reason: a clipped line is exactly one
				// row, so a window measured on the wrapped text would count rows the card never draws
				// and drop the front of a screen that fits.
				const content = section.diff
					? drawn.flatMap(line => wrapDiffRow(line, contentWidth))
					: section.clip
						? drawn.map((line, index) =>
								truncateToWidth(
									line,
									contentWidth,
									section.captured?.[index] === true ? Ellipsis.Unicode : Ellipsis.Omit,
								),
							)
						: drawn;
				const windowed =
					section.tail === undefined ? content : drawTailWindow(content, section.tail, theme, contentWidth);
				const rows = section.note === undefined ? windowed : [...windowed, section.note];
				return {
					label: section.label,
					separator: section.separator,
					lines: section.clip ? rows.map(line => truncateToWidth(line, contentWidth, Ellipsis.Omit)) : rows,
				};
			}),
			...(arriving === undefined ? [] : [{ lines: [arriving] }]),
		],
		state: frame?.state,
		// A listing keeps a quiet edge whatever the write reported: the state belongs to the write and
		// the record is what the body shows, so neither the plate nor the rail colour states it.
		//
		// A card with no header row has no row that states its outcome, so the rail is where the
		// outcome goes: the shell card is the case, and its edge is accent while the run is arriving,
		// quiet once it settles and the failure colour when it failed. Naming no colour is what asks
		// the block for that, since the block derives one from the state it was given.
		borderColor:
			view.contents === "listing"
				? "borderMuted"
				: view.contents === "data" || view.header === undefined
					? undefined
					: frame?.rail,
		applyBg: view.contents === undefined || view.contents === "report",
		width,
	}));
}

/**
 * The narrowest line-number gutter the terminal draws.
 *
 * A gutter derived from the line count alone widens at the 10, 100 and 1000-line crossings, which
 * rewrites every row already on screen: the transcript's commit audit then has to recommit the
 * block's committed prefix, which is a full duplicate of it in native scrollback. Three columns keep
 * the gutter constant through a 999-line file, so a streamed row is byte-identical to the row the
 * settled card draws.
 */
const CODE_GUTTER_MIN_WIDTH = 3;

/**
 * The last code section drawn, so a card that is repainted without changing re-uses its rows.
 *
 * A streaming write recomposes on every spinner frame — twelve times a second — and highlighting a
 * file is the most expensive thing a card does, so a memo is the difference between colouring the
 * window once and colouring it on every tick. One slot: the live cards are drawn one after another
 * and the one being repainted is the one that just drew, which is the same reasoning the
 * single-slot `RenderedStringCache` the hand-written previews used was built on. The theme is
 * compared by reference because a theme switch replaces the instance wholesale.
 */
const codeMemo: { theme: Theme | null; language: string; shape: string; source: string; rows: string[] } = {
	theme: null,
	language: "",
	shape: "",
	source: "",
	rows: [],
};

/**
 * The columns a gutter of stated line numbers spends.
 *
 * As wide as the widest number the FILE has, not the widest the window carries: two windows onto one
 * file are numbered in one column, and a window that happens to end at line 99 is drawn in the same
 * gutter as the one that reaches 1000.
 */
function codeGutterWidth(numbers: readonly (number | null)[], totalLines: number | undefined): number {
	let widest = totalLines ?? 0;
	for (const number of numbers) {
		if (number !== null && number > widest) widest = number;
	}
	return Math.max(CODE_GUTTER_MIN_WIDTH, String(widest).length);
}

/**
 * A code section as highlighted rows in a line-number gutter.
 *
 * The spans of a code line carry text alone — a tool that toned its own keywords would be writing a
 * colour scheme — so the line's text is handed to the highlighter and the tones the section's spans
 * carry are ignored by design. The gutter is as wide as the file's last line number rather than as the
 * window's, so the rows do not shift sideways as more of a file arrives, and a section that
 * states no first line number is drawn without a gutter at all. A section that states a number per
 * line is numbered by those, which is what several windows onto one file are: the rows are in file
 * order and the numbers jump, and a row whose number is `null` keeps a blank gutter of the same
 * width so the source stays in one column.
 */
function drawCodeLines(lines: readonly ViewLine[], code: ViewCodeLines, theme: Theme): string[] {
	const source = lines.map(line => line.map(span => span.text).join("")).join("\n");
	const language = code.language ?? "";
	const first = code.firstLineNumber;
	const numbers = code.lineNumbers;
	const shape = `${first ?? "-"}:${code.totalLines ?? "-"}:${numbers === undefined ? "-" : numbers.join(",")}:${code.lead ?? "-"}`;
	if (
		codeMemo.theme === theme &&
		codeMemo.language === language &&
		codeMemo.shape === shape &&
		codeMemo.source === source
	) {
		return codeMemo.rows;
	}
	const highlighted = highlightCode(source, code.language);
	const rows =
		numbers !== undefined
			? (() => {
					const gutter = codeGutterWidth(numbers, code.totalLines);
					return highlighted.map((body, index) => {
						const number = numbers[index];
						const cell =
							number === null || number === undefined
								? " ".repeat(gutter)
								: String(number).padStart(gutter, " ");
						return `${theme.fg("dim", `${cell} `)}${replaceTabs(body)}`;
					});
				})()
			: first === undefined
				? highlighted.map(body => replaceTabs(body))
				: (() => {
						const last = code.totalLines ?? first + highlighted.length - 1;
						const gutter = Math.max(CODE_GUTTER_MIN_WIDTH, String(last).length);
						return highlighted.map(
							(body, index) =>
								`${theme.fg("dim", `${String(first + index).padStart(gutter, " ")} `)}${replaceTabs(body)}`,
						);
					})();
	// The lead is the prompt the first line is read under, so it opens that row in the aside colour
	// and the highlighter never sees it. A section carrying no source draws no lead: a prompt over a
	// command nobody has states nothing.
	const lead = code.lead;
	const led =
		lead === undefined ? rows : rows.map((row, index) => (index === 0 ? `${theme.fg("dim", lead)}${row}` : row));
	codeMemo.theme = theme;
	codeMemo.language = language;
	codeMemo.shape = shape;
	codeMemo.source = source;
	codeMemo.rows = led;
	return led;
}

/**
 * The last change drawn, so a card repainted without changing re-uses its rows.
 *
 * The same single slot the code sections keep, for the same reason: a streaming edit recomposes on
 * every spinner frame, and colouring a change -- highlighting its unchanged rows in the file's
 * language and diffing the words inside a replaced line -- is the most expensive thing that card
 * does.
 */
const diffMemo: { theme: Theme | null; path: string; source: string; rows: string[] } = {
	theme: null,
	path: "",
	source: "",
	rows: [],
};

/** The marker column each side of a change is drawn in. */
const DIFF_MARKERS: Record<ViewDiffSide, string> = {
	added: "+",
	removed: "-",
	context: " ",
	gap: "",
};

/**
 * A change as the marked, numbered and coloured rows the terminal draws for one.
 *
 * The rows are composed back into the canonical form the terminal's own diff renderer reads --
 * marker, number, `|`, text -- and handed to it, so a change described by a tool and a change drawn
 * from a diff string are the same bytes: one owner for the gutter, the indent glyphs, the
 * word-level highlight inside a one-for-one replacement and the highlighting of the rows that did
 * not change. A row with no number of its own is written without one, which the renderer draws as a
 * marker and its text; a gap is an empty row, which it draws as an ellipsis.
 */
function drawDiffLines(lines: readonly ViewLine[], diff: ViewDiffLines, theme: Theme): string[] {
	const numbers = diff.lineNumbers;
	const source = lines
		.map((line, index) => {
			const side = diff.sides[index] ?? "context";
			if (side === "gap") return "";
			const text = line.map(span => span.text).join("");
			const number = numbers?.[index];
			const marker = DIFF_MARKERS[side];
			return number === null || number === undefined ? `${marker}${text}` : `${marker}${number}|${text}`;
		})
		.join("\n");
	const path = diff.path ?? "";
	if (diffMemo.theme === theme && diffMemo.path === path && diffMemo.source === source) return diffMemo.rows;
	const rows = renderDiff(source, diff.path === undefined ? {} : { filePath: diff.path }).split("\n");
	diffMemo.theme = theme;
	diffMemo.path = path;
	diffMemo.source = source;
	diffMemo.rows = rows;
	return rows;
}

/**
 * A list section as the tree the terminal draws for one, marks and closing row included.
 *
 * Through the same helper every hand-written tree card uses, so the branch glyphs and the wording of
 * the closing row have one owner. The items arrive already trimmed — the tool cut them and said how
 * many it kept back — so the helper is handed the whole list and the count separately, and trims
 * nothing itself.
 */
function drawItemList(
	lines: readonly ViewLine[],
	hidden: ViewHiddenCount | undefined,
	theme: Theme,
	frame?: number,
): string[] {
	const drawn = lines.map(line => drawSpans(line, theme, frame));
	return renderTreeList(
		{
			items: drawn,
			expanded: false,
			maxCollapsed: drawn.length,
			heldBack: hidden?.count ?? 0,
			itemType: hidden?.noun?.one ?? "item",
			renderItem: line => line,
		},
		theme,
	);
}

/**
 * A tree section as the connected rows the terminal draws for one.
 *
 * The guides are resolved from the lines above: a line at depth `d` sits behind one column of chrome
 * per level above it, and each of those columns is a vertical run while the node it belongs to has a
 * sibling still to come and blank once it does not. So the walk keeps the last-child answer of every
 * open level and reads it back for the levels below, which is what lets a tool state depth alone.
 *
 * A line at the section's own level takes no connector and no indent, and its continuation rows take
 * the two columns a node's detail already sat in: the top level of a card is a list of things, not a
 * branch off the card itself.
 */
function drawTreeLines(lines: readonly ViewLine[], tree: ViewTreeLines, theme: Theme, frame?: number): string[] {
	const vertical = `${theme.fg("dim", theme.tree.vertical)}  `;
	const blank = "   ";
	const base = "  ";
	const lastAtDepth: boolean[] = [];
	return lines.map((line, index) => {
		const depth = Math.max(0, tree.depth[index] ?? 0);
		const last = tree.last[index] === true;
		const opens = tree.opens[index] === true;
		if (opens) lastAtDepth[depth] = last;
		if (depth === 0) return `${opens ? "" : base}${drawSpans(line, theme, frame)}`;
		let prefix = base;
		for (let level = 1; level < depth; level++) prefix += lastAtDepth[level] === true ? blank : vertical;
		prefix += opens
			? `${theme.fg("dim", last ? theme.tree.last : theme.tree.branch)} `
			: lastAtDepth[depth] === true
				? blank
				: vertical;
		return `${prefix}${drawSpans(line, theme, frame)}`;
	});
}

/**
 * The end of a section, in the rows it is allowed, with a line saying what came before it.
 *
 * Measured in WRAPPED rows rather than in the tool's lines, because one long command line occupies
 * four rows of an eighty-column terminal and a window counted in tool lines overruns the viewport it
 * exists to fit. The note is one of those rows, so a section given ten rows shows nine of its own.
 *
 * A clipped section arrives already cut to one row per line, so the wrap below returns each of those
 * lines unchanged and the count is the same either way. It is not measured separately.
 */
function drawTailWindow(lines: readonly string[], window: ViewTailWindow, theme: Theme, width: number): string[] {
	const rows: string[] = [];
	for (const line of lines) rows.push(...wrapTextWithAnsi(line.trimEnd(), width));
	const viewport = Math.max(1, previewWindowRows() - (window.reserve ?? 0));
	const max =
		window.max === undefined ? viewport : window.viewport === true ? Math.min(window.max, viewport) : window.max;
	if (rows.length <= max) return rows;
	const kept = max <= 1 ? [] : rows.slice(rows.length - (max - 1));
	const earlier = rows.length - kept.length;
	const note = `… ${earlier} earlier ${pluralize("line", earlier)} ${formatExpandHint(theme, false, true)}`;
	return [theme.fg("dim", note), ...kept];
}

/**
 * A headed block as the frameless component a terse card draws.
 *
 * The two columns of indent, the width every line is cut to and the held-back note are the host's
 * answer to the view, which is why the tool states lines and a count and nothing else. A content
 * line is cut with an ellipsis, since a line that lost its tail has to say so; the header and the
 * host's own note are cut without one, because the host composed them to fit.
 */
export function drawHeadedBlock(view: HeadedBlockView, theme: Theme, spinnerFrame?: number): Component {
	const header = view.header === undefined ? undefined : drawStatusRow(view.header, theme, spinnerFrame);
	const lines = view.lines;
	const hidden = view.hidden;
	const tail = view.tail;
	return createCachedComponent(
		() => false,
		width => {
			const rows: string[] = [];
			if (header !== undefined) rows.push(truncateToWidth(header, width, Ellipsis.Omit));
			const body = lines.map(line => drawRowToWidth(line, theme, Math.max(1, width - INDENT), spinnerFrame));
			// A window is measured on the rows the lines occupy at the width the body has, which is the
			// width minus the indent every one of them is drawn at.
			const windowed = tail === undefined ? body : drawTailWindow(body, tail, theme, Math.max(1, width - INDENT));
			for (const row of windowed) rows.push(`  ${row}`);
			const note = hidden === undefined ? undefined : drawHiddenNote(hidden, theme);
			if (note !== undefined) rows.push(truncateToWidth(`  ${note}`, width, Ellipsis.Omit));
			return rows;
		},
	);
}

/** The two columns a block's lines sit in, under the row that names them. */
const INDENT = 2;

/**
 * One line of a block, cut to the columns it has.
 *
 * The cut lands on the span's TEXT rather than on the drawn bytes: truncating a styled string ends
 * the line between a colour and its reset, so the ellipsis marking the cut draws in the terminal's
 * default colour and the row it belongs to loses its tone at the last column. Spans are measured in
 * order and each is given what the ones before it left, so the span that runs out of room is the one
 * that carries the mark.
 *
 * A mark is atomic and is never cut: a glyph, a state mark and a badge are decoration whose half is
 * nothing, so each is drawn whole and measured on what it drew. A badge is measured on the drawn run
 * for a second reason: the theme's brackets are two columns the tool's text does not carry, and a row
 * that counted the label alone would overrun the columns it was given by exactly that.
 *
 * A captured run is the exception, and is cut AFTER it is replayed: its own escape bytes sit between
 * its characters, so cutting the text first would drop every sequence past the cut and redraw the
 * rest of the row in a colour the program never chose. The cut is width-aware either way, so the
 * columns are the same; only the styles inside them survive.
 */
function drawLineToWidth(line: ViewLine, theme: Theme, width: number, frame?: number): string {
	let used = 0;
	let drawn = "";
	for (const span of line) {
		const remaining = width - used;
		if (remaining <= 0) break;
		if (span.symbol !== undefined && Object.hasOwn(UNICODE_SYMBOLS, span.symbol)) {
			drawn += drawSpan(span, theme, frame);
			used += visibleWidth(theme.symbol(span.symbol as SymbolKey));
			continue;
		}
		if (span.status !== undefined || span.badge === true) {
			const mark = drawSpan(span, theme, frame);
			drawn += mark;
			used += visibleWidth(mark);
			continue;
		}
		if (span.captured) {
			const replayed = truncateToWidth(drawSpan(span, theme, frame), remaining, Ellipsis.Unicode);
			drawn += replayed;
			used += visibleWidth(replayed);
			continue;
		}
		const text = truncateToWidth(span.text, remaining, Ellipsis.Unicode);
		drawn += drawSpan({ ...span, text }, theme, frame);
		used += visibleWidth(text);
	}
	return drawn;
}

/**
 * The columns a row keeps for its own words however long its tail is.
 *
 * A tail is an aside, so it may not consume the row: two columns of mark and eight of name is the
 * floor every hand-written card that reserved a name width already used, and below it the tail
 * overruns the columns rather than the words disappearing.
 */
const TAIL_LEAD_MIN_WIDTH = 10;

/**
 * One plain row of a section: the bytes it draws, or the two halves a trailing run splits it into.
 *
 * A row whose whole line is its subject is drawn once, at no width; a row with a tail is kept as
 * spans, because where the tail lands is the host's answer and it changes with every resize.
 */
type PlainRow = { drawn: string; lead?: undefined; tail?: undefined } | { lead: ViewLine; tail: ViewLine };

/** A plain row as the drawer holds it, split at the first run the tool marked trailing. */
function plainRow(line: ViewLine, theme: Theme, frame?: number): PlainRow {
	const at = line.findIndex(span => span.trailing === true);
	if (at < 0) return { drawn: drawSpans(line, theme, frame) };
	return { lead: line.slice(0, at), tail: line.slice(at) };
}

/**
 * A row with its tail at the end of the columns it has, and its own words cut to what is left.
 *
 * The tail is measured first and keeps every column it asks for, since a duration or a count that
 * lost a digit reads as a different number; the words before it are cut with an ellipsis, and the
 * gap between the two is whatever remains, never less than one column so the two never run together.
 */
function drawRowWithTail(lead: ViewLine, tail: ViewLine, theme: Theme, width: number, frame?: number): string {
	const drawnTail = drawSpans(tail, theme, frame);
	const tailWidth = visibleWidth(drawnTail);
	const drawnLead = drawLineToWidth(lead, theme, Math.max(TAIL_LEAD_MIN_WIDTH, width - tailWidth - 1), frame);
	const gap = padding(Math.max(1, width - visibleWidth(drawnLead) - tailWidth));
	return `${drawnLead}${gap}${drawnTail}`;
}

/** One row of a block in the columns it has, whether or not it carries a tail. */
function drawRowToWidth(line: ViewLine, theme: Theme, width: number, frame?: number): string {
	const at = line.findIndex(span => span.trailing === true);
	if (at < 0) return drawLineToWidth(line, theme, width, frame);
	return drawRowWithTail(line.slice(0, at), line.slice(at), theme, width, frame);
}

/** The unit a held-back count is in, as the words that follow it, or nothing when the tool named none. */
function nounSuffix(hidden: ViewHiddenCount): string {
	if (hidden.noun === undefined) return "";
	return ` ${hidden.count === 1 ? hidden.noun.one : hidden.noun.many}`;
}

/**
 * The sentence the terminal writes for what a card or one of its sections held back, or nothing when
 * it held nothing back and has nothing left to offer.
 *
 * One sentence for both kinds: a tool states a count and the host words it, so a panel and a terse
 * card say `… 3 more lines` the same way and a reader learns one gesture.
 */
function drawHiddenNote(hidden: ViewHiddenCount, theme: Theme): string | undefined {
	if (hidden.count <= 0 && !hidden.revealable) return undefined;
	const hint = formatExpandHint(theme, !hidden.revealable, true);
	if (hidden.count <= 0) return hint;
	return `${theme.fg("dim", `… ${hidden.count} more${nounSuffix(hidden)}`)} ${hint}`;
}

/**
 * The theme colour a notice's plate carries for each state.
 *
 * Total in `ViewStatus` for the same reason every other record here is: a status added to the
 * contract fails the build until the terminal states what a plate of it looks like, rather than
 * painting it in whatever the last branch returned. The three the resolve card reaches are the
 * outcome colours; the rest reduce to them, because a plate is a settled decision and nothing
 * pending or running ever fills one.
 */
const NOTICE_COLORS: Record<ViewStatus, ThemeColor> = {
	success: "success",
	done: "success",
	error: "error",
	warning: "warning",
	info: "infoAccent",
	pending: "muted",
	running: "accent",
	aborted: "warning",
};

/**
 * One span of a notice, whose colour the plate already answered.
 *
 * Emphasis is kept and tone is dropped: the whole plate is `inverse(fg(state, …))`, so a colour
 * started inside it carries its own reset and drops the row back to the default background at that
 * column. For the same reason a symbol is drawn bare rather than through `styledSymbol`, which
 * would wrap the glyph in a colour of its own.
 */
function drawNoticeSpan(span: ViewSpan, theme: Theme): string {
	if (span.symbol !== undefined && Object.hasOwn(UNICODE_SYMBOLS, span.symbol)) {
		return theme.symbol(span.symbol as SymbolKey);
	}
	let text = span.text;
	if (span.bold) text = theme.bold(text);
	if (span.italic) text = theme.italic(text);
	return text;
}

/** Every span of one notice line, with no separator the tool did not ask for. */
function drawNoticeLine(line: ViewLine, theme: Theme): string {
	let drawn = "";
	for (const span of line) drawn += drawNoticeSpan(span, theme);
	return drawn;
}

/**
 * A notice as the full-width plate the terminal fills.
 *
 * The blank row above the headline, the blank row between it and the body, the trailing row and the
 * one column of inset are the terminal's answer to "a notice", not lines the tool sent: a tool that
 * had to state them would be laying out a card it cannot measure. Each row is cut to the width and
 * padded back out to it, so the plate is a rectangle at every width and a resize re-cuts it.
 */
export function drawNotice(view: NoticeView, theme: Theme): Component {
	const color = NOTICE_COLORS[view.state];
	const mark =
		view.mark !== undefined && Object.hasOwn(UNICODE_SYMBOLS, view.mark)
			? `${theme.symbol(view.mark as SymbolKey)} `
			: "";
	const tag =
		view.tag === undefined
			? ""
			: ` ${theme.bold(`${theme.format.bracketLeft}${view.tag}${theme.format.bracketRight}`)}`;
	const lines = ["", `${mark}${drawNoticeLine(view.headline, theme)}${tag}`];
	// The blank row is the gap between the headline and what follows it, so a notice that is a
	// headline alone is three rows rather than a headline with two empty rows under it.
	if (view.body !== undefined && view.body.length > 0) {
		lines.push("");
		for (const line of view.body) lines.push(drawNoticeLine(line, theme));
	}
	lines.push("");
	return createCachedComponent(
		() => false,
		width => {
			const lineWidth = Math.max(3, width);
			const innerWidth = Math.max(1, lineWidth - 2);
			return lines.map(line => {
				const truncated = truncateToWidth(line, innerWidth, Ellipsis.Omit);
				const padded = padToWidth(` ${padToWidth(truncated, innerWidth)} `, lineWidth);
				return theme.inverse(theme.fg(color, padded));
			});
		},
	);
}

/**
 * A view as a terminal component.
 *
 * A one-line view is `Text` with zero padding, which is what every tool renderer converted to a view
 * returned before, so the surrounding card lays the row out exactly as it did. Either block kind is a
 * container instead, because it owes the card a height at a width.
 */
export function drawToolView(view: ToolView, theme: Theme, spinnerFrame?: number): Component {
	switch (view.kind) {
		case "framedBlock":
			return drawFramedBlock(view, theme, spinnerFrame);
		case "headedBlock":
			return drawHeadedBlock(view, theme, spinnerFrame);
		case "notice":
			return drawNotice(view, theme);
		case "statusRow":
		case "textBlock":
			return new Text(drawToolViewText(view, theme, spinnerFrame), 0, 0);
	}
}

/**
 * The card policies a converted tool's registry entry carries, which the component reads from the
 * entry for both render paths.
 *
 * They are the terminal's, not the tool's: whether the result replaces the call row, whether either
 * render consumes a spinner frame, and whether a shape change needs the viewport replayed. A view
 * states none of them, so a conversion moves them here from the deleted renderer object.
 */
export interface ViewToolRendererPolicy {
	mergeCallAndResult?: boolean;
	/** Drawn in the response flow rather than in the card's own box, which is the row's placement. */
	inline?: boolean;
	/**
	 * That the call render IS the live control a reader answers, so a call that never ran must not
	 * paint it: a question nobody can answer any more draws its plain label instead.
	 */
	callIsLiveWidget?: boolean;
	animatedPendingPreview?: boolean | ((args: unknown) => boolean);
	animatedPartialResult?: boolean | ((args: unknown) => boolean);
	forceFirstResultViewportRepaint?: FirstResultViewportRepaint;
	forceResultViewportRepaintOnSettle?: boolean;
}

/**
 * What the registry hands a renderer: the disclosure state, plus the loosely typed bag of surface
 * facts the transcript component fills in. `ToolRenderer` already spells the bag out on its result
 * half; a view reads it on both, because a call preview is the half that has to know a result exists.
 */
type RegistryRenderOptions = RenderResultOptions & { renderContext?: Record<string, unknown> };

/**
 * A view-only tool's card for the terminal's own renderer registry.
 *
 * A tool that describes a view needs no entry here: the card reads `tool.view` off the live tool.
 * The registry is the path taken when there is no live tool to read — a rebuilt transcript for a
 * tool this session did not construct — and without an entry that card falls back to the tool name
 * alone. So a converted tool that used to own a registry entry keeps one, drawn from the same view
 * the tool returns, and the entry holds no rendering of its own.
 *
 * Both members are required. A tool part-way through the migration describes one half and draws the
 * other, and its registry entry is still the hand-written pair.
 */
export function viewToolRenderer<Args, Result>(
	view: Required<ToolViewRenderer<Args, Result>>,
	extras?: ViewToolRendererPolicy,
): ViewToolRendererPolicy & {
	renderCall: (args: unknown, options: RegistryRenderOptions, theme: Theme) => Component;
	renderResult: (result: unknown, options: RegistryRenderOptions, theme: Theme, args?: unknown) => Component;
	view: Required<ToolViewRenderer<Args, Result>>;
} {
	/**
	 * What the surface knows, out of the loosely typed bag the registry path threads through.
	 *
	 * The live path builds a `ToolViewContext` directly and states both facts; this path is handed
	 * the same two through `renderContext`, because the registry's signature predates the contract
	 * and carries a record. A caller that states neither gets a context that omits both, which is
	 * what a rebuilt transcript with no live block knows.
	 */
	const contextOf = (options: RegistryRenderOptions): ToolViewContext => {
		const bag = options.renderContext;
		return {
			expanded: options.expanded,
			partial: options.isPartial,
			frame: options.spinnerFrame,
			...(bag?.hasResult === undefined ? {} : { hasResult: bag.hasResult === true }),
			...(bag?.frozen === undefined ? {} : { frozen: bag.frozen === true }),
		};
	};
	return {
		// The view this entry is a drawing of, carried so a reader can tell an entry that DESCRIBES its
		// card from one that draws its own. Nothing in the terminal path needs it -- both halves above
		// already close over it -- and the architecture gate that records every terminal-only card
		// reads it, which is the difference between a list kept by hand and one resolved from the
		// registry. A host other than a terminal reads the view instead of calling either half.
		view,
		renderCall: (args, options, theme) =>
			drawToolView(view.renderCall(args as Args, contextOf(options)), theme, options.spinnerFrame),
		renderResult: (result, options, theme, args) =>
			drawToolView(
				view.renderResult(result as Result, contextOf(options), args as Args | undefined),
				theme,
				options.spinnerFrame,
			),
		...extras,
	};
}

/**
 * Whether a tool draws its own card rather than falling back to the shared registry.
 *
 * A tool qualifies by owning a terminal renderer OR by describing a view, which is what lets a
 * migrated tool keep its own card instead of silently dropping to the generic one. Structural on
 * purpose: the predicate reads presence and nothing else, so it needs neither the tool's parameter
 * types nor a cast to reach them.
 */
export function toolDrawsItself(
	tool:
		| {
				renderCall?: unknown;
				renderResult?: unknown;
				view?: { renderCall?: unknown; renderResult?: unknown };
		  }
		| undefined,
): boolean {
	if (!tool) return false;
	return Boolean(tool.renderCall ?? tool.renderResult ?? tool.view?.renderCall ?? tool.view?.renderResult);
}
