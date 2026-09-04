/**
 * How a graphical host draws a tool's view.
 *
 * The terminal draws the same models in `packages/coding-agent/src/modes/terminal/draw/draw-tool-view.ts`, and the
 * two share no code and no vocabulary: one produces rows of escape bytes measured in columns, this
 * one produces elements a stylesheet lays out. What they share is the contract, which is the claim
 * this host exists to check -- a tool that returns a `ToolView` reaches a second host with no
 * change to the tool, and every decision the terminal makes about appearance is made again here,
 * differently.
 *
 * Three things a document host answers differently from a terminal, each stated rather than
 * silently dropped:
 *
 *  - `ViewTailWindow.viewport` and `reserve` are a terminal's viewport arithmetic. A document
 *    scrolls, so this host honours the tool's own `max` and ignores the two members that describe
 *    rows a screen does not have.
 *  - `ViewSection.clip` says a line is atomic. A terminal cuts it to the columns it has; this host
 *    marks the row and leaves the cut to the stylesheet, which is the only party that knows the
 *    width.
 *  - `ViewSpan.captured` is another program's screen. A terminal replays the emphasis in it; this
 *    host has no screen to replay onto, keeps the words and drops every control sequence.
 */

import type {
	FramedBlockView,
	HeadedBlockView,
	NoticeView,
	StatusRowView,
	TextBlockView,
	ToolView,
	ToolViewContext,
	ToolViewRenderer,
	ViewCodeLines,
	ViewDiffLines,
	ViewHiddenCount,
	ViewLine,
	ViewSection,
	ViewSpan,
	ViewStatus,
	ViewTailWindow,
	ViewTreeLines,
} from "@veyyon/view";
import { Marked } from "marked";
import { classes, element, escapeHtml, safeHref, stripControlSequences } from "./html";
import { DIFF_SIDE_CLASSES, STATUS_CLASSES, STATUS_IS_LIVE, STATUS_LABELS, TONE_CLASSES } from "./tokens";

/**
 * What an embedder tells the host about itself.
 *
 * A symbol and an emblem are registry keys the contract says the host resolves, so the registry is
 * the embedder's: a desktop application has an icon set and a plain document has none. A key with
 * no entry falls back to the span's own text, which is what the contract states and what keeps an
 * unknown emblem from costing a reader the row it decorated.
 */
export interface GuiViewOptions {
	/** Glyph or markup for a symbol, emblem or `status:<name>` key; an unknown key draws the text. */
	symbols?: Readonly<Record<string, string>>;
}

const NO_OPTIONS: GuiViewOptions = {};

/**
 * The Markdown renderer, configured once.
 *
 * Raw HTML inside a document a model wrote is escaped rather than emitted, and a link is followed
 * only when its scheme is one this host follows, because both arrive from the same untrusted place
 * the rest of the view does.
 */
const markdown = new Marked({
	gfm: true,
	breaks: true,
	renderer: {
		html({ text }) {
			return escapeHtml(text);
		},
		link({ href, title, tokens }) {
			const inner = this.parser.parseInline(tokens);
			const url = safeHref(href);
			if (url === null) return inner;
			const titleAttribute = title === null || title === undefined ? "" : ` title="${escapeHtml(title)}"`;
			return `<a href="${escapeHtml(url)}"${titleAttribute} rel="noopener noreferrer">${inner}</a>`;
		},
	},
});

/** A Markdown document as HTML, or its escaped source when the renderer refuses it. */
function renderMarkdownBlock(source: string): string {
	try {
		return markdown.parse(source, { async: false });
	} catch {
		return escapeHtml(source);
	}
}

/** One line of Markdown as HTML, with no paragraph around it. */
function renderMarkdownInline(source: string): string {
	try {
		return markdown.parseInline(source, { async: false });
	} catch {
		return escapeHtml(source);
	}
}

