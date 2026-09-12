/**
 * Shared, browser-portable semantic interpretation engine for the ToolView contract.
 *
 * Implements the single source of truth for semantic interpretation (statuses, spans,
 * line tail splitting, status rows, code lines, diff lines, tree lines, hidden counts,
 * tail windows, markdown sections, section dispatch, and blocks) across all hosts.
 *
 * Uses a small element-construction adapter (ViewAdapter<TOutput>) to build host-specific
 * representations (HTML strings in GUI host, React nodes in web/export renderer).
 */

import {
	type FramedBlockView,
	type HeadedBlockView,
	type NoticeView,
	type StatusRowView,
	type TextBlockView,
	type ToolView,
	UNICODE_SYMBOLS,
	type ViewCodeLines,
	type ViewDiffLines,
	type ViewDiffSide,
	type ViewHiddenCount,
	type ViewLine,
	type ViewSection,
	type ViewSpan,
	type ViewStatus,
	type ViewTailWindow,
	type ViewTone,
	type ViewTreeLines,
} from "@veyyon/view";
import { Marked } from "marked";

/** HTML character escaping helper. */
export function escapeHtml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

/** Control sequence removal for captured screens. */
const CONTROL_SEQUENCE =
	/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\-_]|[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

export function stripControlSequences(text: string): string {
	return text.replace(CONTROL_SEQUENCE, "");
}

/** Safe URL protocol allowlist. */
const SAFE_SCHEMES: Record<string, true> = {
	"http:": true,
	"https:": true,
	"mailto:": true,
	"file:": true,
};

export function safeHref(target: string | undefined): string | null {
	if (!target) return null;
	const trimmed = target.trim();
	if (trimmed === "") return null;
	let parsed: URL;
	try {
		parsed = new URL(trimmed, "https://veyyon.invalid/");
	} catch {
		return null;
	}
	if (!SAFE_SCHEMES[parsed.protocol]) return null;
	return trimmed;
}

/** Markdown parser configured for safe document rendering. */
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
			const titleAttribute = title ? ` title="${escapeHtml(title)}"` : "";
			return `<a href="${escapeHtml(url)}"${titleAttribute} rel="noopener noreferrer">${inner}</a>`;
		},
	},
});

export function renderMarkdownBlock(source: string): string {
	try {
		return markdown.parse(source, { async: false }) as string;
	} catch {
		return escapeHtml(source);
	}
}

export function renderMarkdownInline(source: string): string {
	try {
		return markdown.parseInline(source, { async: false }) as string;
	} catch {
		return escapeHtml(source);
	}
}

/** The class each tone draws under. */
export const TONE_CLASSES: Record<ViewTone, string> = {
	title: "v-tone-title",
	accent: "v-tone-accent",
	output: "v-tone-output",
	link: "v-tone-link",
	muted: "v-tone-muted",
	dim: "v-tone-dim",
	diffAdded: "v-tone-diff-added",
	diffRemoved: "v-tone-diff-removed",
	success: "v-tone-success",
	warning: "v-tone-warning",
	error: "v-tone-error",
	info: "v-tone-info",
	cost: "v-tone-cost",
	text: "v-tone-text",
};

/** The class each status draws under. */
export const STATUS_CLASSES: Record<ViewStatus, string> = {
	success: "v-status-success",
	done: "v-status-done",
	error: "v-status-error",
	warning: "v-status-warning",
	info: "v-status-info",
	pending: "v-status-pending",
	running: "v-status-running",
	aborted: "v-status-aborted",
};

/** What each status is called for accessibility and labels. */
export const STATUS_LABELS: Record<ViewStatus, string> = {
	success: "succeeded",
	done: "done",
	error: "failed",
	warning: "warning",
	info: "info",
	pending: "pending",
	running: "running",
	aborted: "aborted",
};

/** Whether a status reports work still in flight. */
export const STATUS_IS_LIVE: Record<ViewStatus, boolean> = {
	success: false,
	done: false,
	error: false,
	warning: false,
	info: false,
	pending: true,
	running: true,
	aborted: false,
};

export function isLive(status: ViewStatus | undefined): boolean {
	return status !== undefined && STATUS_IS_LIVE[status];
}

/** The class each side of a diff draws under. */
export const DIFF_SIDE_CLASSES: Record<ViewDiffSide, string> = {
	added: "v-diff-added",
	removed: "v-diff-removed",
	context: "v-diff-context",
	gap: "v-diff-gap",
};

