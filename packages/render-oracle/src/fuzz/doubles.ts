import type { Component } from "@veyyon/tui/tui";
import { VirtualTerminal } from "../terminal/virtual-terminal";

export class UnknownViewportTerminal extends VirtualTerminal {
	isNativeViewportAtBottom(): undefined {
		return undefined;
	}
}

export class IntermittentUnknownViewportTerminal extends VirtualTerminal {
	#probeCount = 0;

	isNativeViewportAtBottom(): boolean | undefined {
		this.#probeCount += 1;
		return this.#probeCount % 3 === 0 ? undefined : super.isNativeViewportAtBottom();
	}
}

export class StaleBottomTerminal extends VirtualTerminal {
	#previous: boolean | undefined;
	#returnStale = false;

	isNativeViewportAtBottom(): boolean | undefined {
		const current = super.isNativeViewportAtBottom();
		if (this.#returnStale) {
			this.#returnStale = false;
			const stale = this.#previous;
			this.#previous = current;
			return stale;
		}
		this.#returnStale = true;
		this.#previous = current;
		return current;
	}
}

export class MutableLinesComponent implements Component {
	#lines: string[];

	constructor(lines: readonly string[]) {
		this.#lines = [...lines];
	}

	setLines(lines: readonly string[]): void {
		this.#lines = [...lines];
	}

	invalidate(): void {}

	render(_width: number): string[] {
		return [...this.#lines];
	}
}
