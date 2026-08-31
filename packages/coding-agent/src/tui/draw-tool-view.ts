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
import { type Component, Text } from "@veyyon/tui";
import { truncateToWidth, visibleWidth } from "@veyyon/utils/width";
import type {
	FramedBlockView,
	HeadedBlockView,
	LineToolView,
	NoticeView,
	StatusRowView,
	TextBlockView,
	ToolView,
	ToolViewRenderer,
	ViewHiddenCount,
	ViewLine,
	ViewSpan,
	ViewStatus,
	ViewTone,
} from "@veyyon/view";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { type SymbolKey, UNICODE_SYMBOLS } from "../theme/symbols";
import type { Theme, ThemeColor } from "../theme/theme";
import { createCachedComponent, formatExpandHint } from "../tools/core/render-utils";
import type { ToolUIStatus } from "../tools/core/tool-ui-status";
import { urlHyperlink } from "./hyperlink";
import { framedBlock } from "./output-block";
import { renderStatusLine } from "./status-line";
import type { State } from "./types";
import { padToWidth } from "./utils";

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
	success: "success",
	warning: "warning",
	error: "error",
	info: "infoAccent",
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
 * here bolds one. A symbol this build has never heard of falls back to `text`, so an extension naming
 * an unknown mark loses the mark and never the line.
 *
 * A span with a link is wrapped in OSC 8 AFTER it is styled, which is the order every hand-written
 * renderer used (`urlHyperlink(url, theme.fg("mdLinkUrl", url))`): the escape that opens the link
 * carries no colour, so a colour started inside it ends inside it.
 */
export function drawSpan(span: ViewSpan, theme: Theme): string {
	if (span.symbol !== undefined && Object.hasOwn(UNICODE_SYMBOLS, span.symbol)) {
		const color = span.tone === undefined ? "accent" : TONE_COLORS[span.tone];
		return linked(span, theme.styledSymbol(span.symbol as SymbolKey, color));
	}
	let text = span.text;
	if (span.bold) text = theme.bold(text);
	if (span.italic) text = theme.italic(text);
	return linked(span, span.tone === undefined ? text : theme.fg(TONE_COLORS[span.tone], text));
}

/** The drawn run, reachable when the span named a target and this terminal offers hyperlinks. */
function linked(span: ViewSpan, drawn: string): string {
	return span.link === undefined ? drawn : urlHyperlink(span.link, drawn);
}

/** Every span concatenated, with no separator the tool did not ask for. */
export function drawSpans(spans: readonly ViewSpan[], theme: Theme): string {
	let line = "";
	for (const span of spans) line += drawSpan(span, theme);
	return line;
}

/**
 * The glyph a row's emblem resolves to, or nothing when this terminal has no entry for it.
 *
 * The membership test is against the symbol table rather than a cast: an emblem is a string a tool
 * chose, so an extension can name one this build has never heard of, and the row must survive that
 * with its status icon instead of a blank column where a glyph should be.
 */
function drawEmblem(emblem: string | undefined, theme: Theme): string | undefined {
	if (emblem === undefined) return undefined;
	if (!Object.hasOwn(UNICODE_SYMBOLS, emblem)) return undefined;
	return theme.styledSymbol(emblem as SymbolKey, "accent");
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
	const emblem = drawEmblem(view.emblem, theme);
	return renderStatusLine(
		{
			icon: view.status === undefined ? undefined : STATUS_ICONS[view.status],
			iconOverride: emblem,
			spinnerFrame,
			title: view.title,
			titleColor: view.titleTone === undefined ? undefined : TONE_COLORS[view.titleTone],
			description:
				view.descriptionLink === undefined || view.description === undefined
					? view.description
					: urlHyperlink(view.descriptionLink, view.description),
			badge: view.badge === undefined ? undefined : { label: view.badge.label, color: TONE_COLORS[view.badge.tone] },
			meta: view.meta?.map(span => drawSpan(span, theme)),
		},
		theme,
	);
}

/** A text block as one styled string. */
export function drawTextBlock(view: TextBlockView, theme: Theme): string {
	return drawSpans(view.spans, theme);
}

/** A one-line view as the terminal string that draws it. */
export function drawToolViewText(view: LineToolView, theme: Theme, spinnerFrame?: number): string {
	return view.kind === "statusRow" ? drawStatusRow(view, theme, spinnerFrame) : drawTextBlock(view, theme);
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
	const header = drawStatusRow(view.header, theme, spinnerFrame);
	const frame = view.state === undefined ? undefined : BLOCK_STATES[view.state];
	const sections = view.sections.map(section => {
		const lines = section.lines.map(line => drawSpans(line, theme));
		const note = section.hidden === undefined ? undefined : drawHiddenNote(section.hidden, theme);
		if (note !== undefined) lines.push(note);
		return { label: section.label === undefined ? undefined : theme.fg("toolTitle", section.label), lines };
	});
	return framedBlock(theme, width => ({
		header,
		sections,
		state: frame?.state,
		borderColor: view.contents === "data" ? undefined : frame?.rail,
		applyBg: view.contents !== "data",
		width,
	}));
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
	return createCachedComponent(
		() => false,
		width => {
			const rows: string[] = [];
			if (header !== undefined) rows.push(truncateToWidth(header, width, Ellipsis.Omit));
			for (const line of lines) rows.push(`  ${drawLineToWidth(line, theme, Math.max(1, width - INDENT))}`);
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
 */
function drawLineToWidth(line: ViewLine, theme: Theme, width: number): string {
	let used = 0;
	let drawn = "";
	for (const span of line) {
		const remaining = width - used;
		if (remaining <= 0) break;
		if (span.symbol !== undefined && Object.hasOwn(UNICODE_SYMBOLS, span.symbol)) {
			drawn += drawSpan(span, theme);
			used += visibleWidth(theme.symbol(span.symbol as SymbolKey));
			continue;
		}
		const text = truncateToWidth(span.text, remaining, Ellipsis.Unicode);
		drawn += drawSpan({ ...span, text }, theme);
		used += visibleWidth(text);
	}
	return drawn;
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
	if (view.kind === "framedBlock") return drawFramedBlock(view, theme, spinnerFrame);
	if (view.kind === "headedBlock") return drawHeadedBlock(view, theme, spinnerFrame);
	if (view.kind === "notice") return drawNotice(view, theme);
	return new Text(drawToolViewText(view, theme, spinnerFrame), 0, 0);
}

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
	extras?: { mergeCallAndResult?: boolean },
): {
	renderCall: (args: unknown, options: RenderResultOptions, theme: Theme) => Component;
	renderResult: (result: unknown, options: RenderResultOptions, theme: Theme, args?: unknown) => Component;
	mergeCallAndResult?: boolean;
} {
	return {
		renderCall: (args, options, theme) =>
			drawToolView(view.renderCall(args as Args, { expanded: options.expanded }), theme, options.spinnerFrame),
		renderResult: (result, options, theme, args) =>
			drawToolView(
				view.renderResult(result as Result, { expanded: options.expanded }, args as Args | undefined),
				theme,
				options.spinnerFrame,
			),
		mergeCallAndResult: extras?.mergeCallAndResult,
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
