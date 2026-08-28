import { stripVTControlCharacters } from "node:util";
import { CURSOR_MARKER, type OverlayAnchor, type OverlayOptions } from "@veyyon/tui/tui";
import {
	Ellipsis,
	extractSegments,
	sliceByColumn,
	sliceWithWidth,
	truncateToWidth,
	visibleWidth,
} from "@veyyon/tui/utils";
import { VirtualTerminal } from "../terminal/virtual-terminal";
import { BEL, ESC, EXHAUSTIVE_SCROLLBACK, SEGMENT_RESET } from "./constants";
import { IntermittentUnknownViewportTerminal, StaleBottomTerminal, UnknownViewportTerminal } from "./doubles";
import { SEGMENTER } from "./text";
import { assertNever } from "./traits";
import type { ExpectedCursor, ExpectedFrame, Scenario, StressOverlayEntry } from "./types";

export function createTerminal(scenario: Scenario): VirtualTerminal {
	switch (scenario.terminalMode) {
		case "unknown":
			return new UnknownViewportTerminal(scenario.columns, scenario.rows, scenario.scrollback);
		case "intermittentUnknown":
			return new IntermittentUnknownViewportTerminal(scenario.columns, scenario.rows, scenario.scrollback);
		case "staleBottom":
			return new StaleBottomTerminal(scenario.columns, scenario.rows, scenario.scrollback);
		case "normal":
			return new VirtualTerminal(scenario.columns, scenario.rows, scenario.scrollback);
		default:
			return assertNever(scenario.terminalMode);
	}
}

export function normalizeLines(lines: readonly string[]): string[] {
	return lines.map(line => line.trimEnd());
}

export function expectedViewport(frame: readonly string[], height: number): string[] {
	return fixedViewportSlice(frame, Math.max(0, frame.length - height), height);
}

export function fixedViewportSlice(frame: readonly string[], start: number, height: number): string[] {
	const view: string[] = [];
	for (let i = 0; i < height; i++) {
		view.push(frame[start + i] ?? "");
	}
	return view;
}

export function sameLines(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) return false;
	for (let i = 0; i < left.length; i++) {
		if (left[i] !== right[i]) return false;
	}
	return true;
}

// ghostty-web's cell-grid text extraction can migrate or merge Unicode
// non-spacing marks across neighboring cells for combining-heavy scripts
// (Arabic harakat), so a byte-exact round trip through the virtual terminal is
// not achievable for those rows (the engine paints them verbatim; see the
// WIDTH notes in docs/internal/tui-core-renderer.md). Fall back to comparing with
// non-spacing marks stripped — row count, order, and all spacing content stay
// exact.
export const NONSPACING_MARKS = /\p{Mn}/gu;
export function sameLinesAllowingMarkDrift(left: readonly string[], right: readonly string[]): boolean {
	if (sameLines(left, right)) return true;
	if (left.length !== right.length) return false;
	for (let i = 0; i < left.length; i++) {
		if (left[i] === right[i]) continue;
		if (left[i]!.replace(NONSPACING_MARKS, "") !== right[i]!.replace(NONSPACING_MARKS, "")) return false;
	}
	return true;
}

export function firstMismatchIndex(left: readonly string[], right: readonly string[]): number {
	const maxLength = Math.max(left.length, right.length);
	for (let i = 0; i < maxLength; i++) {
		if (left[i] !== right[i]) return i;
	}
	return -1;
}

export function windowAround(lines: readonly string[], center: number): string[] {
	const safeCenter = center < 0 ? 0 : center;
	const start = Math.max(0, safeCenter - 3);
	const end = Math.min(lines.length, safeCenter + 4);
	return lines.slice(start, end);
}

export function expectedScrollbackBuffer(frame: readonly string[], height: number, scrollback: number): string[] {
	const expected = [...frame];
	while (expected.length < height) {
		expected.push("");
	}
	const cap = height + scrollback;
	return expected.length > cap ? expected.slice(expected.length - cap) : expected;
}

export function scrollbackProbePositions(maxViewportY: number, frameLength: number, height: number): number[] {
	const maxY = Math.max(0, maxViewportY);
	const positions = new Set<number>();
	const add = (value: number): void => {
		positions.add(Math.max(0, Math.min(maxY, value)));
	};
	add(0);
	add(maxY);
	add(Math.floor(maxY / 2));
	add(Math.max(0, frameLength - height));
	add(frameLength - 1);
	add(frameLength);
	if (EXHAUSTIVE_SCROLLBACK || maxY <= 32) {
		for (let y = 0; y <= maxY; y++) add(y);
	}
	return [...positions].sort((left, right) => left - right);
}

