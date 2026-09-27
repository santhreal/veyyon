import { Tokenizer, type Tokens } from "marked";

const STRICT_STRIKETHROUGH_REGEX = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;

// The first line after the first that is a setext underline (capture 1) or
// whitespace only. A setext heading's text never crosses a whitespace-only
// line, and its underline is the line that follows the text, so when the first
// such line is blank no heading opens at the start of the source.
const SETEXT_UNDERLINE_OR_BLANK_LINE = /\n(?:( {0,3}(?:=+|-+) *)|[^\S\n]*)(?:\n|$)/;

/**
 * marked's tokenizer with two rules replaced:
 *
 * - `~~text~~` is strikethrough only when each delimiter is exactly two tildes
 *   and the text neither starts nor ends with whitespace, so a stray `~` pair
 *   in prose stays literal.
 * - The setext heading rule runs only when an underline precedes the first
 *   blank line. marked tries it before every paragraph and walks the paragraph
 *   one character at a time testing each line break against every block that
 *   can interrupt it; that walk was a quarter of a transcript render. The
 *   precheck admits every source the rule matches, so the tokens are marked's.
 */
export class MarkdownTokenizer extends Tokenizer {
	override del(src: string): Tokens.Del | undefined {
		const match = STRICT_STRIKETHROUGH_REGEX.exec(src);
		if (!match) {
			return undefined;
		}

		const text = match[2];
		return {
			type: "del",
			raw: match[0],
			text,
			tokens: this.lexer.inlineTokens(text),
		};
	}

	override lheading(src: string): Tokens.Heading | undefined {
		if (SETEXT_UNDERLINE_OR_BLANK_LINE.exec(src)?.[1] === undefined) return undefined;
		return super.lheading(src);
	}
}
