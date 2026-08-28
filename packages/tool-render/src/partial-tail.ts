import { AnsiStripper } from "@veyyon/utils/strip-ansi";
import { replaceTabs } from "./util";

export const VISIBLE_CHARS = 2048;

export class PartialTail {
	#stripper = new AnsiStripper();
	#raw = "";
	#settled = "";
	#dropped = false;

	push(raw: string): void {
		if (raw === this.#raw) return;
		if (!raw.startsWith(this.#raw)) this.#restart();
		const delta = raw.slice(this.#raw.length);
		this.#raw = raw;
		this.#settled += replaceTabs(this.#stripper.push(delta));
		if (this.#settled.length <= VISIBLE_CHARS) return;
		this.#settled = this.#settled.slice(-VISIBLE_CHARS);
		this.#dropped = true;
	}

	get text(): string {
		const shown = this.#settled + replaceTabs(this.#stripper.pending);
		if (shown.length <= VISIBLE_CHARS) return this.#dropped ? `…${shown}` : shown;
		return `…${shown.slice(-VISIBLE_CHARS)}`;
	}

	get retained(): number {
		return this.#settled.length + this.#stripper.held;
	}

	#restart(): void {
		this.#stripper = new AnsiStripper();
		this.#raw = "";
		this.#settled = "";
		this.#dropped = false;
	}
}
