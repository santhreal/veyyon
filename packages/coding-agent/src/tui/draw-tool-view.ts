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

import { type Component, Text } from "@veyyon/tui";
import type {
	FramedBlockView,
	LineToolView,
	StatusRowView,
	TextBlockView,
	ToolView,
	ToolViewRenderer,
	ViewSpan,
	ViewStatus,
	ViewTone,
} from "@veyyon/view";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { type SymbolKey, UNICODE_SYMBOLS } from "../theme/symbols";
import type { Theme, ThemeColor } from "../theme/theme";
import type { ToolUIStatus } from "../tools/tool-ui-status";
import { framedBlock } from "./output-block";
import { renderStatusLine } from "./status-line";
import type { State } from "./types";

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
 */
export function drawSpan(span: ViewSpan, theme: Theme): string {
	if (span.symbol !== undefined && Object.hasOwn(UNICODE_SYMBOLS, span.symbol)) {
		const color = span.tone === undefined ? "accent" : TONE_COLORS[span.tone];
		return theme.styledSymbol(span.symbol as SymbolKey, color);
	}
	let text = span.text;
	if (span.bold) text = theme.bold(text);
	if (span.italic) text = theme.italic(text);
	return span.tone === undefined ? text : theme.fg(TONE_COLORS[span.tone], text);
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
 * callers of `renderStatusLine` already pass styled metadata.
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
			description: view.description,
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
 */
export function drawFramedBlock(view: FramedBlockView, theme: Theme, spinnerFrame?: number): Component {
	const header = drawStatusRow(view.header, theme, spinnerFrame);
	const frame = view.state === undefined ? undefined : BLOCK_STATES[view.state];
	const sections = view.sections.map(section => ({
		label: section.label,
		lines: section.lines.map(line => drawSpans(line, theme)),
	}));
	return framedBlock(theme, width => ({
		header,
		sections,
		state: frame?.state,
		borderColor: frame?.rail,
		width,
	}));
}

/**
 * A view as a terminal component.
 *
 * A one-line view is `Text` with zero padding, which is what every tool renderer converted to a view
 * returned before, so the surrounding card lays the row out exactly as it did. A framed block is a
 * container instead, because it owes the card a height at a width.
 */
export function drawToolView(view: ToolView, theme: Theme, spinnerFrame?: number): Component {
	if (view.kind === "framedBlock") return drawFramedBlock(view, theme, spinnerFrame);
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
