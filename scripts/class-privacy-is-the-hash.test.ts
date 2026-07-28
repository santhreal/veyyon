/**
 * Privacy is `#`, not a keyword the compiler throws away, in every package.
 *
 * `private` and `protected` are TypeScript annotations. They vanish at build
 * time, so a `private` field is reachable at runtime from anywhere that has the
 * object: a plugin, a test reaching in to fake state, a stray `as any`. `#name`
 * is enforced by the runtime, which is why AGENTS.md says class privacy uses it
 * and that no field or method carries an access keyword.
 *
 * ONE EXCEPTION, and TypeScript forces it: a constructor PARAMETER PROPERTY,
 * `constructor(private readonly session: ToolSession)`, has no `#` spelling.
 * Declaring the field separately and assigning it would be three lines instead
 * of one for nothing, so the keyword stays there and only there.
 *
 * WHY THIS SUITE EXISTS. The rule started inside `packages/coding-agent`, where a
 * sweep counted about twenty-seven declarations and read them all as violations.
 * Almost all were parameter properties, the exempt case. What was left was
 * twelve: four `protected` lifecycle hooks on `ChatBlock` with one `protected
 * override` on a controller, which became bare methods because a `#` member
 * cannot be overridden by a subclass at all and a hook exists to be overridden,
 * and six genuinely private members that are `#` now. A one-package rule leaves
 * every other package free to drift, and the sweep that widened it found 67 more
 * in `mnemopi`, ten in `argot`, one in `ai` and one in the edit benchmark. So the
 * gate lives here, at the workspace level, and reads every package.
 *
 * The check has to tell a parameter property from a field, or it reports two
 * dozen offenders that nobody may fix and gets switched off. It also has to tell
 * a declaration from a comment and from foreign source inside a template
 * literal, for the same reason, and each of those is asserted below rather than
 * assumed.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const PACKAGES = path.join(REPO_ROOT, "packages");

/** A declaration that opens with an access keyword. */
const ACCESS_KEYWORD = /^\s*(private|protected|public)\s/;

/**
 * `private constructor`, which is the factory pattern and not a field.
 *
 * A class that must be built through `open()` or `create()` says so by making
 * the constructor private, and there is no `#constructor`. Eight classes in
 * `coding-agent` alone do it: the three kernels, the session and history stores,
 * the settings store, the task registry and the QR helper.
 */
const PRIVATE_CONSTRUCTOR = /^\s*private\s+constructor\b/;

/**
 * Files still allowed to carry access keywords, with the count they carry today.
 *
 * This map may SHRINK and may never grow. Each entry is a file another lane is
 * editing right now, so converting it here would collide with in-flight work.
 * When that lane lands, convert the members and delete the row.
 *
 * `mnemopi/src/core/binary-vectors.ts` holds four: the connection-ownership flag
 * and table initialiser on the vector store, and the two backing arrays on the
 * in-memory index.
 */
const GRANDFATHERED: Readonly<Record<string, number>> = {
	"mnemopi/src/core/binary-vectors.ts": 4,
};

/** Directories that hold source we do not own or do not ship. */
const SKIPPED_DIRS = new Set(["vendor", "node_modules", "repo-cache", "__tests__", "dist", "build"]);

/**
 * Lines that declare a member with an access keyword OUTSIDE a constructor's
 * parameter list.
 *
 * The parameter list is tracked by counting parentheses from the `constructor(`
 * that opens it, because a parameter property can span several lines when its
 * type is an object literal, and a line-shape heuristic gets that one wrong.
 */
export function accessKeywordDeclarations(source: string): Array<{ line: number; text: string }> {
	const found: Array<{ line: number; text: string }> = [];
	let depth = 0;
	let inTemplate = false;
	source.split("\n").forEach((raw, index) => {
		const line = raw.replace(/\/\/.*$/, "");
		const startedInTemplate = inTemplate;
		if (countBackticks(line) % 2 === 1) inTemplate = !inTemplate;
		// A template literal can hold ANOTHER language. `stt/recorder.ts` embeds a
		// C# P/Invoke shim whose `public class` and `public static extern` lines are
		// not TypeScript declarations at all.
		if (startedInTemplate || inTemplate) return;
		const inParameterList = depth > 0;
		if (!inParameterList && ACCESS_KEYWORD.test(line) && !PRIVATE_CONSTRUCTOR.test(line)) {
			found.push({ line: index + 1, text: raw.trim() });
		}
		if (depth === 0) {
			const opens = line.indexOf("constructor(");
			if (opens !== -1) depth = countParens(line.slice(opens));
		} else {
			depth += countParens(line);
		}
		if (depth < 0) depth = 0;
	});
	return found;
}

