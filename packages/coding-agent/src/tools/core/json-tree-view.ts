/**
 * A JSON value as the lines a card shows for it, for any host.
 *
 * The view-model twin of `json-tree-render.ts`, which draws the same walk as terminal strings with a
 * branch glyph on every row. A structure is stated here as depth: each line opens with two columns
 * per level and a kind mark, so a host that draws a tree, a host that indents and a host that mounts
 * a disclosure widget all have what they need, and none of them is handed a `├─`.
 *
 * The bounds, the scalar cut and the one-line argument preview live here rather than beside the
 * terminal walker: a ToolView card has no theme and no tree-rail glyph, and loading `json-tree-render`
 * to read a number would put both on its boot path.
 */

import { Ellipsis } from "@veyyon/natives";
import { formatMoreLines, isRecord } from "@veyyon/utils";
import { truncateToWidth } from "@veyyon/utils/width";
import type { ViewLine, ViewSpan } from "@veyyon/view";
import { INTENT_FIELD } from "@veyyon/wire";
import { shortenEmbeddedPaths } from "./render-utils";
/** Max depth for JSON tree rendering. */
export const JSON_TREE_MAX_DEPTH_COLLAPSED = 2;
export const JSON_TREE_MAX_DEPTH_EXPANDED = 6;
export const JSON_TREE_MAX_LINES_COLLAPSED = 6;
export const JSON_TREE_MAX_LINES_EXPANDED = 200;
export const JSON_TREE_SCALAR_LEN_COLLAPSED = 60;
export const JSON_TREE_SCALAR_LEN_EXPANDED = 2000;

/** The two columns one level of nesting costs. */
const LEVEL_INDENT = "  ";

/** The keys a tool's own plumbing writes into an argument object, which a reader never asked for. */
export const HIDDEN_JSON_TREE_KEYS: Readonly<Record<string, number>> = { [INTENT_FIELD]: 1, __partialJson: 1 };

const ARGS_INLINE_PAIR_SEP = ", ";
const ARGS_INLINE_PAIR_SEP_WIDTH = Bun.stringWidth(ARGS_INLINE_PAIR_SEP);
const ARGS_INLINE_MORE = "…";
const ARGS_INLINE_MORE_WIDTH = Bun.stringWidth(ARGS_INLINE_MORE);
/** Minimal value footprint (quotes + a couple chars) reserved for each not-yet-rendered key. */
const ARGS_INLINE_TAIL_VALUE_RESERVE = 4;

/** Format a scalar value for inline display. */
export function formatScalar(value: unknown, maxLen: number): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (typeof value === "boolean") return String(value);
	if (typeof value === "number") return String(value);
	if (typeof value === "string") {
		const shortened = shortenEmbeddedPaths(value);
		const escaped = shortened.replace(/\n/g, "\\n").replace(/\t/g, "\\t");
		const truncated = truncateToWidth(escaped, maxLen);
		return `"${truncated}"`;
	}
	if (Array.isArray(value)) return `[${value.length} items]`;
	if (typeof value === "object") {
		const keys = Object.keys(value);
		return `{${keys.length} keys}`;
	}
	return String(value);
}

/** Format args inline for a collapsed preview. */
export function formatArgsInline(
	args: Record<string, unknown>,
	maxWidth: number,
	formatText?: (text: string) => string,
): string {
	const keys: string[] = [];
	for (const key in args) {
		if (key in HIDDEN_JSON_TREE_KEYS) continue;
		keys.push(key);
	}
	let result = "";
	let width = 0;
	for (let i = 0; i < keys.length; i++) {
		const key = keys[i];
		const value = args[key];
		const sep = width > 0 ? ARGS_INLINE_PAIR_SEP : "";
		const sepW = width > 0 ? ARGS_INLINE_PAIR_SEP_WIDTH : 0;
		const current = width + sepW;
		const cap = maxWidth - current - ARGS_INLINE_MORE_WIDTH;
		if (cap <= 0) {
			return `${result}${ARGS_INLINE_MORE}`;
		}
		// Reserve each still-pending key's minimal footprint (sep + name + `=` +
		// a short value) so a long value can't starve the keys that follow it.
		let tailReserve = 0;
		for (let j = i + 1; j < keys.length; j++) {
			tailReserve += ARGS_INLINE_PAIR_SEP_WIDTH + Bun.stringWidth(keys[j]) + 1 + ARGS_INLINE_TAIL_VALUE_RESERVE;
		}
		// Budget the whole `key=value` piece against the width left after the
		// tail reserve, then back out the value's share. The last key reserves
		// nothing and fills the line.
		const pieceBudget = Math.min(cap, maxWidth - current - tailReserve);
		const valueMaxLen = Math.max(1, pieceBudget - Bun.stringWidth(key) - 3);
		const valueStr = formatScalar(typeof value === "string" && formatText ? formatText(value) : value, valueMaxLen);
		const piece = `${key}=${valueStr}`;
		const pieceW = Bun.stringWidth(piece);
		if (pieceW > pieceBudget) {
			return `${result}${sep}${truncateToWidth(piece, cap)}`;
		}
		result += sep + piece;
		width = current + pieceW;
	}
	return result;
}