/**
 * The glyph every web host draws a symbol, emblem or notice mark key from: the same Unicode table the
 * terminal's plain preset uses, so a card names `tool.edit` and every host draws `✎`. A key with no
 * row draws nothing here and the span's own text in its place; the key itself is never text.
 */
export const CANONICAL_SYMBOLS: Readonly<Record<string, string>> = UNICODE_SYMBOLS;

export const VIEW_TONES: readonly ViewTone[] = Object.freeze(Object.keys(TONE_CLASSES) as ViewTone[]);
export const VIEW_STATUSES: readonly ViewStatus[] = Object.freeze(Object.keys(STATUS_CLASSES) as ViewStatus[]);
export const VIEW_DIFF_SIDES: readonly ViewDiffSide[] = Object.freeze(Object.keys(DIFF_SIDE_CLASSES) as ViewDiffSide[]);

export const VIEW_KINDS_DRAWN: Record<ToolView["kind"], true> = {
	statusRow: true,
	textBlock: true,
	headedBlock: true,
	framedBlock: true,
	notice: true,
};

/** The unit a held-back count is in, as the words that follow it. */
export function nounFor(hidden: ViewHiddenCount): string {
	if (hidden.noun === undefined) return "";
	return ` ${hidden.count === 1 ? hidden.noun.one : hidden.noun.many}`;
}

/** The line number a code line carries in the file, or null when it has none. */
export function codeLineNumber(code: ViewCodeLines, index: number): number | null {
	if (code.lineNumbers !== undefined) return code.lineNumbers[index] ?? null;
	if (code.firstLineNumber === undefined) return null;
	return code.firstLineNumber + index;
}

/** Slices a list of rows to the tail window maximum and returns the dropped count. */
export function applyTail<T>(
	rows: readonly T[],
	tail: ViewTailWindow | undefined,
): { rows: readonly T[]; dropped: number } {
	if (tail?.max === undefined || tail.max <= 0 || rows.length <= tail.max) return { rows, dropped: 0 };
	const dropped = rows.length - tail.max;
	return { rows: rows.slice(dropped), dropped };
}

// ---------------------------------------------------------------------------
// ViewAdapter Props and Interface
// ---------------------------------------------------------------------------

export interface SpanAttributes {
	symbol?: string;
	status?: ViewStatus;
	file?: string;
	fileLine?: number;
	language?: string;
	live?: boolean;
	ariaLabel?: string;
	role?: string;
	tone?: ViewTone;
	badge?: boolean;
	captured?: boolean;
}

export interface StatusRowProps<TOutput> {
	status?: ViewStatus;
	live?: boolean;
	inline?: boolean;
	/** Present only when the host resolved the emblem's glyph; an unknown emblem leaves the status mark. */
	emblem?: {
		name: string;
		tone?: ViewTone;
		element: TOutput;
	};
	statusMark?: {
		status: ViewStatus;
		element?: TOutput;
	};
	title: string;
	titleTone?: ViewTone;
	description?: {
		text: string;
		tone?: ViewTone;
		fits?: boolean;
		file?: string;
		fileLine?: number;
		link?: string;
	};
	badge?: {
		label: string;
		tone: ViewTone;
	};
	language?: {
		name: string;
	};
	meta?: TOutput[];
}

export interface CodeRowData<TOutput> {
	index: number;
	line: number | null;
	content: TOutput;
}

export interface DiffRowData<TOutput> {
	index: number;
	side: ViewDiffSide;
	line: number | null;
	content: TOutput;
}

export interface TreeRowData<TOutput> {
	index: number;
	depth: number;
	opens: boolean;
	last: boolean;
	content: TOutput;
}

export interface ProseRowData<TOutput> {
	index: number;
	clip?: boolean;
	content: TOutput;
}

export interface ViewAdapter<TOutput> {
	/** Convert raw text to output. */
	text(str: string): TOutput;
	/** Convert sanitized Markdown HTML to output. */
	rawHtml?(html: string, inline?: boolean): TOutput;
	/** Combine a list of outputs into a fragment. */
	fragment(children: TOutput[]): TOutput;

	/** Build a span element. */
	span(attrs: SpanAttributes, child: TOutput): TOutput;
	/** Apply inline emphasis. */
	emphasis(type: "bold" | "italic" | "strike", child: TOutput): TOutput;
	/** Wrap with a hyperlink. */
	link(href: string, child: TOutput): TOutput;
	/** Wrap with an agent link if supported. */
	agentLink?(agentId: string, child: TOutput): TOutput;
	/** Wrap trailing runs in a line. */
	trailing(child: TOutput): TOutput;

