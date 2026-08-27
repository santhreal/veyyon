// WHY: a structure search printed every metavariable binding after the match,
// and an ast-grep binding is a source range inside the match the result had just
// printed line by line. A multi-node capture arrives joined onto one line, so
// `$$$BODY` was a second copy of the whole body; a single-node capture spanning
// lines arrived with its newlines and entered the body carrying no line number,
// so no hashline anchor covered it and a caller could not tell it from content.
// Measured over five patterns of this repository the bindings cost 8,414 tokens
// on top of 9,052 tokens of match text.
//
// The class this closes: a search result restating bytes it already delivered.
// Two invariants carry it, both asserted over every pattern the fixture answers
// rather than one reproduction: every delivered line carries a line number, and
// no binding value exceeds `META_VALUE_MAX_BYTES`. Raising that constant without
// a fixture that exercises it turns the guard case red.
//
// What it does not catch: a value under the bound, which is kept because it
// names which fragment bound to which variable for about ten tokens; the
// separator ast-grep uses for a multi-node capture, which lists a comma token as
// an element of its own; and duplication between the match text and note lines.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createTools, type ToolSession } from "@veyyon/coding-agent/tools";
import { META_VALUE_MAX_BYTES } from "@veyyon/coding-agent/tools/structure-search";
import { astGrep } from "@veyyon/natives";
import { removeWithRetries } from "@veyyon/utils";

const FIXTURE = `export function alpha(one: string, two: number): string {
	const joined = one + two;
	const trimmed = joined.trim();
	return trimmed;
}

export function beta(): number {
	return 7;
}
`;

/** Patterns the fixture answers: a multi-line body, then a single-line binding. */
const PATTERNS = ["export function $NAME($$$ARGS): $_ { $$$BODY }", "return $X;"];

/** A note line, as opposed to delivered file content. */
const NOTE = /^(#|\[|\s*meta:|\.\.\.|-\s|Match limit reached|Parse issues:|No matches)/;
const NUMBERED = /^\s*\*?\d+[:|│]/;

function createTestSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

async function withWorkspace<T>(body: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-structure-meta-"));
	try {
		await fs.writeFile(path.join(dir, "fixture.ts"), FIXTURE);
		return await body(dir);
	} finally {
		await removeWithRetries(dir);
	}
}

async function structureText(cwd: string, input: string): Promise<string> {
	const tools = await createTools(createTestSession(cwd));
	const tool = tools.find(entry => entry.name === "search");
	if (!tool) throw new Error("search tool missing");
	const result = await tool.execute(`structure-meta-${input}`, { type: "structure", input, path: "fixture.ts" });
	return result.content
		.filter(content => content.type === "text")
		.map(content => content.text)
		.join("\n");
}

describe("a structure match never prints its source twice", () => {
	it("exposes a binding past the bound for every pattern that should have one", async () => {
		// Green-by-luck guard: with no oversized binding in the corpus every
		// assertion below holds for results that never had one.
		await withWorkspace(async dir => {
			const found = await astGrep({
				patterns: [PATTERNS[0]!],
				path: path.join(dir, "fixture.ts"),
				includeMeta: true,
			});
			const oversized = found.matches.flatMap(match =>
				Object.values(match.metaVariables ?? {}).filter(
					value => value.includes("\n") || Buffer.byteLength(value, "utf-8") > META_VALUE_MAX_BYTES,
				),
			);
			expect(oversized.length).toBeGreaterThan(0);
		});
	});

	it("keeps every delivered line numbered for every pattern", async () => {
		await withWorkspace(async dir => {
			for (const pattern of PATTERNS) {
				const text = await structureText(dir, pattern);
				const delivered = text.split("\n").filter(line => line.trim().length > 0 && !NOTE.test(line));
				expect(delivered.length).toBeGreaterThan(0);
				for (const line of delivered) {
					expect(line).toMatch(NUMBERED);
				}
			}
		});
	});

	it("holds every binding value to the bound for every pattern", async () => {
		await withWorkspace(async dir => {
			let checked = 0;
			for (const pattern of PATTERNS) {
				const text = await structureText(dir, pattern);
				for (const line of text.split("\n")) {
					if (!line.startsWith("  meta: ")) continue;
					for (const pair of line.slice("  meta: ".length).split(/, (?=[A-Za-z_][A-Za-z0-9_]*=)/)) {
						const value = pair.slice(pair.indexOf("=") + 1);
						checked++;
						expect(value).not.toContain("\n");
						expect(Buffer.byteLength(value, "utf-8")).toBeLessThanOrEqual(META_VALUE_MAX_BYTES);
					}
				}
			}
			expect(checked).toBeGreaterThan(0);
		});
	});

	it("elides an oversized binding rather than restating the body", async () => {
		await withWorkspace(async dir => {
			const text = await structureText(dir, PATTERNS[0]!);
			// Only `BODY` is past the bound: the argument list is 34 bytes and stays,
			// as do both of `beta`'s values.
			expect(text).toContain("meta: ARGS=[one: string, ,, two: number], BODY=…, NAME=alpha");
			expect(text).toContain("meta: ARGS=[], BODY=[return 7;], NAME=beta");
			expect(text).not.toContain("const trimmed = joined.trim();, return trimmed;");
		});
	});

	it("keeps a value inside the bound", async () => {
		await withWorkspace(async dir => {
			const text = await structureText(dir, PATTERNS[1]!);
			expect(text).toContain("meta: X=trimmed");
			expect(text).toContain("meta: X=7");
			expect(text).not.toContain("X=…");
		});
	});
});
