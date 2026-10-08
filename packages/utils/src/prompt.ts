import type { HelperDelegate, HelperOptions, Template, TemplateDelegate } from "handlebars";
import { createRuntimeEnvironment, withCompiler } from "./prompt-handlebars";
import { precompiledTemplate } from "./prompt-precompiled";
import { analyzeTemplate, assertTemplateVariablesFilled, type TemplateVariables } from "./prompt-variables";
import { internString } from "./strings";

export {
	analyzeTemplate,
	assertTemplateContext,
	findMissingTemplateVariables,
	MissingTemplateVariableError,
	type TemplateVariable,
	type TemplateVariables,
	type TemplateVariableUse,
} from "./prompt-variables";
export type { HelperDelegate, HelperOptions, Template, TemplateDelegate };

export type PromptRenderPhase = "pre-render" | "post-render";

export interface PromptFormatOptions {
	renderPhase?: PromptRenderPhase;
	replaceAsciiSymbols?: boolean;
	normalizeRfc2119?: boolean;
}

/**
 * Whether `text[s, end)` is a closing XML tag, a manual equivalent of
 * `/^<\/([a-z_-]+)>$/` that runs no RegExp and copies nothing. The caller
 * guarantees `text[s]` is `<`.
 */
function isClosingTagAt(text: string, s: number, end: number): boolean {
	if (end - s < 4 || text.charCodeAt(s + 1) !== 47 /* / */ || text.charCodeAt(end - 1) !== 62 /* > */) return false;
	for (let j = s + 2; j < end - 1; j++) {
		const c = text.charCodeAt(j);
		if (!((c >= 97 /* a */ && c <= 122) /* z */ || c === 45 /* - */ || c === 95) /* _ */) return false;
	}
	return true;
}

// Table row
const TABLE_ROW = /^\|.*\|$/;
// Table separator (|---|---|)
const TABLE_SEP = /^\|[-:\s|]+\|$/;

/**
 * RFC 2119 keywords (plus project aliases NEVER/AVOID) wrapped in markdown bold
 * — `**MUST**`, `**MUST NOT**`, `**NEVER**`, etc.
 */
const RFC2119_BOLD = /\*\*(MUST NOT|SHOULD NOT|RECOMMENDED|REQUIRED|OPTIONAL|SHOULD|MUST|MAY|NEVER|AVOID)\*\*/g;

/**
 * Fast pre-check for {@link normalizeRfc2119}: a line that lacks every one of
 * these substrings is untouched by all three replacements, so the
 * split/replace/join machinery can be skipped entirely.
 */
const RFC2119_GUARD = /\*\*(?:MUST|SHOULD|RECOMMENDED|REQUIRED|OPTIONAL|MAY|NEVER|AVOID)|MUST NOT|SHOULD NOT/;
const MUST_NOT = /\bMUST NOT\b/g;
const SHOULD_NOT = /\bSHOULD NOT\b/g;

function applyRfc2119(text: string): string {
	return text.replace(RFC2119_BOLD, "$1").replace(MUST_NOT, "NEVER").replace(SHOULD_NOT, "AVOID");
}

/**
 * Normalize RFC 2119 markers per project convention:
 *   - Strip `**KEYWORD**` bold (visual noise, no semantics).
 *   - Alias `MUST NOT` → `NEVER` and `SHOULD NOT` → `AVOID` (single-token equivalents).
 * Skips spans inside inline code (`` `…` ``) so alias definitions can be quoted literally.
 */
function normalizeRfc2119(line: string): string {
	if (!RFC2119_GUARD.test(line)) return line;
	if (!line.includes("`")) return applyRfc2119(line);
	const segments = line.split("`");
	for (let i = 0; i < segments.length; i += 2) {
		segments[i] = applyRfc2119(segments[i]);
	}
	return segments.join("`");
}

/** Compact a table row by trimming cell padding */
function compactTableRow(line: string): string {
	const cells = line.split("|");
	return cells.map(c => c.trim()).join("|");
}

