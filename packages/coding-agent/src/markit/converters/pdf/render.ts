import type { ContentBlock, TableGrid, TextBox } from "./types";

interface RenderLine {
	text: string;
	topY: number;
	fontSize: number;
	isBold: boolean;
	isTabular: boolean;
}

type WrapBlock = ContentBlock & { lastTopY: number };

function normalizeFullWidthAscii(text: string): string {
	return text.replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

function escapePipes(text: string): string {
	return normalizeFullWidthAscii(text).replaceAll("|", "\\|").replaceAll("\n", "<br>");
}

export function parsePipeRow(line: string): string[] {
	const trimmed = line.trim();
	if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return [];
	return trimmed
		.slice(1, -1)
		.split(/(?<!\\)\|/)
		.map(cell => cell.trim());
}

export function renderTableToMarkdown(table: TableGrid): string {
	if (table.rows === 0 || table.cols === 0) return "";
	const matrix = Array.from({ length: table.rows }, () => Array.from({ length: table.cols }, () => ""));
	for (const cell of table.cells) {
		if (cell.row < table.rows && cell.col < table.cols) {
			matrix[cell.row][cell.col] = escapePipes(cell.text.trim());
		}
	}
	const normalized = normalizeShiftedSparseColumns(matrix);
	const promoted = promoteSubHeaderPrefixes(normalized);
	const header = `| ${promoted[0].join(" | ")} |`;
	const divider = `| ${Array.from({ length: promoted[0].length }, () => "---").join(" | ")} |`;
	const body = promoted
		.slice(1)
		.map(row => `| ${row.join(" | ")} |`)
		.join("\n");
	return [header, divider, body].filter(l => l.length > 0).join("\n");
}

function normalizeShiftedSparseColumns(matrix: string[][]): string[][] {
	if (matrix.length === 0 || matrix[0].length < 5) return matrix;
	const cols = matrix[0].length;
	const counts = Array.from({ length: cols }, (_, c) =>
		matrix.reduce((n, row) => n + (row[c].trim().length > 0 ? 1 : 0), 0),
	);
	const denseCols = new Set(
		counts
			.map((count, col) => ({ count, col }))
			.filter(({ col, count }) => col === 0 || count >= 2)
			.map(({ col }) => col),
	);
	const sparseCols = counts
		.map((count, col) => ({ count, col }))
		.filter(({ col, count }) => col > 0 && col < cols - 1 && count === 1)
		.map(({ col }) => col);
	if (sparseCols.length < 2 || denseCols.size < 4) return matrix;
	const moves: Array<{ from: number; to: number; row: number }> = [];
	for (const from of sparseCols) {
		const row = matrix.findIndex(r => r[from].trim().length > 0);
		const to = from + 1;
		if (row < 0) return matrix;
		if (!denseCols.has(to)) return matrix;
		if (matrix[row][to].trim().length > 0) return matrix;
		moves.push({ from, to, row });
	}
	const copy = matrix.map(row => row.slice());
	for (const { from, to, row } of moves) {
		copy[row][to] = copy[row][to].trim().length > 0 ? `${copy[row][to]} ${copy[row][from]}` : copy[row][from];
		copy[row][from] = "";
	}
	const keepCols = Array.from({ length: cols }, (_, c) => c).filter(c => copy.some(row => row[c].trim().length > 0));
	if (keepCols.length === cols) return copy;
	return copy.map(row => keepCols.map(c => row[c]));
}

function promoteSubHeaderPrefixes(matrix: string[][]): string[][] {
	if (matrix.length < 2) return matrix;
	const PAREN_RE = /^\([^)]{1,40}\)$/;
	const result = matrix.map(row => row.slice());
	const cols = matrix[0].length;
	const rowsToRemove = new Set<number>();
	for (let r = 1; r < result.length; r++) {
		if (rowsToRemove.has(r)) continue;
		const promotable: Array<{ col: number; prefix: string; isFullCell: boolean }> = [];
		for (let col = 1; col < cols; col++) {
			const cell = (result[r][col] ?? "").trim();
			if (!cell) continue;
			const parts = cell.split("<br>");
			if (parts.length === 1 && PAREN_RE.test(cell)) {
				promotable.push({ col, prefix: cell, isFullCell: true });
			} else if (parts.length >= 2 && PAREN_RE.test(parts[0].trim())) {
				promotable.push({
					col,
					prefix: parts[0].trim(),
					isFullCell: false,
				});
			}
		}
		if (promotable.length < 2) continue;
		if (promotable.some(p => p.isFullCell) && result[r][0].trim().length > 0) continue;
		for (const { col, prefix, isFullCell } of promotable) {
			result[0][col] = result[0][col].trim() ? `${result[0][col]} ${prefix}` : prefix;
			if (isFullCell) {
				result[r][col] = "";
			} else {
				const parts = result[r][col].split("<br>");
				result[r][col] = parts.slice(1).join("<br>");
			}
		}
		if (result[r].every(cell => cell.trim().length === 0)) {
			rowsToRemove.add(r);
		}
	}
	return result.filter((_, r) => !rowsToRemove.has(r));
}