/**
 * A fact a row states either way, as the attribute value that says which.
 *
 * `element` writes `true` as the bare attribute HTML defines for `disabled` and `checked`, and that
 * spelling is wrong for a `data-` attribute: a bare `data-opens` reads back as the empty string,
 * which is falsy, so a node that opens its subtree would be read as one that does not, and `false`
 * would drop the attribute and be indistinguishable from a tool that said nothing. Both answers are
 * written out, so a stylesheet can select either and `dataset.opens === "true"` is the whole read.
 */
function stated(fact: boolean): string {
	return fact ? "true" : "false";
}

/** The text a span draws, before emphasis and before the element that carries its tone. */
function spanContent(span: ViewSpan, options: GuiViewOptions): string {
	if (span.symbol !== undefined) return options.symbols?.[span.symbol] ?? escapeHtml(span.text);
	if (span.status !== undefined) return options.symbols?.[`status:${span.status}`] ?? escapeHtml(span.text);
	if (span.captured === true) return escapeHtml(stripControlSequences(span.text));
	if (span.markdown === true) return renderMarkdownInline(span.text);
	return escapeHtml(span.text);
}

/** The emphasis a span asked for, innermost first, around content already safe. */
function emphasize(span: ViewSpan, content: string): string {
	let drawn = content;
	if (span.bold === true) drawn = element("strong", {}, drawn);
	if (span.italic === true) drawn = element("em", {}, drawn);
	if (span.strike === true) drawn = element("s", {}, drawn);
	return drawn;
}

/**
 * The class a span's own element carries.
 *
 * A span that IS a mark takes the mark's appearance and never the tone beside it, which is what the
 * contract states: two rows reporting the same state look the same however the tool toned the words
 * next to them.
 */
function spanClass(span: ViewSpan): string | undefined {
	if (span.status !== undefined) return classes("v-mark", STATUS_CLASSES[span.status]);
	if (span.symbol !== undefined)
		return classes("v-symbol", span.tone === undefined ? undefined : TONE_CLASSES[span.tone]);
	if (span.captured === true) return "v-captured";
	return classes(
		span.badge === true ? "v-chip" : undefined,
		span.tone === undefined ? undefined : TONE_CLASSES[span.tone],
	);
}

/** One span as the element that draws it, reachable when it named a target this host follows. */
export function drawSpan(span: ViewSpan, options: GuiViewOptions = NO_OPTIONS): string {
	const drawn = element(
		span.captured === true ? "code" : "span",
		{
			class: spanClass(span),
			"data-symbol": span.symbol,
			"data-status": span.status,
			"data-file": span.file,
			"data-file-line": span.file === undefined ? undefined : span.fileLine,
			"data-language": span.language,
			"data-live": span.live === true ? "true" : undefined,
			"aria-label": span.status === undefined ? undefined : STATUS_LABELS[span.status],
			role: span.status === undefined ? undefined : "img",
		},
		emphasize(span, spanContent(span, options)),
	);
	if (span.link === undefined) return drawn;
	const href = safeHref(span.link);
	return href === null ? drawn : element("a", { href, rel: "noopener noreferrer" }, drawn);
}

/**
 * Every span of one line, with the trailing runs gathered into their own element.
 *
 * The first run a tool marked trailing opens the tail and nothing after it leaves it, so a host that
 * lays a row out in columns has the two halves to place. This host writes them as two elements and
 * leaves the placing to a stylesheet.
 */
export function drawLine(line: ViewLine, options: GuiViewOptions = NO_OPTIONS): string {
	const tailStart = line.findIndex(span => span.trailing === true);
	if (tailStart === -1) return line.map(span => drawSpan(span, options)).join("");
	const lead = line
		.slice(0, tailStart)
		.map(span => drawSpan(span, options))
		.join("");
	const tail = line
		.slice(tailStart)
		.map(span => drawSpan(span, options))
		.join("");
	return lead + element("span", { class: "v-trailing" }, tail);
}