/** Compact a table separator row */
function compactTableSep(line: string): string {
	const cells = line.split("|").filter(c => c.trim());
	const normalized = cells.map(c => {
		const trimmed = c.trim();
		const left = trimmed.startsWith(":");
		const right = trimmed.endsWith(":");
		if (left && right) return ":---:";
		if (left) return ":---";
		if (right) return "---:";
		return "---";
	});
	return `|${normalized.join("|")}|`;
}

const HTML_COMMENT_OPEN = "<!--";
const HTML_COMMENT_CLOSE = "-->";

type HtmlCommentState = {
	inHtmlComment: boolean;
};

// Single-pass alternation equivalent to the former chain of seven .replace()
// calls. Alternative order mirrors the old sequential order (`<->` before
// `->`/`<-`), and every replacement emits a non-ASCII char, so one pass
// produces byte-identical output to the sequential passes.
const ASCII_SYMBOLS = /\.{3}|<->|->|<-|!=|<=|>=/g;
const ASCII_SYMBOL_REPLACEMENTS: Record<string, string> = {
	"...": "…",
	"<->": "↔",
	"->": "→",
	"<-": "←",
	"!=": "≠",
	"<=": "≤",
	">=": "≥",
};
const replaceAsciiSymbol = (match: string): string => ASCII_SYMBOL_REPLACEMENTS[match];

function replaceCommonAsciiSymbols(line: string): string {
	return line.replace(ASCII_SYMBOLS, replaceAsciiSymbol);
}

function replaceCommonAsciiSymbolsOutsideHtmlComments(line: string, state: HtmlCommentState): string {
	// When not inside a comment, a line without `<!--` takes the fast path even
	// if it contains `-->`: the slow path would hit openIndex === -1 and replace
	// the whole line identically.
	if (!state.inHtmlComment && !line.includes(HTML_COMMENT_OPEN)) {
		return replaceCommonAsciiSymbols(line);
	}

	let result = "";
	let cursor = 0;

	while (cursor < line.length) {
		if (state.inHtmlComment) {
			const closeIndex = line.indexOf(HTML_COMMENT_CLOSE, cursor);
			if (closeIndex === -1) {
				return result + line.slice(cursor);
			}
			result += line.slice(cursor, closeIndex + HTML_COMMENT_CLOSE.length);
			cursor = closeIndex + HTML_COMMENT_CLOSE.length;
			state.inHtmlComment = false;
			continue;
		}

		const openIndex = line.indexOf(HTML_COMMENT_OPEN, cursor);
		if (openIndex === -1) {
			result += replaceCommonAsciiSymbols(line.slice(cursor));
			return result;
		}

		result += replaceCommonAsciiSymbols(line.slice(cursor, openIndex));
		const closeIndex = line.indexOf(HTML_COMMENT_CLOSE, openIndex + HTML_COMMENT_OPEN.length);
		if (closeIndex === -1) {
			result += line.slice(openIndex);
			state.inHtmlComment = true;
			return result;
		}

		result += line.slice(openIndex, closeIndex + HTML_COMMENT_CLOSE.length);
		cursor = closeIndex + HTML_COMMENT_CLOSE.length;
	}

	return result;
}

/** What `format` rewrites prose lines with, and whether the previous line left an HTML comment open. */
interface ProseRewrite extends HtmlCommentState {
	readonly replaceAsciiSymbols: boolean;
	readonly normalizeRfc2119: boolean;
}

/**
 * A prose line with indent `s` after the ASCII symbol, table and RFC 2119
 * rewrites `rewrite` enables. No rewrite changes leading whitespace, so the
 * rewritten line's indent is `s` as well.
 */
function rewriteProse(line: string, s: number, rewrite: ProseRewrite): string {
	let out = rewrite.replaceAsciiSymbols ? replaceCommonAsciiSymbolsOutsideHtmlComments(line, rewrite) : line;
	if (out.charCodeAt(s) === 124 /* | */) {
		const trimmedStart = s === 0 ? out : out.slice(s);
		if (TABLE_SEP.test(trimmedStart)) out = `${out.slice(0, s)}${compactTableSep(trimmedStart)}`;
		else if (TABLE_ROW.test(trimmedStart)) out = `${out.slice(0, s)}${compactTableRow(trimmedStart)}`;
	}
	return rewrite.normalizeRfc2119 ? normalizeRfc2119(out) : out;
}

