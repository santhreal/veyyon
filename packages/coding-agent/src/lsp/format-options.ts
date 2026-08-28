/** Per-file LSP `FormattingOptions` resolution. Replaces the historical hardcoded `{ tabSize: 3, insertSpaces: true }` default */
import { getEditorConfigFormatting } from "@veyyon/utils";

/** Subset of the LSP `FormattingOptions` we send. */
export interface LspFormattingOptions {
	tabSize: number;
	insertSpaces: boolean;
	trimTrailingWhitespace: boolean;
	insertFinalNewline: boolean;
	trimFinalNewlines: boolean;
}

/** Sensible fallback when neither `.editorconfig` nor file content pins the indent. */
const FALLBACK_TAB_SIZE = 2;
const FALLBACK_INSERT_SPACES = true;

/** Static flags we always pass — these have no per-file analogue and match common formatter expectations. */
const TRIM_OPTIONS = {
	trimTrailingWhitespace: true,
	insertFinalNewline: true,
	trimFinalNewlines: true,
} as const;

interface DetectedIndent {
	tabSize?: number;
	insertSpaces?: boolean;
}

/** Sniff `insertSpaces` and the indent unit from `content`. Walks the buffer once: the first indented line decides spaces vs tabs; for */
export function detectIndentFromContent(content: string): DetectedIndent {
	if (content.length === 0) return {};

	let insertSpaces: boolean | undefined;
	let unit = 0;

	// Split is the cheapest reliable line walk on arbitrary text; the
	// per-line regex matches are O(leading whitespace) so total cost is
	// linear in the file's indented prefix bytes.
	for (const line of content.split("\n")) {
		// Skip blank/whitespace-only lines — they carry no indent signal.
		if (line.length === 0 || line.trim().length === 0) continue;

		const first = line[0];
		if (first !== " " && first !== "\t") continue;

		if (insertSpaces === undefined) {
			insertSpaces = first === " ";
		}

		// Tab-indented file: the unit is one tab per level; tabSize is a
		// display concern, leave it to caller defaults / editorconfig.
		if (first === "\t") continue;

		// Space-indented: count the leading spaces (stop at first tab to avoid
		// mixing). GCD across non-zero widths converges on the stride.
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

/** Resolve the `FormattingOptions` payload for a `textDocument/formatting` request targeting `filePath` with `content`. */
export function resolveFormatOptions(filePath: string, content: string): LspFormattingOptions {
	const fromConfig = getEditorConfigFormatting(filePath);
	const detected = detectIndentFromContent(content);

	return {
		tabSize: fromConfig.tabSize ?? detected.tabSize ?? FALLBACK_TAB_SIZE,
		insertSpaces: fromConfig.insertSpaces ?? detected.insertSpaces ?? FALLBACK_INSERT_SPACES,
		...TRIM_OPTIONS,
	};
}