	/** The element for a symbol key, or `undefined` for a key this host has no glyph for. */
	resolveSymbol?(symbol: string): TOutput | undefined;
	/** Status mark symbol resolution hook. */
	resolveStatusMark?(status: ViewStatus): TOutput | undefined;

	/** Status row element. */
	statusRow(props: StatusRowProps<TOutput>): TOutput;

	/** Text block element. */
	textBlock(child: TOutput): TOutput;

	/** Code section element. */
	codeSection(props: {
		lead?: string;
		language?: string;
		totalLines?: number;
		numbered: boolean;
		rows: CodeRowData<TOutput>[];
	}): TOutput;

	/** Diff section element. */
	diffSection(props: { path?: string; rows: DiffRowData<TOutput>[] }): TOutput;

	/** Tree section element. */
	treeSection(props: { rows: TreeRowData<TOutput>[] }): TOutput;

	/** List section element. */
	listSection(props: { rows: TOutput[] }): TOutput;

	/** Prose section lines with tail note. */
	proseSection(props: { rows: readonly ProseRowData<TOutput>[]; dropped: number }): TOutput;

	/** Markdown section block. */
	markdownSection(props: { html: string; tone?: ViewTone }): TOutput;

	/** Hidden count note. */
	hiddenNote(props: { count: number; noun: string; revealable: boolean }): TOutput | undefined;

	/** Section container. */
	section(props: { index: number; label?: string; separator?: boolean; body: TOutput; hidden?: TOutput }): TOutput;

	/** Framed block container. */
	framedBlock(props: {
		header?: TOutput;
		sections: TOutput[];
		state?: ViewStatus;
		contents: string;
		gutter?: boolean;
		live?: boolean;
	}): TOutput;

	/** Headed block lines container. */
	headedBody(props: { rows: readonly TOutput[]; dropped: number }): TOutput;

	/** Headed block container. */
	headedBlock(props: { header?: TOutput; body: TOutput; hidden?: TOutput }): TOutput;

	/** Notice element. */
	notice(props: {
		state: ViewStatus;
		role: "alert" | "status";
		mark?: string;
		markElement?: TOutput;
		headline: TOutput;
		tag?: string;
		body?: TOutput[];
	}): TOutput;
}

// ---------------------------------------------------------------------------
// Unified Semantic Rendering Functions
// ---------------------------------------------------------------------------

/** Renders a single ViewSpan using the element adapter. */
export function renderSpan<T>(span: ViewSpan, adapter: ViewAdapter<T>): T {
	let contentNode: T;
	if (span.symbol !== undefined) {
		const resolved = adapter.resolveSymbol?.(span.symbol);
		if (resolved !== undefined) {
			contentNode = resolved;
		} else {
			contentNode = adapter.text(span.text);
		}
	} else if (span.status !== undefined) {
		const resolved = adapter.resolveStatusMark?.(span.status);
		if (resolved !== undefined) {
			contentNode = resolved;
		} else {
			contentNode = adapter.text(span.text);
		}
	} else if (span.captured === true) {
		const clean = stripControlSequences(span.text);
		contentNode = adapter.text(clean);
	} else if (span.markdown === true) {
		const html = renderMarkdownInline(span.text);
		contentNode = adapter.rawHtml ? adapter.rawHtml(html, true) : adapter.text(span.text);
	} else {
		contentNode = adapter.text(span.text);
	}

	if (span.bold === true) contentNode = adapter.emphasis("bold", contentNode);
	if (span.italic === true) contentNode = adapter.emphasis("italic", contentNode);
	if (span.strike === true) contentNode = adapter.emphasis("strike", contentNode);

	if (span.agentId && adapter.agentLink) {
		return adapter.agentLink(span.agentId, contentNode);
	}

	const spanNode = adapter.span(
		{
			symbol: span.symbol,
			status: span.status,
			file: span.file,
			fileLine: span.file === undefined ? undefined : span.fileLine,
			language: span.language,
			live: span.live === true,
			ariaLabel: span.status !== undefined ? STATUS_LABELS[span.status] : undefined,
			role: span.status !== undefined ? "img" : undefined,
			tone: span.tone,
			badge: span.badge === true,
			captured: span.captured === true,
		},
		contentNode,
	);

	if (span.link !== undefined) {
		const href = safeHref(span.link);
		if (href !== null) {
			return adapter.link(href, spanNode);
		}
	}
	return spanNode;
}

