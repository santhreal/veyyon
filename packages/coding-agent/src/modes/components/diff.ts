import { SGR_INTENSITY_RESET } from "@veyyon/tui/ansi";
import { DEFAULT_TAB_WIDTH, sanitizeText } from "@veyyon/utils";
import * as Diff from "diff";
import { type CodeFrameMarker, formatCodeFrameLine, replaceTabs } from "../../tools/render-utils";
import { getLanguageFromPath } from "../../utils/lang-from-path";
import { highlightCode } from "../theme/highlight";
import { theme } from "../theme/theme-binding";

const DIM = "\x1b[2m";

function visualizeIndent(text: string): string {
	const match = text.match(/^([ \t]+)/);
	if (!match) return replaceTabs(text);
	const indent = match[1];
	const rest = text.slice(indent.length);
	const tabWidth = DEFAULT_TAB_WIDTH;
	const leftPadding = Math.floor(tabWidth / 2);
	const rightPadding = Math.max(0, tabWidth - leftPadding - 1);
	const tabMarker = `${DIM}${" ".repeat(leftPadding)}→${" ".repeat(rightPadding)}${SGR_INTENSITY_RESET}`;
	let visible = "";
	for (let ci = 0; ci < indent.length; ci++) {
		if (indent.charCodeAt(ci) === 9) {
			visible += tabMarker;
		} else {
			visible += `${DIM}·${SGR_INTENSITY_RESET}`;
		}
	}
	return `${visible}${replaceTabs(rest)}`;
}

function parseDiffLine(line: string): { prefix: CodeFrameMarker; lineNum: string; content: string } | null {
	const canonical = line.match(/^([+-\s])(\s*\d+)\|(.*)$/);
	if (canonical) {
		return { prefix: canonical[1] as CodeFrameMarker, lineNum: canonical[2] ?? "", content: canonical[3] ?? "" };
	}
	const legacy = line.match(/^([+-\s])(?:(\s*\d+)\s)?(.*)$/);
	if (!legacy) return null;
	return { prefix: legacy[1] as CodeFrameMarker, lineNum: legacy[2] ?? "", content: legacy[3] ?? "" };
}

function renderIntraLineDiff(oldContent: string, newContent: string): { removedLine: string; addedLine: string } {
	const wordDiff = Diff.diffWords(oldContent, newContent);

	let removedLine = "";
	let addedLine = "";
	let isFirstRemoved = true;
	let isFirstAdded = true;

	for (let pi = 0; pi < wordDiff.length; pi++) {
		const part = wordDiff[pi]!;
		if (part.removed) {
			let value = part.value;
			if (isFirstRemoved) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				removedLine += leadingWs;
				isFirstRemoved = false;
			}
			if (value) {
				removedLine += theme.inverse(value);
			}
		} else if (part.added) {
			let value = part.value;
			if (isFirstAdded) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				addedLine += leadingWs;
				isFirstAdded = false;
			}
			if (value) {
				addedLine += theme.inverse(value);
			}
		} else {
			removedLine += part.value;
			addedLine += part.value;
		}
	}

	return { removedLine, addedLine };
}

export interface RenderDiffOptions {
	filePath?: string;
}

