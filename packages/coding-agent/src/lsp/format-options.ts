import { getEditorConfigFormatting } from "@veyyon/utils";

export interface LspFormattingOptions {
	tabSize: number;
	insertSpaces: boolean;
	trimTrailingWhitespace: boolean;
	insertFinalNewline: boolean;
	trimFinalNewlines: boolean;
}

const FALLBACK_TAB_SIZE = 2;
const FALLBACK_INSERT_SPACES = true;

const TRIM_OPTIONS = {
	trimTrailingWhitespace: true,
	insertFinalNewline: true,
	trimFinalNewlines: true,
} as const;

interface DetectedIndent {
	tabSize?: number;
	insertSpaces?: boolean;
}

export function detectIndentFromContent(content: string): DetectedIndent {
	if (content.length === 0) return {};

	let insertSpaces: boolean | undefined;
	let unit = 0;

	for (const line of content.split("\n")) {
		if (line.length === 0 || line.trim().length === 0) continue;

		const first = line[0];
		if (first !== " " && first !== "\t") continue;

		if (insertSpaces === undefined) {
			insertSpaces = first === " ";
		}

		if (first === "\t") continue;

		let n = 0;
		while (n < line.length && line[n] === " ") n++;
		if (n === 0) continue;
		unit = unit === 0 ? n : gcd(unit, n);
	}

	const result: DetectedIndent = {};
	if (insertSpaces !== undefined) result.insertSpaces = insertSpaces;
	if (unit > 0 && insertSpaces === true) result.tabSize = unit;
	return result;
}

function gcd(a: number, b: number): number {
	let x = a;
	let y = b;
	while (y !== 0) {
		const t = y;
		y = x % y;
		x = t;
	}
	return x;
}

export function resolveFormatOptions(filePath: string, content: string): LspFormattingOptions {
	const fromConfig = getEditorConfigFormatting(filePath);
	const detected = detectIndentFromContent(content);

	return {
		tabSize: fromConfig.tabSize ?? detected.tabSize ?? FALLBACK_TAB_SIZE,
		insertSpaces: fromConfig.insertSpaces ?? detected.insertSpaces ?? FALLBACK_INSERT_SPACES,
		...TRIM_OPTIONS,
	};
}
