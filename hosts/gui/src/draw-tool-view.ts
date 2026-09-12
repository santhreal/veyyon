/**
 * How a graphical host draws a tool's view.
 *
 * Delegates semantic interpretation to the shared browser-portable `@veyyon/tool-render/view-core`
 * engine, using a lightweight HTML/DOM element-construction adapter.
 */

import {
	DIFF_SIDE_CLASSES,
	escapeHtml,
	renderFramedBlock,
	renderHeadedBlock,
	renderLine,
	renderNotice,
	renderSpan,
	renderStatusRow,
	renderTextBlock,
	renderToolView,
	type SpanAttributes,
	STATUS_CLASSES,
	STATUS_LABELS,
	type StatusRowProps,
	TONE_CLASSES,
	VIEW_KINDS_DRAWN,
	type ViewAdapter,
} from "@veyyon/tool-render/view-core";
import {
	type FramedBlockView,
	type HeadedBlockView,
	type NoticeView,
	type StatusRowView,
	type SymbolKey,
	type TextBlockView,
	type ToolView,
	type ToolViewContext,
	type ToolViewRenderer,
	UNICODE_SYMBOLS,
	type ViewLine,
	type ViewSpan,
} from "@veyyon/view";
import { classes, element } from "./html";

export { VIEW_KINDS_DRAWN };

export interface GuiViewOptions {
	/**
	 * Markup for a symbol, emblem or `status:<name>` key, drawn ahead of the `UNICODE_SYMBOLS` glyph
	 * the host draws without it. A key in neither draws the span's text and no emblem, never the key.
	 */
	symbols?: Readonly<Record<string, string>>;
}

const NO_OPTIONS: GuiViewOptions = {};

function stated(fact: boolean): string {
	return fact ? "true" : "false";
}

function spanClass(attrs: SpanAttributes): string | undefined {
	if (attrs.status !== undefined) return classes("v-mark", STATUS_CLASSES[attrs.status]);
	if (attrs.symbol !== undefined)
		return classes("v-symbol", attrs.tone === undefined ? undefined : TONE_CLASSES[attrs.tone]);
	if (attrs.captured === true) return "v-captured";
	return classes(
		attrs.badge === true ? "v-chip" : undefined,
		attrs.tone === undefined ? undefined : TONE_CLASSES[attrs.tone],
	);
}

