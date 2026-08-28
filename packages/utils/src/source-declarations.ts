import { withoutComments } from "./module-reach";

export interface StringConstant {
	name: string;
	value: string;
	exported: boolean;
}

const STRING_CONSTANT_RE =
	/(?:^|\n)[ \t]*(export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=\n]+)?=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\$]|\\.|\$(?!\{))*)`)\s*(?:as\s+const\s*)?;/g;

const SIMPLE_ESCAPES: Record<string, string> = {
	n: "\n",
	r: "\r",
	t: "\t",
	b: "\b",
	f: "\f",
	v: "\v",
	"0": "\0",
};

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

export interface DeclaringModule {
	file: string;
	source: string;
}

export function declarersOfStringValue(modules: Iterable<DeclaringModule>, value: string): string[] {
	const declarers: string[] = [];
	for (const module of modules) {
		if (stringConstantsIn(module.source).some(constant => constant.value === value)) declarers.push(module.file);
	}
	return declarers;
}

export function stringConstantValue(source: string, name: string): string | undefined {
	return stringConstantsIn(source).find(constant => constant.name === name)?.value;
}

const EXPORTED_DECLARATION_RE =
	/(?:^|\n)[ \t]*export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)/g;

const LOCAL_EXPORT_CLAUSE_RE = /(?:^|\n)[ \t]*export\s+(?:type\s+)?\{([^}]*)\}\s*(?!\s*from)[;\n]/g;

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
			const parts = name.split(/\s+as\s+/);
			const exported = (parts.length > 1 ? parts[1] : parts[0])?.trim();
			if (exported) found.push(exported);
		}
	}
	return found;
}

export function declarersOfName(modules: Iterable<DeclaringModule>, name: string): string[] {
	const declarers: string[] = [];
	for (const module of modules) {
		if (exportedDeclarationsIn(module.source).includes(name)) declarers.push(module.file);
	}
	return declarers;
}
