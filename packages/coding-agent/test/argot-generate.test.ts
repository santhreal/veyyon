/**
 * The auto dict generator is vendored from the argot SDK, where its behavior is
 * covered in depth (ranking, budget packing, TOML escaping, determinism). These
 * tests confirm the vendored copy is REACHABLE through veyyon's import surface
 * (`argot`) and still honors the two contracts a
 * harness depends on: the emitted dictionary re-parses through the same codec,
 * and it stays under the token budget a harness reads into context.
 */

import { describe, expect, it } from "bun:test";
import { generateDict, generateDictFromRepo, makeExpander, parseDict } from "argot";

const PATH = "packages/coding-agent/src/database/connection.ts";
const CMD = "CARGO_TARGET_DIR=/dev/null bunx tsgo -p packages/coding-agent/tsconfig.json --noEmit";

function transcript(repeats: number): string[] {
	const out: string[] = [];
	for (let i = 0; i < repeats; i++) {
		out.push(`Editing ${PATH} to fix the pool size.`);
		out.push(CMD);
		out.push(`Reconnecting through ${PATH}.`);
	}
	return out;
}

describe("vendored generateDict", () => {
	it("proposes handles for the recurring strings and re-parses to an identical vocabulary", () => {
		const result = generateDict(transcript(5));
		expect(result.handles.map(h => h.expansion)).toContain(PATH);
		const reparsed = parseDict(result.toml, "AGENTS.dict");
		expect([...reparsed.handles.entries()].sort()).toEqual([...result.vocab.handles.entries()].sort());
	});

	it("defaults to a 1000-token budget and never exceeds it", () => {
		const result = generateDict(transcript(5));
		expect(result.tokenBudget).toBe(1000);
		expect(result.dictTokens).toBeLessThanOrEqual(1000);
	});

	it("the chosen handles round-trip through the codec the dictionary describes", () => {
		const result = generateDict(transcript(5));
		const expand = makeExpander(result.vocab);
		const handle = result.handles.find(h => h.expansion === PATH);
		expect(handle).toBeDefined();
		if (handle) {
			expect(expand(`open §${handle.name} now`)).toBe(`open ${PATH} now`);
		}
	});

	it("yields an empty, non-throwing dictionary for an all-prose corpus", () => {
		const result = generateDict(["nothing structured to see here", "still just words"]);
		expect(result.handles).toEqual([]);
		expect(result.toml).toBe("");
	});
});

describe("vendored generateDictFromRepo", () => {
	const FILES = [
		{ path: "packages/coding-agent/src/database/connection.ts", content: "export const url = 'x';" },
		{
			path: "packages/coding-agent/src/server/routes.ts",
			content: "import './database/connection.ts';\n// packages/coding-agent/src/database/connection.ts",
		},
	];

	it("builds a re-parseable, under-budget dictionary straight from a repo file list", () => {
		const result = generateDictFromRepo(FILES);
		expect(result.handles.map(h => h.expansion)).toContain("packages/coding-agent/src/database/connection.ts");
		expect(result.dictTokens).toBeLessThanOrEqual(1000);
		expect(() => parseDict(result.toml, "AGENTS.dict")).not.toThrow();
	});

	it("proposes a handle for a path listed just once (minFrequency defaults to 1)", () => {
		const result = generateDictFromRepo([{ path: "some/very/long/module/path/handler.ts" }]);
		expect(result.handles.map(h => h.expansion)).toContain("some/very/long/module/path/handler.ts");
	});
});
