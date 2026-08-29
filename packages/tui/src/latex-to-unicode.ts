import { SGR_FG_RESET } from "./ansi";
import type { AnsiColor, Argument, FontStyle } from "./latex-to-unicode-helpers";

import {
	ACCENTS,
	ansiColor,
	applyCombining,
	BIG_DELIM,
	codePointLength,
	ENV_DELIMS,
	EXTENSIBLE_ARROWS,
	FONTS,
	FUNCTIONS,
	NOT_MAP,
	PRIMES,
	restoreAnsi,
	SYMBOLS,
	styleChar,
	TEXT_COMMANDS,
	toSubscript,
	toSuperscript,
	unescapeText,
	VULGAR,
} from "./latex-to-unicode-helpers";

export { latexColorScope, MATH_FONT_COMMANDS } from "./latex-to-unicode-helpers";

class LatexParser {
	#s: string;
	#i = 0;
	#foreground: string | null = null;
	#background: string | null = null;
	#depth = 0;
	static readonly #MAX_DEPTH = 500;

	constructor(src: string, startDepth = 0) {
		this.#s = src;
		this.#depth = startDepth;
	}

	#literalRun(stopAtBrace: boolean): string {
		let out = "";
		while (this.#i < this.#s.length) {
			const c = this.#s[this.#i];
			if (c === "}" && stopAtBrace) break;
			this.#i++;
			out += c;
		}
		return out;
	}

	render(): string {
		return restoreAnsi(this.parse(null, false), this.#foreground, null, this.#background, null);
	}

	parse(style: FontStyle | null, stopAtBrace: boolean): string {
		if (this.#depth >= LatexParser.#MAX_DEPTH) return this.#literalRun(stopAtBrace);
		this.#depth++;
		let out = "";
		while (this.#i < this.#s.length) {
			const c = this.#s[this.#i];
			if (c === "}") {
				if (stopAtBrace) break;
				this.#i++; // stray close brace
				continue;
			}
			out += this.#node(style);
		}
		this.#depth--;
		return out;
	}

	#node(style: FontStyle | null): string {
		const c = this.#s[this.#i];
		switch (c) {
			case "\\":
				return this.#command(style);
			case "{":
				return this.#group(style);
			case "^":
				this.#i++;
				return this.#script(style, true);
			case "_":
				this.#i++;
				return this.#script(style, false);
			case "$":
				this.#i++;
				return ""; // stray delimiter
			case "~":
				this.#i++;
				return " "; // non-breaking space
			case "&":
				this.#i++;
				return "  "; // column separator
			case "'": {
				let k = 0;
				while (this.#s[this.#i] === "'") {
					k++;
					this.#i++;
				}
				return k <= 4 ? PRIMES[k] : PRIMES[1].repeat(k);
			}
			case "%": {
				const nl = this.#s.indexOf("\n", this.#i);
				this.#i = nl === -1 ? this.#s.length : nl + 1;
				return "";
			}
			default:
				this.#i++;
				return styleChar(c, style);
		}
	}

	#command(style: FontStyle | null): string {
		this.#i++; // past backslash
		if (this.#i >= this.#s.length) return "";
		const c = this.#s[this.#i];
		if (!/[A-Za-z]/.test(c)) {
			this.#i++;
			switch (c) {
				case "\\":
					return "\n"; // row break
				case "{":
				case "}":
				case "$":
				case "%":
				case "&":
				case "#":
				case "_":
				case " ":
				case ".":
					return c;
				case ",":
				case ":":
				case ";":
				case ">":
					return " "; // spacing
				case "!":
					return ""; // negative thin space
				case "/":
					return ""; // italic correction
				case "|":
					return "‖";
				case "(":
				case ")":
				case "[":
				case "]":
					return ""; // bare math delimiters that slipped through
				default:
					return c;
			}
		}
		let name = "";
		while (this.#i < this.#s.length && /[A-Za-z]/.test(this.#s[this.#i])) {
			name += this.#s[this.#i];
			this.#i++;
		}
		if (this.#s[this.#i] === "*") this.#i++; // starred variants (operatorname*, …)
		return this.#applyCommand(name, style);
	}

	#applyCommand(name: string, style: FontStyle | null): string {
		const font = FONTS[name];
		if (font) return this.#argument(font).text;

		if (TEXT_COMMANDS[name]) return unescapeText(this.#rawArgument());

		if (name === "operatorname") {
			const fn = unescapeText(this.#rawArgument());
			return fn + this.#spaceBeforeArg();
		}

		const accent = ACCENTS[name];
		if (accent) return applyCombining(this.#argument(style).text, accent);

		if (name === "frac" || name === "dfrac" || name === "tfrac" || name === "cfrac") {
			const num = this.#argument(style);
			const den = this.#argument(style);
			return this.#fraction(num, den);
		}

		if (name === "genfrac") {
			const left = this.#argument(style).text;
			const right = this.#argument(style).text;
			this.#rawArgument(); // rule thickness
			this.#rawArgument(); // math style
			const num = this.#argument(style);
			const den = this.#argument(style);
			return left + this.#fraction(num, den) + right;
		}

		if (name === "binom" || name === "dbinom" || name === "tbinom") {
			const n = this.#argument(style);
			const k = this.#argument(style);
			return `C(${n.text}, ${k.text})`;
		}

		if (name === "sqrt") return this.#sqrt(style);

		if (name === "not") {
			const arg = this.#argument(style);
			return NOT_MAP[arg.text] ?? applyCombining(arg.text, "\u0338");
		}

		if (name === "overset" || name === "stackrel") return this.#scriptedAbove(style);
		if (name === "underset") return this.#scriptedBelow(style);
		if (name === "prescript") return this.#prescript(style);

		const arrow = EXTENSIBLE_ARROWS[name];
		if (arrow !== undefined) return this.#extensibleArrow(style, arrow);

		if (name === "boxed" || name === "fbox") return `[${this.#argument(style).text}]`;
		if (name === "overbrace") return `⏞(${this.#argument(style).text})`;
		if (name === "underbrace") return `⏟(${this.#argument(style).text})`;
		if (name === "overbracket") return `⎴(${this.#argument(style).text})`;
		if (name === "underbracket") return `⎵(${this.#argument(style).text})`;
		if (name === "overparen") return `⏜(${this.#argument(style).text})`;
		if (name === "underparen") return `⏝(${this.#argument(style).text})`;
		if (name === "cancel") return applyCombining(this.#argument(style).text, "\u0338");
		if (name === "bcancel") return applyCombining(this.#argument(style).text, "\u20E5");
		if (name === "xcancel") return applyCombining(applyCombining(this.#argument(style).text, "\u0338"), "\u20E5");
		if (name === "sout") return applyCombining(this.#argument(style).text, "\u0336");
		if (name === "substack") return this.#argument(style).text.replace(NEWLINES, ",");

		if (name === "left" || name === "right" || name === "middle") return this.#delimiter(style);

		if (BIG_DELIM.test(name)) return this.#delimiter(style); // \big \Bigl \Biggr …

		if (name === "begin") return this.#environment(style);
		if (name === "end") {
			this.#rawArgument();
			return "";
		}

		if (name === "bmod") return " mod ";
		if (name === "pmod") return `(mod ${this.#argument(style).text})`;
		if (name === "pod") return `(${this.#argument(style).text})`;
		if (name === "tag") return `(${this.#argument(style).text})`;
		if (name === "label") {
			this.#rawArgument();
			return "";
		}
		if (name === "ref" || name === "eqref") return `(${unescapeText(this.#rawArgument())})`;
		if (name === "url") return unescapeText(this.#rawArgument());
		if (name === "href") {
			this.#rawArgument();
			return this.#argument(style).text;
		}
		if (name === "textcolor") return this.#scopedForeground(this.#readAnsiColor(), style);
		if (name === "colorbox") return this.#scopedBackground(this.#readAnsiColor(), style);
		if (name === "fcolorbox") return this.#fcolorbox(style);
		if (name === "color") return this.#setForeground();
		if (name === "normalcolor") {
			const previous = this.#foreground;
			this.#foreground = null;
			return previous === null ? "" : SGR_FG_RESET;
		}
		if (name === "phantom" || name === "hphantom") {
			return " ".repeat(codePointLength(this.#argument(style).text));
		}
		if (name === "vphantom") {
			this.#argument(style);
			return "";
		}

		if (FUNCTIONS[name]) return name + this.#spaceBeforeArg();

		const symbol = SYMBOLS[name];
		if (symbol !== undefined) return symbol;

		switch (name) {
			case "displaystyle":
			case "textstyle":
			case "scriptstyle":
			case "scriptscriptstyle":
			case "limits":
			case "nolimits":
			case "nonumber":
			case "notag":
			case "quad":
				return name === "quad" ? "  " : "";
			case "qquad":
				return "    ";
			case "thinspace":
			case "enspace":
			case "medspace":
			case "thickspace":
			case "space":
				return " ";
			case "negthinspace":
			case "negmedspace":
			case "negthickspace":
				return "";
		}

		return name;
	}

	#group(style: FontStyle | null): string {
		this.#i++;
		const outerForeground = this.#foreground;
		const outerBackground = this.#background;
		const inner = this.parse(style, true);
		const innerForeground = this.#foreground;
		const innerBackground = this.#background;
		if (this.#s[this.#i] === "}") this.#i++;
		this.#foreground = outerForeground;
		this.#background = outerBackground;
		return restoreAnsi(inner, innerForeground, outerForeground, innerBackground, outerBackground);
	}

	#readAnsiColor(): AnsiColor | null {
		const model = this.#optionalRawArgument();
		return ansiColor(model, this.#rawArgument());
	}

	#setForeground(): string {
		const color = this.#readAnsiColor();
		if (color === null) return "";
		this.#foreground = color.foreground;
		return color.foreground;
	}

	#scopedForeground(color: AnsiColor | null, style: FontStyle | null): string {
		const outerForeground = this.#foreground;
		if (color === null) return this.#argument(style).text;
		this.#foreground = color.foreground;
		const arg = this.#argument(style).text;
		const innerForeground = this.#foreground;
		this.#foreground = outerForeground;
		return color.foreground + restoreAnsi(arg, innerForeground, outerForeground, this.#background, this.#background);
	}

	#scopedBackground(color: AnsiColor | null, style: FontStyle | null): string {
		const outerBackground = this.#background;
		if (color === null) return this.#argument(style).text;
		this.#background = color.background;
		const arg = this.#argument(style).text;
		const innerBackground = this.#background;
		this.#background = outerBackground;
		return color.background + restoreAnsi(arg, this.#foreground, this.#foreground, innerBackground, outerBackground);
	}

	#fcolorbox(style: FontStyle | null): string {
		const frameModel = this.#optionalRawArgument();
		const frame = ansiColor(frameModel, this.#rawArgument());
		const backgroundModel = this.#optionalRawArgument() ?? frameModel;
		const background = ansiColor(backgroundModel, this.#rawArgument());
		const body = this.#scopedBackground(background, style);
		if (frame === null) return `[${body}]`;
		return `${frame.foreground}[${this.#foreground ?? SGR_FG_RESET}${body}${frame.foreground}]${this.#foreground ?? SGR_FG_RESET}`;
	}

	#argument(style: FontStyle | null): Argument {
		while (this.#s[this.#i] === " ") this.#i++;
		const c = this.#s[this.#i];
		if (c === undefined) return { text: "", group: false };
		if (this.#depth >= LatexParser.#MAX_DEPTH) {
			if (c === "{") {
				this.#i++;
				const inner = this.#literalRun(true);
				if (this.#s[this.#i] === "}") this.#i++;
				return { text: inner, group: true };
			}
			this.#i++;
			return { text: c, group: false };
		}
		this.#depth++;
		try {
			if (c === "{") {
				this.#i++;
				const inner = this.parse(style, true);
				if (this.#s[this.#i] === "}") this.#i++;
				return { text: inner, group: true };
			}
			if (c === "\\") return { text: this.#command(style), group: false };
			if (c === "^" || c === "_") {
				this.#i++;
				return { text: this.#script(style, c === "^"), group: false };
			}
			this.#i++;
			return { text: styleChar(c, style), group: false };
		} finally {
			this.#depth--;
		}
	}

	#rawArgument(): string {
		while (this.#s[this.#i] === " ") this.#i++;
		if (this.#s[this.#i] !== "{") {
			const c = this.#s[this.#i];
			if (c === undefined) return "";
			if (c === "\\") {
				let t = "\\";
				this.#i++;
				if (/[A-Za-z]/.test(this.#s[this.#i] ?? "")) {
					while (/[A-Za-z]/.test(this.#s[this.#i] ?? "")) {
						t += this.#s[this.#i];
						this.#i++;
					}
				} else {
					t += this.#s[this.#i] ?? "";
					this.#i++;
				}
				return t;
			}
			this.#i++;
			return c;
		}
		this.#i++; // past {
		const start = this.#i;
		let depth = 1;
		while (this.#i < this.#s.length && depth > 0) {
			const c = this.#s[this.#i];
			if (c === "\\") {
				this.#i += 2;
				continue;
			}
			if (c === "{") depth++;
			else if (c === "}") {
				depth--;
				if (depth === 0) {
					const end = this.#i;
					this.#i++;
					return this.#s.slice(start, end);
				}
			}
			this.#i++;
		}
		return this.#s.slice(start, this.#i);
	}

	#script(style: FontStyle | null, sup: boolean): string {
		const arg = this.#argument(style);
		return sup ? toSuperscript(arg.text, arg.group) : toSubscript(arg.text, arg.group);
	}

	#wrapFrac(arg: Argument): string {
		return arg.group && codePointLength(arg.text) > 1 ? `(${arg.text})` : arg.text;
	}

	#fraction(num: Argument, den: Argument): string {
		const vulgar = VULGAR[`${num.text}/${den.text}`];
		if (vulgar) return vulgar;
		return `${this.#wrapFrac(num)}/${this.#wrapFrac(den)}`;
	}

	#scriptedAbove(style: FontStyle | null): string {
		const above = this.#argument(style);
		const base = this.#argument(style);
		return base.text + toSuperscript(above.text, true);
	}

	#scriptedBelow(style: FontStyle | null): string {
		const below = this.#argument(style);
		const base = this.#argument(style);
		return base.text + toSubscript(below.text, true);
	}

	#prescript(style: FontStyle | null): string {
		const sup = this.#argument(style);
		const sub = this.#argument(style);
		const base = this.#argument(style);
		return toSuperscript(sup.text, true) + toSubscript(sub.text, true) + base.text;
	}

	#extensibleArrow(style: FontStyle | null, arrow: string): string {
		const below = this.#optionalArgument(style);
		const above = this.#argument(style);
		return arrow + toSuperscript(above.text, true) + (below ? toSubscript(below.text, true) : "");
	}

	#delimiter(style: FontStyle | null): string {
		while (this.#s[this.#i] === " ") this.#i++;
		const c = this.#s[this.#i];
		if (c === undefined) return "";
		if (c === ".") {
			this.#i++;
			return "";
		}
		if (c !== "\\") {
			this.#i++;
			return styleChar(c, style);
		}
		this.#i++;
		if (this.#i >= this.#s.length) return "";
		const d = this.#s[this.#i];
		if (!/[A-Za-z]/.test(d)) {
			this.#i++;
			switch (d) {
				case ".":
					return "";
				case "{":
					return "{";
				case "}":
					return "}";
				case "|":
					return "‖";
				default:
					return d;
			}
		}
		let name = "";
		while (this.#i < this.#s.length && /[A-Za-z]/.test(this.#s[this.#i])) {
			name += this.#s[this.#i];
			this.#i++;
		}
		return SYMBOLS[name] ?? name;
	}

	#optionalArgument(style: FontStyle | null): Argument | null {
		const source = this.#optionalRawArgument();
		if (source === null) return null;
		if (this.#depth >= LatexParser.#MAX_DEPTH) {
			return { text: source, group: true };
		}
		return { text: new LatexParser(source, this.#depth).parse(style, false), group: true };
	}

	#optionalRawArgument(): string | null {
		while (this.#s[this.#i] === " ") this.#i++;
		if (this.#s[this.#i] !== "[") return null;
		this.#i++;
		const start = this.#i;
		let bracketDepth = 1;
		let braceDepth = 0;
		while (this.#i < this.#s.length && bracketDepth > 0) {
			const c = this.#s[this.#i];
			if (c === "\\") {
				this.#i += 2;
				continue;
			}
			if (c === "{") braceDepth++;
			else if (c === "}" && braceDepth > 0) braceDepth--;
			else if (braceDepth === 0 && c === "[") bracketDepth++;
			else if (braceDepth === 0 && c === "]") {
				bracketDepth--;
				if (bracketDepth === 0) {
					const end = this.#i;
					this.#i++;
					return this.#s.slice(start, end);
				}
			}
			this.#i++;
		}
		return this.#s.slice(start, this.#i);
	}

	#sqrt(style: FontStyle | null): string {
		while (this.#s[this.#i] === " ") this.#i++;
		let radical = "√";
		const index = this.#optionalArgument(style)?.text;
		if (index !== undefined) {
			radical = index === "2" ? "√" : index === "3" ? "∛" : index === "4" ? "∜" : `${toSuperscript(index, true)}√`;
		}
		const radicand = this.#argument(style).text;
		return radical + (codePointLength(radicand) > 1 ? `(${radicand})` : radicand);
	}

	#environment(style: FontStyle | null): string {
		const env = this.#rawArgument().trim();
		if (env === "array" || env === "tabular" || env === "array*" || env === "tabular*") {
			this.#optionalRawArgument();
			if (this.#s[this.#i] === "{") this.#rawArgument(); // column spec
		} else if (
			env === "alignedat" ||
			env === "alignedat*" ||
			env === "alignat" ||
			env === "alignat*" ||
			env === "gatheredat"
		) {
			this.#optionalRawArgument();
			if (this.#s[this.#i] === "{") this.#rawArgument(); // column count
		}
		let body = "";
		while (this.#i < this.#s.length) {
			if (this.#s.startsWith("\\end", this.#i)) {
				this.#i += 4;
				this.#rawArgument();
				break;
			}
			body += this.#node(style);
		}
		body = body.trim();
		if (
			env === "cases" ||
			env === "cases*" ||
			env === "dcases" ||
			env === "dcases*" ||
			env === "rcases" ||
			env === "drcases"
		) {
			body = body.replace(/[ \t]*\n+[ \t]*/g, "; ").replace(/ {3,}/g, "  ");
		}
		const delims = ENV_DELIMS[env];
		return delims ? delims[0] + body + delims[1] : body;
	}

	#spaceBeforeArg(): string {
		const c = this.#s[this.#i];
		if (c === undefined) return "";
		return /[A-Za-z0-9\\]/.test(c) ? " " : "";
	}
}

export function latexToUnicode(src: string): string {
	if (typeof src !== "string" || src.length === 0) return src;
	return new LatexParser(src).render();
}

const NEWLINES = /\n+/g;
const BARE_MATH_LINE_COMMAND =
	/\\(?:operatorname|frac|dfrac|tfrac|cfrac|genfrac|sqrt|sum|prod|coprod|int|iint|iiint|lim|alpha|beta|gamma|delta|epsilon|varepsilon|theta|lambda|mu|sigma|phi|varphi|pi|omega|infty|partial|nabla|forall|exists|mathbb|mathcal|mathscr|mathbf|mathrm|left|right|begin|phantom|hphantom|vphantom|cdots|ldots|dots|to|rightarrow|leftarrow|leq|geq|neq|times|cdot|overline|underline|vec|hat|bar|textcolor|color|normalcolor|colorbox|fcolorbox)\b/;

const BARE_MATH_ENVIRONMENTS = new Set([
	"matrix",
	"smallmatrix",
	"pmatrix",
	"bmatrix",
	"Bmatrix",
	"vmatrix",
	"Vmatrix",
	"cases",
	"dcases",
	"rcases",
	"drcases",
	"aligned",
	"alignedat",
	"align",
	"alignat",
	"split",
	"gathered",
	"gatheredat",
	"gather",
	"multline",
	"equation",
	"eqnarray",
	"array",
	"subarray",
]);

export function isBareMathEnvironment(env: string): boolean {
	return BARE_MATH_ENVIRONMENTS.has(env.endsWith("*") ? env.slice(0, -1) : env);
}

function renderBareMathInText(text: string): string {
	let out = "";
	let i = 0;
	for (;;) {
		const begin = text.indexOf("\\begin{", i);
		if (begin === -1) return out + renderBareMathLines(text.slice(i));
		const envStart = begin + "\\begin{".length;
		const envEnd = text.indexOf("}", envStart);
		if (envEnd === -1) return out + renderBareMathLines(text.slice(i));
		const env = text.slice(envStart, envEnd);
		const closeToken = `\\end{${env}}`;
		const close = text.indexOf(closeToken, envEnd + 1);
		if (close === -1) {
			out += renderBareMathLines(text.slice(i, envEnd + 1));
			i = envEnd + 1;
			continue;
		}
		const blockEnd = close + closeToken.length;
		if (!isBareMathEnvironment(env)) {
			out += renderBareMathLines(text.slice(i, begin)) + text.slice(begin, blockEnd);
			i = blockEnd;
			continue;
		}
		const lineStart = text.lastIndexOf("\n", begin - 1) + 1;
		const prefix = text.slice(lineStart, begin);
		let start = prefix.includes("\\") || prefix.includes("=") ? lineStart : begin;
		if (start === begin && prefix.trim() === "" && lineStart > 0) {
			const previousLineEnd = lineStart - 1;
			const previousLineStart = text.lastIndexOf("\n", previousLineEnd - 1) + 1;
			const previousLine = text.slice(previousLineStart, previousLineEnd);
			if (/[=([{]\s*$/.test(previousLine)) start = previousLineStart;
		}
		out += renderBareMathLines(text.slice(i, start));
		out += latexToUnicode(text.slice(start, blockEnd)).replace(NEWLINES, " ");
		i = blockEnd;
	}
}

function renderBareMathLines(text: string): string {
	let out = "";
	let lineStart = 0;
	for (let i = 0; i <= text.length; i++) {
		if (i !== text.length && text[i] !== "\n") continue;
		const line = text.slice(lineStart, i);
		out += shouldRenderBareMathLine(line) ? latexToUnicode(line).replace(NEWLINES, " ") : line;
		if (i !== text.length) out += "\n";
		lineStart = i + 1;
	}
	return out;
}

function shouldRenderBareMathLine(line: string): boolean {
	const trimmed = line.trim();
	if (trimmed === "" || !trimmed.includes("\\")) return false;
	const env = /\\(?:begin|end)\{([^}]*)\}/.exec(trimmed);
	if (env && !isBareMathEnvironment(env[1])) return false;
	if (!BARE_MATH_LINE_COMMAND.test(trimmed)) return false;
	return trimmed.startsWith("\\") || /[=<>^_{}&]/.test(trimmed);
}

export function renderMathInText(text: string): string {
	if (typeof text !== "string" || text.length === 0) return text;
	if (
		!text.includes("$") &&
		!text.includes("\\(") &&
		!text.includes("\\[") &&
		!text.includes("\\begin") &&
		!BARE_MATH_LINE_COMMAND.test(text)
	) {
		return text;
	}

	const conv = (inner: string): string => latexToUnicode(inner).replace(NEWLINES, " ");
	let out = "";
	let i = 0;
	const n = text.length;
	while (i < n) {
		const c = text[i];
		if (c === "\\") {
			const d = text[i + 1];
			if (d === "\\") {
				out += "\\\\";
				i += 2;
				continue;
			}
			if (d === "(") {
				const close = text.indexOf("\\)", i + 2);
				if (close !== -1) {
					out += conv(text.slice(i + 2, close));
					i = close + 2;
					continue;
				}
			} else if (d === "[") {
				const close = text.indexOf("\\]", i + 2);
				if (close !== -1) {
					out += conv(text.slice(i + 2, close));
					i = close + 2;
					continue;
				}
			} else if (d === "$") {
				out += "$";
				i += 2;
				continue;
			}
			out += c;
			i++;
			continue;
		}
		if (c === "$") {
			if (text[i + 1] === "$") {
				const close = text.indexOf("$$", i + 2);
				if (close !== -1 && text.slice(i + 2, close).trim().length > 0) {
					out += conv(text.slice(i + 2, close));
					i = close + 2;
					continue;
				}
				out += "$$";
				i += 2;
				continue;
			}
			const close = inlineMathSpanEnd(text, i);
			if (close !== -1) {
				out += conv(text.slice(i + 1, close));
				i = close + 1;
				continue;
			}
			out += "$";
			i++;
			continue;
		}
		out += c;
		i++;
	}
	return renderBareMathInText(out);
}

export function inlineMathSpanEnd(text: string, open: number): number {
	const after = text[open + 1];
	if (after === undefined || after === " " || after === "\t" || after === "\n" || after === "$") {
		return -1;
	}
	for (let j = open + 1; j < text.length; j++) {
		const ch = text[j];
		if (ch === "\\") {
			j++;
			continue;
		}
		if (ch === "\n") return -1;
		if (ch === "$") {
			const prev = text[j - 1];
			if (prev === " " || prev === "\t") return -1;
			const next = text[j + 1];
			if (next !== undefined && next >= "0" && next <= "9") continue; // currency: keep scanning
			return text.slice(open + 1, j).trim().length > 0 ? j : -1;
		}
	}
	return -1;
}