function countBackticks(text: string): number {
	let seen = 0;
	for (let index = 0; index < text.length; index += 1) {
		if (text[index] === "\\") {
			index += 1;
			continue;
		}
		if (text[index] === "`") seen += 1;
	}
	return seen;
}

function countParens(text: string): number {
	let net = 0;
	for (const char of text) {
		if (char === "(") net += 1;
		else if (char === ")") net -= 1;
	}
	return net;
}

/** Every shipped `.ts` file under `packages/*\/src`, keyed by `<package>/src/<path>`. */
function sourceFiles(): string[] {
	const found: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!SKIPPED_DIRS.has(entry.name)) walk(full);
				continue;
			}
			if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) found.push(full);
		}
	};
	for (const pkg of fs.readdirSync(PACKAGES, { withFileTypes: true })) {
		if (!pkg.isDirectory()) continue;
		const src = path.join(PACKAGES, pkg.name, "src");
		if (fs.existsSync(src)) walk(src);
	}
	return found;
}

/** Path as the allowlist spells it: `<package>/src/<rest>`, with forward slashes. */
function relativeKey(file: string): string {
	return path.relative(PACKAGES, file).split(path.sep).join("/");
}

interface Hit {
	key: string;
	line: number;
	text: string;
}

function violations(): Hit[] {
	return sourceFiles().flatMap(file =>
		accessKeywordDeclarations(fs.readFileSync(file, "utf8")).map(hit => ({
			key: relativeKey(file),
			line: hit.line,
			text: hit.text,
		})),
	);
}

describe("class privacy is the hash", () => {
	/** The scan reads the real tree, so an empty walk cannot pass the rules below. */
	it("reads every package's source", () => {
		const files = sourceFiles();
		const packages = new Set(files.map(file => relativeKey(file).split("/")[0]));

		expect(files.length).toBeGreaterThan(900);
		expect(packages.size).toBeGreaterThan(10);
		expect(packages.has("coding-agent")).toBe(true);
		expect(packages.has("mnemopi")).toBe(true);
		expect(files.some(file => relativeKey(file) === "coding-agent/src/modes/components/chat-block.ts")).toBe(true);
	});

	/**
	 * The rule. A failure names the file and line, and the fix depends on the
	 * member: a field or a method that nothing outside the class touches becomes
	 * `#name`, and a hook a subclass overrides drops the keyword and stays bare,
	 * because `#` cannot be inherited.
	 */
	it("no field or method carries an access keyword", () => {
		const offenders = violations()
			.filter(hit => !(hit.key in GRANDFATHERED))
			.map(hit => `${hit.key}:${hit.line} ${hit.text}`);

		expect(offenders).toEqual([]);
	});

	/**
	 * The grandfathered files shrink and never grow.
	 *
	 * A count that came in under its ceiling means the lane landed and the
	 * conversion happened, so the row is stale: lower the number, or delete the
	 * row when it reaches zero. A count over the ceiling is a new violation
	 * hiding behind an old exception, which is the whole reason the ceiling is a
	 * number rather than a bare filename.
	 */
	it("the grandfathered files carry exactly the count written down", () => {
		const all = violations();
		const counted = Object.fromEntries(
			Object.keys(GRANDFATHERED).map(key => [key, all.filter(hit => hit.key === key).length]),
		);

		expect(counted).toEqual(GRANDFATHERED);
	});

	/**
	 * And every grandfathered path is a file that exists.
	 *
	 * A row naming a moved or deleted file would sit there forever excusing
	 * nothing, and the rule above would keep passing while the exception rotted.
	 */
	it("every grandfathered path names a real file", () => {
		for (const key of Object.keys(GRANDFATHERED)) {
			expect(fs.existsSync(path.join(PACKAGES, key))).toBe(true);
		}
	});
});