/**
 * Whether the line `text[s, end)`, from its indent on, closes a block, which
 * lets a blank line before it go: `body\n\n</tag>` tightens to `body\n</tag>`,
 * and before rendering, likewise before a Handlebars `{{/block}}`. This is not
 * nesting-aware: any closing tag at any depth, balanced or not, counts.
 */
function closesBlock(text: string, s: number, end: number, isPreRender: boolean): boolean {
	const first = text.charCodeAt(s);
	if (first === 60 /* < */) return isClosingTagAt(text, s, end);
	return isPreRender && first === 123 /* { */ && text.startsWith("{{/", s);
}

/** Whether the line whose indent ends at `p` with char code `first` there opens or closes a code block. */
function isFence(text: string, p: number, first: number): boolean {
	return first === 96 /* ` */ ? text.startsWith("```", p) : first === 126 /* ~ */ && text.startsWith("~~~", p);
}

/** End of the line `text[start, rawEnd)` once `trimEnd` drops its trailing whitespace. */
function trimmedEnd(text: string, start: number, rawEnd: number): number {
	let end = rawEnd;
	let c = text.charCodeAt(end - 1);
	// ASCII whitespace: space, and \t through \r.
	while (end > start && (c === 32 || (c >= 9 && c <= 13))) c = text.charCodeAt(--end - 1);
	// Possible unicode trailing whitespace — defer to trimEnd for exactness.
	return end > start && c >= 128 ? start + text.slice(start, end).trimEnd().length : end;
}

/**
 * One `format` pass, which reads `content` a line at a time by offset rather
 * than splitting it. A run of lines kept as they stand stays one slice of
 * `content`, so the output copies only around a rewritten or dropped line, and
 * text that loses nothing but trailing blank lines is a slice of the input.
 *
 * Blank lines are held until the next line that is not blank. Inside a code
 * block they are kept, as everything there is. Outside one, a single blank
 * between two lines of text is kept unless the second closes a block; a run of
 * two or more goes, as does a blank before any text or at the end.
 */
class FormatPass {
	readonly #content: string;
	readonly #rewrite: ProseRewrite;
	readonly #rewrites: boolean;
	readonly #isPreRender: boolean;
	#inCodeBlock = false;
	// Blank lines held since the last kept line, from offset `#blankStart` to the end of the last at `#blankEnd`.
	#blanks = 0;
	#blankStart = 0;
	#blankEnd = 0;
	// Finished output pieces, joined by newlines. The kept lines after the last piece are the
	// run `content[#runStart, #runEnd)`, or none while `#runStart` is -1.
	readonly #parts: string[] = [];
	#runStart = -1;
	#runEnd = -2;

	constructor(content: string, options: PromptFormatOptions) {
		const { renderPhase = "post-render", replaceAsciiSymbols = false, normalizeRfc2119 = false } = options;
		this.#content = content;
		this.#rewrite = { replaceAsciiSymbols, normalizeRfc2119, inHtmlComment: false };
		this.#rewrites = replaceAsciiSymbols || normalizeRfc2119;
		this.#isPreRender = renderPhase === "pre-render";
	}

