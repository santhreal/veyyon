/**
 * Kitty's OSC 66 text-sizing protocol, as an encoder.
 *
 * Whether the terminal HONORS the sequence is a capability question and belongs to
 * `@veyyon/tui`; producing the bytes is string work and belongs here.
 */

export type TextSizingScale = 1 | 2 | 3;
export type TextSizingVerticalAlign = "top" | "bottom" | "center";
export type TextSizingHorizontalAlign = "left" | "right" | "center";

export interface TextSizingOptions {
	scale?: TextSizingScale;
	widthCells?: number;
	verticalAlign?: TextSizingVerticalAlign;
	horizontalAlign?: TextSizingHorizontalAlign;
}

const OSC66_UNSAFE = /[\x00-\x1f\x7f-\x9f]/u;
const OSC66_UNSAFE_GLOBAL = /[\x00-\x1f\x7f-\x9f]/gu;

function textSizingVerticalAlignValue(align: TextSizingVerticalAlign | undefined): number | undefined {
	switch (align) {
		case "top":
			return 0;
		case "bottom":
			return 1;
		case "center":
			return 2;
		default:
			return undefined;
	}
}

function textSizingHorizontalAlignValue(align: TextSizingHorizontalAlign | undefined): number | undefined {
	switch (align) {
		case "left":
			return 0;
		case "right":
			return 1;
		case "center":
			return 2;
		default:
			return undefined;
	}
}

/**
 * Encode a plain-text span using Kitty's OSC 66 text-sizing protocol. The TUI
 * emits only safe UTF-8 payloads and ST terminators so its ANSI parser and the
 * terminal agree on span boundaries.
 */
export function encodeTextSized(text: string, options: TextSizingOptions = {}): string {
	const metadata: string[] = [];
	if (options.scale !== undefined) metadata.push(`s=${options.scale}`);
	if (options.widthCells !== undefined && Number.isFinite(options.widthCells)) {
		metadata.push(`w=${Math.max(0, Math.trunc(options.widthCells))}`);
	}
	const verticalAlign = textSizingVerticalAlignValue(options.verticalAlign);
	if (verticalAlign !== undefined) metadata.push(`v=${verticalAlign}`);
	const horizontalAlign = textSizingHorizontalAlignValue(options.horizontalAlign);
	if (horizontalAlign !== undefined) metadata.push(`h=${horizontalAlign}`);

	const safeText = OSC66_UNSAFE.test(text) ? text.replace(OSC66_UNSAFE_GLOBAL, " ") : text;
	return `\x1b]66;${metadata.join(":")};${safeText}\x1b\\`;
}