const TEXT_LINE_Y_TOLERANCE = 3;
const TABULAR_X_GAP = 30;
const MIN_BODY_FONT_SIZE = 7;

function modalFontSize(textBoxes: TextBox[]): number {
	const counts = new Map<number, number>();
	for (const tb of textBoxes) {
		const size = Math.round((tb.fontSize ?? 0) * 10) / 10;
		if (size < MIN_BODY_FONT_SIZE) continue;
		counts.set(size, (counts.get(size) ?? 0) + 1);
	}
	let modal = 0;
	let maxCount = 0;
	for (const [size, count] of counts) {
		if (count > maxCount) {
			maxCount = count;
			modal = size;
		}
	}
	return modal;
}

function groupFreeTextIntoLines(textBoxes: TextBox[]): RenderLine[] {
	if (textBoxes.length === 0) return [];
	const sorted = textBoxes.slice().sort((a, b) => {
		const ya = (a.bounds.top + a.bounds.bottom) / 2;
		const yb = (b.bounds.top + b.bounds.bottom) / 2;
		const dy = yb - ya;
		if (Math.abs(dy) > TEXT_LINE_Y_TOLERANCE) return dy;
		return a.bounds.left - b.bounds.left;
	});
	const lines: RenderLine[] = [];
	let curParts = [sorted[0].text];
	let curBoxes = [sorted[0]];
	let curY = (sorted[0].bounds.top + sorted[0].bounds.bottom) / 2;
	let curTopY = curY;
	let curFontSize = sorted[0].fontSize;
	let curIsBold = sorted[0].isBold;
	const finishLine = () => {
		let isTabular = false;
		for (let j = 1; j < curBoxes.length; j++) {
			if (curBoxes[j].bounds.left - curBoxes[j - 1].bounds.right > TABULAR_X_GAP) {
				isTabular = true;
				break;
			}
		}
		lines.push({
			text: curParts.join(" "),
			topY: curTopY,
			fontSize: curFontSize,
			isBold: curIsBold,
			isTabular,
		});
	};
	for (let i = 1; i < sorted.length; i++) {
		const box = sorted[i];
		const cy = (box.bounds.top + box.bounds.bottom) / 2;
		if (Math.abs(cy - curY) <= TEXT_LINE_Y_TOLERANCE) {
			curParts.push(box.text);
			curBoxes.push(box);
			curFontSize = Math.max(curFontSize, box.fontSize);
			curIsBold = curIsBold || box.isBold;
		} else {
			finishLine();
			curParts = [box.text];
			curBoxes = [box];
			curY = cy;
			curTopY = cy;
			curFontSize = box.fontSize;
			curIsBold = box.isBold;
		}
	}
	finishLine();
	return lines;
}

function headingPrefix(fontSize: number, bodyFontSize: number, isBold: boolean): string {
	if (bodyFontSize <= 0) return "";
	const ratio = fontSize / bodyFontSize;
	if (ratio >= 2.0) return "# ";
	if (ratio >= 1.4) return "## ";
	if (ratio >= 1.1 && isBold) return "### ";
	return "";
}