	/** Place the line `content[start, rawEnd)`. */
	line(start: number, rawEnd: number): void {
		const content = this.#content;
		// charCode fast path: only scan back when the last char might be whitespace
		// (<= 0x20 ASCII ws/controls, >= 0x80 unicode ws). A blank line reads the
		// newline before it, which also takes the scan.
		const last = content.charCodeAt(rawEnd - 1);
		const end = last > 32 && last < 128 ? rawEnd : trimmedEnd(content, start, rawEnd);
		if (end === start) {
			if (this.#blanks++ === 0) this.#blankStart = start;
			this.#blankEnd = rawEnd;
			return;
		}
		// Locate the first non-whitespace char without a trimStart copy.
		let p = start;
		let first = content.charCodeAt(p);
		while (first === 32 /* space */ || first === 9 /* tab */) first = content.charCodeAt(++p);
		if (first >= 128) {
			// Possible unicode leading whitespace — defer to trimStart for exactness.
			p = end - content.slice(p, end).trimStart().length;
			first = content.charCodeAt(p);
		}
		const fence = isFence(content, p, first);
		if (!fence && !this.#inCodeBlock) return this.#placeProse(start, p, end, first);
		if (this.#blanks > 0) this.#keepBlanks(false);
		if (fence) this.#inCodeBlock = !this.#inCodeBlock;
		this.#keepSpan(start, end);
	}

	#placeProse(start: number, p: number, end: number, first: number): void {
		// No rewrite writes `|`, so a line that does not start with one keeps its
		// text unless a symbol or RFC 2119 rewrite is on.
		if (this.#rewrites || first === 124 /* | */) {
			const line = this.#content.slice(start, end);
			const s = p - start;
			const out = rewriteProse(line, s, this.#rewrite);
			if (out !== line) {
				if (this.#blanks > 0) this.#keepBlanks(closesBlock(out, s, out.length, this.#isPreRender));
				this.#keepText(out);
				return;
			}
		}
		if (this.#blanks > 0) this.#keepBlanks(closesBlock(this.#content, p, end, this.#isPreRender));
		this.#keepSpan(start, end);
	}

	/** Settle the held blank lines before a line that is not blank; `closes` is whether that line closes a block. */
	#keepBlanks(closes: boolean): void {
		const count = this.#blanks;
		this.#blanks = 0;
		if (this.#inCodeBlock) {
			const content = this.#content;
			for (let at = this.#blankStart; at <= this.#blankEnd; ) {
				const nl = content.indexOf("\n", at);
				this.#keepSpan(at, at);
				at = nl + 1;
			}
		} else if (count === 1 && !closes && (this.#runStart >= 0 || this.#parts.length > 0)) {
			this.#keepSpan(this.#blankStart, this.#blankStart);
		}
	}

	/** Keep the line `content[start, end)` as it stands. */
	#keepSpan(start: number, end: number): void {
		if (start !== this.#runEnd + 1) {
			this.#flush();
			this.#runStart = start;
		}
		this.#runEnd = end;
	}

	/** Keep a rewritten line. */
	#keepText(text: string): void {
		this.#flush();
		this.#parts.push(text);
		this.#runStart = -1;
		this.#runEnd = -2;
	}

	#flush(): void {
		if (this.#runStart >= 0) this.#parts.push(this.#content.slice(this.#runStart, this.#runEnd));
	}

	/** The kept lines as text. Blank lines still held end the text, so they go. */
	text(): string {
		this.#flush();
		return this.#parts.length === 1 ? this.#parts[0] : this.#parts.join("\n");
	}
}

export function format(content: string, options: PromptFormatOptions = {}): string {
	const pass = new FormatPass(content, options);
	let start = 0;
	for (let nl = content.indexOf("\n"); nl !== -1; nl = content.indexOf("\n", start)) {
		pass.line(start, nl);
		start = nl + 1;
	}
	pass.line(start, content.length);
	return pass.text();
}

export interface TemplateContext extends Record<string, unknown> {
	args?: string[];
	ARGUMENTS?: string;
	arguments?: string;
}

/**
 * The environment every prompt renders on, with the helpers below. It starts without the compiler:
 * a precompiled template revives on the runtime, and {@link withCompiler} installs the compiler for
 * the first template that is not one.
 */
const handlebars = createRuntimeEnvironment();

handlebars.registerHelper("arg", function (this: TemplateContext, index: number | string): string {
	const args = this.args ?? [];
	const parsedIndex = typeof index === "number" ? index : Number.parseInt(index, 10);
	if (!Number.isFinite(parsedIndex)) return "";
	const zeroBased = parsedIndex - 1;
	if (zeroBased < 0) return "";
	return args[zeroBased] ?? "";
});

/**
 * {{#list items prefix="- " suffix="" join="\n"}}{{this}}{{/list}}
 * Renders an array with customizable prefix, suffix, and join separator.
 * Note: Use \n in join for newlines (will be unescaped automatically).
 */
handlebars.registerHelper("list", function (this: unknown, context: unknown[], options: HelperOptions): string {
	if (!Array.isArray(context) || context.length === 0) return "";
	const prefix = (options.hash.prefix as string) ?? "";
	const suffix = (options.hash.suffix as string) ?? "";
	const rawSeparator = (options.hash.join as string) ?? "\n";
	const separator = rawSeparator.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
	return context.map(item => `${prefix}${options.fn(item)}${suffix}`).join(separator);
});

/**
 * {{join array ", "}}
 * Joins an array with a separator (default: ", ").
 * Note: Use \n/\t in the separator for newlines/tabs (unescaped automatically,
 * same convention as {{#list}} — Handlebars string literals carry no escapes).
 */
handlebars.registerHelper("join", (context: unknown[], separator?: unknown): string => {
	if (!Array.isArray(context)) return "";
	const sep = typeof separator === "string" ? separator.replace(/\\n/g, "\n").replace(/\\t/g, "\t") : ", ";
	return context.join(sep);
});

/**
 * {{default value "fallback"}}
 * Returns the value if truthy, otherwise returns the fallback.
 */
handlebars.registerHelper("default", (value: unknown, defaultValue: unknown): unknown => value || defaultValue);

/**
 * {{pluralize count "item" "items"}}
 * Returns "1 item" or "5 items" based on count.
 */
handlebars.registerHelper(
	"pluralize",
	(count: number, singular: string, plural: string): string => `${count} ${count === 1 ? singular : plural}`,
);

/**
 * {{#when value "==" compare}}...{{else}}...{{/when}}
 * Conditional block with comparison operators: ==, ===, !=, !==, >, <, >=, <=
 */
handlebars.registerHelper(
	"when",
	function (this: unknown, lhs: unknown, operator: string, rhs: unknown, options: HelperOptions): string {
		const ops: Record<string, (a: unknown, b: unknown) => boolean> = {
			"==": (a, b) => a === b,
			"===": (a, b) => a === b,
			"!=": (a, b) => a !== b,
			"!==": (a, b) => a !== b,
			">": (a, b) => (a as number) > (b as number),
			"<": (a, b) => (a as number) < (b as number),
			">=": (a, b) => (a as number) >= (b as number),
			"<=": (a, b) => (a as number) <= (b as number),
		};
		const fn = ops[operator];
		if (!fn) return options.inverse(this);
		return fn(lhs, rhs) ? options.fn(this) : options.inverse(this);
	},
);

/**
 * {{#ifAny a b c}}...{{else}}...{{/ifAny}}
 * True if any argument is truthy.
 */
handlebars.registerHelper("ifAny", function (this: unknown, ...args: unknown[]): string {
	const options = args.pop() as HelperOptions;
	return args.some(Boolean) ? options.fn(this) : options.inverse(this);
});

/**
 * {{#ifAll a b c}}...{{else}}...{{/ifAll}}
 * True if all arguments are truthy.
 */
handlebars.registerHelper("ifAll", function (this: unknown, ...args: unknown[]): string {
	const options = args.pop() as HelperOptions;
	return args.every(Boolean) ? options.fn(this) : options.inverse(this);
});

/**
 * {{#table rows headers="Col1|Col2"}}{{col1}}|{{col2}}{{/table}}
 * Generates a markdown table from an array of objects.
 */
handlebars.registerHelper("table", function (this: unknown, context: unknown[], options: HelperOptions): string {
	if (!Array.isArray(context) || context.length === 0) return "";
	const headersStr = options.hash.headers as string | undefined;
	const headers = headersStr?.split("|") ?? [];
	const separator = headers.map(() => "---").join(" | ");
	const headerRow = headers.length > 0 ? `| ${headers.join(" | ")} |\n| ${separator} |\n` : "";
	const rows = context.map(item => `| ${options.fn(item).trim()} |`).join("\n");
	return headerRow + rows;
});

/**
 * {{#codeblock lang="diff"}}...{{/codeblock}}
 * Wraps content in a fenced code block.
 */
handlebars.registerHelper("codeblock", function (this: unknown, options: HelperOptions): string {
	const lang = (options.hash.lang as string) ?? "";
	const content = options.fn(this).trim();
	return `\`\`\`${lang}\n${content}\n\`\`\``;
});

/**
 * {{#xml "tag"}}content{{/xml}}
 * Wraps content in XML-style tags. Returns empty string if content is empty.
 */
handlebars.registerHelper("xml", function (this: unknown, tag: string, options: HelperOptions): string {
	const content = options.fn(this).trim();
	if (!content) return "";
	return `<${tag}>\n${content}\n</${tag}>`;
});

/**
 * {{escapeXml value}}
 * Escapes XML special characters: & < > "
 */
handlebars.registerHelper("escapeXml", (value: unknown): string => {
	if (value == null) return "";
	return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
});

/**
 * {{len array}}
 * Returns the length of an array or string.
 */
handlebars.registerHelper("len", (value: unknown): number => {
	if (Array.isArray(value)) return value.length;
	if (typeof value === "string") return value.length;
	return 0;
});

/**
 * {{add a b}}
 * Adds two numbers.
 */
handlebars.registerHelper("add", (a: number, b: number): number => (a ?? 0) + (b ?? 0));

/**
 * {{sub a b}}
 * Subtracts b from a.
 */
handlebars.registerHelper("sub", (a: number, b: number): number => (a ?? 0) - (b ?? 0));

/**
 * {{#has collection item}}...{{else}}...{{/has}}
 * Checks if an array includes an item or if a Set/Map has a key.
 */
handlebars.registerHelper(
	"has",
	function (this: unknown, collection: unknown, item: unknown, options: HelperOptions): string {
		let found = false;
		if (Array.isArray(collection)) {
			found = collection.includes(item);
		} else if (collection instanceof Set) {
			found = collection.has(item);
		} else if (collection instanceof Map) {
			found = collection.has(item);
		} else if (collection && typeof collection === "object") {
			if (typeof item === "string" || typeof item === "number" || typeof item === "symbol") {
				found = item in collection;
			}
		}
		return found ? options.fn(this) : options.inverse(this);
	},
);

/**
 * {{includes array item}}
 * Returns true if array includes item. For use in other helpers.
 */
handlebars.registerHelper("includes", (collection: unknown, item: unknown): boolean => {
	if (Array.isArray(collection)) return collection.includes(item);
	if (collection instanceof Set) return collection.has(item);
	if (collection instanceof Map) return collection.has(item);
	return false;
});

/**
 * {{not value}}
 * Returns logical NOT of value. For use in subexpressions.
 */
handlebars.registerHelper("not", (value: unknown): boolean => !value);

handlebars.registerHelper("jsonStringify", (value: unknown): string => JSON.stringify(value));

/**
 * The helpers this module registers, which every analysis `precompileTemplate` produces assumes.
 * Captured after the last registration above, before any caller can add one.
 */
const BUILTIN_HELPER_NAMES: readonly string[] = Object.keys(handlebars.helpers);

/**
 * Helpers registered through {@link registerHelper} after this module loaded. A precompiled
 * analysis of a template whose text contains one of these names is recomputed, because a
 * zero-argument mustache of that name is now a helper call rather than a context variable.
 */
const helpersRegisteredAfterLoad: string[] = [];

/**
 * Options for every template compile: at render and in {@link precompileTemplate}. A function
 * rather than a constant because `Handlebars.precompile` writes defaults into the object it gets.
 */
function compileOptions(): CompileOptions {
	return { noEscape: true, strict: false };
}

/**
 * Analyses keyed on the raw template. A template's AST walk costs more than
 * rendering it, and every render asserts its context, so without this each
 * render parses the template a second time to learn what it already learned.
 * {@link registerHelper} clears it, since the helper set is an input.
 */
const templateAnalysisCache = new Map<string, TemplateVariables>();

export function registerHelper(name: string, fn: HelperDelegate): void {
	handlebars.registerHelper(name, fn);
	if (!BUILTIN_HELPER_NAMES.includes(name) && !helpersRegisteredAfterLoad.includes(name)) {
		helpersRegisteredAfterLoad.push(name);
	}
	// A new helper turns a zero-argument mustache of its name from a context
	// variable into a helper call, so every cached analysis may now be wrong.
	templateAnalysisCache.clear();
}

export function registerPartial(name: string, fn: Template): void {
	handlebars.registerPartial(name, fn);
}

/**
 * Handlebars' lexer greedily matches `}}}` as `CLOSE_UNESCAPED` (the close of a
 * triple-stash `{{{ ... }}}`). When a regular helper close `}}` is immediately
 * followed by a literal `}` (common in compact JSON examples like
 * `{del:{{href ...}}}`), the lexer mistakes the trailing `}}}` for a triple-close
 * and rejects the input.
 *
 * We never use triple-stash (it's redundant under `noEscape: true`), so any run
 * of 3+ closing braces is unambiguously "helper close `}}`" + "literal `}`s".
 * Inject a no-op comment between them so the lexer tokenizes the helper close
 * cleanly and treats the rest as content.
 */
export function disambiguateClosingBraces(template: string): string {
	return template.replace(/\}\}(\}+)/g, "}}{{!---}}$1");
}

