/**
 * Monotonic regeneration: generateDict with a `pinned` vocabulary. This is what
 * makes the generated dictionary safe to treat as a regenerating local cache —
 * a handle already taught to the model must keep its exact meaning forever, or
 * text that used it stops expanding. The invariants under test:
 *
 *   - every pinned name -> expansion survives verbatim, even absent from the corpus;
 *   - a pinned name is never reassigned to a different expansion;
 *   - a pinned expansion never gets a second handle;
 *   - new handles are added alongside the frozen base (the cache grows);
 *   - pinned entries are retained even past the budget and past maxHandles;
 *   - the pinned sigil is authoritative;
 *   - regeneration is a stable fixpoint and grows monotonically over "commits".
 */

import { describe, expect, test } from "bun:test";
import { makeExpander } from "../src/codec.js";
import { generateDict } from "../src/generate.js";
import { parseDict } from "../src/parse.js";
import type { Vocabulary } from "../src/types.js";

function vocab(sigil: string, entries: Record<string, string>): Vocabulary {
	return { version: 1, sigil, handles: new Map(Object.entries(entries)), meta: new Map() };
}

const PATH = "packages/coding-agent/src/database/connection.ts";
const OTHER = "packages/coding-agent/src/server/routes.ts";

function corpus(repeats: number, ...lines: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < repeats; i++) out.push(...lines);
	return out;
}

