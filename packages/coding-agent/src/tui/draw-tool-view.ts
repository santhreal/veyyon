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
import type { StatusRowView, TextBlockView, ToolView, ViewSpan, ViewStatus, ViewTone } from "@veyyon/view";
import type { Theme, ThemeColor } from "../theme/theme";
import type { ToolUIStatus } from "../tools/tool-ui-status";
import { renderStatusLine } from "./status-line";

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
 * One span as terminal bytes.
 *
 * Emphasis is applied INSIDE the colour, which is the order every hand-written renderer here already
 * used (`theme.fg("toolTitle", theme.bold(name))`). Keeping it means a renderer converted to a view
 * emits the same bytes it did before. A span with no tone is raw text, so a caller can place a
 * literal separator between two styled runs without the host colouring it.
 */
export function drawSpan(span: ViewSpan, theme: Theme): string {
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
 * A status row through the shared status line, so a view-returning tool sits in the same column as
 * every tool that builds its header by hand.
 *
 * The row's metadata spans are drawn first and handed over as strings, which is how the existing
 * callers of `renderStatusLine` already pass styled metadata.
 */
export function drawStatusRow(view: StatusRowView, theme: Theme, spinnerFrame?: number): string {
	return renderStatusLine(
		{
			icon: view.status === undefined ? undefined : STATUS_ICONS[view.status],
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

/** A view as the terminal string that draws it. */
export function drawToolViewText(view: ToolView, theme: Theme, spinnerFrame?: number): string {
	return view.kind === "statusRow" ? drawStatusRow(view, theme, spinnerFrame) : drawTextBlock(view, theme);
}

/**
 * A view as a terminal component.
 *
 * `Text` with zero padding, which is what every tool renderer converted to a view returned before, so
 * the surrounding card lays the row out exactly as it did.
 */
export function drawToolView(view: ToolView, theme: Theme, spinnerFrame?: number): Component {
	return new Text(drawToolViewText(view, theme, spinnerFrame), 0, 0);
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