export function createHtmlAdapter(options: GuiViewOptions = NO_OPTIONS): ViewAdapter<string> {
	return {
		text(str: string): string {
			return escapeHtml(str);
		},
		rawHtml(html: string): string {
			return html;
		},
		fragment(children: string[]): string {
			return children.join("");
		},
		span(attrs: SpanAttributes, child: string): string {
			const tag = attrs.captured === true ? "code" : "span";
			return element(
				tag,
				{
					class: spanClass(attrs),
					"data-symbol": attrs.symbol,
					"data-status": attrs.status,
					"data-file": attrs.file,
					"data-file-line": attrs.fileLine,
					"data-language": attrs.language,
					"data-live": attrs.live ? "true" : undefined,
					"aria-label": attrs.ariaLabel,
					role: attrs.role,
				},
				child,
			);
		},
		emphasis(type: "bold" | "italic" | "strike", child: string): string {
			const tag = type === "bold" ? "strong" : type === "italic" ? "em" : "s";
			return element(tag, {}, child);
		},
		link(href: string, child: string): string {
			return element("a", { href, rel: "noopener noreferrer" }, child);
		},
		trailing(child: string): string {
			return element("span", { class: "v-trailing" }, child);
		},
		resolveSymbol(symbol: string): string | undefined {
			if (options.symbols && Object.hasOwn(options.symbols, symbol)) return options.symbols[symbol];
			return Object.hasOwn(UNICODE_SYMBOLS, symbol) ? escapeHtml(UNICODE_SYMBOLS[symbol as SymbolKey]) : undefined;
		},
		resolveStatusMark(status): string {
			return options.symbols?.[`status:${status}`] ?? escapeHtml(UNICODE_SYMBOLS[`status.${status}`]);
		},
		statusRow(props: StatusRowProps<string>): string {
			const parts: string[] = [];
			if (props.emblem) {
				parts.push(
					element(
						"span",
						{
							class: classes("v-emblem", props.emblem.tone ? TONE_CLASSES[props.emblem.tone] : undefined),
							"data-emblem": props.emblem.name,
						},
						props.emblem.element,
					),
				);
			} else if (props.statusMark) {
				parts.push(
					element(
						"span",
						{
							class: classes("v-mark", STATUS_CLASSES[props.statusMark.status]),
							role: "img",
							"aria-label": STATUS_LABELS[props.statusMark.status],
							"data-status": props.statusMark.status,
						},
						props.statusMark.element ?? "",
					),
				);
			}

			parts.push(
				element(
					"span",
					{ class: classes("v-title", props.titleTone ? TONE_CLASSES[props.titleTone] : undefined) },
					escapeHtml(props.title),
				),
			);

			if (props.description) {
				const tone = props.description.tone ? TONE_CLASSES[props.description.tone] : undefined;
				const descEl = element(
					"span",
					{
						class: classes("v-description", tone, props.description.fits ? "v-fits" : undefined),
						"data-file": props.description.file,
						"data-file-line": props.description.fileLine,
					},
					escapeHtml(props.description.text),
				);
				if (props.description.link) {
					parts.push(element("a", { href: props.description.link, rel: "noopener noreferrer" }, descEl));
				} else {
					parts.push(descEl);
				}
			}

			if (props.badge) {
				parts.push(
					element(
						"span",
						{ class: classes("v-chip", TONE_CLASSES[props.badge.tone]) },
						escapeHtml(props.badge.label),
					),
				);
			}

			if (props.language) {
				parts.push(
					element(
						"span",
						{ class: "v-language", "data-language": props.language.name },
						escapeHtml(props.language.name),
					),
				);
			}

			if (props.meta && props.meta.length > 0) {
				const entries = props.meta.map(entry => element("span", { class: "v-meta-entry" }, entry));
				parts.push(element("span", { class: "v-meta" }, entries.join("")));
			}

			return element(
				"div",
				{ class: "v-row", "data-status": props.status, "data-live": props.live ? "true" : undefined },
				parts.join(""),
			);
		},
		textBlock(child: string): string {
			return element("p", { class: "v-text" }, child);
		},
		codeSection(props): string {
			const rows = props.rows.map(r =>
				element(
					"li",
					{ class: "v-code-line", value: r.line ?? undefined, "data-line": r.line ?? undefined },
					element("code", {}, r.content),
				),
			);
			const lead = props.lead ? element("p", { class: "v-code-lead" }, escapeHtml(props.lead)) : "";
			return (
				lead +
				element(
					"ol",
					{
						class: "v-code",
						"data-language": props.language,
						"data-total-lines": props.totalLines,
						"data-numbered": stated(props.numbered),
					},
					rows.join(""),
				)
			);
		},
		diffSection(props): string {
			const rows = props.rows.map(r =>
				element(
					"li",
					{
						class: classes("v-diff-line", DIFF_SIDE_CLASSES[r.side]),
						"data-side": r.side,
						value: r.line ?? undefined,
						"data-line": r.line ?? undefined,
					},
					element("code", {}, r.content),
				),
			);
			return element("ol", { class: "v-diff", "data-path": props.path }, rows.join(""));
		},
		treeSection(props): string {
			const rows = props.rows.map(r =>
				element(
					"li",
					{
						class: "v-tree-node",
						"data-depth": r.depth,
						"data-opens": stated(r.opens),
						"data-last": stated(r.last),
					},
					r.content,
				),
			);
			return element("ul", { class: "v-tree" }, rows.join(""));
		},
		listSection(props): string {
			const rows = props.rows.map(r => element("li", { class: "v-item" }, r));
			return element("ul", { class: "v-list" }, rows.join(""));
		},
		proseSection(props): string {
			const drawn = props.rows.map(r =>
				element("div", { class: classes("v-line", r.clip ? "v-clip" : undefined) }, r.content),
			);
			const note =
				props.dropped > 0
					? element(
							"p",
							{ class: "v-tail-note", "data-dropped": props.dropped },
							escapeHtml(`${props.dropped} earlier lines`),
						)
					: "";
			return note + drawn.join("");
		},
		markdownSection(props): string {
			return element(
				"div",
				{ class: classes("v-markdown", props.tone ? TONE_CLASSES[props.tone] : undefined) },
				props.html,
			);
		},
		hiddenNote(props): string {
			if (props.count <= 0) return "";
			const sentence = `${props.count} more${props.noun}`;
			const body = props.revealable
				? element("button", { type: "button", class: "v-reveal" }, escapeHtml(sentence))
				: escapeHtml(sentence);
			return element(
				"p",
				{ class: "v-hidden", "data-count": props.count, "data-revealable": stated(props.revealable) },
				body,
			);
		},
		section(props): string {
			const label = props.label ? element("h3", { class: "v-section-label" }, escapeHtml(props.label)) : "";
			return element(
				"section",
				{
					class: "v-section",
					"data-separator": props.separator ? "true" : undefined,
				},
				label + props.body + (props.hidden ?? ""),
			);
		},
		framedBlock(props): string {
			return element(
				"section",
				{
					class: "v-framed",
					"data-state": props.state,
					"data-contents": props.contents,
					"data-gutter": props.gutter ? "true" : undefined,
					"data-live": props.live ? "true" : undefined,
				},
				(props.header ?? "") + props.sections.join(""),
			);
		},
		headedBody(props): string {
			const note =
				props.dropped > 0
					? element(
							"p",
							{ class: "v-tail-note", "data-dropped": props.dropped },
							escapeHtml(`${props.dropped} earlier lines`),
						)
					: "";
			return element(
				"div",
				{ class: "v-lines" },
				note + props.rows.map(r => element("div", { class: "v-line" }, r)).join(""),
			);
		},
		headedBlock(props): string {
			return element("section", { class: "v-headed" }, (props.header ?? "") + props.body + (props.hidden ?? ""));
		},
		notice(props): string {
			const parts: string[] = [];
			if (props.markElement) {
				parts.push(element("span", { class: "v-notice-mark", "data-mark": props.mark }, props.markElement));
			}
			parts.push(element("span", { class: "v-notice-headline" }, props.headline));
			if (props.tag) parts.push(element("span", { class: "v-notice-tag" }, escapeHtml(props.tag)));
			const body =
				props.body && props.body.length > 0
					? element(
							"div",
							{ class: "v-notice-body" },
							props.body.map(l => element("div", { class: "v-line" }, l)).join(""),
						)
					: "";
			return element(
				"aside",
				{
					class: classes("v-notice", STATUS_CLASSES[props.state]),
					"data-state": props.state,
					role: props.role,
				},
				parts.join("") + body,
			);
		},
	};
}