const compiledTemplateCache = new Map<string, (context: TemplateContext) => string>();

export function compile(template: string): (context: TemplateContext) => string {
	// Keyed on the raw template so repeat renders skip disambiguateClosingBraces
	// (a full-template regex pass) as well as the Handlebars compile.
	const cached = compiledTemplateCache.get(template);
	if (cached) return cached;
	const precompiled = precompiledTemplate(template);
	const compiled = (
		precompiled
			? handlebars.template(precompiled.spec())
			: withCompiler(handlebars).compile(disambiguateClosingBraces(template), compileOptions())
	) as (context: TemplateContext) => string;
	compiledTemplateCache.set(template, compiled);
	return compiled;
}

/** A template's precompiled specification, as JavaScript source, and the analysis of its variables. */
export interface TemplatePrecompilation {
	/** An object literal expression that `Handlebars.template` revives into the template's render function. */
	readonly spec: string;
	readonly variables: TemplateVariables;
}

/**
 * Precompile a template of this module's dialect, for the binary build.
 *
 * The specification is what {@link compile} builds at run time, with the same options and the same
 * {@link disambiguateClosingBraces} pass. The analysis assumes {@link BUILTIN_HELPER_NAMES}; a helper
 * registered later invalidates it for any template whose text contains the helper's name.
 */
