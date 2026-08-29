import type { HelperDelegate, HelperOptions, Template, TemplateDelegate } from "handlebars";
import Handlebars from "handlebars";
import { analyzeTemplate, assertTemplateContext, type TemplateVariables } from "./prompt-variables";

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

function closingTagName(s: string): string | null {
	const n = s.length;
	if (n < 4 || s.charCodeAt(n - 1) !== 62 /* > */) return null;
	for (let j = 2; j < n - 1; j++) {
		const c = s.charCodeAt(j);
		if (!((c >= 97 /* a */ && c <= 122) /* z */ || c === 45 /* - */ || c === 95) /* _ */) return null;
	}
	return s.slice(2, n - 1);
}

const TABLE_ROW = /^\|.*\|$/;
const TABLE_SEP = /^\|[-:\s|]+\|$/;
const NON_BLANK = /\S/;

const RFC2119_BOLD = /\*\*(MUST NOT|SHOULD NOT|RECOMMENDED|REQUIRED|OPTIONAL|SHOULD|MUST|MAY|NEVER|AVOID)\*\*/g;

const RFC2119_GUARD = /\*\*(?:MUST|SHOULD|RECOMMENDED|REQUIRED|OPTIONAL|MAY|NEVER|AVOID)|MUST NOT|SHOULD NOT/;
const MUST_NOT = /\bMUST NOT\b/g;
const SHOULD_NOT = /\bSHOULD NOT\b/g;

function applyRfc2119(text: string): string {
	return text.replace(RFC2119_BOLD, "$1").replace(MUST_NOT, "NEVER").replace(SHOULD_NOT, "AVOID");
}

function normalizeRfc2119(line: string): string {
	if (!RFC2119_GUARD.test(line)) return line;
	if (!line.includes("`")) return applyRfc2119(line);
	const segments = line.split("`");
	for (let i = 0; i < segments.length; i += 2) {
		segments[i] = applyRfc2119(segments[i]);
	}
	return segments.join("`");
}

function compactTableRow(line: string): string {
	const cells = line.split("|");
	return cells.map(c => c.trim()).join("|");
}

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

export function format(content: string, options: PromptFormatOptions = {}): string {
	const {
		renderPhase = "post-render",
		replaceAsciiSymbols = false,
		normalizeRfc2119: shouldNormalizeRfc2119 = false,
	} = options;
	const isPreRender = renderPhase === "pre-render";
	const lines = content.split("\n");
	const result: string[] = new Array(lines.length);
	let n = 0; // logical length of `result` (pops are n--)
	let inCodeBlock = false;

	const htmlCommentState: HtmlCommentState = { inHtmlComment: false };

	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		const last = raw.charCodeAt(raw.length - 1);
		let line = last <= 32 || last >= 128 ? raw.trimEnd() : raw;
		let s = 0;
		let first = line.charCodeAt(0);
		while (first === 32 /* space */ || first === 9 /* tab */) first = line.charCodeAt(++s);
		if (first >= 128) {
			s = line.length - line.trimStart().length;
			first = line.charCodeAt(s);
		}

		if ((first === 96 /* ` */ || first === 126) /* ~ */ && (line.startsWith("```", s) || line.startsWith("~~~", s))) {
			inCodeBlock = !inCodeBlock;
			result[n++] = line;
			continue;
		}

		if (inCodeBlock) {
			result[n++] = line;
			continue;
		}

		if (replaceAsciiSymbols) {
			const replaced = replaceCommonAsciiSymbolsOutsideHtmlComments(line, htmlCommentState);
			if (replaced !== line) {
				line = replaced;
				s = 0;
				first = line.charCodeAt(0);
				while (first === 32 || first === 9) first = line.charCodeAt(++s);
				if (first >= 128) {
					s = line.length - line.trimStart().length;
					first = line.charCodeAt(s);
				}
			}
		}

		let isClosingLine = false;
		if (first === 60 /* < */) {
			const trimmedStart = s === 0 ? line : line.slice(s);
			if (trimmedStart.charCodeAt(1) === 47 /* / */ && closingTagName(trimmedStart) !== null) {
				isClosingLine = true;
			}
		} else if (first === 124 /* | */) {
			const trimmedStart = s === 0 ? line : line.slice(s);
			if (TABLE_SEP.test(trimmedStart)) {
				line = `${line.slice(0, s)}${compactTableSep(trimmedStart)}`;
			} else if (TABLE_ROW.test(trimmedStart)) {
				line = `${line.slice(0, s)}${compactTableRow(trimmedStart)}`;
			}
		}

		if (shouldNormalizeRfc2119) {
			line = normalizeRfc2119(line);
		}

		if (s >= line.length) {
			const next = lines[i + 1];
			if (next === undefined || next.length === 0 || !NON_BLANK.test(next)) {
				while (n > 0 && result[n - 1].length === 0) n--;
				let j = i + 1;
				while (j < lines.length && (lines[j].length === 0 || !NON_BLANK.test(lines[j]))) j++;
				i = j - 1;
				continue;
			}
			if (n === 0 || result[n - 1].length === 0) {
				continue;
			}
		}

		if (isClosingLine || (isPreRender && first === 123 /* { */ && line.startsWith("{{/", s))) {
			while (n > 0 && result[n - 1].length === 0) n--;
		}

		result[n++] = line;
	}

	while (n > 0 && result[n - 1].length === 0) n--;
	result.length = n;

	return result.join("\n");
}