export function duplicateNonblankLines(lines: readonly string[]): Set<string> {
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const line of lines) {
		if (line.length === 0) continue;
		if (seen.has(line)) duplicates.add(line);
		seen.add(line);
	}
	return duplicates;
}

export function expectedTerminalLine(line: string, width: number): string {
	const safeWidth = Math.max(1, width);
	const fitted = visibleWidth(line) > safeWidth ? truncateToWidth(line, safeWidth, Ellipsis.Omit) : line;
	return stripPlainTerminalText(fitted).trimEnd();
}

export function stripPlainTerminalText(text: string): string {
	return stripVTControlCharacters(text)
		.replace(/\]8;;[^\x07]*(?:\x07)?/g, "")
		.replaceAll(BEL, "");
}

export function findPrivateCsiTerminator(input: string, start: number): number {
	return findCsiTerminator(input, start);
}

export function findCsiTerminator(input: string, start: number): number {
	for (let index = start; index < input.length; index++) {
		const code = input.charCodeAt(index);
		if (code >= 0x40 && code <= 0x7e) return index;
	}
	return -1;
}

export function findOscTerminator(input: string, start: number): number {
	for (let index = start; index < input.length; index++) {
		const code = input.charCodeAt(index);
		if (code === 0x07) return index + 1;
		if (code === 0x1b && input[index + 1] === "\\") return index + 2;
	}
	return -1;
}

export function parseCsiParameters(paramsText: string): number[] {
	if (paramsText.length === 0) return [];
	const params: number[] = [];
	for (const part of paramsText.split(";")) {
		if (part.length === 0) continue;
		const parsed = Number.parseInt(part, 10);
		if (Number.isFinite(parsed)) params.push(parsed);
	}
	return params;
}