/** Renders a line of spans, grouping trailing runs into a trailing container. */
export function renderLine<T>(line: ViewLine, adapter: ViewAdapter<T>): T {
	const tailStart = line.findIndex(span => span.trailing === true);
	if (tailStart === -1) {
		const spans = line.map(span => renderSpan(span, adapter));
		return adapter.fragment(spans);
	}

	const leadSpans = line.slice(0, tailStart).map(span => renderSpan(span, adapter));
	const tailSpans = line.slice(tailStart).map(span => renderSpan(span, adapter));
	const tailNode = adapter.trailing(adapter.fragment(tailSpans));
	return adapter.fragment([...leadSpans, tailNode]);
}

/** Renders a status row with title, description, badge, language and metadata. */
export function renderStatusRow<T>(view: StatusRowView, adapter: ViewAdapter<T>, inline?: boolean): T {
	const emblemElement = view.emblem === undefined ? undefined : adapter.resolveSymbol?.(view.emblem);
	const emblem =
		emblemElement === undefined || view.emblem === undefined
			? undefined
			: { name: view.emblem, tone: view.emblemTone, element: emblemElement };
	const statusMark =
		emblem === undefined && view.status !== undefined
			? { status: view.status, element: adapter.resolveStatusMark?.(view.status) ?? adapter.text("") }
			: undefined;
	return adapter.statusRow({
		status: view.status,
		live: isLive(view.status),
		inline,
		emblem,
		statusMark,
		title: view.title,
		titleTone: view.titleTone,
		description:
			view.description === undefined
				? undefined
				: {
						text: view.description,
						tone: view.descriptionTone,
						fits: view.descriptionFits === true,
						file: view.descriptionFile,
						fileLine: view.descriptionFile === undefined ? undefined : view.descriptionFileLine,
						link: safeHref(view.descriptionLink) ?? undefined,
					},
		badge: view.badge,
		language: view.language === undefined ? undefined : { name: view.language },
		meta: view.meta?.map(line => renderLine(line, adapter)),
	});
}

/** Renders a TextBlockView. */
export function renderTextBlock<T>(view: TextBlockView, adapter: ViewAdapter<T>): T {
	return adapter.textBlock(renderLine(view.spans, adapter));
}

/** Renders a code section with numbered lines. */
export function renderCodeSection<T>(lines: readonly ViewLine[], code: ViewCodeLines, adapter: ViewAdapter<T>): T {
	const rows: CodeRowData<T>[] = lines.map((line, index) => {
		const lineNum = codeLineNumber(code, index);
		const content = renderLine(line, adapter);
		return { index, line: lineNum, content };
	});
	return adapter.codeSection({
		lead: code.lead,
		language: code.language,
		totalLines: code.totalLines,
		numbered: code.firstLineNumber !== undefined || code.lineNumbers !== undefined,
		rows,
	});
}

/** Renders a diff section with sides and path. */
export function renderDiffSection<T>(lines: readonly ViewLine[], diff: ViewDiffLines, adapter: ViewAdapter<T>): T {
	const rows: DiffRowData<T>[] = lines.map((line, index) => {
		const side = diff.sides[index] ?? "context";
		const lineNum = diff.lineNumbers !== undefined ? (diff.lineNumbers[index] ?? null) : null;
		const content = renderLine(line, adapter);
		return { index, side, line: lineNum, content };
	});
	return adapter.diffSection({
		path: diff.path,
		rows,
	});
}

/** Renders a tree section with depth, opens, and last attributes. */
export function renderTreeSection<T>(lines: readonly ViewLine[], tree: ViewTreeLines, adapter: ViewAdapter<T>): T {
	const rows: TreeRowData<T>[] = lines.map((line, index) => ({
		index,
		depth: tree.depth[index] ?? 0,
		opens: tree.opens[index] === true,
		last: tree.last[index] === true,
		content: renderLine(line, adapter),
	}));
	return adapter.treeSection({ rows });
}

/** Renders a list section. */
export function renderListSection<T>(lines: readonly ViewLine[], adapter: ViewAdapter<T>): T {
	const rows = lines.map(line => renderLine(line, adapter));
	return adapter.listSection({ rows });
}

/** Renders a prose section with clipping and tail window. */
export function renderProseSection<T>(lines: readonly ViewLine[], section: ViewSection, adapter: ViewAdapter<T>): T {
	const rows: ProseRowData<T>[] = lines.map((line, index) => ({
		index,
		clip: section.clip === true,
		content: renderLine(line, adapter),
	}));
	const window = applyTail(rows, section.tail);
	return adapter.proseSection({
		rows: window.rows,
		dropped: window.dropped,
	});
}