function mergeConsecutiveHeadings(blocks: ContentBlock[], bodyFS: number): ContentBlock[] {
	if (blocks.length === 0) return [];
	const HEADING_RE = /^(#{1,6} )/;
	const maxGap = Math.max(bodyFS * 3, 30);
	const merged: ContentBlock[] = [];
	let cur: ContentBlock = { ...blocks[0] };
	for (let i = 1; i < blocks.length; i++) {
		const next = blocks[i];
		const curMatch = cur.content.match(HEADING_RE);
		const nextMatch = next.content.match(HEADING_RE);
		const gap = cur.topY - next.topY;
		if (curMatch && nextMatch && curMatch[1] === nextMatch[1] && gap <= maxGap) {
			cur = {
				topY: cur.topY,
				content: `${cur.content} ${next.content.slice(nextMatch[1].length)}`,
				isTabular: cur.isTabular || next.isTabular,
			};
		} else {
			merged.push(cur);
			cur = { ...next };
		}
	}
	merged.push(cur);
	return merged;
}

function mergeParagraphWraps(blocks: ContentBlock[], bodyFS: number): ContentBlock[] {
	if (blocks.length === 0 || bodyFS <= 0) return blocks;
	const HEADING_RE = /^#{1,6} /;
	const SENTENCE_END_RE = /[.!?…)\]]\s*$/;
	const maxGap = bodyFS * 2.0;
	const MIN_WRAP_LENGTH = 25;
	const merged: ContentBlock[] = [];
	let cur: WrapBlock = { ...blocks[0], lastTopY: blocks[0].topY };
	for (let i = 1; i < blocks.length; i++) {
		const next = blocks[i];
		const curIsBody = !HEADING_RE.test(cur.content) && !cur.content.startsWith("|");
		const nextIsBody = !HEADING_RE.test(next.content) && !next.content.startsWith("|");
		const gap = cur.lastTopY - next.topY;
		const isWrap =
			curIsBody &&
			nextIsBody &&
			!cur.isTabular &&
			!next.isTabular &&
			gap > 0 &&
			gap <= maxGap &&
			cur.content.length > MIN_WRAP_LENGTH &&
			!SENTENCE_END_RE.test(cur.content);
		if (isWrap) {
			cur = {
				topY: cur.topY,
				lastTopY: next.topY,
				content: `${cur.content.trimEnd()} ${next.content.trimStart()}`,
				isTabular: false,
			};
		} else {
			merged.push({ topY: cur.topY, content: cur.content });
			cur = { ...next, lastTopY: next.topY };
		}
	}
	merged.push({ topY: cur.topY, content: cur.content });
	return merged;
}