/** A status row as the header element a card is titled by. */
export function drawStatusRow(view: StatusRowView, options: GuiViewOptions = NO_OPTIONS): string {
	const parts: string[] = [];
	const emblem = view.emblem === undefined ? undefined : options.symbols?.[view.emblem];
	if (emblem !== undefined) {
		parts.push(
			element(
				"span",
				{
					class: classes("v-emblem", view.emblemTone === undefined ? undefined : TONE_CLASSES[view.emblemTone]),
					"data-emblem": view.emblem,
				},
				emblem,
			),
		);
	} else if (view.status !== undefined) {
		parts.push(drawStatusMark(view.status, options));
	}
	parts.push(
		element(
			"span",
			{ class: classes("v-title", view.titleTone === undefined ? undefined : TONE_CLASSES[view.titleTone]) },
			escapeHtml(view.title),
		),
	);
	if (view.description !== undefined) parts.push(drawDescription(view));
	if (view.badge !== undefined) {
		parts.push(
			element("span", { class: classes("v-chip", TONE_CLASSES[view.badge.tone]) }, escapeHtml(view.badge.label)),
		);
	}
	if (view.language !== undefined) {
		parts.push(element("span", { class: "v-language", "data-language": view.language }, escapeHtml(view.language)));
	}
	if (view.meta !== undefined && view.meta.length > 0) {
		const entries = view.meta.map(entry => element("span", { class: "v-meta-entry" }, drawLine(entry, options)));
		parts.push(element("span", { class: "v-meta" }, entries.join("")));
	}
	return element(
		"div",
		{ class: "v-row", "data-status": view.status, "data-live": isLive(view.status) ? "true" : undefined },
		parts.join(""),
	);
}

/** The mark a status draws as, from the embedder's icon set or from the word itself. */
function drawStatusMark(status: ViewStatus, options: GuiViewOptions): string {
	return element(
		"span",
		{
			class: classes("v-mark", STATUS_CLASSES[status]),
			role: "img",
			"aria-label": STATUS_LABELS[status],
			"data-status": status,
		},
		options.symbols?.[`status:${status}`] ?? "",
	);
}

/** Whether a row reports work in flight, which a stylesheet may animate. */
function isLive(status: ViewStatus | undefined): boolean {
	return status !== undefined && STATUS_IS_LIVE[status];
}

/**
 * The description of a row, which is the row's subject when it names one.
 *
 * `descriptionFits` is a terminal's shortening decision, and this host carries it as a mark rather
 * than cutting the text: a stylesheet cuts a path through the middle with `text-overflow`, and a
 * host that cut the string would have chosen a width nobody gave it.
 */
function drawDescription(view: StatusRowView): string {
	const tone = view.descriptionTone === undefined ? undefined : TONE_CLASSES[view.descriptionTone];
	const drawn = element(
		"span",
		{
			class: classes("v-description", tone, view.descriptionFits === true ? "v-fits" : undefined),
			"data-file": view.descriptionFile,
			"data-file-line": view.descriptionFile === undefined ? undefined : view.descriptionFileLine,
		},
		escapeHtml(view.description ?? ""),
	);
	if (view.descriptionLink === undefined) return drawn;
	const href = safeHref(view.descriptionLink);
	return href === null ? drawn : element("a", { href, rel: "noopener noreferrer" }, drawn);
}

/** A text block as one paragraph of styled runs. */
export function drawTextBlock(view: TextBlockView, options: GuiViewOptions = NO_OPTIONS): string {
	return element("p", { class: "v-text" }, drawLine(view.spans, options));
}

/** The unit a held-back count is in, as the words that follow it. */
function nounFor(hidden: ViewHiddenCount): string {
	if (hidden.noun === undefined) return "";
	return ` ${hidden.count === 1 ? hidden.noun.one : hidden.noun.many}`;
}