export interface TemplateContext extends Record<string, unknown> {
	args?: string[];
	ARGUMENTS?: string;
	arguments?: string;
}

const handlebars = Handlebars.create();

handlebars.registerHelper("arg", function (this: TemplateContext, index: number | string): string {
	const args = this.args ?? [];
	const parsedIndex = typeof index === "number" ? index : Number.parseInt(index, 10);
	if (!Number.isFinite(parsedIndex)) return "";
	const zeroBased = parsedIndex - 1;
	if (zeroBased < 0) return "";
	return args[zeroBased] ?? "";
});

handlebars.registerHelper(
	"list",
	function (this: unknown, context: unknown[], options: Handlebars.HelperOptions): string {
		if (!Array.isArray(context) || context.length === 0) return "";
		const prefix = (options.hash.prefix as string) ?? "";
		const suffix = (options.hash.suffix as string) ?? "";
		const rawSeparator = (options.hash.join as string) ?? "\n";
		const separator = rawSeparator.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
		return context.map(item => `${prefix}${options.fn(item)}${suffix}`).join(separator);
	},
);

handlebars.registerHelper("join", (context: unknown[], separator?: unknown): string => {
	if (!Array.isArray(context)) return "";
	const sep = typeof separator === "string" ? separator.replace(/\\n/g, "\n").replace(/\\t/g, "\t") : ", ";
	return context.join(sep);
});

handlebars.registerHelper("default", (value: unknown, defaultValue: unknown): unknown => value || defaultValue);

handlebars.registerHelper(
	"pluralize",
	(count: number, singular: string, plural: string): string => `${count} ${count === 1 ? singular : plural}`,
);