function removePageNumbers(blocks: ContentBlock[]): ContentBlock[] {
	const PAGE_NUM_RE = /^(?:#{1,6}\s*)?\d+\s*$/;
	const BOTTOM_Y = 120;
	return blocks.filter((block, idx) => {
		const isBottom = idx >= blocks.length - 3;
		const isLowY = block.topY <= BOTTOM_Y;
		const isPageNum = PAGE_NUM_RE.test(block.content.trim());
		return !(isBottom && isLowY && isPageNum);
	});
}

export function normalizeDetachedFirstColumnTables(blocks: ContentBlock[]): ContentBlock[] {
	const HEADING_RE = /^#{1,6}\s/;
	const isTableBlock = (text: string) => text.trimStart().startsWith("|");
	const isPlainBlock = (text: string) => !HEADING_RE.test(text) && !isTableBlock(text);
	const isShortLabel = (text: string) => {
		const t = text.trim();
		return t.length > 0 && t.length <= 40;
	};
	const splitTokens = (text: string) =>
		text
			.trim()
			.split(/[ \t]+/)
			.filter(Boolean);
	const replacements = new Map<number, string>();
	const remove = new Set<number>();
	for (let tableIdx = 0; tableIdx < blocks.length; tableIdx++) {
		if (remove.has(tableIdx)) continue;
		const tableBlock = blocks[tableIdx];
		if (!isTableBlock(tableBlock.content)) continue;
		const tableLines = tableBlock.content
			.split("\n")
			.map(line => line.trim())
			.filter(line => line.startsWith("|"));
		const dataRows = tableLines
			.filter(line => !/^\|\s*[-: ]+\|/.test(line))
			.map(parsePipeRow)
			.filter(row => row.length > 0);
		if (dataRows.length === 0) continue;
		const cols = dataRows[0].length;
		if (cols < 2 || dataRows.some(row => row.length !== cols)) continue;
		const logicalRows: string[][] = [];
		for (const row of dataRows) {
			const splitCells = row.map(cell => cell.split("<br>").map(p => p.trim()));
			const rowSpan = Math.max(...splitCells.map(parts => parts.length));
			for (let k = 0; k < rowSpan; k++) {
				logicalRows.push(splitCells.map(parts => parts[k] ?? ""));
			}
		}
		if (logicalRows.length < 2) continue;
		let headerIdx = -1;
		let headerTokens: string[] = [];
		for (let i = Math.max(0, tableIdx - 4); i <= tableIdx - 1; i++) {
			const text = normalizeFullWidthAscii(blocks[i].content).trim();
			if (!isPlainBlock(text)) continue;
			const tokens = splitTokens(text);
			if (tokens.length === cols + 1 && tokens.every(tok => !/[0-9]/.test(tok))) {
				headerIdx = i;
				headerTokens = tokens;
			}
		}
		if (headerIdx < 0) continue;
		const aboveLabels: Array<{ idx: number; text: string }> = [];
		for (let i = tableIdx - 1; i > headerIdx; i--) {
			const text = normalizeFullWidthAscii(blocks[i].content).trim();
			if (!isPlainBlock(text) || !isShortLabel(text)) break;
			aboveLabels.push({ idx: i, text });
		}
		aboveLabels.reverse();
		const belowLabels: Array<{ idx: number; text: string }> = [];
		for (let i = tableIdx + 1; i < blocks.length; i++) {
			const text = normalizeFullWidthAscii(blocks[i].content).trim();
			if (!isPlainBlock(text) || !isShortLabel(text)) break;
			belowLabels.push({ idx: i, text });
		}
		const labels = aboveLabels.concat(belowLabels);
		if (labels.length !== logicalRows.length) continue;
		const normalizedLines: string[] = [];
		normalizedLines.push(`| ${headerTokens.map(escapePipes).join(" | ")} |`);
		normalizedLines.push(`| ${Array.from({ length: cols + 1 }, () => "---").join(" | ")} |`);
		for (let r = 0; r < logicalRows.length; r++) {
			normalizedLines.push(`| ${escapePipes(labels[r].text)} | ${logicalRows[r].join(" | ")} |`);
		}
		replacements.set(tableIdx, normalizedLines.join("\n"));
		remove.add(headerIdx);
		for (const label of labels) remove.add(label.idx);
	}
	if (replacements.size === 0 && remove.size === 0) return blocks;
	const out: ContentBlock[] = [];
	for (let i = 0; i < blocks.length; i++) {
		if (remove.has(i)) continue;
		const replaced = replacements.get(i);
		if (replaced) {
			out.push({ topY: blocks[i].topY, content: replaced });
		} else {
			out.push(blocks[i]);
		}
	}
	return out;
}

export function renderPageContent(
	freeTextBoxes: TextBox[],
	tables: TableGrid[],
	imageBlocks: Array<{ topY: number; markdown: string }> = [],
	allTextBoxes?: TextBox[],
): string {
	const blocks: ContentBlock[] = [];
	const bodyFS = modalFontSize(allTextBoxes ?? freeTextBoxes);
	for (const line of groupFreeTextIntoLines(freeTextBoxes)) {
		const prefix = headingPrefix(line.fontSize, bodyFS, line.isBold);
		blocks.push({
			topY: line.topY,
			content: prefix + line.text,
			isTabular: prefix === "" && line.isTabular,
		});
	}
	for (const table of tables) {
		const md = renderTableToMarkdown(table);
		if (md.length > 0) {
			blocks.push({ topY: table.topY, content: md });
		}
	}
	for (const img of imageBlocks) {
		blocks.push({ topY: img.topY, content: img.markdown });
	}
	blocks.sort((a, b) => b.topY - a.topY);
	const cleaned = removePageNumbers(blocks);
	const headingsMerged = mergeConsecutiveHeadings(cleaned, bodyFS);
	const merged = mergeParagraphWraps(headingsMerged, bodyFS);
	const normalized = normalizeDetachedFirstColumnTables(merged);
	return normalized
		.map(b => b.content)
		.join("\n\n")
		.trim();
}