/**
 * What a card or a section held back, and the control for asking to see it.
 *
 * The tool states the count and whether more is reachable; the gesture is the host's, so a
 * revealable hold-back is a button and one that is not is a sentence.
 */
function drawHidden(hidden: ViewHiddenCount): string {
	if (hidden.count <= 0) return "";
	const sentence = `${hidden.count} more${nounFor(hidden)}`;
	const body = hidden.revealable
		? element("button", { type: "button", class: "v-reveal" }, escapeHtml(sentence))
		: escapeHtml(sentence);
	return element(
		"p",
		{ class: "v-hidden", "data-count": hidden.count, "data-revealable": stated(hidden.revealable) },
		body,
	);
}

/**
 * The end of a run of rows, in the rows the tool allowed, with a note for what came before.
 *
 * `viewport` and `reserve` describe a terminal's remaining screen and are ignored here, which is
 * why a section with no `max` keeps every row: a document scrolls, so the honest answer to "as many
 * rows as the host has" is all of them.
 */
function applyTail(
	rows: readonly string[],
	tail: ViewTailWindow | undefined,
): { rows: readonly string[]; dropped: number } {
	if (tail?.max === undefined || tail.max <= 0 || rows.length <= tail.max) return { rows, dropped: 0 };
	return { rows: rows.slice(rows.length - tail.max), dropped: rows.length - tail.max };
}

/** The note a host writes for the rows a tail window dropped. */
function drawTailNote(dropped: number): string {
	if (dropped <= 0) return "";
	return element("p", { class: "v-tail-note", "data-dropped": dropped }, escapeHtml(`${dropped} earlier lines`));
}

/** The number a code line carries in the file, or `null` when it has none. */
function codeLineNumber(code: ViewCodeLines, index: number): number | null {
	if (code.lineNumbers !== undefined) return code.lineNumbers[index] ?? null;
	if (code.firstLineNumber === undefined) return null;
	return code.firstLineNumber + index;
}

/**
 * A code section as a numbered list of source lines.
 *
 * The spans of a code line carry text alone, so the source is joined from them and handed to the
 * document as text: colouring it is the embedder's, through whatever highlighter it mounts on
 * `data-language`, and a host that tokenized here would be a second answer to a question the
 * stylesheet already owns.
 */
function drawCodeSection(lines: readonly ViewLine[], code: ViewCodeLines): string {
	const rows = lines.map((line, index) => {
		const number = codeLineNumber(code, index);
		const source = line.map(span => span.text).join("");
		return element(
			"li",
			{ class: "v-code-line", value: number ?? undefined, "data-line": number ?? undefined },
			element("code", {}, escapeHtml(source)),
		);
	});
	const lead = code.lead === undefined ? "" : element("p", { class: "v-code-lead" }, escapeHtml(code.lead));
	return (
		lead +
		element(
			"ol",
			{
				class: "v-code",
				"data-language": code.language,
				"data-total-lines": code.totalLines,
				"data-numbered": stated(code.firstLineNumber !== undefined || code.lineNumbers !== undefined),
			},
			rows.join(""),
		)
	);
}

/**
 * A change as a numbered list of rows, each marked with the side it is on.
 *
 * The marker column, the colours and whatever a host does with the words inside a replaced line are
 * all the host's; this one states the side as an attribute and leaves every one of them to a
 * stylesheet, which is how the same model draws as two columns somewhere else.
 */
function drawDiffSection(lines: readonly ViewLine[], diff: ViewDiffLines): string {
	const rows = lines.map((line, index) => {
		const side = diff.sides[index] ?? "context";
		const number = diff.lineNumbers?.[index] ?? null;
		const source = line.map(span => span.text).join("");
		return element(
			"li",
			{
				class: classes("v-diff-line", DIFF_SIDE_CLASSES[side]),
				"data-side": side,
				value: number ?? undefined,
				"data-line": number ?? undefined,
			},
			element("code", {}, escapeHtml(source)),
		);
	});
	return element("ol", { class: "v-diff", "data-path": diff.path }, rows.join(""));
}

