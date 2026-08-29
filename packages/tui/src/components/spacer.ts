import type { Component } from "../tui";

import { normalizeLineCount } from "./spacer-helpers";

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