/** Renders a markdown section block. */
export function renderMarkdownSection<T>(lines: readonly ViewLine[], adapter: ViewAdapter<T>): T {
	const source = lines.map(line => line.map(span => span.text).join("")).join("\n");
	const tone = lines[0]?.[0]?.tone;
	const html = renderMarkdownBlock(source);
	return adapter.markdownSection({ html, tone });
}

/** Renders a section body dispatching by content type in prioritized order. */
export function renderSectionBody<T>(section: ViewSection, adapter: ViewAdapter<T>): T {
	if (section.diff !== undefined) return renderDiffSection(section.lines, section.diff, adapter);
	if (section.code !== undefined) return renderCodeSection(section.lines, section.code, adapter);
	if (section.markdown === true) return renderMarkdownSection(section.lines, adapter);
	if (section.tree !== undefined) return renderTreeSection(section.lines, section.tree, adapter);
	if (section.list === true) return renderListSection(section.lines, adapter);
	return renderProseSection(section.lines, section, adapter);
}

/** Renders a single ViewSection. */
export function renderSection<T>(section: ViewSection, index: number, adapter: ViewAdapter<T>): T {
	const body = renderSectionBody(section, adapter);
	let hidden: T | undefined;
	if (section.hidden !== undefined && section.hidden.count > 0) {
		hidden = adapter.hiddenNote({
			count: section.hidden.count,
			noun: nounFor(section.hidden),
			revealable: section.hidden.revealable === true,
		});
	}
	return adapter.section({
		index,
		label: section.label,
		separator: index > 0 && section.separator === true,
		body,
		hidden,
	});
}

/** Renders a FramedBlockView. */
export function renderFramedBlock<T>(view: FramedBlockView, adapter: ViewAdapter<T>): T {
	const header = view.header !== undefined ? renderStatusRow(view.header, adapter) : undefined;
	const sections = view.sections.map((section, index) => renderSection(section, index, adapter));
	return adapter.framedBlock({
		header,
		sections,
		state: view.state,
		contents: view.contents ?? "report",
		gutter: view.gutter === true,
		live: isLive(view.state),
	});
}

/** Renders a HeadedBlockView. */
export function renderHeadedBlock<T>(view: HeadedBlockView, adapter: ViewAdapter<T>): T {
	const header = view.header !== undefined ? renderStatusRow(view.header, adapter) : undefined;
	const rows = view.lines.map(line => renderLine(line, adapter));
	const window = applyTail(rows, view.tail);
	const body = adapter.headedBody({
		rows: window.rows,
		dropped: window.dropped,
	});
	let hidden: T | undefined;
	if (view.hidden !== undefined && view.hidden.count > 0) {
		hidden = adapter.hiddenNote({
			count: view.hidden.count,
			noun: nounFor(view.hidden),
			revealable: view.hidden.revealable === true,
		});
	}
	return adapter.headedBlock({
		header,
		body,
		hidden,
	});
}

/**
 * Strips tone from notice line spans so the notice state colours the whole region.
 */
function toTonelessLine(line: ViewLine): ViewLine {
	return line.map(span => (span.tone === undefined ? span : { ...span, tone: undefined }));
}

/** Renders a NoticeView. */
export function renderNotice<T>(view: NoticeView, adapter: ViewAdapter<T>): T {
	const role: "alert" | "status" = view.state === "error" ? "alert" : "status";
	// A mark the host has no glyph for is dropped, never drawn as its key.
	const markElement = view.mark === undefined ? undefined : adapter.resolveSymbol?.(view.mark);
	const headline = renderLine(toTonelessLine(view.headline), adapter);
	const body =
		view.body !== undefined && view.body.length > 0
			? view.body.map(line => renderLine(toTonelessLine(line), adapter))
			: undefined;

	return adapter.notice({
		state: view.state,
		role,
		mark: view.mark,
		markElement,
		headline,
		tag: view.tag,
		body,
	});
}

/** Renders any Canonical ToolView. */
export function renderToolView<T>(view: ToolView, adapter: ViewAdapter<T>, inline?: boolean): T {
	switch (view.kind) {
		case "statusRow":
			return renderStatusRow(view, adapter, inline);
		case "textBlock":
			return renderTextBlock(view, adapter);
		case "headedBlock":
			return renderHeadedBlock(view, adapter);
		case "framedBlock":
			return renderFramedBlock(view, adapter);
		case "notice":
			return renderNotice(view, adapter);
	}
}
