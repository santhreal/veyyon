/**
 * A JSON value as the lines a card shows for it, for any host.
 *
 * The view-model twin of `json-tree-render.ts`, which draws the same walk as terminal strings with a
 * branch glyph on every row. A structure is stated here as depth: each line opens with two columns
 * per level and a kind mark, so a host that draws a tree, a host that indents and a host that mounts
 * a disclosure widget all have what they need, and none of them is handed a `├─`.
 *
 * The bounds are the caller's, because they are the reader's: a collapsed card allows two levels and
 * six lines where an expanded one allows six and two hundred, and the constants for both live beside
 * the terminal walk this replaces.
 */

import { isRecord } from "@veyyon/utils";
import { INTENT_FIELD } from "@veyyon/wire";
import type { ViewLine, ViewSpan } from "@veyyon/view";
import { Ellipsis, truncateToWidth } from "./render-utils";
import { formatScalar } from "./json-tree-render";

/** The two columns one level of nesting costs. */
const LEVEL_INDENT = "  ";

/** The keys a tool's own plumbing writes into an argument object, which a reader never asked for. */
const HIDDEN_KEYS: Readonly<Record<string, number>> = { [INTENT_FIELD]: 1, __partialJson: 1 };

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
 * A JSON value as view lines, and whether the bounds cut it short.
 *
 * `truncated` is the caller's to state: the walk stops at the bound and says so, and a card decides
 * whether that closes with an ellipsis row of its own or a held-back count.
 */
export function jsonTreeViewLines(
	value: unknown,
	bounds: JsonTreeBounds,
): { lines: ViewLine[]; truncated: boolean } {
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

	const indent = (depth: number): ViewSpan[] => (depth <= 0 ? [] : [{ text: LEVEL_INDENT.repeat(depth) }]);

	const renderNode = (node: unknown, key: string | undefined, depth: number): void => {
		if (lines.length >= bounds.maxLines) {
			truncated = true;
			return;
		}
		const label: ViewSpan = { text: key ?? (Array.isArray(node) ? "array" : isRecord(node) ? "object" : "value"), tone: "muted" };
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
					push([...indent(depth + 1), { text: `…(${parts.length - shown} more lines)"`, tone: "dim" }]);
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
			if (depth + 1 > bounds.maxDepth) {
				truncated = true;
				return closing("…");
			}
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
		if (depth + 1 > bounds.maxDepth) {
			truncated = true;
			return closing("…");
		}
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
			if (Object.hasOwn(HIDDEN_KEYS, key)) continue;
			renderNode(value[key], key, 0);
			if (lines.length >= bounds.maxLines) {
				truncated = true;
				break;
			}
		}
	} else if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) {
			renderNode(value[index], `[${index}]`, 0);
			if (lines.length >= bounds.maxLines) {
				truncated = true;
				break;
			}
		}
	} else {
		renderNode(value, undefined, 0);
	}

	return { lines, truncated };
}
