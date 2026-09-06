/**
 * JSON tree rendering as terminal strings.
 *
 * Bounds, scalar formatting, the one-line argument preview, and the shared tree walker
 * live in `json-tree-view.ts`. This module projects that walk into terminal strings with
 * tree-rail glyphs and theme styling, for the transcript fallback that paints a JSON value
 * as terminal bytes rather than as a ToolView.
 */
import { buildTreePrefix } from "../../modes/terminal/draw/utils";
import type { Theme } from "../../theme/theme";
import { HIDDEN_JSON_TREE_KEYS, type JsonTreeVisitor, walkJsonTree } from "./json-tree-view";
import { replaceTabs, shortenEmbeddedPaths, truncateToWidth } from "./render-utils";

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

	const visitor: JsonTreeVisitor = {
		get lineCount() {
			return lines.length;
		},
		markTruncated() {
			truncated = true;
		},
		filterRootKeys(obj) {
			const keys: string[] = [];
			for (const key in obj) {
				if (key in HIDDEN_JSON_TREE_KEYS) continue;
				keys.push(key);
			}
			return keys;
		},
		objectDepthPrecedesEmpty: true,
		formatMultilineRow(rawText) {
			return truncateToWidth(replaceTabs(shortenEmbeddedPaths(rawText)), maxScalarLen);
		},
		onScalar(key, formattedValue, _depth, isLast, ancestors) {
			const connector = isLast ? theme.tree.last : theme.tree.branch;
			const prefix = `${buildTreePrefix(ancestors, theme)}${theme.fg("dim", connector)} `;
			const label = key ? theme.fg("muted", key) : theme.fg("muted", "value");
			return pushLine(`${prefix}${iconScalar} ${label}: ${theme.fg("dim", formattedValue)}`);
		},
		onMultilineRow(rowText, _depth, ancestors) {
			const continuePrefix = buildTreePrefix(ancestors, theme);
			return pushLine(`${continuePrefix}   ${theme.fg("dim", ` ${rowText}`)}`);
		},
		onMultilineCloseQuote() {
			const lastIdx = lines.length - 1;
			if (lastIdx >= 0) {
				lines[lastIdx] = `${lines[lastIdx]}${theme.fg("dim", '"')}`;
			}
		},
		onContainerOpen(kind, key, _depth, isLast, ancestors) {
			const connector = isLast ? theme.tree.last : theme.tree.branch;
			const prefix = `${buildTreePrefix(ancestors, theme)}${theme.fg("dim", connector)} `;
			const icon = kind === "array" ? iconArray : iconObject;
			const header = key ? theme.fg("muted", key) : theme.fg("muted", kind === "array" ? "array" : "object");
			return pushLine(`${prefix}${icon} ${header}`);
		},
		onContainerClose(text, _depth, ancestors) {
			return pushLine(
				`${buildTreePrefix(ancestors, theme)}${theme.fg("dim", theme.tree.last)} ${theme.fg("dim", text)}`,
			);
		},
	};

	walkJsonTree(value, { maxDepth, maxLines, maxScalarLen }, visitor);
	return { lines, truncated };
}
