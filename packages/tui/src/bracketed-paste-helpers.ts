export const PASTE_END = "\x1b[201~";

export type PasteResult =
	| { handled: false }
	| {
			handled: true;
			prefix?: string;
			pasteContent?: string;
			remaining: string;
	  };

export const REENCODED_CTRL_CSI_U = /\x1b\[(\d+);5u/g;
export const REENCODED_CTRL_XTERM = /\x1b\[27;5;(\d+)~/g;

export function decodeReencodedCtrlByte(match: string, code: string): string {
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
