import { sgrSequence } from "@veyyon/tui/ansi";

/**
 * Columns the composer indents its prompt glyph by.
 *
 * `COMPOSER_INSET_COLS` in `packages/coding-agent/src/modes/components/composer-chrome.ts`
 * is the single definition of this value for the renderer. This package cannot import it
 * without depending on the application it inspects, so the value is restated here and the
 * two are pinned equal by
 * `packages/coding-agent/test/the-oracle-inset-matches-the-composer-it-inspects.test.ts`.
 * A frame state may override it through `insetCols` when a mount indents differently.
 */
export const DEFAULT_COMPOSER_INSET_COLS = 2;

const PROMPT_GLYPHS = ["›", "!", "$", "◈", ">"] as const;

/**
 * The prompt glyphs that also open an ordinary transcript row: a shell command,
 * a markdown blockquote, a CSS rule. `›` and `◈` open none, so only these need
 * the composer's inset before they count as a prompt.
 */
const AMBIGUOUS_PROMPT_GLYPHS = new Set(["!", "$", ">"]);

const SGR = sgrSequence("g");

/**
 * Whether a raw terminal line paints a background anywhere in it.
 *
 * Walks the SGR parameter list instead of pattern-matching its text. The `4`-prefixed spelling
 * this replaced read `ESC [ 4 m` (underline) and `ESC [ 49 m` (background reset) as fills, missed
 * the bright backgrounds 100-107, and missed a truecolor background written with colon
 * subparameters, because a background is a parameter value rather than a text shape.
 */
export function paintsBackground(rawLine: string): boolean {
	SGR.lastIndex = 0;
	for (let match = SGR.exec(rawLine); match !== null; match = SGR.exec(rawLine)) {
		const params = match[1] ?? "";
		const parts = params.length > 0 ? params.split(";") : [];
		for (let index = 0; index < parts.length; index += 1) {
			const part = parts[index] ?? "";
			const code = Number(part.split(":")[0]);
			if (code === 48 || (code >= 40 && code <= 47) || (code >= 100 && code <= 107)) return true;
			// Skip an extended foreground or underline colour so its subparameters are not
			// misread as background codes: `38;5;41` selects a foreground, not background 41.
			if (code === 38 || code === 58) {
				if (part.includes(":")) continue;
				const selector = Number(parts[index + 1]);
				if (selector === 2) index += 4;
				else if (selector === 5) index += 2;
				else index += 1;
			}
		}
	}
	return false;
}

/**
 * Check if a line is a composer prompt row.
 *
 * `expectedGlyph` is the glyph the frame states the composer painted. When it is
 * given, only it counts. The wider `PROMPT_GLYPHS` set exists for a frame that
 * does not say, and three of its members — `!`, `$` and `>` — open ordinary
 * transcript rows: a shell command, a markdown blockquote, a CSS rule. Matching
 * the whole set against a known glyph counted those as extra prompt rows and
 * reported a composer defect that the frame does not contain.
 */
export function isComposerPromptLine(
	plainLine: string,
	expectedGlyph?: string,
	insetCols: number = DEFAULT_COMPOSER_INSET_COLS,
): boolean {
	const trimmedLeading = plainLine.trimStart();
	if (trimmedLeading.length === 0) return false;
	const leadingSpaces = plainLine.length - trimmedLeading.length;
	const glyphs: readonly string[] = expectedGlyph ? [expectedGlyph] : PROMPT_GLYPHS;
	const glyph = glyphs.find(g => trimmedLeading.startsWith(g));
	if (glyph === undefined) return false;

	// A narrow terminal collapses the inset, so an unambiguous glyph counts at any
	// column. `!`, `$` and `>` are ASCII that opens ordinary transcript rows, so
	// they count only where the composer would actually paint them.
	return leadingSpaces >= insetCols || !AMBIGUOUS_PROMPT_GLYPHS.has(glyph);
}

/** Check if a line is a hairline row (consisting of box drawing horizontal line chars) */
export function isHairlineLine(plainLine: string): boolean {
	const trimmed = plainLine.trim();
	if (trimmed.length < 3) return false;
	const barChars = ["─", "━", "-"];
	let barCount = 0;
	for (const char of trimmed) {
		if (barChars.includes(char)) barCount++;
	}
	return barCount >= trimmed.length * 0.7;
}