/** What the walk is allowed to spend. */
export interface JsonTreeBounds {
	/** Levels of nesting shown before a node closes with an ellipsis. */
	maxDepth: number;
	/** Lines the whole walk may spend, the ellipsis rows among them. */
	maxLines: number;
	/** Columns one scalar may spend before it is cut. */
	maxScalarLen: number;
}

/**
 * Visitor interface for walking a JSON tree structure.
 *
 * `ancestors` is borrowed from the traversal stack and only valid synchronously during the callback.
 */
export interface JsonTreeVisitor {
	readonly lineCount: number;
	markTruncated(): void;
	filterRootKeys?(value: Record<string, unknown>): string[];
	objectDepthPrecedesEmpty?: boolean;
	formatMultilineRow(rawText: string): string;
	onScalar(
		key: string | undefined,
		formattedValue: string,
		depth: number,
		isLast: boolean,
		ancestors: readonly boolean[],
	): boolean;
	onMultilineRow(rowText: string, depth: number, ancestors: readonly boolean[]): boolean;
	onMultilineCloseQuote(): void;
	onContainerOpen(
		kind: "object" | "array",
		key: string | undefined,
		depth: number,
		isLast: boolean,
		ancestors: readonly boolean[],
	): boolean;
	onContainerClose(text: "[]" | "{}" | "…", depth: number, ancestors: readonly boolean[]): boolean;
}

/**
 * Walk a JSON value with depth, line, and scalar bounds, reporting tree events to a visitor.
 */
export function walkJsonTree(value: unknown, bounds: JsonTreeBounds, visitor: JsonTreeVisitor): void {
	const ancestors: boolean[] = [];

	const renderNode = (val: unknown, key: string | undefined, depth: number, isLast: boolean): void => {
		if (visitor.lineCount >= bounds.maxLines) {
			visitor.markTruncated();
			return;
		}

		if (val === null || val === undefined || typeof val !== "object") {
			if (typeof val === "string" && val.includes("\n")) {
				const strLines = val.split("\n");
				const maxStrLines = Math.min(strLines.length, Math.max(1, bounds.maxLines - visitor.lineCount - 1));
				const firstLine = visitor.formatMultilineRow(strLines[0] ?? "");
				if (!visitor.onScalar(key, `"${firstLine}`, depth, isLast, ancestors)) return;

				ancestors.push(!isLast);
				try {
					for (let i = 1; i < maxStrLines; i++) {
						if (visitor.lineCount >= bounds.maxLines) {
							visitor.markTruncated();
							break;
						}
						const line = visitor.formatMultilineRow(strLines[i] ?? "");
						if (!visitor.onMultilineRow(line, depth, ancestors)) break;
					}

					if (strLines.length > maxStrLines) {
						visitor.markTruncated();
						visitor.onMultilineRow(`…(${formatMoreLines(strLines.length - maxStrLines)})"`, depth, ancestors);
					} else {
						visitor.onMultilineCloseQuote();
					}
				} finally {
					ancestors.pop();
				}
				return;
			}

			const scalar = formatScalar(val, bounds.maxScalarLen);
			visitor.onScalar(key, scalar, depth, isLast, ancestors);
			return;
		}

		if (Array.isArray(val)) {
			if (!visitor.onContainerOpen("array", key, depth, isLast, ancestors)) return;
			ancestors.push(!isLast);
			try {
				if (val.length === 0) {
					visitor.onContainerClose("[]", depth, ancestors);
					return;
				}
				if (depth >= bounds.maxDepth) {
					visitor.onContainerClose("…", depth, ancestors);
					return;
				}
				for (let i = 0; i < val.length; i++) {
					renderNode(val[i], `[${i}]`, depth + 1, i === val.length - 1);
					if (visitor.lineCount >= bounds.maxLines) {
						visitor.markTruncated();
						return;
					}
				}
			} finally {
				ancestors.pop();
			}
			return;
		}

		if (!isRecord(val)) return;

		if (!visitor.onContainerOpen("object", key, depth, isLast, ancestors)) return;
		ancestors.push(!isLast);
		try {
			if (visitor.objectDepthPrecedesEmpty && depth >= bounds.maxDepth) {
				visitor.onContainerClose("…", depth, ancestors);
				return;
			}
			const keys = Object.keys(val);
			if (keys.length === 0) {
				visitor.onContainerClose("{}", depth, ancestors);
				return;
			}
			if (depth >= bounds.maxDepth) {
				visitor.onContainerClose("…", depth, ancestors);
				return;
			}
			for (let i = 0; i < keys.length; i++) {
				const childKey = keys[i]!;
				renderNode(val[childKey], childKey, depth + 1, i === keys.length - 1);
				if (visitor.lineCount >= bounds.maxLines) {
					visitor.markTruncated();
					return;
				}
			}
		} finally {
			ancestors.pop();
		}
	};

	if (isRecord(value)) {
		const keys = visitor.filterRootKeys?.(value) ?? Object.keys(value);
		for (const key of keys) {
			if (!visitor.filterRootKeys && Object.hasOwn(HIDDEN_JSON_TREE_KEYS, key)) continue;
			renderNode(value[key], key, 1, true);
			if (visitor.lineCount >= bounds.maxLines) {
				visitor.markTruncated();
				break;
			}
		}
	} else if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			renderNode(value[i], `[${i}]`, 1, i === value.length - 1);
			if (visitor.lineCount >= bounds.maxLines) {
				visitor.markTruncated();
				break;
			}
		}
	} else {
		renderNode(value, undefined, 1, true);
	}
}

