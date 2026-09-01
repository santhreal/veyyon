/**
 * What an LSP card shows, for any host.
 *
 * The tool half in `index.ts` decides what a language server answered; this half states what a
 * reader is told, and names no colour, glyph, tree or width. A terminal draws it through
 * `src/tui/draw-tool-view.ts` and a second host writes its own mapping from the same value.
 *
 * A card is one framed panel: a row naming the operation and what it found, the request under it,
 * then the answer as the shape that answer has -- source for a hover, one row per diagnostic, one
 * row per reference, one row per symbol, and the server's own lines for everything else. Which
 * shape it is comes from the action the tool reports rather than from a pattern in the text: the
 * text a server returns is prose the tool composed, and reading a card's structure out of it means
 * re-deciding on every render what the tool already knew.
 *
 * The panel's body is what the server sent rather than a report the tool wrote, so it is stated as
 * `data`: the outcome shows on the card's edge and the body keeps its own ground.
 */

import type {
	FramedBlockView,
	HeadedBlockView,
	StatusRowView,
	ToolView,
	ToolViewContext,
	ToolViewRenderer,
	ViewHiddenCount,
	ViewLine,
	ViewSection,
	ViewStatus,
	ViewTone,
} from "@veyyon/view";
import {
	replaceTabs,
	sanitizeDiagnosticDisplayText,
	shortenPath,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "../tools/core/render-utils";
import { getLanguageFromPath } from "../utils/lang-from-path";
import type { LspParams, LspToolDetails } from "./types";

/** What every card of this tool is titled. */
const LSP_TITLE = "LSP";

/** The group the server's answer sits in, whatever shape that answer has. */
const RESPONSE_LABEL = "Response";

/** Items a collapsed card shows before it says how many it kept back. */
const COLLAPSED_ITEMS = 3;

/** Lines of the server's own output a card shows, at each disclosure state. */
const OUTPUT_LINES = { collapsed: 4, expanded: 200 } as const;

/** Lines of source and of prose a hover card shows, at each disclosure state. */
const CODE_LINES = { collapsed: 1, expanded: 200 } as const;
const DOC_LINES = { collapsed: 1, expanded: 40 } as const;

/** Items a card shows at each disclosure state, for the answers that are a list of things. */
const ITEM_LINES = { collapsed: COLLAPSED_ITEMS, expanded: 200 } as const;

/** The units a held-back count is in, which the host words. */
const LINE_NOUN = { one: "line", many: "lines" } as const;
const DIAGNOSTIC_NOUN = { one: "diagnostic", many: "diagnostics" } as const;
const REFERENCE_NOUN = { one: "reference", many: "references" } as const;
const SYMBOL_NOUN = { one: "symbol", many: "symbols" } as const;

/** The columns a symbol's nesting spends per level, which is what its own indent already stated. */
const NEST_INDENT = "  ";

/** The result a card reads, which is the tool's own result narrowed to what a card shows. */
export interface LspViewResult {
	content?: Array<{ type: string; text?: string }>;
	details?: LspToolDetails;
	isError?: boolean;
}

/** The fenced block a hover answer carries its signature in. */
const CODE_FENCE = /```(\w*)\n([\s\S]*?)```/;
const ERROR_COUNT = /(\d+)\s+error\(s\)/;
const WARNING_COUNT = /(\d+)\s+warning\(s\)/;
const REFERENCE_COUNT = /(\d+)\s+reference\(s\)/;
const SYMBOLS_IN = /Symbols in (.+):/;
const DIAGNOSTIC_ROW = /^(.*):(\d+):(\d+)\s+\[(\w+)\]\s*(.*)$/;
const LOCATION_ROW = /^(.+):(\d+):(\d+)$/;
const SYMBOL_ROW = /^(\s*)(\S+)\s+(.+?)\s*@\s*line\s*(\d+)/;
const POSITION_IN_ROW = /:\d+:\d+/;

/** The shapes an answer comes in, which decides how the card's body is laid out. */
type CardShape = "hover" | "diagnostics" | "references" | "symbols" | "output";

/** One diagnostic the server reported, as much of it as the tool's own line stated. */
interface Diagnostic {
	file: string;
	line: number;
	col: number;
	severity: string;
	message: string;
}

/** The tone a severity carries, which is what that severity means. */
function severityTone(severity: string): ViewTone {
	switch (severity) {
		case "error":
			return "error";
		case "warning":
			return "warning";
		case "info":
			return "info";
		default:
			return "dim";
	}
}

/** One line of text with no leading or trailing control characters a host would draw as a hole. */
function row(text: string, tone?: ViewTone): ViewLine {
	return tone === undefined ? [{ text: replaceTabs(text) }] : [{ text: replaceTabs(text), tone }];
}

/** What a card kept back, or nothing when it kept back none of it. */
function heldBack(count: number, noun: { one: string; many: string }, expanded: boolean): ViewHiddenCount | undefined {
	if (count <= 0) return undefined;
	return { count, noun, revealable: !expanded };
}

/** The window of a list a card shows, and how much of it stayed behind. */
function window<T>(
	items: readonly T[],
	expanded: boolean,
	bounds: { collapsed: number; expanded: number },
): { kept: readonly T[]; held: number } {
	const max = expanded ? bounds.expanded : bounds.collapsed;
	if (items.length <= max) return { kept: items, held: 0 };
	return { kept: items.slice(0, max), held: items.length - max };
}

/** The text parts of a result, which is everything a card shows of what the tool returned. */
function textOf(content: Array<{ type: string; text?: string }> | undefined): string {
	if (!content) return "";
	return content
		.filter(part => part.type === "text")
		.map(part => part.text ?? "")
		.join("\n");
}

/**
 * Which shape an answer is, from what the tool reported it did.
 *
 * A fenced block wins over the action, because a hover whose answer is a signature is source
 * whatever the request was named, and an action that returned no block has nothing to draw as one.
 * The text patterns are the fallback for a result that carries no details at all, which is what a
 * rebuilt transcript of an older session holds.
 */
function cardShape(action: string | undefined, text: string): CardShape {
	if (CODE_FENCE.test(text)) return "hover";
	if (action === "diagnostics" || ERROR_COUNT.test(text) || WARNING_COUNT.test(text)) return "diagnostics";
	if (action === "references" || REFERENCE_COUNT.test(text)) return "references";
	if (action === "symbols" || SYMBOLS_IN.test(text)) return "symbols";
	return "output";
}

/** The diagnostics a text states, as much of each as its own line carried. */
function parseDiagnostics(lines: readonly string[]): { parsed: Diagnostic[]; raw: string[] } {
	const candidates = lines.filter(line => POSITION_IN_ROW.test(line));
	const parsed: Diagnostic[] = [];
	for (const line of candidates) {
		const match = DIAGNOSTIC_ROW.exec(line.trim());
		if (match === null) continue;
		parsed.push({
			file: sanitizeDiagnosticDisplayText(match[1]),
			line: Number.parseInt(match[2], 10),
			col: Number.parseInt(match[3], 10),
			severity: match[4].toLowerCase(),
			message: sanitizeDiagnosticDisplayText(match[5]),
		});
	}
	// A row this parse could not read is stated as text, which is where its tabs are widened.
	return { parsed, raw: candidates.map(line => line.trim()) };
}

/** One diagnostic as its row: where it is, how bad it is, and what it says. */
function diagnosticRow(diagnostic: Diagnostic): ViewLine {
	const language = getLanguageFromPath(diagnostic.file);
	const spans: ViewLine = [
		{
			text: `${diagnostic.file}:${diagnostic.line}:${diagnostic.col}`,
			tone: severityTone(diagnostic.severity),
			file: diagnostic.file,
			fileLine: diagnostic.line,
			language,
		},
		{ text: " " },
		{ text: `[${diagnostic.severity}]`, tone: "dim" },
	];
	if (!diagnostic.message) return spans;
	return [
		...spans,
		{ text: " " },
		// The message arrived widened from the parse, which is the one place a diagnostic's own text
		// is sanitised, so the row states it and cuts it.
		{ text: truncateToWidth(diagnostic.message, TRUNCATE_LENGTHS.LINE), tone: "muted" },
	];
}

/** The diagnostics group, or the server's own lines when it reported none in a shape a card can read. */
function diagnosticSections(text: string, lines: readonly string[], expanded: boolean): ViewSection[] {
	const { parsed, raw } = parseDiagnostics(lines);
	if (parsed.length > 0) {
		const { kept, held } = window(parsed, expanded, ITEM_LINES);
		return [
			{
				label: RESPONSE_LABEL,
				lines: kept.map(diagnosticRow),
				list: true,
				...withHidden(heldBack(held, DIAGNOSTIC_NOUN, expanded)),
			},
		];
	}
	if (raw.length > 0) {
		const { kept, held } = window(raw, expanded, ITEM_LINES);
		return [
			{
				label: RESPONSE_LABEL,
				lines: kept.map(line => row(line, "muted")),
				list: true,
				...withHidden(heldBack(held, DIAGNOSTIC_NOUN, expanded)),
			},
		];
	}
	return outputSections(text, expanded);
}

/** The references group: one row per place the symbol is used, in the order the server listed them. */
function referenceSections(lines: readonly string[], expanded: boolean): ViewSection[] {
	const locations: ViewLine[] = [];
	for (const line of lines) {
		const match = LOCATION_ROW.exec(line.trim());
		if (match === null) continue;
		const file = match[1];
		const at = Number.parseInt(match[2], 10);
		locations.push([
			{
				text: `${file}:${at}:${match[3]}`,
				tone: "accent",
				file,
				fileLine: at,
				language: getLanguageFromPath(file),
			},
		]);
	}
	if (locations.length === 0) return [];
	const { kept, held } = window(locations, expanded, ITEM_LINES);
	return [
		{
			label: RESPONSE_LABEL,
			lines: kept,
			list: true,
			...withHidden(heldBack(held, REFERENCE_NOUN, expanded)),
		},
	];
}

/** The symbols group: one row per symbol, each at the depth the server nested it. */
function symbolSections(lines: readonly string[], expanded: boolean): ViewSection[] {
	const symbols: ViewLine[] = [];
	for (const line of lines) {
		const match = SYMBOL_ROW.exec(line);
		if (match === null) continue;
		// The tool indents a child by two columns per level, which is the only place the nesting is
		// stated; a flat list of names would lose which symbol a method belongs to.
		const depth = Math.floor(match[1].length / NEST_INDENT.length);
		symbols.push([
			...(depth > 0 ? [{ text: NEST_INDENT.repeat(depth) }] : []),
			{ text: match[2], tone: "accent" as ViewTone },
			{ text: " " },
			{ text: replaceTabs(match[3]), tone: "accent" as ViewTone },
			{ text: " " },
			{ text: `line ${match[4]}`, tone: "dim" as ViewTone, trailing: true },
		]);
	}
	if (symbols.length === 0) return [];
	const { kept, held } = window(symbols, expanded, ITEM_LINES);
	return [
		{
			label: RESPONSE_LABEL,
			lines: kept,
			list: true,
			...withHidden(heldBack(held, SYMBOL_NOUN, expanded)),
		},
	];
}

/**
 * The hover groups: what the server said about the symbol, the signature it gave, and the rest of
 * the documentation.
 *
 * The signature is source, so the section states the text and the language and the host colours it;
 * the prose either side is the server's own documentation and stays prose.
 */
function hoverSections(text: string, expanded: boolean): ViewSection[] {
	const fence = CODE_FENCE.exec(text);
	if (fence === null) return outputSections(text, expanded);
	const language = fence[1];
	const code = fence[2].trim().split("\n");
	const before = text.slice(0, fence.index).trimEnd();
	const after = text.slice(fence.index + fence[0].length).trim();
	const sections: ViewSection[] = [];
	if (before) sections.push(docSection(before, expanded, RESPONSE_LABEL));
	const source = window(code, expanded, CODE_LINES);
	sections.push({
		...(sections.length === 0 ? { label: RESPONSE_LABEL } : {}),
		lines: source.kept.map(line => [{ text: line }]),
		code: language === "" ? {} : { language },
		...withHidden(heldBack(source.held, LINE_NOUN, expanded)),
	});
	if (after) sections.push(docSection(after, expanded));
	return sections;
}

/** One run of the server's documentation, as the lines a card has room for. */
function docSection(source: string, expanded: boolean, label?: string): ViewSection {
	const { kept, held } = window(source.split("\n"), expanded, DOC_LINES);
	return {
		...(label === undefined ? {} : { label }),
		lines: kept.map(line => row(line, "muted")),
		...withHidden(heldBack(held, LINE_NOUN, expanded)),
	};
}

/** The server's own output, for an answer with no shape of its own. */
function outputSections(text: string, expanded: boolean): ViewSection[] {
	const lines = text.split("\n");
	const { kept, held } = window(lines, expanded, OUTPUT_LINES);
	return [
		{
			label: RESPONSE_LABEL,
			lines: kept.map(line => row(line, "output")),
			...withHidden(heldBack(held, LINE_NOUN, expanded)),
		},
	];
}

/** A hidden count as the member a section carries it in, or nothing at all. */
function withHidden(hidden: ViewHiddenCount | undefined): { hidden?: ViewHiddenCount } {
	return hidden === undefined ? {} : { hidden };
}

/** What the call asked about, in the words the row is described by. */
function describeCall(args: LspParams | undefined): { description: string; meta: readonly ViewLine[] } {
	const action = (args?.action ?? "request").replace(/_/g, " ");
	const query = args?.query ? truncateToWidth(args.query, TRUNCATE_LENGTHS.SHORT) : undefined;
	const symbol = args?.symbol
		? truncateToWidth(replaceTabs(args.symbol).replaceAll(/\r?\n/g, " "), TRUNCATE_LENGTHS.SHORT)
		: undefined;

	let target: string | undefined;
	if (args?.file) target = shortenPath(args.file);
	if (args?.line !== undefined) {
		target = target === undefined ? `line ${args.line}` : `${target}:${args.line}`;
		if (symbol) target += ` (${symbol})`;
	}

	const meta: ViewLine[] = [];
	if (query && target) meta.push([{ text: `query:${query}` }]);
	if (args?.new_name) meta.push([{ text: `new:${args.new_name}` }]);
	if (args?.apply !== undefined) meta.push([{ text: `apply:${args.apply ? "true" : "false"}` }]);

	const parts = [action];
	if (target) parts.push(target);
	else if (query) parts.push(query);
	return { description: parts.join(" "), meta };
}

/** What the request itself was, as its own group under the row that reports it. */
function requestSection(request: LspParams | undefined): ViewSection | undefined {
	if (request === undefined) return undefined;
	const lines: ViewLine[] = [];
	if (request.file) lines.push(row(request.file, "output"));
	if (request.line !== undefined) lines.push(row(`line ${request.line}`, "dim"));
	if (request.symbol) lines.push(row(`symbol: ${replaceTabs(request.symbol).replaceAll(/\r?\n/g, " ")}`, "dim"));
	if (request.query) lines.push(row(`query: ${request.query}`, "dim"));
	if (request.new_name) lines.push(row(`new name: ${request.new_name}`, "dim"));
	if (request.apply !== undefined) lines.push(row(`apply: ${request.apply ? "true" : "false"}`, "dim"));
	if (lines.length === 0) return undefined;
	return { lines };
}

/** What the card reports, which for diagnostics is the worst thing the server found. */
function cardState(shape: CardShape, text: string, isError: boolean): ViewStatus {
	if (isError) return "error";
	if (shape !== "diagnostics") return "success";
	const errors = ERROR_COUNT.exec(text);
	const warnings = WARNING_COUNT.exec(text);
	if (errors !== null && Number.parseInt(errors[1], 10) > 0) return "error";
	if (warnings !== null && Number.parseInt(warnings[1], 10) > 0) return "warning";
	return "success";
}

/** What the card found, stated beside the operation rather than repeated inside the body. */
function resultMeta(shape: CardShape, text: string): ViewLine[] {
	if (shape === "diagnostics") {
		const errors = ERROR_COUNT.exec(text);
		const warnings = WARNING_COUNT.exec(text);
		const errorCount = errors === null ? 0 : Number.parseInt(errors[1], 10);
		const warningCount = warnings === null ? 0 : Number.parseInt(warnings[1], 10);
		const meta: ViewLine[] = [];
		if (errorCount > 0) meta.push([{ text: `${errorCount} error${errorCount === 1 ? "" : "s"}`, tone: "error" }]);
		if (warningCount > 0) {
			meta.push([{ text: `${warningCount} warning${warningCount === 1 ? "" : "s"}`, tone: "warning" }]);
		}
		if (meta.length === 0) meta.push([{ text: "no issues", tone: "success" }]);
		return meta;
	}
	if (shape === "references") {
		const found = REFERENCE_COUNT.exec(text);
		return found === null ? [] : [[{ text: `${found[1]} found`, tone: "dim" }]];
	}
	if (shape === "symbols") {
		const where = SYMBOLS_IN.exec(text);
		return where === null ? [] : [[{ text: `in ${where[1]}`, tone: "dim" }]];
	}
	if (shape === "hover") {
		const fence = CODE_FENCE.exec(text);
		return fence === null || fence[1] === "" ? [] : [[{ text: fence[1], tone: "dim" }]];
	}
	return [];
}

/**
 * The row that heads a settled card: the operation it ran, and what it found.
 *
 * A card that succeeded is titled by what the tool IS rather than by the outcome, which is what the
 * emblem states; a card still arriving and a card that failed report that instead.
 */
function resultHeader(
	action: string,
	shape: CardShape,
	text: string,
	options: { partial: boolean; isError: boolean },
): StatusRowView {
	const meta = resultMeta(shape, text);
	return {
		kind: "statusRow",
		status: options.partial ? "running" : options.isError ? "error" : "success",
		...(options.partial || options.isError ? {} : { emblem: "tool.lsp" }),
		title: LSP_TITLE,
		description: action.replace(/_/g, " "),
		...(meta.length === 0 ? {} : { meta }),
	};
}

/** The card a result with no text at all falls back to, which is every card this tool can fail to fill. */
function emptyCard(): HeadedBlockView {
	return {
		kind: "headedBlock",
		header: { kind: "statusRow", status: "warning", title: LSP_TITLE },
		lines: [[{ text: "No result", tone: "dim" }]],
	};
}

export const lspToolView: Required<ToolViewRenderer<LspParams, LspViewResult>> = {
	renderCall(args: LspParams): ToolView {
		const { description, meta } = describeCall(args);
		return {
			kind: "statusRow",
			status: "pending",
			title: LSP_TITLE,
			description,
			...(meta.length === 0 ? {} : { meta }),
		};
	},

	renderResult(result: LspViewResult, context: ToolViewContext, args?: LspParams): ToolView {
		const text = textOf(result.content);
		if (!text) return emptyCard();

		const request = args ?? result.details?.request;
		const shape = cardShape(result.details?.action ?? request?.action, text);
		const lines = text.split("\n");
		const expanded = context.expanded;

		const body =
			shape === "hover"
				? hoverSections(text, expanded)
				: shape === "diagnostics"
					? diagnosticSections(text, lines, expanded)
					: shape === "references"
						? referenceSections(lines, expanded)
						: shape === "symbols"
							? symbolSections(lines, expanded)
							: outputSections(text, expanded);
		// A shape whose rows the text held none of still shows what the server sent, rather than an
		// empty group under a row that says it found something.
		const sections = body.length > 0 ? body : outputSections(text, expanded);

		const requested = requestSection(request);
		const card: FramedBlockView = {
			kind: "framedBlock",
			header: resultHeader(request?.action ?? result.details?.action ?? shape, shape, text, {
				partial: context.partial === true,
				isError: result.isError === true,
			}),
			state: cardState(shape, text, result.isError === true),
			sections: requested === undefined ? sections : [requested, ...sections],
			contents: "data",
		};
		return card;
	},
};