/**
 * A tree section as a list whose rows state where they sit.
 *
 * A terminal draws the branch, the elbow and the vertical run; a document indents, and the depth,
 * whether a row opens its node and whether that node is its parent's last child are the three facts
 * a stylesheet needs to do it. No glyph is named here, which is the part that was terminal chrome
 * in every hand-written card that drew one.
 */
function drawTreeSection(lines: readonly ViewLine[], tree: ViewTreeLines, options: GuiViewOptions): string {
	const rows = lines.map((line, index) =>
		element(
			"li",
			{
				class: "v-tree-node",
				"data-depth": tree.depth[index] ?? 0,
				"data-opens": stated(tree.opens[index] === true),
				"data-last": stated(tree.last[index] === true),
			},
			drawLine(line, options),
		),
	);
	return element("ul", { class: "v-tree" }, rows.join(""));
}

/** A list section as list items, one per line the tool stated. */
function drawListSection(lines: readonly ViewLine[], options: GuiViewOptions): string {
	const rows = lines.map(line => element("li", { class: "v-item" }, drawLine(line, options)));
	return element("ul", { class: "v-list" }, rows.join(""));
}

/** A section's lines as prose rows, cut to the window the tool asked for. */
function drawProseSection(lines: readonly ViewLine[], section: ViewSection, options: GuiViewOptions): string {
	const drawn = lines.map(line =>
		element(
			"div",
			{ class: classes("v-line", section.clip === true ? "v-clip" : undefined) },
			drawLine(line, options),
		),
	);
	const window = applyTail(drawn, section.tail);
	return drawTailNote(window.dropped) + window.rows.join("");
}

/**
 * One section's body, by what the tool said its lines ARE.
 *
 * A section that states both `diff` and `code` is a tool contradicting itself, and the contract
 * names the reading that keeps the meaning of a `-` row: draw the diff.
 */
function drawSectionBody(section: ViewSection, options: GuiViewOptions): string {
	if (section.diff !== undefined) return drawDiffSection(section.lines, section.diff);
	if (section.code !== undefined) return drawCodeSection(section.lines, section.code);
	if (section.markdown === true) {
		const source = section.lines.map(line => line.map(span => span.text).join("")).join("\n");
		const tone = section.lines[0]?.[0]?.tone;
		return element(
			"div",
			{ class: classes("v-markdown", tone === undefined ? undefined : TONE_CLASSES[tone]) },
			renderMarkdownBlock(source),
		);
	}
	if (section.tree !== undefined) return drawTreeSection(section.lines, section.tree, options);
	if (section.list === true) return drawListSection(section.lines, options);
	return drawProseSection(section.lines, section, options);
}

/** One labelled group of lines. */
function drawSection(section: ViewSection, index: number, options: GuiViewOptions): string {
	const label =
		section.label === undefined ? "" : element("h3", { class: "v-section-label" }, escapeHtml(section.label));
	const hidden = section.hidden === undefined ? "" : drawHidden(section.hidden);
	return element(
		"section",
		{
			class: "v-section",
			"data-separator": index > 0 && section.separator === true ? "true" : undefined,
		},
		label + drawSectionBody(section, options) + hidden,
	);
}

/** A framed block as the region a card's body sits in. */
export function drawFramedBlock(view: FramedBlockView, options: GuiViewOptions = NO_OPTIONS): string {
	const header = view.header === undefined ? "" : drawStatusRow(view.header, options);
	const sections = view.sections.map((section, index) => drawSection(section, index, options)).join("");
	return element(
		"section",
		{
			class: "v-framed",
			"data-state": view.state,
			"data-contents": view.contents ?? "report",
			"data-gutter": view.gutter === true ? "true" : undefined,
			"data-live": isLive(view.state) ? "true" : undefined,
		},
		header + sections,
	);
}

