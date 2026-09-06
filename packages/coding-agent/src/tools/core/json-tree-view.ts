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
export function formatArgsInline(args: Record<string, unknown>, maxWidth: number): string {
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
		const valueStr = formatScalar(value, valueMaxLen);
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

/** The mark a node's kind carries, which the host draws however it draws a kind. */
function kindSymbol(value: unknown): string {
	if (Array.isArray(value)) return "icon.package";
	if (value !== null && typeof value === "object") return "icon.folder";
	return "icon.file";
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

	// Depth is the level a node sits at, counted from 1 for a root child, which is what `maxDepth`
	// bounds. The columns are one level behind it, so a root child opens flush and its children step
	// in by two.
	const indent = (depth: number): ViewSpan[] => (depth <= 1 ? [] : [{ text: LEVEL_INDENT.repeat(depth - 1) }]);

	const renderNode = (node: unknown, key: string | undefined, depth: number): void => {
		if (lines.length >= bounds.maxLines) {
			truncated = true;
			return;
		}
		const label: ViewSpan = {
			text: key ?? (Array.isArray(node) ? "array" : isRecord(node) ? "object" : "value"),
			tone: "muted",
		};
		const head: ViewSpan[] = [
			...indent(depth),
			{ text: "", symbol: kindSymbol(node), tone: "muted" },
			{ text: " " },
			label,
		];

		if (node === null || node === undefined || typeof node !== "object") {
			// A multi-line string is the one scalar that is several rows: the first row carries the key
			// and the opening quote, and the rest hang under it so the text reads as one value.
			if (typeof node === "string" && node.includes("\n")) {
				const parts = node.split("\n");
				const room = Math.max(1, bounds.maxLines - lines.length - 1);
				const shown = Math.min(parts.length, room);
				push([
					...head,
					{ text: ": " },
					{ text: `"${truncateToWidth(parts[0] ?? "", bounds.maxScalarLen, Ellipsis.Unicode)}`, tone: "dim" },
				]);
				for (let index = 1; index < shown; index++) {
					if (
						!push([
							...indent(depth + 1),
							{ text: truncateToWidth(parts[index] ?? "", bounds.maxScalarLen, Ellipsis.Unicode), tone: "dim" },
						])
					) {
						return;
					}
				}
				if (parts.length > shown) {
					truncated = true;
					push([...indent(depth + 1), { text: `…(${formatMoreLines(parts.length - shown)})"`, tone: "dim" }]);
					return;
				}
				const last = lines[lines.length - 1];
				if (last !== undefined) lines[lines.length - 1] = [...last, { text: '"', tone: "dim" }];
				return;
			}
			push([...head, { text: ": " }, { text: formatScalar(node, bounds.maxScalarLen), tone: "dim" }]);
			return;
		}

		if (!push(head)) return;

		const closing = (text: string): void => {
			push([...indent(depth + 1), { text, tone: "dim" }]);
		};

		if (Array.isArray(node)) {
			if (node.length === 0) return closing("[]");
			if (depth >= bounds.maxDepth) return closing("…");
			for (let index = 0; index < node.length; index++) {
				renderNode(node[index], `[${index}]`, depth + 1);
				if (lines.length >= bounds.maxLines) {
					truncated = true;
					return;
				}
			}
			return;
		}

		if (!isRecord(node)) return;
		const keys = Object.keys(node);
		if (keys.length === 0) return closing("{}");
		if (depth >= bounds.maxDepth) return closing("…");
		for (const childKey of keys) {
			renderNode(node[childKey], childKey, depth + 1);
			if (lines.length >= bounds.maxLines) {
				truncated = true;
				return;
			}
		}
	};

	if (isRecord(value)) {
		for (const key of Object.keys(value)) {
			if (Object.hasOwn(HIDDEN_JSON_TREE_KEYS, key)) continue;
			renderNode(value[key], key, 1);
			if (lines.length >= bounds.maxLines) {
				truncated = true;
				break;
			}
		}
	} else if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) {
			renderNode(value[index], `[${index}]`, 1);
			if (lines.length >= bounds.maxLines) {
				truncated = true;
				break;
			}
		}
	} else {
		// A bare value sits where a root child sits: flush, with its continuation rows hanging under it.
		renderNode(value, undefined, 1);
	}

	return { lines, truncated };
}
