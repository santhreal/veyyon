export const PASTE_START = "\x1b[200~";

export const PASTE_END = "\x1b[201~";

export type PasteResult =
	| { handled: false }
	| {
			handled: true;
			prefix?: string;
			pasteContent?: string;
			remaining: string;
	  };

const REENCODED_CTRL_CSI_U = /\x1b\[(\d+);5u/g;
const REENCODED_CTRL_XTERM = /\x1b\[27;5;(\d+)~/g;

function decodeReencodedCtrlByte(match: string, code: string): string {
	const cp = Number(code);
	if (cp >= 97 && cp <= 122) return String.fromCharCode(cp - 96); // a-z → Ctrl+A..Ctrl+Z
	if (cp >= 65 && cp <= 90) return String.fromCharCode(cp - 64); // A-Z → Ctrl+A..Ctrl+Z
	return match;
}

export function decodeReencodedPasteControls(text: string): string {
	return text
		.replace(REENCODED_CTRL_CSI_U, decodeReencodedCtrlByte)
		.replace(REENCODED_CTRL_XTERM, decodeReencodedCtrlByte);
}

export type BracketedPasteHandlerOptions = {
	byteLimit?: number;
};

export const PASTE_MAX_BYTES = 64 * 1024 * 1024;

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