handlebars.registerHelper(
	"when",
	function (this: unknown, lhs: unknown, operator: string, rhs: unknown, options: Handlebars.HelperOptions): string {
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

handlebars.registerHelper("ifAny", function (this: unknown, ...args: unknown[]): string {
	const options = args.pop() as Handlebars.HelperOptions;
	return args.some(Boolean) ? options.fn(this) : options.inverse(this);
});

handlebars.registerHelper("ifAll", function (this: unknown, ...args: unknown[]): string {
	const options = args.pop() as Handlebars.HelperOptions;
	return args.every(Boolean) ? options.fn(this) : options.inverse(this);
});

handlebars.registerHelper(
	"table",
	function (this: unknown, context: unknown[], options: Handlebars.HelperOptions): string {
		if (!Array.isArray(context) || context.length === 0) return "";
		const headersStr = options.hash.headers as string | undefined;
		const headers = headersStr?.split("|") ?? [];
		const separator = headers.map(() => "---").join(" | ");
		const headerRow = headers.length > 0 ? `| ${headers.join(" | ")} |\n| ${separator} |\n` : "";
		const rows = context.map(item => `| ${options.fn(item).trim()} |`).join("\n");
		return headerRow + rows;
	},
);

handlebars.registerHelper("codeblock", function (this: unknown, options: Handlebars.HelperOptions): string {
	const lang = (options.hash.lang as string) ?? "";
	const content = options.fn(this).trim();
	return `\`\`\`${lang}\n${content}\n\`\`\``;
});

handlebars.registerHelper("xml", function (this: unknown, tag: string, options: Handlebars.HelperOptions): string {
	const content = options.fn(this).trim();
	if (!content) return "";
	return `<${tag}>\n${content}\n</${tag}>`;
});

handlebars.registerHelper("escapeXml", (value: unknown): string => {
	if (value == null) return "";
	return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
});

handlebars.registerHelper("len", (value: unknown): number => {
	if (Array.isArray(value)) return value.length;
	if (typeof value === "string") return value.length;
	return 0;
});

handlebars.registerHelper("add", (a: number, b: number): number => (a ?? 0) + (b ?? 0));

handlebars.registerHelper("sub", (a: number, b: number): number => (a ?? 0) - (b ?? 0));

handlebars.registerHelper(
	"has",
	function (this: unknown, collection: unknown, item: unknown, options: Handlebars.HelperOptions): string {
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

handlebars.registerHelper("includes", (collection: unknown, item: unknown): boolean => {
	if (Array.isArray(collection)) return collection.includes(item);
	if (collection instanceof Set) return collection.has(item);
	if (collection instanceof Map) return collection.has(item);
	return false;
});

handlebars.registerHelper("not", (value: unknown): boolean => !value);

handlebars.registerHelper("jsonStringify", (value: unknown): string => JSON.stringify(value));

export function registerHelper(name: string, fn: HelperDelegate): void {
	handlebars.registerHelper(name, fn);
}

function registerPartial(name: string, fn: Template): void {
	handlebars.registerPartial(name, fn);
}

export function disambiguateClosingBraces(template: string): string {
	return template.replace(/\}\}(\}+)/g, "}}{{!---}}$1");
}

const compiledTemplateCache = new Map<string, (context: TemplateContext) => string>();

export function compile(template: string): (context: TemplateContext) => string {
	const cached = compiledTemplateCache.get(template);
	if (cached) return cached;
	const compiled = handlebars.compile(disambiguateClosingBraces(template), { noEscape: true, strict: false }) as (
		context: TemplateContext,
	) => string;
	compiledTemplateCache.set(template, compiled);
	return compiled;
}

function analyzerOptions(): { helperNames: string[] } {
	return { helperNames: Object.keys(handlebars.helpers) };
}

export function analyzePromptTemplate(template: string): TemplateVariables {
	return analyzeTemplate(disambiguateClosingBraces(template), analyzerOptions());
}

export function assertPromptContext(template: string, context: TemplateContext, label?: string): void {
	assertTemplateContext(disambiguateClosingBraces(template), context, label, analyzerOptions());
}

export interface RenderOptions {
	label?: string;
	allowMissing?: boolean;
}

export function render(template: string, context: TemplateContext = {}, options: RenderOptions = {}): string {
	const resolved = context ?? {};
	if (!options.allowMissing) assertPromptContext(template, resolved, options.label);
	const compiled = compile(template);
	const rendered = compiled(resolved);
	return format(rendered, { renderPhase: "post-render" });
}
