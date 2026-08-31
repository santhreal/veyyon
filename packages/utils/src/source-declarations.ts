import { withoutComments } from "./module-reach";

/**
 * The string constants a module declares, read from its declarations rather than from its formatting.
 *
 * A one-owner gate has two halves. The import half is answered by `module-reach.ts`: which specifiers a
 * module instantiates, parsed, so a doc comment mentioning an import is not mistaken for one. The other
 * half is the value itself -- an OAuth callback path, a wire tag, a version string -- and it used to be
 * answered by searching source text for a formatted line: `expect(text).toContain('export const
 * DEFAULT_CALLBACK_PATH = "/callback";')`. That fails on both sides at once. It goes red when a formatter
 * moves the value to the next line or a rename lands, which is noise, and it stays green when a second
 * module declares the same value with a different name, spacing, or quote style, which is the defect the
 * gate exists to catch.
 *
 * This reads the declaration instead: the binding name, whether it is exported, and the DECODED value, so
 * `"\u0060\u0060\u0060"`, `'\u0060\u0060\u0060'` and a backtick literal are one answer. A census over a
 * directory then says which modules declare a value, and a gate compares that list by exact equality --
 * which is what makes a new declarer red by default.
 *
 * What it does not see, stated so the next reader knows where the fence ends: a value built by
 * concatenation or interpolation, one assembled at run time, one held in an object literal or an array,
 * and one declared with `let` or `var`. A gate that needs those needs a real parse of the module, and this
 * is not it. Everything here is a top-level `const NAME = <string literal>`, which is the shape a shared
 * constant has in this codebase.
 */

/** One `const NAME = "value"` a module declares at the top level. */
export interface StringConstant {
	/** The binding name. */
	name: string;
	/** The decoded value: escapes resolved, quotes removed, so quote style is not part of the answer. */
	value: string;
	/** True when the declaration carries `export`, so a gate can tell a shared constant from a private one. */
	exported: boolean;
}

/**
 * `const NAME = <literal>`, optionally exported, optionally `as const`, with the literal in any of the
 * three quote styles. The value group keeps its escapes: {@link decodeStringLiteral} resolves them.
 * `[^"\\]*(?:\\.[^"\\]*)*` is the standard "up to the unescaped closing quote" shape, so `"a\"b"` is one
 * literal and not two. A template literal is accepted only without `${`, because anything interpolated is
 * not a constant this can report.
 */
const STRING_CONSTANT_RE =
	/(?:^|\n)[ \t]*(export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=\n]+)?=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\$]|\\.|\$(?!\{))*)`)\s*(?:as\s+const\s*)?;/g;

/** The escapes a string literal may carry, resolved to the characters they stand for. */
const SIMPLE_ESCAPES: Record<string, string> = {
	n: "\n",
	r: "\r",
	t: "\t",
	b: "\b",
	f: "\f",
	v: "\v",
	"0": "\0",
};

/**
 * The characters a literal's body stands for.
 *
 * `JSON.parse` handles the double-quoted case and nothing else, and the single-quoted and template forms
 * are as common here as the double-quoted one, so the escapes are resolved directly: the six control
 * escapes, `\xNN`, `\uNNNN`, `\u{N...}`, and any other escaped character as itself (`\\`, `\"`, `` \` ``).
 */
function decodeStringLiteral(body: string): string {
	let out = "";
	for (let i = 0; i < body.length; i++) {
		const char = body[i];
		if (char !== "\\") {
			out += char;
			continue;
		}
		const next = body[++i];
		if (next === undefined) return out;
		if (next === "x") {
			out += String.fromCharCode(Number.parseInt(body.slice(i + 1, i + 3), 16));
			i += 2;
			continue;
		}
		if (next === "u") {
			if (body[i + 1] === "{") {
				const end = body.indexOf("}", i + 2);
				if (end !== -1) {
					out += String.fromCodePoint(Number.parseInt(body.slice(i + 2, end), 16));
					i = end;
					continue;
				}
			}
			out += String.fromCodePoint(Number.parseInt(body.slice(i + 1, i + 5), 16));
			i += 4;
			continue;
		}
		out += SIMPLE_ESCAPES[next] ?? next;
	}
	return out;
}

