import type { Component, Focusable } from "@veyyon/tui/tui";
import { reflowToWidth, type StressModel } from "./model";
import type { Rng } from "./random";
import { insertCursorMarker, pickCursorMode, randomDecoratedText } from "./text";
import type { CursorMode, JsonObject, LogicalLine } from "./types";

export class StressComponent implements Component, Focusable {
	focused = false;
	#model: StressModel;
	#reflow: boolean;

	constructor(model: StressModel, reflow = false) {
		this.#model = model;
		this.#reflow = reflow;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines = this.#model.renderedLines(width, this.focused);
		return this.#reflow ? reflowToWidth(lines, width) : lines;
	}
}

export class StressOverlayModel {
	readonly lines: LogicalLine[] = [];
	readonly sentinel: string;
	#rng: Rng;
	#nextId = 0;
	#cursorLineIndex = 0;
	#cursorMode: CursorMode = "middle";

	constructor(rng: Rng, id: number) {
		this.#rng = rng;
		this.sentinel = `OV_SENTINEL_${id.toString(36)}_`;
		const count = rng.int(1, 5);
		this.lines.push(this.#line(`${this.sentinel}${randomDecoratedText(rng, `ov${id}-0`)}`));
		for (let i = 1; i < count; i++) {
			this.lines.push(this.#line(randomDecoratedText(rng, `ov${id}-${i}`)));
		}
	}

	renderedLines(width: number, focused = false): string[] {
		const lines = this.lines.map(line => line.text);
		if (!lines.some(line => line.includes(this.sentinel))) lines.unshift(this.sentinel);
		if (focused && lines.length > 0) {
			const index = this.#clampedCursorLineIndex();
			lines[index] = insertCursorMarker(lines[index] ?? "", this.#cursorMode, width);
		}
		return lines;
	}

	mutate(width: number): JsonObject {
		this.#ensureLine();
		const action = this.#rng.int(0, 3);
		if (action === 0 || this.lines.length === 1) {
			const line = this.#freshLine("oa");
			this.lines.push(line);
			return { action: "append", text: line.text };
		}
		if (action === 1) {
			const index = this.#rng.int(0, this.lines.length - 1);
			const before = this.lines[index]?.text ?? "";
			this.lines[index] = this.#freshLine("oe");
			return { action: "edit", index, before, after: this.lines[index]?.text ?? "" };
		}
		if (action === 2) {
			const index = this.#rng.int(0, this.lines.length - 1);
			const removed = this.lines.splice(index, 1);
			return { action: "delete", index, removed: removed[0]?.text ?? "" };
		}
		return { action: "cursor", ...this.setCursor(width) };
	}

	setCursor(width: number): JsonObject {
		this.#ensureLine();
		const index = this.#rng.int(0, this.lines.length - 1);
		const text = this.lines[index]?.text ?? "";
		const mode = pickCursorMode(this.#rng, text, width);
		this.#cursorLineIndex = index;
		this.#cursorMode = mode;
		return { index, mode, text };
	}

	debugLines(): string[] {
		return this.lines.map(line => `${line.id}:${JSON.stringify(line.text)}`);
	}

	#freshLine(prefix: string): LogicalLine {
		const id = this.#nextId.toString(36);
		return this.#line(randomDecoratedText(this.#rng, `${prefix}${id}`));
	}

	#ensureLine(): void {
		if (this.lines.length === 0) {
			this.lines.push(this.#freshLine("oq"));
		}
	}

	#clampedCursorLineIndex(): number {
		return Math.max(0, Math.min(this.#cursorLineIndex, this.lines.length - 1));
	}

	#line(text: string): LogicalLine {
		const line = { id: this.#nextId, text };
		this.#nextId += 1;
		return line;
	}
}

export class StressOverlayComponent implements Component, Focusable {
	focused = false;
	#model: StressOverlayModel;

	constructor(model: StressOverlayModel) {
		this.#model = model;
	}

	invalidate(): void {}

	render(width: number): string[] {
		return this.#model.renderedLines(width, this.focused);
	}
}