export function precompileTemplate(template: string): TemplatePrecompilation {
	const source = disambiguateClosingBraces(template);
	return {
		// The typings declare an object; the compiler returns the specification's source text.
		spec: withCompiler(handlebars).precompile(source, compileOptions()) as unknown as string,
		variables: analyzeTemplate(source, { helperNames: BUILTIN_HELPER_NAMES }),
	};
}

/**
 * How the analyzer must be told to read a template of THIS module's dialect.
 *
 * Two things differ from a stock Handlebars parse and both would give wrong
 * answers if a caller skipped them, so nothing outside this file should be
 * calling `analyzeTemplate` directly:
 *
 *   - the source has to go through {@link disambiguateClosingBraces} first, or a
 *     template containing `{{x}}}` fails to parse at all (that transform is the
 *     only reason it compiles);
 *   - the helper list has to come from the PRIVATE instance, which carries ~20
 *     helpers the global registry does not, or a zero-argument helper mustache
 *     reads as a context variable and gets demanded of the caller.
 */
function analyzerOptions(): { helperNames: string[] } {
	return { helperNames: Object.keys(handlebars.helpers) };
}

/** Analyze a template of this module's dialect. See {@link analyzerOptions}. */
export function analyzePromptTemplate(template: string): TemplateVariables {
	const cached = templateAnalysisCache.get(template);
	if (cached) return cached;
	const precompiled = precompiledTemplate(template);
	const analysis =
		precompiled && !helpersRegisteredAfterLoad.some(name => template.includes(name))
			? precompiled.variables()
			: analyzeTemplate(disambiguateClosingBraces(template), analyzerOptions());
	templateAnalysisCache.set(template, analysis);
	return analysis;
}

