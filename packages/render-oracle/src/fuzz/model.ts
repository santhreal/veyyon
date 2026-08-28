import { visibleWidth, wrapTextWithAnsi } from "@veyyon/tui/utils";
import type { Rng } from "./random";
import {
	arabicCombiningText,
	backgroundStyledText,
	emojiPresentationText,
	insertCursorMarker,
	linkedText,
	longText,
	pickCursorMode,
	randomDecoratedText,
	styledText,
	wideText,
} from "./text";
import type { CursorMode, JsonObject, LogicalLine } from "./types";

export class StressModel {
	readonly lines: LogicalLine[] = [];
	readonly minLines: number;
	#rng: Rng;
	#nextId = 0;
	#collapsibleIds: number[] = [];
	#cursorLineIndex: number | null = null;
	#cursorMode: CursorMode = "end";
	#uniqueContent: boolean;
	#usedText = new Set<string>();
	#labelPrefix: string;

	constructor(rng: Rng, minLines: number, uniqueContent = false, labelPrefix = "") {
		this.#rng = rng;
		this.minLines = minLines;
		this.#uniqueContent = uniqueContent;
		this.#labelPrefix = labelPrefix;
		const initialLength = minLines + 20;
		for (let i = 0; i < initialLength; i++) {
			this.lines.push(this.#line(this.#initialText(i)));
		}
	}

	renderedLines(width: number, focused = false): string[] {
		const lines = this.lines.map(line => line.text);
		if (focused && lines.length > 0) {
			const index = this.#clampedCursorLineIndex();
			lines[index] = insertCursorMarker(lines[index] ?? "", this.#cursorMode, width);
		}
		return lines;
	}

	debugLines(): string[] {
		const cursor = this.#cursorLineIndex === null ? "none" : `${this.#cursorLineIndex}:${this.#cursorMode}`;
		return [`cursor:${cursor}`, ...this.lines.map(line => `${line.id}:${JSON.stringify(line.text)}`)];
	}

	setCursorVisible(height: number, width: number): JsonObject {
		this.#ensureLine();
		const start = Math.max(0, this.lines.length - height);
		const index = this.#rng.int(start, this.lines.length - 1);
		return this.#setCursor(index, width, false);
	}

	setCursorOffscreen(height: number, width: number): JsonObject {
		while (this.lines.length <= height) {
			this.lines.push(this.#randomLine("u"));
		}
		const limit = Math.max(1, this.lines.length - height);
		const index = this.#rng.int(0, limit - 1);
		return this.#setCursor(index, width, true);
	}

	appendSmall(): JsonObject {
		const count = this.#rng.int(1, 3);
		for (let i = 0; i < count; i++) {
			this.lines.push(this.#randomLine("a"));
		}
		return { count };
	}

	// Append a row whose visible width EXACTLY equals the terminal width. Half
	// the time the final cell is a wide (2-cell) glyph so the exact-fit boundary
	// lands a double-width char on the last column — the pending-wrap trigger the
	// renderer's autowrap-off discipline must neutralize.
	appendExactWidth(width: number): JsonObject {
		const text = this.#exactWidthLine(width);
		this.lines.push(this.#line(text));
		return { width, text, visibleWidth: visibleWidth(text) };
	}

	#exactWidthLine(width: number): string {
		if (width <= 0) return "";
		const label = `${this.#labelPrefix}ew${this.#nextId.toString(36)}`;
		// Pad with enough ASCII fill to cover any terminal width (the widest stress
		// geometry is 120 cols). ASCII is one cell per code unit, so a code-unit
		// slice is a cell-exact slice.
		const fill = label.length >= width ? label : `${label}${".".repeat(width)}`;
		// End on a wide CJK char (2 cells) on the wider rows so the exact-fit
		// boundary lands a double-width glyph on the last column.
		if (width >= 3 && this.#rng.chance(0.5)) {
			return `${fill.slice(0, width - 2)}界`;
		}
		return fill.slice(0, width);
	}

	appendBulk(maxBulk: number): JsonObject {
		const min = Math.min(20, maxBulk);
		const count = this.#rng.int(min, maxBulk);
		for (let i = 0; i < count; i++) {
			this.lines.push(this.#randomLine("b"));
		}
		return { count };
	}

	streamOne(): JsonObject {
		this.lines.push(this.#randomLine("s"));
		return { count: 1 };
	}

	appendRepeatedTail(): JsonObject {
		if (this.#uniqueContent) {
			const line = this.#freshLine("repeatAlt");
			this.lines.push(line);
			return { convertedToUnique: true, text: line.text };
		}
		const text = this.lines[this.lines.length - 1]?.text ?? "";
		this.lines.push(this.#line(text));
		return { text };
	}

	appendDuplicateOfExisting(): JsonObject {
		const sourceIndex = this.#rng.int(0, this.lines.length - 1);
		if (this.#uniqueContent) {
			const line = this.#freshLine("dupAlt");
			this.lines.push(line);
			return { sourceIndex, convertedToUnique: true, text: line.text };
		}
		const text = this.lines[sourceIndex]?.text ?? "";
		this.lines.push(this.#line(text));
		return { sourceIndex, text };
	}

	injectBlankCluster(): JsonObject {
		const count = this.#rng.int(2, 8);
		for (let i = 0; i < count; i++) {
			this.lines.push(this.#line(""));
		}
		return { count };
	}

	editVisibleLine(height: number): JsonObject {
		const start = Math.max(0, this.lines.length - height);
		const index = this.#rng.int(start, this.lines.length - 1);
		const before = this.lines[index]?.text ?? "";
		this.lines[index] = this.#randomLine("v");
		return { index, before, after: this.lines[index]?.text ?? "" };
	}

	editOffscreenLine(height: number): JsonObject {
		const limit = Math.max(1, this.lines.length - height);
		const index = this.#rng.int(0, limit - 1);
		const before = this.lines[index]?.text ?? "";
		this.lines[index] = this.#randomLine("o");
		return { index, before, after: this.lines[index]?.text ?? "" };
	}

	offscreenEditAppendRepeatedTail(height: number): JsonObject {
		while (this.lines.length < height + 3) {
			this.lines.push(this.#randomLine("p"));
		}
		const previousLength = this.lines.length;
		const offscreenLimit = Math.max(1, previousLength - height);
		const offscreenIndex = this.#rng.int(0, offscreenLimit - 1);
		const previousLast = this.lines[previousLength - 1]?.text ?? "";
		this.lines[offscreenIndex] = this.#randomLine("x");
		const repeatedIndex = Math.max(0, previousLength - 2);
		this.lines[repeatedIndex] = this.#uniqueContent ? this.#freshLine("xAlt") : this.#line(previousLast);
		this.lines[previousLength - 1] = this.#randomLine("e");
		this.lines.push(this.#randomLine("f"));
		return { offscreenIndex, repeatedIndex, previousLast, previousLength };
	}

	insertOffscreen(height: number): JsonObject {
		const count = this.#rng.int(1, 4);
		const limit = Math.max(1, this.lines.length - height);
		const index = this.#rng.int(0, limit - 1);
		this.lines.splice(index, 0, ...this.#newLines(count, "i"));
		return { index, count };
	}

	insertMiddle(): JsonObject {
		const count = this.#rng.int(1, 3);
		const index = this.#rng.int(1, Math.max(1, this.lines.length - 2));
		this.lines.splice(index, 0, ...this.#newLines(count, "m"));
		return { index, count };
	}

	deleteTrailing(): JsonObject {
		const removable = Math.max(0, this.lines.length - this.minLines);
		if (removable === 0) return { count: 0 };
		const count = Math.min(removable, this.#rng.int(1, 4));
		const removed = this.lines.splice(this.lines.length - count, count);
		return { count, firstRemoved: removed[0]?.text ?? null };
	}

	deleteMiddle(height: number): JsonObject {
		const removable = Math.max(0, this.lines.length - this.minLines);
		if (removable === 0) return { count: 0 };
		const count = Math.min(removable, this.#rng.int(1, 3));
		const offscreenLimit = Math.max(1, this.lines.length - height - count);
		const index = this.#rng.int(1, Math.max(1, offscreenLimit));
		const removed = this.lines.splice(index, count);
		return { index, count: removed.length, firstRemoved: removed[0]?.text ?? null };
	}

	replaceAll(): JsonObject {
		const nextLength = this.#rng.int(this.minLines, this.minLines + 40);
		this.lines.splice(0, this.lines.length, ...this.#newLines(nextLength, "r"));
		return { nextLength };
	}

	toggleCollapsible(): JsonObject {
		if (this.#collapsibleIds.length > 0) {
			const ids = new Set(this.#collapsibleIds);
			const before = this.lines.length;
			for (let i = this.lines.length - 1; i >= 0; i--) {
				const line = this.lines[i];
				if (line && ids.has(line.id)) {
					this.lines.splice(i, 1);
				}
			}
			const removed = before - this.lines.length;
			this.#collapsibleIds = [];
			if (removed > 0) {
				return { expanded: false, removed };
			}
		}

		const block = this.#uniqueContent
			? [this.#freshLine("blk0"), this.#freshLine("blk1"), this.#freshLine("blk2"), this.#freshLine("blk3")]
			: [
					this.#line(styledText("blk0", 35)),
					this.#line(wideText("blk1")),
					this.#line(linkedText("blk2")),
					this.#line(longText("blk3", 3)),
				];
		this.#collapsibleIds = block.map(line => line.id);
		const index = Math.min(2, this.lines.length);
		this.lines.splice(index, 0, ...block);
		return { expanded: true, inserted: block.length, index };
	}

	tickStatusHeader(): JsonObject {
		const before = this.lines[0]?.text ?? "";
		this.lines[0] = this.#freshLine("h");
		return { index: 0, before, after: this.lines[0]?.text ?? "" };
	}

	rotateUp(): JsonObject {
		if (this.lines.length < 2) {
			this.lines.push(this.#freshLine("t"));
			return { dropped: null, appended: this.lines[this.lines.length - 1]?.text ?? "" };
		}
		const dropped = this.lines.shift();
		this.lines.push(this.#randomLine("t"));
		return { dropped: dropped?.text ?? null, appended: this.lines[this.lines.length - 1]?.text ?? "" };
	}

	collapseToFew(): JsonObject {
		const nextLength = this.#rng.int(0, 2);
		this.lines.splice(0, this.lines.length, ...this.#newLines(nextLength, "c"));
		return { nextLength };
	}

	clear(): JsonObject {
		const previousLength = this.lines.length;
		this.lines.splice(0, this.lines.length);
		return { previousLength };
	}

	appendCount(count: number, prefix: string): JsonObject {
		this.lines.push(...this.#newLines(count, prefix));
		return { count };
	}

	beginHighWaterPreview(height: number): JsonObject {
		while (this.lines.length < height + 8) {
			this.lines.push(this.#freshLine("seed"));
		}
		const start = this.lines.length;
		const count = this.#rng.int(height + 4, height + 14);
		for (let i = 0; i < count; i++) {
			this.lines.push(this.#freshLine("preview"));
		}
		return { start, count };
	}

	collapseHighWaterPreview(start: number, count: number): JsonObject {
		const removed = this.lines.splice(start, count);
		this.#ensureLine();
		const editedIndex = this.lines.length - 1;
		const before = this.lines[editedIndex]?.text ?? "";
		this.lines[editedIndex] = this.#freshLine("done");
		return { start, count: removed.length, editedIndex, before, after: this.lines[editedIndex]?.text ?? "" };
	}

	swapOffscreenRows(height: number): JsonObject {
		const offscreenLimit = this.lines.length - height;
		if (offscreenLimit < 2) return { swapped: 0 };
		const i = this.#rng.int(0, offscreenLimit - 1);
		let j = this.#rng.int(0, offscreenLimit - 1);
		if (j === i) j = (j + 1) % offscreenLimit;
		const a = this.lines[i]!;
		const b = this.lines[j]!;
		this.lines[i] = b;
		this.lines[j] = a;
		return { swapped: 2, i, j };
	}

	#initialText(index: number): string {
		if (this.#uniqueContent) return index % 13 === 0 ? "" : `${this.#labelPrefix}init${index.toString(36)}`;
		if (index % 13 === 0) return "";
		if (index % 37 === 0) return backgroundStyledText(`bg${index.toString(36)}`, 41 + (index % 6));
		if (index % 31 === 0) return emojiPresentationText(`ep${index.toString(36)}`);
		if (index % 29 === 0) return arabicCombiningText(`ar${index.toString(36)}`);
		if (index % 23 === 0) return longText(`L${index.toString(36)}`, 4);
		if (index % 19 === 0) return linkedText(`link${index.toString(36)}`);
		if (index % 17 === 0) return styledText(`sg${index.toString(36)}界`, 31 + (index % 6));
		if (index % 11 === 0) return wideText(`w${index.toString(36)}`);
		if (index % 7 === 0) return `r${index % 3}`;
		return `l${index.toString(36)}`;
	}

	#newLines(count: number, prefix: string): LogicalLine[] {
		const lines: LogicalLine[] = [];
		for (let i = 0; i < count; i++) {
			lines.push(this.#randomLine(prefix));
		}
		return lines;
	}

	#randomLine(prefix: string): LogicalLine {
		if (this.#uniqueContent) return this.#freshLine(prefix);
		const roll = this.#rng.next();
		if (roll < 0.1) return this.#line("");
		if (roll < 0.2) return this.#line(`r${this.#rng.int(0, 3)}`);
		if (roll < 0.34 && this.lines.length > 0) {
			const source = this.lines[this.#rng.int(0, this.lines.length - 1)];
			return this.#line(source?.text ?? "");
		}
		return this.#freshLine(prefix);
	}

	#freshLine(prefix: string): LogicalLine {
		for (;;) {
			const id = this.#nextId.toString(36);
			const text = randomDecoratedText(this.#rng, `${this.#labelPrefix}${prefix}${id}`);
			if (!this.#uniqueContent || text.length === 0 || !this.#usedText.has(text)) return this.#line(text);
			this.#nextId += 1;
		}
	}

	#ensureLine(): void {
		if (this.lines.length === 0) {
			this.lines.push(this.#freshLine("q"));
		}
	}

	#setCursor(index: number, width: number, offscreen: boolean): JsonObject {
		const clampedIndex = Math.max(0, Math.min(index, this.lines.length - 1));
		const text = this.lines[clampedIndex]?.text ?? "";
		const mode = pickCursorMode(this.#rng, text, width);
		this.#cursorLineIndex = clampedIndex;
		this.#cursorMode = mode;
		return { index: clampedIndex, mode, offscreen, text };
	}

	#clampedCursorLineIndex(): number {
		if (this.lines.length === 0) return 0;
		if (this.#cursorLineIndex === null) return this.lines.length - 1;
		return Math.max(0, Math.min(this.#cursorLineIndex, this.lines.length - 1));
	}

	#line(text: string): LogicalLine {
		const line = { id: this.#nextId, text };
		this.#nextId += 1;
		if (text.length > 0) this.#usedText.add(text);
		return line;
	}
}

// Wrap a rendered line set to the viewport width, ANSI- and grapheme-aware, so
// a logical line can occupy a width-dependent NUMBER of physical rows — the
// reflow that real wrapped/markdown content performs and that fixed-line
// components never exercised. Use the renderer's native wrapper rather than
// Bun.wrapAnsi so combining marks stay with their base grapheme instead of
// starting a physical row the terminal will fold back into the previous cell.
export function reflowToWidth(lines: readonly string[], width: number): string[] {
	const target = Math.max(1, width);
	const out: string[] = [];
	for (const line of lines) {
		if (line.length === 0) {
			out.push("");
			continue;
		}
		for (const physical of wrapTextWithAnsi(line, target)) out.push(physical);
	}
	return out;
}