export function renderDiff(diffText: string, options: RenderDiffOptions = {}): string {
	const lines = sanitizeText(diffText).split("\n");
	const result: string[] = [];
	const parsedLines = new Array(lines.length);
	let lineNumberWidth = 3;
	for (let pi = 0; pi < lines.length; pi++) {
		const parsed = parseDiffLine(lines[pi]!);
		parsedLines[pi] = parsed;
		const lineNumber = parsed?.lineNum.trim() ?? "";
		if (lineNumber.length > lineNumberWidth) lineNumberWidth = lineNumber.length;
	}

	const contextHighlights = highlightContextLines(parsedLines, options.filePath);
	let prevLineNum = "";

	const formatLine = (prefix: CodeFrameMarker, lineNum: string, content: string): string => {
		if (lineNum.trim().length === 0) {
			prevLineNum = "";
			return `${prefix}${content}`;
		}
		const trimmed = lineNum.trim();
		const displayNum = trimmed === prevLineNum ? "" : trimmed;
		prevLineNum = trimmed;
		return formatCodeFrameLine(prefix, displayNum, content, lineNumberWidth);
	};

	let i = 0;
	while (i < lines.length) {
		const parsed = parsedLines[i];

		if (!parsed) {
			prevLineNum = "";
			const line = lines[i]!;
			const trimmed = line.trim();
			const isGapRow = trimmed.length === 0 || trimmed === "..." || trimmed === "…";
			result.push(theme.fg("toolDiffContext", isGapRow ? "…" : replaceTabs(line)));
			i++;
			continue;
		}

		if (parsed.prefix === "-") {
			const removedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const p = parsedLines[i];
				if (p?.prefix !== "-") break;
				removedLines.push({ lineNum: p.lineNum, content: p.content });
				i++;
			}

			const addedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const p = parsedLines[i];
				if (p?.prefix !== "+") break;
				addedLines.push({ lineNum: p.lineNum, content: p.content });
				i++;
			}

			if (removedLines.length === 1 && addedLines.length === 1) {
				const removed = removedLines[0];
				const added = addedLines[0];

				const { removedLine, addedLine } = renderIntraLineDiff(
					replaceTabs(removed.content),
					replaceTabs(added.content),
				);

				result.push(theme.fg("toolDiffRemoved", formatLine("-", removed.lineNum, visualizeIndent(removedLine))));
				result.push(theme.fg("toolDiffAdded", formatLine("+", added.lineNum, visualizeIndent(addedLine))));
			} else {
				for (let ri = 0; ri < removedLines.length; ri++) {
					const removed = removedLines[ri]!;
					result.push(
						theme.fg("toolDiffRemoved", formatLine("-", removed.lineNum, visualizeIndent(removed.content))),
					);
				}
				for (let ai = 0; ai < addedLines.length; ai++) {
					const added = addedLines[ai]!;
					result.push(theme.fg("toolDiffAdded", formatLine("+", added.lineNum, visualizeIndent(added.content))));
				}
			}
		} else if (parsed.prefix === "+") {
			result.push(theme.fg("toolDiffAdded", formatLine("+", parsed.lineNum, visualizeIndent(parsed.content))));
			i++;
		} else {
			const highlighted = contextHighlights.get(i);
			const content = highlighted !== undefined ? replaceTabs(highlighted) : visualizeIndent(parsed.content);
			result.push(theme.fg("toolDiffContext", formatLine(" ", parsed.lineNum, content)));
			i++;
		}
	}

	return result.join("\n");
}

function highlightContextLines(
	parsedLines: Array<{ prefix: CodeFrameMarker; lineNum: string; content: string } | null>,
	filePath: string | undefined,
): Map<number, string> {
	const map = new Map<number, string>();
	const lang = filePath ? getLanguageFromPath(filePath) : undefined;
	if (!lang) return map;

	let runIndices: number[] = [];
	let runContents: string[] = [];
	const flush = () => {
		if (runContents.length === 0) return;
		const highlighted = highlightCode(runContents.join("\n"), lang);
		for (let k = 0; k < runIndices.length; k++) {
			map.set(runIndices[k], highlighted[k] ?? runContents[k]);
		}
		runIndices = [];
		runContents = [];
	};

	for (let j = 0; j < parsedLines.length; j++) {
		const p = parsedLines[j];
		const isCollapseMarker = p?.prefix === " " && (p.content === "..." || p.content === "…");
		if (p && p.prefix === " " && !isCollapseMarker) {
			runIndices.push(j);
			runContents.push(p.content);
		} else {
			flush();
		}
	}
	flush();
	return map;
}