/** Assert a context fills a template of this module's dialect. */
export function assertPromptContext(template: string, context: TemplateContext, label?: string): void {
	assertTemplateVariablesFilled(analyzePromptTemplate(template), context, label);
}

export interface RenderOptions {
	/**
	 * Names the template in a missing-variable error. Pass the source path when
	 * there is one: the stack trace runs through the render machinery and does
	 * not say which of the 143 templates failed.
	 */
	label?: string;
	/**
	 * Render even if the context leaves a hole.
	 *
	 * For callers that legitimately build a context piecemeal (a partial render
	 * whose remaining variables are filled by a later pass). It is an explicit,
	 * greppable opt-out rather than the default precisely because the default
	 * used to be silent, which is the defect this option exists to keep visible.
	 */
	allowMissing?: boolean;
}

/**
 * Render `template` against `context`, refusing to leave a hole.
 *
 * A variable the template PRINTS but the context does not provide throws
 * {@link MissingTemplateVariableError} rather than rendering the empty string.
 * Variables the template only TESTS are untouched: absent still means "off",
 * which is what every optional region in these prompts relies on. See
 * `prompt-variables.ts` for why the check draws the line there.
 *
 * The result is interned ({@link internString}): each session renders the same tool descriptions
 * and prompt sections, and every session holding one shares one copy.
 */
