import { makeExpander } from "./codec.js";
import { HANDLE_NAME_CHAR_RE } from "./constants.js";
import type { Vocabulary } from "./types.js";

function isNameChar(ch: string): boolean {
	return HANDLE_NAME_CHAR_RE.test(ch);
}

export class StreamDecoder {
	readonly #expand: (text: string) => string;
	readonly #sigil: string;
	readonly #maxNameLen: number;
	readonly #active: boolean;
	#held = "";

	constructor(vocab: Vocabulary) {
		this.#expand = makeExpander(vocab);
		this.#sigil = vocab.sigil;
		this.#active = vocab.handles.size > 0;
		let max = 0;
		for (const name of vocab.handles.keys()) {
			if (name.length > max) max = name.length;
		}
		this.#maxNameLen = max;
	}

	push(chunk: string): string {
		if (!this.#active) {
			return chunk;
		}
		if (chunk === "") {
			return "";
		}
		const buf = this.#held + chunk;
		const retain = this.#retainStart(buf);
		this.#held = buf.slice(retain);
		return this.#expand(buf.slice(0, retain));
	}

	flush(): string {
		const tail = this.#held;
		this.#held = "";
		if (!this.#active) {
			return tail;
		}
		return this.#expand(tail);
	}

	reset(): void {
		this.#held = "";
	}

	get pending(): string {
		return this.#held;
	}

	#retainStart(buf: string): number {
		let holdAt = buf.length;

		const sigilLen = this.#sigil.length;
		const lastSigil = buf.lastIndexOf(this.#sigil);
		if (lastSigil >= 0) {
			const tailStart = lastSigil + sigilLen;
			let allName = true;
			for (let k = tailStart; k < buf.length; k++) {
				if (!isNameChar(buf.charAt(k))) {
					allName = false;
					break;
				}
			}
			if (allName && buf.length - tailStart <= this.#maxNameLen) {
				holdAt = lastSigil;
			}
		}

		if (sigilLen > 1) {
			for (let k = sigilLen - 1; k >= 1; k--) {
				if (buf.endsWith(this.#sigil.slice(0, k))) {
					holdAt = Math.min(holdAt, buf.length - k);
					break;
				}
			}
		}

		return holdAt;
	}
}

export function makeStreamDecoder(vocab: Vocabulary): StreamDecoder {
	return new StreamDecoder(vocab);
}