/**
 * Every top-level string constant `source` declares, in source order.
 *
 * Comments are stripped first, so prose quoting a declaration is not counted as one -- the same reason
 * {@link withoutComments} exists for the import readers next door.
 */
export function stringConstantsIn(source: string): StringConstant[] {
	const code = withoutComments(source);
	const found: StringConstant[] = [];
	for (const match of code.matchAll(STRING_CONSTANT_RE)) {
		const body = match[3] ?? match[4] ?? match[5];
		if (body === undefined || match[2] === undefined) continue;
		found.push({ name: match[2], value: decodeStringLiteral(body), exported: match[1] !== undefined });
	}
	return found;
}

/** One module's declarations, as a census wants them: the name a gate reports and the source to read. */
export interface DeclaringModule {
	/** How the gate names the module in its failure message, usually a repo-relative path. */
	file: string;
	/** The module's source text. */
	source: string;
}

/**
 * Which modules declare `value` as a string constant, in the order given.
 *
 * A gate asserts this by exact equality against the owner alone, so a second declarer is red the moment it
 * lands, whatever it calls the binding and however it quotes it.
 */
export function declarersOfStringValue(modules: Iterable<DeclaringModule>, value: string): string[] {
	const declarers: string[] = [];
	for (const module of modules) {
		if (stringConstantsIn(module.source).some(constant => constant.value === value)) declarers.push(module.file);
	}
	return declarers;
}

/**
 * The value a named constant holds in `source`, or `undefined` when the module does not declare it.
 *
 * For the module-private constant a gate cannot import: the value is the contract, the name is how the
 * gate finds it, and neither is the formatting of the line.
 */
export function stringConstantValue(source: string, name: string): string | undefined {
	return stringConstantsIn(source).find(constant => constant.name === name)?.value;
}

/**
 * `export function f`, `export const C`, `export class K`, `export type T`, `export enum E` — a name a
 * module DECLARES and exports, as opposed to one it re-exports from somewhere else.
 */
const EXPORTED_DECLARATION_RE =
	/(?:^|\n)[ \t]*export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)/g;

/** `export { a, b as c }` with no `from`, which exports names declared in this module. */
const LOCAL_EXPORT_CLAUSE_RE = /(?:^|\n)[ \t]*export\s+(?:type\s+)?\{([^}]*)\}\s*(?!\s*from)[;\n]/g;

/**
 * The names `source` declares and exports, in source order.
 *
 * The value census above answers "who declares this value". This answers "who declares this NAME", which
 * is the other half of the same claim and was checked by matching the declaration's own bytes:
 * `expect(owner).toMatch(/^export function parse\(/m)` passes on a comment that quotes the signature,
 * fails on a reflow that moves the parameter list to the next line, and says nothing about a second
 * module that declares the same name.
 *
 * A re-export (`export { x } from "./owner"`) is NOT a declaration and is excluded: the module that
 * re-exports a name is the module that does not own it.
 */
export function exportedDeclarationsIn(source: string): string[] {
	const code = withoutComments(source);
	const found: string[] = [];
	for (const match of code.matchAll(EXPORTED_DECLARATION_RE)) {
		if (match[1]) found.push(match[1]);
	}
	for (const match of code.matchAll(LOCAL_EXPORT_CLAUSE_RE)) {
		for (const entry of (match[1] ?? "").split(",")) {
			const name = entry.trim().replace(/^type\s+/, "");
			if (!name) continue;
			// `a as b` exports `b`, which is the name a consumer imports.
			const parts = name.split(/\s+as\s+/);
			const exported = (parts.length > 1 ? parts[1] : parts[0])?.trim();
			if (exported) found.push(exported);
		}
	}
	return found;
}

/**
 * Which modules declare `name`, in the order given, so a gate can assert the set by exact equality.
 *
 * The answer is a LIST rather than a boolean because the interesting failures are two owners and no
 * owner, and a boolean per module turns both into a sequence of separate assertions that each pass.
 */
export function declarersOfName(modules: Iterable<DeclaringModule>, name: string): string[] {
	const declarers: string[] = [];
	for (const module of modules) {
		if (exportedDeclarationsIn(module.source).includes(name)) declarers.push(module.file);
	}
	return declarers;
}