export function trailingPrivateCsiPrefixStart(input: string): number {
	const esc = input.lastIndexOf(ESC);
	if (esc === -1) return -1;
	const tail = input.slice(esc);
	return /^\x1b(?:\[?|\[\?[0-9;]*)$/.test(tail) ? esc : -1;
}

export function expectedFrameFromLines(lines: readonly string[], width: number, height: number): ExpectedFrame {
	const stripped = [...lines];
	const viewportTop = Math.max(0, stripped.length - height);
	let cursor: ExpectedCursor | null = null;
	const backgroundColumns: number[][] = Array.from({ length: stripped.length }, () => []);
	for (let row = stripped.length - 1; row >= 0; row--) {
		const line = stripped[row] ?? "";
		const markerIndex = line.indexOf(CURSOR_MARKER);
		const cleanLine = markerIndex === -1 ? line : removeCursorMarkers(line);
		backgroundColumns[row] = expectedBackgroundColumns(cleanLine, width);
		if (markerIndex !== -1 && cursor === null && row >= viewportTop) {
			cursor = { row: row - viewportTop, col: visibleWidth(line.slice(0, markerIndex)) };
		}
		stripped[row] = cleanLine;
	}
	return { frame: stripped.map(line => expectedTerminalLine(line, width)), cursor, backgroundColumns };
}

export function expectedBackgroundColumns(line: string, width: number): number[] {
	const safeWidth = Math.max(1, width);
	const fitted = visibleWidth(line) > safeWidth ? truncateToWidth(line, safeWidth, Ellipsis.Omit) : line;
	const columns: number[] = [];
	let backgroundActive = false;
	let skipUntil = 0;
	let col = 0;
	for (const segment of SEGMENTER.segment(fitted)) {
		if (segment.index < skipUntil) continue;
		if (fitted.charCodeAt(segment.index) === 0x1b) {
			const next = segment.index + 1;
			if (fitted[next] === "[") {
				const terminator = findCsiTerminator(fitted, next + 1);
				if (terminator === -1) break;
				if (fitted[terminator] === "m") {
					backgroundActive = applySgrBackground(backgroundActive, fitted.slice(next + 1, terminator));
				}
				skipUntil = terminator + 1;
				continue;
			}
			if (fitted[next] === "]") {
				const terminator = findOscTerminator(fitted, next + 1);
				if (terminator === -1) break;
				skipUntil = terminator;
				continue;
			}
		}
		const segmentWidth = visibleWidth(segment.segment);
		if (segmentWidth <= 0) continue;
		if (backgroundActive) {
			const end = Math.min(safeWidth, col + segmentWidth);
			for (let column = col; column < end; column++) columns.push(column);
		}
		col += segmentWidth;
		if (col >= safeWidth) break;
	}
	return columns;
}

export function applySgrBackground(current: boolean, paramsText: string): boolean {
	const params = parseCsiParameters(paramsText);
	let active = current;
	for (const param of params.length === 0 ? [0] : params) {
		if (param === 0 || param === 49) {
			active = false;
		} else if ((param >= 40 && param <= 48) || (param >= 100 && param <= 107)) {
			active = true;
		}
	}
	return active;
}

export function removeCursorMarkers(line: string): string {
	return line.includes(CURSOR_MARKER) ? line.split(CURSOR_MARKER).join("") : line;
}

export function compositeExpectedOverlays(
	lines: readonly string[],
	overlays: readonly StressOverlayEntry[],
	termWidth: number,
	termHeight: number,
): string[] {
	if (overlays.length === 0) return [...lines];
	const result = [...lines];
	const rendered: { overlayLines: string[]; row: number; col: number; w: number }[] = [];
	let minLinesNeeded = result.length;
	for (const entry of overlays) {
		if (!isExpectedOverlayVisible(entry, termWidth, termHeight)) continue;
		const firstLayout = resolveExpectedOverlayLayout(entry.options, 0, termWidth, termHeight);
		let overlayLines = entry.component.render(firstLayout.width);
		if (overlayLines.length > firstLayout.maxHeight) {
			overlayLines = overlayLines.slice(0, firstLayout.maxHeight);
		}
		const layout = resolveExpectedOverlayLayout(entry.options, overlayLines.length, termWidth, termHeight);
		rendered.push({ overlayLines, row: layout.row, col: layout.col, w: layout.width });
		minLinesNeeded = Math.max(minLinesNeeded, layout.row + overlayLines.length);
	}
	const workingHeight = Math.max(result.length, minLinesNeeded);
	while (result.length < workingHeight) {
		result.push("");
	}
	const viewportStart = Math.max(0, workingHeight - termHeight);
	for (const { overlayLines, row, col, w } of rendered) {
		for (let i = 0; i < overlayLines.length; i++) {
			const index = viewportStart + row + i;
			if (index < 0 || index >= result.length) continue;
			const overlayLine = overlayLines[i] ?? "";
			const truncatedOverlayLine =
				visibleWidth(overlayLine) > w ? sliceByColumn(overlayLine, 0, w, true) : overlayLine;
			result[index] = compositeExpectedLineAt(result[index] ?? "", truncatedOverlayLine, col, w, termWidth);
		}
	}
	return result;
}

export function isExpectedOverlayVisible(entry: StressOverlayEntry, termWidth: number, termHeight: number): boolean {
	if (entry.hidden) return false;
	return entry.options.visible?.(termWidth, termHeight) ?? true;
}

export function resolveExpectedOverlayLayout(
	options: OverlayOptions | undefined,
	overlayHeight: number,
	termWidth: number,
	termHeight: number,
): { width: number; row: number; col: number; maxHeight: number } {
	const opt = options ?? {};
	const margin =
		typeof opt.margin === "number"
			? { top: opt.margin, right: opt.margin, bottom: opt.margin, left: opt.margin }
			: (opt.margin ?? {});
	const marginTop = Math.max(0, margin.top ?? 0);
	const marginRight = Math.max(0, margin.right ?? 0);
	const marginBottom = Math.max(0, margin.bottom ?? 0);
	const marginLeft = Math.max(0, margin.left ?? 0);
	const availWidth = Math.max(1, termWidth - marginLeft - marginRight);
	const availHeight = Math.max(1, termHeight - marginTop - marginBottom);
	let width = parseOverlaySizeValue(opt.width, termWidth) ?? Math.min(80, availWidth);
	if (opt.minWidth !== undefined) {
		width = Math.max(width, opt.minWidth);
	}
	width = Math.max(1, Math.min(width, availWidth));
	let maxHeight = parseOverlaySizeValue(opt.maxHeight, termHeight) ?? availHeight;
	maxHeight = Math.max(1, Math.min(maxHeight, availHeight));
	const effectiveHeight = Math.min(overlayHeight, maxHeight);
	let row: number;
	let col: number;
	if (opt.row !== undefined) {
		row =
			typeof opt.row === "string"
				? resolveOverlayPercentPosition(opt.row, Math.max(0, availHeight - effectiveHeight), marginTop)
				: opt.row;
	} else {
		row = resolveExpectedAnchorRow(opt.anchor ?? "center", effectiveHeight, availHeight, marginTop);
	}
	if (opt.col !== undefined) {
		col =
			typeof opt.col === "string"
				? resolveOverlayPercentPosition(opt.col, Math.max(0, availWidth - width), marginLeft)
				: opt.col;
	} else {
		col = resolveExpectedAnchorCol(opt.anchor ?? "center", width, availWidth, marginLeft);
	}
	if (opt.offsetY !== undefined) row += opt.offsetY;
	if (opt.offsetX !== undefined) col += opt.offsetX;
	row = Math.max(marginTop, Math.min(row, termHeight - marginBottom - effectiveHeight));
	col = Math.max(marginLeft, Math.min(col, termWidth - marginRight - width));
	return { width, row, col, maxHeight };
}

export function parseOverlaySizeValue(
	value: OverlayOptions["width"] | undefined,
	referenceSize: number,
): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number") return value;
	const match = value.match(/^(\d+(?:\.\d+)?)%$/);
	return match ? Math.floor((referenceSize * Number.parseFloat(match[1] ?? "0")) / 100) : undefined;
}

export function resolveOverlayPercentPosition(value: string, maxPosition: number, margin: number): number {
	const match = value.match(/^(\d+(?:\.\d+)?)%$/);
	if (!match) return margin + Math.floor(maxPosition / 2);
	return margin + Math.floor(maxPosition * (Number.parseFloat(match[1] ?? "0") / 100));
}

export function resolveExpectedAnchorRow(
	anchor: OverlayAnchor,
	height: number,
	availHeight: number,
	marginTop: number,
): number {
	switch (anchor) {
		case "top-left":
		case "top-center":
		case "top-right":
			return marginTop;
		case "bottom-left":
		case "bottom-center":
		case "bottom-right":
			return marginTop + availHeight - height;
		case "left-center":
		case "center":
		case "right-center":
			return marginTop + Math.floor((availHeight - height) / 2);
		default:
			return assertNever(anchor);
	}
}

export function resolveExpectedAnchorCol(
	anchor: OverlayAnchor,
	width: number,
	availWidth: number,
	marginLeft: number,
): number {
	switch (anchor) {
		case "top-left":
		case "left-center":
		case "bottom-left":
			return marginLeft;
		case "top-right":
		case "right-center":
		case "bottom-right":
			return marginLeft + availWidth - width;
		case "top-center":
		case "center":
		case "bottom-center":
			return marginLeft + Math.floor((availWidth - width) / 2);
		default:
			return assertNever(anchor);
	}
}

export function compositeExpectedLineAt(
	baseLine: string,
	overlayLine: string,
	startCol: number,
	overlayWidth: number,
	totalWidth: number,
): string {
	const afterStart = startCol + overlayWidth;
	const base = extractSegments(baseLine, startCol, afterStart, totalWidth - afterStart, true);
	const overlay = sliceWithWidth(overlayLine, 0, overlayWidth, true);
	const beforePad = Math.max(0, startCol - base.beforeWidth);
	const overlayPad = Math.max(0, overlayWidth - overlay.width);
	const actualBeforeWidth = Math.max(startCol, base.beforeWidth);
	const actualOverlayWidth = Math.max(overlayWidth, overlay.width);
	const afterTarget = Math.max(0, totalWidth - actualBeforeWidth - actualOverlayWidth);
	const afterPad = Math.max(0, afterTarget - base.afterWidth);
	const result =
		base.before +
		" ".repeat(beforePad) +
		SEGMENT_RESET +
		overlay.text +
		" ".repeat(overlayPad) +
		SEGMENT_RESET +
		base.after +
		" ".repeat(afterPad);
	return visibleWidth(result) <= totalWidth ? result : sliceByColumn(result, 0, totalWidth, true);
}
