import { getSegmenter } from "../utils";

export const segmenter = getSegmenter();

export interface InputState {
	value: string;
	cursor: number;
}

export const DEFAULT_MASK_CHAR = "•";

export function maskValue(value: string, cursor: number, maskChar: string): { value: string; cursor: number } {
	let masked = "";
	let maskedCursor = 0;
	for (const { index } of segmenter.segment(value)) {
		if (index < cursor) maskedCursor += maskChar.length;
		masked += maskChar;
	}
	return { value: masked, cursor: Math.min(maskedCursor, masked.length) };
}
