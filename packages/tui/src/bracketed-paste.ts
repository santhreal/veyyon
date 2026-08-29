export const PASTE_START = "\x1b[200~";

import type { BracketedPasteHandlerOptions, PasteResult } from "./bracketed-paste-helpers";
import { PASTE_END, PASTE_MAX_BYTES } from "./bracketed-paste-helpers";

export { decodeReencodedPasteControls } from "./bracketed-paste-helpers";
export type { PasteResult };
export { PASTE_END, PASTE_MAX_BYTES };

export class BracketedPasteHandler {
	#buffer = "";
	#active = false;
	readonly #byteLimit: number;

	constructor(options: BracketedPasteHandlerOptions = {}) {
		this.#byteLimit = options.byteLimit ?? PASTE_MAX_BYTES;
	}

	process(data: string): PasteResult {
		let prefix: string | undefined;

		const startIndex = data.indexOf(PASTE_START);
		if (startIndex !== -1) {
			if (startIndex > 0) prefix = data.slice(0, startIndex);
			this.#active = true;
			this.#buffer = "";
			data = data.slice(startIndex + PASTE_START.length);
		}

		if (!this.#active) return { handled: false };

		this.#buffer += data;

		const endIndex = this.#buffer.indexOf(PASTE_END);
		if (endIndex !== -1) {
			const pasteContent = this.#buffer.substring(0, endIndex);
			const remaining = this.#buffer.substring(endIndex + PASTE_END.length);

			this.#buffer = "";
			this.#active = false;

			return { handled: true, prefix, pasteContent, remaining };
		}

		if (this.#buffer.length > this.#byteLimit) {
			const pasteContent = this.#buffer;
			this.#buffer = "";
			this.#active = false;
			return { handled: true, prefix, pasteContent, remaining: "" };
		}

		return { handled: true, prefix, remaining: "" };
	}
}
