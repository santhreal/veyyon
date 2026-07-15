import type { Component } from "../tui";
import { clamp } from "../utils";

/**
 * Spacer component that renders empty lines
 */
/**
 * Coerce a requested line count to a safe array length. `render` builds
 * `new Array(#lines)`, which throws `RangeError` for a negative, fractional,
 * NaN, or out-of-range value — so a public caller passing a computed height
 * (e.g. `availableRows - usedRows` gone negative) would crash the render.
 * Clamp to a non-negative integer, matching ScrollView/Image height handling.
 */
function normalizeLineCount(lines: number): number {
	if (!Number.isFinite(lines)) return 0;
	return clamp(Math.trunc(lines), 0, MAX_SPACER_LINES);
}

// Far above any real layout; a spacer taller than this is a caller bug, not a
// legitimate request, and reserving it would waste memory in the render tree.
const MAX_SPACER_LINES = 1 << 16;

export class Spacer implements Component {
	#lines: number;
	#cached: string[] | undefined;

	constructor(lines: number = 1) {
		this.#lines = normalizeLineCount(lines);
	}

	setLines(lines: number): void {
		const normalized = normalizeLineCount(lines);
		if (normalized === this.#lines) return;
		this.#lines = normalized;
		this.#cached = undefined;
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(_width: number): readonly string[] {
		let cached = this.#cached;
		if (cached === undefined) {
			cached = new Array(this.#lines).fill("");
			this.#cached = cached;
		}
		return cached;
	}
}