/**
 * A JSON value as view lines, and whether rows were dropped without a mark.
 *
 * `truncated` reports the line budget and a held-back run of a multi-line string: rows the walk had
 * to drop with nothing in the lines to say so, which a card turns into an ellipsis row or a count. A
 * depth cut is not one of them, because the walk already closes that node with its own `…` row, and
 * a card that added a second one would state the same cut twice.
 */
export function jsonTreeViewLines(value: unknown, bounds: JsonTreeBounds): { lines: ViewLine[]; truncated: boolean } {
	const lines: ViewLine[] = [];
	let truncated = false;

	const push = (line: ViewLine): boolean => {
		if (lines.length >= bounds.maxLines) {
			truncated = true;
			return false;
		}
		lines.push(line);
		return true;
	};

	const indent = (depth: number): ViewSpan[] => (depth <= 1 ? [] : [{ text: LEVEL_INDENT.repeat(depth - 1) }]);

	const visitor: JsonTreeVisitor = {
		get lineCount() {
			return lines.length;
		},
		markTruncated() {
			truncated = true;
		},
		formatMultilineRow(rawText) {
			return truncateToWidth(rawText, bounds.maxScalarLen, Ellipsis.Unicode);
		},
		onScalar(key, formattedValue, depth) {
			const label: ViewSpan = { text: key ?? "value", tone: "muted" };
			const head: ViewSpan[] = [
				...indent(depth),
				{ text: "", symbol: "icon.file", tone: "muted" },
				{ text: " " },
				label,
			];
			return push([...head, { text: ": " }, { text: formattedValue, tone: "dim" }]);
		},
		onMultilineRow(rowText, depth) {
			return push([...indent(depth + 1), { text: rowText, tone: "dim" }]);
		},
		onMultilineCloseQuote() {
			const last = lines[lines.length - 1];
			if (last !== undefined) lines[lines.length - 1] = [...last, { text: '"', tone: "dim" }];
		},
		onContainerOpen(kind, key, depth) {
			const symbol = kind === "array" ? "icon.package" : "icon.folder";
			const label: ViewSpan = { text: key ?? (kind === "array" ? "array" : "object"), tone: "muted" };
			return push([...indent(depth), { text: "", symbol, tone: "muted" }, { text: " " }, label]);
		},
		onContainerClose(text, depth) {
			return push([...indent(depth + 1), { text, tone: "dim" }]);
		},
	};

	walkJsonTree(value, bounds, visitor);
	return { lines, truncated };
}
