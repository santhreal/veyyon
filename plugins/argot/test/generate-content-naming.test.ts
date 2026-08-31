/**
 * Content-addressed handle naming (`naming: "content"`). This is the naming
 * scheme that makes one shared cache safe for several agents to regenerate at
 * once, so the property that matters is: a handle's name is a pure function of
 * its expansion. No ordering, no shared counter, no dependence on what else is
 * in the corpus. Two processes that independently learn the same string pick
 * the SAME name for it, and different strings get different names, so their
 * writes to a shared cache agree without any coordination.
 */

import { describe, expect, test } from "bun:test";
import { makeExpander } from "../src/codec.js";
import { HANDLE_NAME_RE } from "../src/constants.js";
import { generateDict } from "../src/generate.js";
import { parseDict } from "../src/parse.js";
import type { Vocabulary } from "../src/types.js";

const PATH = "packages/coding-agent/src/database/connection.ts";
const OTHER = "packages/coding-agent/src/server/routes.ts";
const THIRD = "packages/coding-agent/src/config/settings.ts";

function vocab(sigil: string, entries: Record<string, string>): Vocabulary {
	return { version: 1, sigil, handles: new Map(Object.entries(entries)), meta: new Map() };
}

function corpus(repeats: number, ...lines: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < repeats; i++) out.push(...lines);
	return out;
}

/** The name a content-generated dictionary assigns to one expansion. */
function nameFor(result: ReturnType<typeof generateDict>, expansion: string): string | undefined {
	return result.handles.find(h => h.expansion === expansion)?.name;
}

describe("content-addressed naming", () => {
	test("every content name is a valid handle name and round-trips through the codec", () => {
		const result = generateDict(corpus(5, `edit ${PATH}`, `touch ${OTHER}`), { naming: "content", minFrequency: 2 });
		expect(result.handles.length).toBeGreaterThan(0);
		const expand = makeExpander(result.vocab);
		for (const handle of result.handles) {
			expect(HANDLE_NAME_RE.test(handle.name)).toBe(true);
			expect(expand(`open §${handle.name} now`)).toBe(`open ${handle.expansion} now`);
		}
	});

	test("a name carries a readable stem drawn from the expansion", () => {
		const result = generateDict(corpus(5, `edit ${PATH}`), { naming: "content", minFrequency: 2 });
		// The stem is the last path segment: "connection.ts" -> "connec".
		expect(nameFor(result, PATH)).toMatch(/^connec_/);
	});

	test("the same expansion always gets the same name across independent calls", () => {
		// Two totally different corpora that happen to both contain PATH. The name
		// depends only on PATH, so both calls agree.
		const a = generateDict(corpus(4, `edit ${PATH}`, "some unrelated prose here"), {
			naming: "content",
			minFrequency: 2,
		});
		const b = generateDict(corpus(9, `${PATH} again`, `touch ${OTHER}`, `see ${THIRD}`), {
			naming: "content",
			minFrequency: 2,
		});
		expect(nameFor(a, PATH)).toBeDefined();
		expect(nameFor(a, PATH)).toBe(nameFor(b, PATH));
	});

	test("different expansions get different names", () => {
		const result = generateDict(corpus(5, `edit ${PATH}`, `touch ${OTHER}`, `see ${THIRD}`), {
			naming: "content",
			minFrequency: 2,
		});
		const names = result.handles.map(h => h.name);
		expect(new Set(names).size).toBe(names.length);
		expect(nameFor(result, PATH)).not.toBe(nameFor(result, OTHER));
	});

	test("two agents learning disjoint sets converge to a mergeable, self-consistent cache", () => {
		// Agent A learns PATH and OTHER; agent B learns OTHER and THIRD. They share
		// no counter and no ordering. Because names are content-addressed, the one
		// string they both learned (OTHER) gets the identical name from each, so a
		// naive union of their handles is a valid vocabulary with no collision.
		const a = generateDict(corpus(5, `edit ${PATH}`, `touch ${OTHER}`), { naming: "content", minFrequency: 2 });
		const b = generateDict(corpus(5, `touch ${OTHER}`, `see ${THIRD}`), { naming: "content", minFrequency: 2 });
		expect(nameFor(a, OTHER)).toBe(nameFor(b, OTHER));
		const merged = new Map<string, string>();
		for (const h of [...a.handles, ...b.handles]) {
			const prior = merged.get(h.name);
			// No name ever maps to two different expansions across the two caches.
			if (prior !== undefined) expect(prior).toBe(h.expansion);
			merged.set(h.name, h.expansion);
		}
		expect(merged.get(nameFor(a, PATH) as string)).toBe(PATH);
		expect(merged.get(nameFor(b, THIRD) as string)).toBe(THIRD);
	});

	test("is deterministic and re-parses", () => {
		const a = generateDict(corpus(5, `edit ${PATH}`, `touch ${OTHER}`), { naming: "content", minFrequency: 2 });
		const b = generateDict(corpus(5, `edit ${PATH}`, `touch ${OTHER}`), { naming: "content", minFrequency: 2 });
		expect(a.toml).toBe(b.toml);
		expect(() => parseDict(a.toml, "AGENTS.dict")).not.toThrow();
	});

	test("a content-named cache regenerates monotonically when fed back as pinned", () => {
		const first = generateDict(corpus(5, `edit ${PATH}`, `touch ${OTHER}`), { naming: "content", minFrequency: 2 });
		// A later commit adds THIRD; regenerate with the previous cache pinned.
		const second = generateDict(corpus(5, `edit ${PATH}`, `touch ${OTHER}`, `see ${THIRD}`, `see ${THIRD}`), {
			naming: "content",
			pinned: first.vocab,
			minFrequency: 2,
		});
		// Every earlier binding survives with its exact name...
		for (const [name, expansion] of first.vocab.handles) {
			expect(second.vocab.handles.get(name)).toBe(expansion);
		}
		// ...and the freshly learned string joins under its own content name.
		expect(nameFor(second, THIRD)).toBeDefined();
	});

	test("a pinned name is never reassigned even if a content name would collide", () => {
		// Pin the exact content name PATH would generate to a DIFFERENT expansion.
		// PATH must then be refused a second (colliding) handle, and the frozen
		// binding stays put. (Content names collide only on a hash clash, but the
		// generator must survive one regardless.)
		const probe = generateDict(corpus(3, `edit ${PATH}`), { naming: "content", minFrequency: 2 });
		const pathName = nameFor(probe, PATH);
		expect(pathName).toBeDefined();
		const pinned = vocab("§", { [pathName as string]: "a/frozen/different/thing.ts" });
		const result = generateDict(corpus(5, `edit ${PATH}`), { naming: "content", pinned, minFrequency: 2 });
		expect(result.vocab.handles.get(pathName as string)).toBe("a/frozen/different/thing.ts");
		// PATH did not overwrite the frozen name; at most it got no handle at all.
		const forPath = result.handles.filter(h => h.expansion === PATH);
		expect(forPath.length).toBeLessThanOrEqual(1);
		if (forPath[0]) expect(forPath[0].name).not.toBe(pathName);
	});
});
