import { formatMoreLines, isRecord } from "@veyyon/utils";
import { INTENT_FIELD } from "@veyyon/wire";
import type { Theme } from "../modes/theme/theme";
import { buildTreePrefix } from "../tui/utils";
import { truncateToWidth } from "./render-utils";

export const JSON_TREE_MAX_DEPTH_COLLAPSED = 2;
export const JSON_TREE_MAX_DEPTH_EXPANDED = 6;
export const JSON_TREE_MAX_LINES_COLLAPSED = 6;
export const JSON_TREE_MAX_LINES_EXPANDED = 200;
export const JSON_TREE_SCALAR_LEN_COLLAPSED = 60;
export const JSON_TREE_SCALAR_LEN_EXPANDED = 2000;

const HIDDEN_ARG_KEYS = { [INTENT_FIELD]: 1, __partialJson: 1 };

const ARGS_INLINE_PAIR_SEP = ", ";
const ARGS_INLINE_PAIR_SEP_WIDTH = Bun.stringWidth(ARGS_INLINE_PAIR_SEP);
const ARGS_INLINE_MORE = "…";
const ARGS_INLINE_MORE_WIDTH = Bun.stringWidth(ARGS_INLINE_MORE);
const ARGS_INLINE_TAIL_VALUE_RESERVE = 4;

export function formatScalar(value: unknown, maxLen: number): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (typeof value === "boolean") return String(value);
	if (typeof value === "number") return String(value);
	if (typeof value === "string") {
		const escaped = value.replace(/\n/g, "\\n").replace(/\t/g, "\\t");
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

export function formatArgsInline(args: Record<string, unknown>, maxWidth: number): string {
	const keys: string[] = [];
	for (const key in args) {
		if (key in HIDDEN_ARG_KEYS) continue;
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
		let tailReserve = 0;
		for (let j = i + 1; j < keys.length; j++) {
			tailReserve += ARGS_INLINE_PAIR_SEP_WIDTH + Bun.stringWidth(keys[j]) + 1 + ARGS_INLINE_TAIL_VALUE_RESERVE;
		}
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

export function renderJsonTreeLines(
	value: unknown,
	theme: Theme,
	maxDepth: number,
	maxLines: number,
	maxScalarLen: number,
): { lines: string[]; truncated: boolean } {
	const lines: string[] = [];
	let truncated = false;

	const iconObject = theme.styledSymbol("icon.folder", "muted");
	const iconArray = theme.styledSymbol("icon.package", "muted");
	const iconScalar = theme.styledSymbol("icon.file", "muted");

	const pushLine = (line: string): boolean => {
		if (lines.length >= maxLines) {
			truncated = true;
			return false;
		}
		lines.push(line);
		return true;
	};

	const renderNode = (val: unknown, key: string | undefined, ancestors: boolean[], isLast: boolean, depth: number) => {
		if (lines.length >= maxLines) {
			truncated = true;
			return;
		}

		const connector = isLast ? theme.tree.last : theme.tree.branch;
		const prefix = `${buildTreePrefix(ancestors, theme)}${theme.fg("dim", connector)} `;

		ancestors.push(!isLast);
		try {
			if (val === null || val === undefined || typeof val !== "object") {
				const label = key ? theme.fg("muted", key) : theme.fg("muted", "value");

				if (typeof val === "string" && val.includes("\n")) {
					const strLines = val.split("\n");
					const maxStrLines = Math.min(strLines.length, Math.max(1, maxLines - lines.length - 1));
					const continuePrefix = buildTreePrefix(ancestors, theme);

					const firstLine = truncateToWidth(strLines[0], maxScalarLen);
					pushLine(`${prefix}${iconScalar} ${label}: ${theme.fg("dim", `"${firstLine}`)}`);

					for (let i = 1; i < maxStrLines; i++) {
						if (lines.length >= maxLines) {
							truncated = true;
							break;
						}
						const line = truncateToWidth(strLines[i], maxScalarLen);
						pushLine(`${continuePrefix}   ${theme.fg("dim", ` ${line}`)}`);
					}

					if (strLines.length > maxStrLines) {
						truncated = true;
						pushLine(
							`${continuePrefix}   ${theme.fg("dim", ` …(${formatMoreLines(strLines.length - maxStrLines)})"`)}`,
						);
					} else {
						const lastIdx = lines.length - 1;
						lines[lastIdx] = `${lines[lastIdx]}${theme.fg("dim", '"')}`;
					}
					return;
				}

				const scalar = formatScalar(val, maxScalarLen);
				pushLine(`${prefix}${iconScalar} ${label}: ${theme.fg("dim", scalar)}`);
				return;
			}

			if (Array.isArray(val)) {
				const header = key ? theme.fg("muted", key) : theme.fg("muted", "array");
				pushLine(`${prefix}${iconArray} ${header}`);
				if (val.length === 0) {
					pushLine(
						`${buildTreePrefix(ancestors, theme)}${theme.fg("dim", theme.tree.last)} ${theme.fg("dim", "[]")}`,
					);
					return;
				}
				if (depth >= maxDepth) {
					pushLine(
						`${buildTreePrefix(ancestors, theme)}${theme.fg("dim", theme.tree.last)} ${theme.fg("dim", "…")}`,
					);
					return;
				}
				for (let i = 0; i < val.length; i++) {
					renderNode(val[i], `[${i}]`, ancestors, i === val.length - 1, depth + 1);
					if (lines.length >= maxLines) {
						truncated = true;
						return;
					}
				}
				return;
			}

			if (!isRecord(val)) return;

			const header = key ? theme.fg("muted", key) : theme.fg("muted", "object");
			pushLine(`${prefix}${iconObject} ${header}`);
			if (depth >= maxDepth) {
				pushLine(`${buildTreePrefix(ancestors, theme)}${theme.fg("dim", theme.tree.last)} ${theme.fg("dim", "…")}`);
				return;
			}
			const keys = Object.keys(val);
			if (keys.length === 0) {
				pushLine(
					`${buildTreePrefix(ancestors, theme)}${theme.fg("dim", theme.tree.last)} ${theme.fg("dim", "{}")}`,
				);
				return;
			}
			for (let i = 0; i < keys.length; i++) {
				const childKey = keys[i];
				const child = val[childKey];
				renderNode(child, childKey, ancestors, i === keys.length - 1, depth + 1);
				if (lines.length >= maxLines) {
					truncated = true;
					return;
				}
			}
		} finally {
			ancestors.pop();
		}
	};

	if (isRecord(value)) {
		for (const key in value) {
			if (key in HIDDEN_ARG_KEYS) continue;
			renderNode(value[key], key, [], true, 1);
			if (lines.length >= maxLines) {
				truncated = true;
				break;
			}
		}
	} else if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			renderNode(value[i], `[${i}]`, [], i === value.length - 1, 1);
			if (lines.length >= maxLines) {
				truncated = true;
				break;
			}
		}
	} else {
		renderNode(value, undefined, [], true, 0);
	}

	return { lines, truncated };
}
