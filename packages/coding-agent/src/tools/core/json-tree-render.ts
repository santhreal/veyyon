/**
 * JSON tree rendering as terminal strings.
 *
 * Bounds, scalar formatting and the one-line argument preview live in `json-tree-view.ts`, which
 * a ToolView card can load without pulling a theme or a tree-rail glyph. This module draws the
 * same walk with those glyphs, for the transcript fallback that still paints a JSON value as
 * terminal bytes rather than as a view.
 */
import { formatMoreLines, isRecord } from "@veyyon/utils";
import { buildTreePrefix } from "../../modes/terminal/draw/utils";
import type { Theme } from "../../theme/theme";
import {
	formatScalar,
	HIDDEN_JSON_TREE_KEYS,
} from "./json-tree-view";
import { truncateToWidth } from "./render-utils";

export {
	formatArgsInline,
	formatScalar,
	JSON_TREE_MAX_DEPTH_COLLAPSED,
	JSON_TREE_MAX_DEPTH_EXPANDED,
	JSON_TREE_MAX_LINES_COLLAPSED,
	JSON_TREE_MAX_LINES_EXPANDED,
	JSON_TREE_SCALAR_LEN_COLLAPSED,
	JSON_TREE_SCALAR_LEN_EXPANDED,
} from "./json-tree-view";

/**
 * Render a JSON value as tree lines.
 */
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
			// Handle scalars
			if (val === null || val === undefined || typeof val !== "object") {
				const label = key ? theme.fg("muted", key) : theme.fg("muted", "value");

				// Special handling for multiline strings
				if (typeof val === "string" && val.includes("\n")) {
					const strLines = val.split("\n");
					const maxStrLines = Math.min(strLines.length, Math.max(1, maxLines - lines.length - 1));
					const continuePrefix = buildTreePrefix(ancestors, theme);

					// First line with label
					const firstLine = truncateToWidth(strLines[0], maxScalarLen);
					pushLine(`${prefix}${iconScalar} ${label}: ${theme.fg("dim", `"${firstLine}`)}`);

					// Subsequent lines indented
					for (let i = 1; i < maxStrLines; i++) {
						if (lines.length >= maxLines) {
							truncated = true;
							break;
						}
						const line = truncateToWidth(strLines[i], maxScalarLen);
						pushLine(`${continuePrefix}   ${theme.fg("dim", ` ${line}`)}`);
					}

					// Show truncation and closing quote
					if (strLines.length > maxStrLines) {
						truncated = true;
						pushLine(
							`${continuePrefix}   ${theme.fg("dim", ` …(${formatMoreLines(strLines.length - maxStrLines)})"`)}`,
						);
					} else {
						// Add closing quote to last line - need to modify the last pushed line
						const lastIdx = lines.length - 1;
						lines[lastIdx] = `${lines[lastIdx]}${theme.fg("dim", '"')}`;
					}
					return;
				}

				const scalar = formatScalar(val, maxScalarLen);
				pushLine(`${prefix}${iconScalar} ${label}: ${theme.fg("dim", scalar)}`);
				return;
			}

			// Handle arrays
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

			// Handle objects
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

	// Render root level
	if (isRecord(value)) {
		for (const key in value) {
			if (key in HIDDEN_JSON_TREE_KEYS) continue;
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
