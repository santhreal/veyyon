/**
 * One literal scanner for the suites that sweep this tree's own source for a
 * spelling defect.
 *
 * A sweep over TypeScript cannot read raw lines. Half the periods, plurals and
 * ternaries in this tree sit in doc comments describing the defect the suite
 * closes, a `//` inside a URL is not a comment, a `/` after `)` divides rather
 * than opening a regex, and a character class holding a quote (`/["']/`) throws
 * a line scanner out of phase for the rest of the file. Two suites needed the
 * same walk, so it lives here once.
 *
 * {@link scanSource} makes one pass and returns both views a sweep wants: every
 * string, character and template literal with its line and its substitutions,
 * and the same source with comment and regex bodies blanked in place — offsets
 * and line numbers preserved, so a pattern matched against `code` reports a
 * line that means something.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * What the scanner leaves where a template literal had a `${…}` substitution.
 *
 * A hole is not empty text: `.${base}.${id}.tmp` would otherwise read as
 * `...tmp` and look like an elision mark, and `${count} ${plural}` would read
 * as one word. A character no source row contains keeps the text either side of
 * a hole apart.
 */
export const HOLE = "\0";

/** One string, character or template literal, as the scanner found it. */
export interface SourceLiteral {
	/** 1-based line of the opening quote. */
	line: number;
	/** The literal's text: escapes decoded, each `${…}` replaced by {@link HOLE}. */
	body: string;
	/** The source text of each substitution, in order, without the `${}`. */
	holes: readonly string[];
}

/** Both views of one source file, from a single pass. */
export interface ScannedSource {
	literals: readonly SourceLiteral[];
	/** The file with comment and regex bodies replaced by spaces, newlines kept. */
	code: string;
}

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", "0": "\0" };

/** Whether the `/` at `index` opens a regex literal rather than dividing. */
function opensRegex(source: string, index: number): boolean {
	let i = index - 1;
	while (i >= 0 && (source[i] === " " || source[i] === "\t")) i--;
	if (i < 0) return true;
	const previous = source[i] ?? "";
	return !(/[\w$]/.test(previous) || previous === ")" || previous === "]");
}

/** Read a `${…}` substitution starting at the `$`; returns the index after its `}`. */
function endOfHole(source: string, dollar: number): number {
	let k = dollar + 2;
	let depth = 1;
	while (k < source.length && depth > 0) {
		const inner = source[k];
		if (inner === "{") depth++;
		else if (inner === "}") depth--;
		else if (inner === '"' || inner === "'" || inner === "`") {
			const quote = inner;
			k++;
			while (k < source.length && source[k] !== quote) k += source[k] === "\\" ? 2 : 1;
		}
		k++;
	}
	return k;
}

export function scanSource(source: string): ScannedSource {
	const literals: SourceLiteral[] = [];
	// UTF-16 units, not code points: an astral character must not shift the offsets.
	const code = source.split("");
	// Literal starts only ever move forward, so one cursor counts every newline once.
	let cursorIndex = 0;
	let cursorLine = 1;
	const lineAt = (index: number): number => {
		while (cursorIndex < index) {
			if (source[cursorIndex] === "\n") cursorLine++;
			cursorIndex++;
		}
		return cursorLine;
	};
	const blank = (from: number, to: number): void => {
		for (let at = from; at < to && at < code.length; at++) {
			if (code[at] !== "\n") code[at] = " ";
		}
	};

	let i = 0;
	while (i < source.length) {
		const c = source[i];
		if (c === "/" && source[i + 1] === "/") {
			const end = source.indexOf("\n", i);
			const stop = end === -1 ? source.length : end;
			blank(i, stop);
			i = stop;
			continue;
		}
		if (c === "/" && source[i + 1] === "*") {
			const end = source.indexOf("*/", i + 2);
			const stop = end === -1 ? source.length : end + 2;
			blank(i, stop);
			i = stop;
			continue;
		}
		if (c === "/" && opensRegex(source, i)) {
			let j = i + 1;
			let inClass = false;
			while (j < source.length) {
				const ch = source[j];
				if (ch === "\\") {
					j += 2;
					continue;
				}
				if (ch === "\n") break;
				if (ch === "[") inClass = true;
				else if (ch === "]") inClass = false;
				else if (ch === "/" && !inClass) break;
				j++;
			}
			blank(i, j + 1);
			i = j + 1;
			continue;
		}
		if (c === '"' || c === "'") {
			const line = lineAt(i);
			let j = i + 1;
			let body = "";
			while (j < source.length) {
				const ch = source[j] ?? "";
				if (ch === "\\") {
					body += ESCAPES[source[j + 1] ?? ""] ?? source[j + 1] ?? "";
					j += 2;
					continue;
				}
				if (ch === c || ch === "\n") break;
				body += ch;
				j++;
			}
			literals.push({ line, body, holes: [] });
			i = j + 1;
			continue;
		}
		if (c === "`") {
			const line = lineAt(i);
			const holes: string[] = [];
			let j = i + 1;
			let body = "";
			while (j < source.length) {
				const ch = source[j] ?? "";
				if (ch === "\\") {
					body += ESCAPES[source[j + 1] ?? ""] ?? source[j + 1] ?? "";
					j += 2;
					continue;
				}
				if (ch === "`") break;
				if (ch === "$" && source[j + 1] === "{") {
					const end = endOfHole(source, j);
					holes.push(source.slice(j + 2, Math.max(j + 2, end - 1)));
					body += HOLE;
					j = end;
					continue;
				}
				body += ch;
				j++;
			}
			literals.push({ line, body, holes });
			i = j + 1;
			continue;
		}
		i++;
	}
	return { literals, code: code.join("") };
}

/**
 * Every `.ts` and `.tsx` under a root, tests and vendored trees excluded.
 *
 * The React tool views are a second renderer of the same tool results, so a row
 * spelled by hand in a `.tsx` reaches a different screen with the same defect.
 */
export function sources(dir: string, found: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === "vendor" || entry.name === "__tests__") continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			sources(full, found);
			continue;
		}
		const code = entry.name.endsWith(".ts") || entry.name.endsWith(".tsx");
		if (code && !entry.name.includes(".test.")) found.push(full);
	}
	return found;
}
