const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

import type { FencedThinkingResult } from "./fenced-thinking-helpers";
import { BACKTICK_LEAD, LANG_TOKEN } from "./fenced-thinking-helpers";

export class FencedThinkingScanner {
	#buffer = "";
	#inner = "";
	#emitted = 0;

	feed(text: string, final: boolean): FencedThinkingResult {
		this.#buffer += text;
		let thinking = "";
		for (;;) {
			const nl = this.#buffer.indexOf("\n");
			if (nl === -1) break;
			const line = this.#buffer.slice(0, nl);
			if (!this.#inner) {
				const close = this.#closeRest(line);
				if (close !== undefined) {
					const rest = close + this.#buffer.slice(nl); // keep the newline with the reply
					this.#reset();
					return { thinking, closed: true, rest };
				}
			}
			thinking += this.#buffer.slice(this.#emitted, nl + 1);
			this.#updateInner(line);
			this.#buffer = this.#buffer.slice(nl + 1);
			this.#emitted = 0;
		}

		const tail = this.#buffer;
		if (this.#inner) {
			thinking += tail.slice(this.#emitted);
			this.#emitted = tail.length;
			return { thinking, closed: false, rest: "" };
		}

		if (final) {
			const close = this.#closeRestFinal(tail);
			if (close !== undefined) {
				this.#reset();
				return { thinking, closed: true, rest: close };
			}
		} else {
			const close = this.#closeRestStreamingTail(tail);
			if (close !== undefined) {
				this.#reset();
				return { thinking, closed: true, rest: close };
			}
			if (this.#mustHold(tail)) return { thinking, closed: false, rest: "" };
		}
		thinking += tail.slice(this.#emitted);
		if (final) this.#reset();
		else this.#emitted = tail.length;
		return { thinking, closed: false, rest: "" };
	}

	#closeRest(line: string): string | undefined {
		const m = BACKTICK_LEAD.exec(line);
		if (!m || m[1]!.length < 3) return undefined;
		const rest = m[2]!;
		if (rest === "" || rest.trim() === "") return ""; // bare close (only whitespace)
		if (LANG_TOKEN.test(rest)) return undefined; // language-tagged inner opener
		return rest;
	}

	#closeRestFinal(tail: string): string | undefined {
		const m = BACKTICK_LEAD.exec(tail);
		if (!m || m[1]!.length < 3) return undefined;
		const rest = m[2]!;
		return rest.trim() === "" ? "" : rest;
	}

	#closeRestStreamingTail(tail: string): string | undefined {
		const m = BACKTICK_LEAD.exec(tail);
		if (!m || m[1]!.length < 3) return undefined;
		const rest = m[2]!;
		if (rest === "" || rest.trim() === "" || LANG_TOKEN.test(rest)) return undefined;
		return rest;
	}

	#mustHold(tail: string): boolean {
		const m = BACKTICK_LEAD.exec(tail);
		if (!m) return false;
		const ticks = m[1]!.length;
		const rest = m[2]!;
		if (rest === "" || rest.trim() === "") return ticks >= 1 || /^ {0,3}$/.test(tail);
		return ticks >= 3 && LANG_TOKEN.test(rest);
	}

	#reset(): void {
		this.#buffer = "";
		this.#inner = "";
		this.#emitted = 0;
	}

	#updateInner(line: string): void {
		const fence = FENCE_LINE.exec(line);
		if (!fence) return;
		const run = fence[1]!;
		const info = fence[2]!.trim();
		if (!this.#inner) {
			this.#inner = run;
		} else if (run[0] === this.#inner[0] && run.length >= this.#inner.length && info === "") {
			this.#inner = "";
		}
	}
}