/** Draws one span as an HTML string. */
export function drawSpan(span: ViewSpan, options: GuiViewOptions = NO_OPTIONS): string {
	return renderSpan(span, createHtmlAdapter(options));
}

/** Draws a line of spans as an HTML string. */
export function drawLine(line: ViewLine, options: GuiViewOptions = NO_OPTIONS): string {
	return renderLine(line, createHtmlAdapter(options));
}

/** Draws a status row as an HTML string. */
export function drawStatusRow(view: StatusRowView, options: GuiViewOptions = NO_OPTIONS): string {
	return renderStatusRow(view, createHtmlAdapter(options));
}

/** Draws a text block as an HTML string. */
export function drawTextBlock(view: TextBlockView, options: GuiViewOptions = NO_OPTIONS): string {
	return renderTextBlock(view, createHtmlAdapter(options));
}

/** Draws a framed block as an HTML string. */
export function drawFramedBlock(view: FramedBlockView, options: GuiViewOptions = NO_OPTIONS): string {
	return renderFramedBlock(view, createHtmlAdapter(options));
}

/** Draws a headed block as an HTML string. */
export function drawHeadedBlock(view: HeadedBlockView, options: GuiViewOptions = NO_OPTIONS): string {
	return renderHeadedBlock(view, createHtmlAdapter(options));
}

/** Draws a notice as an HTML string. */
export function drawNotice(view: NoticeView, options: GuiViewOptions = NO_OPTIONS): string {
	return renderNotice(view, createHtmlAdapter(options));
}

/** A view as the HTML that draws it. */
export function drawToolView(view: ToolView, options: GuiViewOptions = NO_OPTIONS): string {
	return renderToolView(view, createHtmlAdapter(options));
}

/**
 * The two halves of one tool's card, as HTML.
 */
export interface GuiToolCard<Args, Result> {
	renderCall?: (args: Args, context: ToolViewContext) => string;
	renderResult?: (result: Result, context: ToolViewContext, args?: Args) => string;
}

/**
 * A tool's own renderer as the two cards this host draws from it.
 */
export function guiToolRenderer<Args, Result>(
	renderer: ToolViewRenderer<Args, Result>,
	options: GuiViewOptions = NO_OPTIONS,
): GuiToolCard<Args, Result> {
	const { renderCall, renderResult } = renderer;
	return {
		...(renderCall === undefined
			? {}
			: {
					renderCall: (args: Args, context: ToolViewContext): string =>
						drawToolView(renderCall(args, context), options),
				}),
		...(renderResult === undefined
			? {}
			: {
					renderResult: (result: Result, context: ToolViewContext, args?: Args): string =>
						drawToolView(renderResult(result, context, args), options),
				}),
	};
}