describe("the check tells a parameter property from a field", () => {
	/**
	 * The exempt case, single line, which is most of them.
	 */
	it("allows a one-line constructor parameter property", () => {
		const source = ["class A {", "\tconstructor(private readonly session: Session) {}", "}"].join("\n");

		expect(accessKeywordDeclarations(source)).toEqual([]);
	});

	/**
	 * The exempt case spanning several lines, which is the one a line-shape rule
	 * gets wrong: `private clipboard: {` opens an object type and the parameter
	 * runs on for six more lines. `input-controller.ts` has exactly this.
	 */
	it("allows a parameter property whose type spans lines", () => {
		const source = [
			"class A {",
			"\tconstructor(",
			"\t\tprivate ctx: Context,",
			"\t\tprivate clipboard: {",
			"\t\t\tread: () => string;",
			"\t\t} = defaults,",
			"\t) {}",
			"}",
		].join("\n");

		expect(accessKeywordDeclarations(source)).toEqual([]);
	});

	/**
	 * The non-vacuity twin: a real field, a real method, a static, and an
	 * accessor are all still caught, INCLUDING one declared after a constructor
	 * has opened and closed, which is where a naive parenthesis counter drifts.
	 */
	it("still catches a field or method outside the parameter list", () => {
		const source = [
			"class A {",
			"\tprivate readonly scoped: Resources;",
			"\tconstructor(private ctx: Context) {}",
			"\tprotected onMount(): void {}",
			"\tprivate static readonly EXAMPLES = [];",
			"\tprotected get active(): boolean {",
			"\t\treturn true;",
			"\t}",
			"}",
		].join("\n");

		expect(accessKeywordDeclarations(source).map(hit => hit.text)).toEqual([
			"private readonly scoped: Resources;",
			"protected onMount(): void {}",
			"private static readonly EXAMPLES = [];",
			"protected get active(): boolean {",
		]);
	});

	/**
	 * And a keyword written inside a comment is not a declaration.
	 */
	it("ignores an access keyword in a trailing comment", () => {
		expect(accessKeywordDeclarations("\tconst x = 1; // private state").length).toBe(0);
	});

	/**
	 * A private constructor is the factory pattern, not a field, and has no `#`
	 * spelling. It stays, and the members inside its parameter list stay with it.
	 */
	it("allows a private constructor", () => {
		const source = ["class A {", "\tprivate constructor(private readonly db: Db) {}", "}"].join("\n");

		expect(accessKeywordDeclarations(source)).toEqual([]);
	});

	/**
	 * Foreign source inside a template literal is not TypeScript.
	 *
	 * `stt/recorder.ts` embeds a C# P/Invoke shim to reach the Windows audio API,
	 * and its `public class` / `public static extern` lines would otherwise be
	 * reported as two permanent offenders nobody can fix.
	 */
	it("ignores declarations inside a template literal", () => {
		const source = [
			"const shim = `",
			"public class MciAudio {",
			"\tpublic static extern int mciSendString(string cmd);",
			"}",
			"`;",
			"class A {",
			"\tprivate real: number;",
			"}",
		].join("\n");

		expect(accessKeywordDeclarations(source).map(hit => hit.text)).toEqual(["private real: number;"]);
	});
});

describe("the scan covers the packages it claims to", () => {
	/**
	 * The walk skips vendored and generated trees.
	 *
	 * `packages/utils/src/vendor` holds third-party source we may not edit, so a
	 * keyword in there is not a finding and reporting it would be a permanent
	 * failure. This asserts the skip really happens rather than trusting the set.
	 */
	it("does not read vendored source", () => {
		const vendored = sourceFiles().filter(file => relativeKey(file).includes("/vendor/"));

		expect(vendored).toEqual([]);
		expect(fs.existsSync(path.join(PACKAGES, "utils", "src", "vendor"))).toBe(true);
	});

	/**
	 * And the key the allowlist is written in is the key the scan produces, on
	 * every platform. A Windows separator here would make every exemption miss.
	 */
	it("keys files by package and forward slash", () => {
		const key = relativeKey(path.join(PACKAGES, "mnemopi", "src", "core", "binary-vectors.ts"));

		expect(key).toBe("mnemopi/src/core/binary-vectors.ts");
	});
});