/** A headed block as a header row with its own lines under it and no frame. */
export function drawHeadedBlock(view: HeadedBlockView, options: GuiViewOptions = NO_OPTIONS): string {
	const header = view.header === undefined ? "" : drawStatusRow(view.header, options);
	const drawn = view.lines.map(line => element("div", { class: "v-line" }, drawLine(line, options)));
	const window = applyTail(drawn, view.tail);
	const hidden = view.hidden === undefined ? "" : drawHidden(view.hidden);
	const body = element("div", { class: "v-lines" }, drawTailNote(window.dropped) + window.rows.join(""));
	return element("section", { class: "v-headed" }, header + body + hidden);
}

/** A notice as the region whose whole body carries one state. */
export function drawNotice(view: NoticeView, options: GuiViewOptions = NO_OPTIONS): string {
	const mark = view.mark === undefined ? undefined : options.symbols?.[view.mark];
	const parts: string[] = [];
	if (mark !== undefined) parts.push(element("span", { class: "v-notice-mark", "data-mark": view.mark }, mark));
	parts.push(element("span", { class: "v-notice-headline" }, drawNoticeLine(view.headline, options)));
	if (view.tag !== undefined) parts.push(element("span", { class: "v-notice-tag" }, escapeHtml(view.tag)));
	const body =
		view.body === undefined
			? ""
			: element(
					"div",
					{ class: "v-notice-body" },
					view.body.map(line => element("div", { class: "v-line" }, drawNoticeLine(line, options))).join(""),
				);
	return element(
		"aside",
		{
			class: classes("v-notice", STATUS_CLASSES[view.state]),
			"data-state": view.state,
			role: view.state === "error" ? "alert" : "status",
		},
		parts.join("") + body,
	);
}

/**
 * One line of a notice, whose colour the notice already answered.
 *
 * A span inside a notice states emphasis and structure, never colour: the whole notice is one
 * state, so a tone on such a span is the tool overriding it and this host ignores it, which is the
 * freedom the contract states.
 */
function drawNoticeLine(line: ViewLine, options: GuiViewOptions): string {
	const toneless: ViewSpan[] = line.map(span => (span.tone === undefined ? span : { ...span, tone: undefined }));
	return toneless.map(span => drawSpan(span, options)).join("");
}

/** Every kind of view this host draws, which is every kind the contract declares. */
export const VIEW_KINDS_DRAWN: Record<ToolView["kind"], true> = {
	statusRow: true,
	textBlock: true,
	headedBlock: true,
	framedBlock: true,
	notice: true,
};

/** A view as the HTML that draws it. */
export function drawToolView(view: ToolView, options: GuiViewOptions = NO_OPTIONS): string {
	switch (view.kind) {
		case "statusRow":
			return drawStatusRow(view, options);
		case "textBlock":
			return drawTextBlock(view, options);
		case "headedBlock":
			return drawHeadedBlock(view, options);
		case "framedBlock":
			return drawFramedBlock(view, options);
		case "notice":
			return drawNotice(view, options);
	}
}

/**
 * The two halves of one tool's card, as HTML.
 *
 * A half is present only when the tool describes it, which is the same shape the contract states: a
 * tool that says nothing about its call leaves the call to the host's own presentation, and an
 * embedder that finds `renderCall` undefined draws its default rather than an empty element.
 */
export interface GuiToolCard<Args, Result> {
	renderCall?: (args: Args, context: ToolViewContext) => string;
	renderResult?: (result: Result, context: ToolViewContext, args?: Args) => string;
}

/**
 * A tool's own renderer as the two cards this host draws from it.
 *
 * The terminal's `viewToolRenderer` does the same job with a `Theme` and a component tree. Neither
 * signature reaches the tool, which is the whole claim: the plugin that produced the renderer is
 * the same file in both hosts.
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