describe("generateDict with pinned bindings (monotonic regeneration)", () => {
	test("keeps every pinned binding verbatim even when the corpus never mentions it", () => {
		const pinned = vocab("§", { dbconn: PATH, gone: "a/deleted/path/removed.ts" });
		const result = generateDict(["nothing structured here", "still just words"], { pinned });
		const map = new Map(result.handles.map(h => [h.name, h.expansion]));
		expect(map.get("dbconn")).toBe(PATH);
		expect(map.get("gone")).toBe("a/deleted/path/removed.ts");
	});

	test("the emitted TOML re-parses to a vocabulary containing every pinned binding", () => {
		const pinned = vocab("§", { dbconn: PATH });
		const result = generateDict(corpus(5, `touch ${OTHER}`, `touch ${OTHER}`), { pinned });
		const reparsed = parseDict(result.toml, "AGENTS.dict");
		expect(reparsed.handles.get("dbconn")).toBe(PATH);
		// And the round-trip is exact for the whole vocabulary.
		expect([...reparsed.handles.entries()].sort()).toEqual([...result.vocab.handles.entries()].sort());
	});

	test("never reassigns a pinned name that a new expansion would otherwise claim", () => {
		// The mnemonic name for "…/database.ts" is "databa"; pin that name to a
		// different string. The new path must get a different name, not clobber it.
		const pinned = vocab("§", { databa: "the/other/frozen/thing.ts" });
		const result = generateDict(corpus(4, "x/y/database.ts twice", "x/y/database.ts again"), {
			pinned,
			minFrequency: 2,
		});
		const map = new Map(result.handles.map(h => [h.name, h.expansion]));
		expect(map.get("databa")).toBe("the/other/frozen/thing.ts");
		const newHandle = result.handles.find(h => h.expansion === "x/y/database.ts");
		expect(newHandle).toBeDefined();
		expect(newHandle?.name).not.toBe("databa");
		// Every name is still unique.
		expect(new Set(result.handles.map(h => h.name)).size).toBe(result.handles.length);
	});

	test("never gives a pinned expansion a second handle", () => {
		const pinned = vocab("§", { p: PATH });
		// The corpus repeats the already-pinned path many times; it must not earn a
		// second, differently-named handle.
		const result = generateDict(corpus(6, `open ${PATH}`), { pinned, minFrequency: 2 });
		const forPath = result.handles.filter(h => h.expansion === PATH);
		expect(forPath.length).toBe(1);
		expect(forPath[0]?.name).toBe("p");
	});

	test("adds new handles alongside the frozen base (the cache grows)", () => {
		const pinned = vocab("§", { dbconn: PATH });
		const result = generateDict(corpus(5, `touch ${OTHER}`, `touch ${OTHER}`), { pinned, minFrequency: 2 });
		const expansions = result.handles.map(h => h.expansion);
		expect(expansions).toContain(PATH); // pinned
		expect(expansions).toContain(OTHER); // newly learned
		expect(result.handles.length).toBeGreaterThan(1);
	});

	test("the pinned sigil is authoritative and overrides the sigil option", () => {
		const pinned = vocab("@@", { dbconn: PATH });
		const result = generateDict([`edit ${OTHER}`], { pinned, sigil: "§" });
		expect(result.vocab.sigil).toBe("@@");
		expect(result.toml).toContain('sigil = "@@"');
		const expand = makeExpander(result.vocab);
		expect(expand("@@dbconn")).toBe(PATH);
	});

	test("retains all pinned entries even when they exceed a tiny budget, adding nothing new", () => {
		const pinned = vocab("§", { a: PATH, b: OTHER, c: "packages/coding-agent/src/config/settings.ts" });
		const result = generateDict(
			corpus(5, "touch some/new/frequent/path/module.ts twice", "touch some/new/frequent/path/module.ts again"),
			{
				pinned,
				tokenBudget: 20,
				minFrequency: 2,
			},
		);
		const map = new Map(result.handles.map(h => [h.name, h.expansion]));
		expect(map.get("a")).toBe(PATH);
		expect(map.get("b")).toBe(OTHER);
		expect(map.get("c")).toBe("packages/coding-agent/src/config/settings.ts");
		// No room for new handles under the tiny budget, but the base is intact.
		expect(result.handles.length).toBe(3);
		// And it still re-parses despite exceeding the budget.
		expect(() => parseDict(result.toml, "AGENTS.dict")).not.toThrow();
	});

	test("maxHandles never drops a pinned entry to meet the cap", () => {
		const pinned = vocab("§", { a: PATH, b: OTHER });
		const result = generateDict(corpus(5, "touch some/new/path/here.ts twice", "touch some/new/path/here.ts again"), {
			pinned,
			maxHandles: 1,
			minFrequency: 2,
		});
		// Two pinned entries survive even though maxHandles is 1; the cap only bounds
		// new additions, and it cannot evict a taught handle.
		expect(result.handles.length).toBe(2);
		expect(result.handles.map(h => h.expansion).sort()).toEqual([PATH, OTHER].sort());
	});

	test("numeric naming continues past the largest pinned number", () => {
		const pinned = vocab("§", { "1": PATH, "2": OTHER });
		const result = generateDict(corpus(4, "touch a/b/c/deep/module.ts twice", "touch a/b/c/deep/module.ts again"), {
			pinned,
			naming: "numeric",
			minFrequency: 2,
		});
		const newHandle = result.handles.find(h => h.expansion === "a/b/c/deep/module.ts");
		expect(newHandle).toBeDefined();
		// The new numeric name must not collide with pinned "1"/"2".
		expect(["1", "2"]).not.toContain(newHandle?.name);
		expect(Number(newHandle?.name)).toBeGreaterThanOrEqual(3);
	});

	test("regenerating with the previous result as pinned is a stable fixpoint", () => {
		const first = generateDict(corpus(5, `edit ${PATH}`, `edit ${PATH}`, `touch ${OTHER}`, `touch ${OTHER}`));
		expect(first.handles.length).toBeGreaterThan(0);
		// Feed the result back as the frozen base over the same corpus: nothing new
		// to learn, nothing dropped, so the vocabulary is unchanged.
		const second = generateDict(corpus(5, `edit ${PATH}`, `edit ${PATH}`, `touch ${OTHER}`, `touch ${OTHER}`), {
			pinned: first.vocab,
		});
		expect([...second.vocab.handles.entries()].sort()).toEqual([...first.vocab.handles.entries()].sort());
	});

	test("across a growing corpus every earlier binding is preserved (monotonic superset)", () => {
		const v1 = generateDict(corpus(5, `edit ${PATH}`, `edit ${PATH}`));
		expect(v1.handles.map(h => h.expansion)).toContain(PATH);
		// A later "commit" adds a new recurring path; regenerate monotonically.
		const v2 = generateDict(corpus(5, `edit ${PATH}`, `edit ${PATH}`, `touch ${OTHER}`, `touch ${OTHER}`), {
			pinned: v1.vocab,
			minFrequency: 2,
		});
		// Every v1 binding is still present, unchanged.
		for (const [name, expansion] of v1.vocab.handles) {
			expect(v2.vocab.handles.get(name)).toBe(expansion);
		}
		// And the new path was learned on top.
		expect(v2.handles.map(h => h.expansion)).toContain(OTHER);
	});
});