export function render(template: string, context: TemplateContext = {}, options: RenderOptions = {}): string {
	if (!template.includes("{{")) return internString(format(template, { renderPhase: "post-render" }));
	const resolved = context ?? {};
	if (!options.allowMissing) assertPromptContext(template, resolved, options.label);
	const compiled = compile(template);
	const rendered = compiled(resolved);
	return internString(format(rendered, { renderPhase: "post-render" }));
}

/**
 * Render templates written one after another: the result of `render(templates.join(""), ...)`.
 *
 * When every template holding a mustache is one the binary build precompiled, each renders on its
 * own and the results are joined, so the joined text is never parsed or compiled at run time. A
 * precompiled template compiled on its own at build time, so no block, comment or raw block opens
 * in one template and closes in the next. The results are the same because nothing else in one
 * template reaches into its neighbour: every template but the last ends with a newline, so each
 * starts a line as a whole template does and Handlebars' standalone-line rule reads its first and
 * last lines the same way, and no template uses the `~` whitespace control, which strips across a
 * boundary. Any other sequence renders joined. A context that leaves a hole throws
 * {@link MissingTemplateVariableError} either way; rendered one by one, the error lists the holes
 * of the first template that has one.
 */
export function renderSequence(
	templates: readonly string[],
	context: TemplateContext = {},
	options: RenderOptions = {},
): string {
	if (!rendersOneByOne(templates)) return render(templates.join(""), context, options);
	const resolved = context ?? {};
	let rendered = "";
	for (const template of templates) {
		if (!template.includes("{{")) {
			rendered += template;
			continue;
		}
		if (!options.allowMissing) assertPromptContext(template, resolved, options.label);
		rendered += compile(template)(resolved);
	}
	return internString(format(rendered, { renderPhase: "post-render" }));
}

/** Whether {@link renderSequence} renders `templates` one by one. */
function rendersOneByOne(templates: readonly string[]): boolean {
	let last = templates.length - 1;
	while (last >= 0 && templates[last] === "") last--;
	for (let index = 0; index <= last; index++) {
		const template = templates[index]!;
		if (template === "") continue;
		if (index < last && !template.endsWith("\n")) return false;
		if (!template.includes("{{")) continue;
		if (precompiledTemplate(template) === undefined) return false;
		if (template.includes("{{~") || template.includes("~}}")) return false;
	}
	return true;
}
