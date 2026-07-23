/**
 * Property fuzz for the auto dict generator. The unit tests in generate.test.ts
 * pin specific behaviors; these assert the two guarantees that must hold for
 * EVERY input, or a harness could ship a dictionary the loader rejects or one
 * that blows its context budget:
 *
 *   1. The emitted TOML always re-parses to the same vocabulary (round-trip).
 *   2. The dictionary never exceeds the requested token budget.
 *
 * Both are checked over thousands of random corpora and budgets. The generator
 * is deterministic, so the seeded fuzzer reproduces any failure from its seed.
 */

import { describe, expect, test } from "bun:test";
import { HANDLE_NAME_RE, MAX_EXPANSION_BYTES } from "../src/constants.js";
import { generateDict, generateDictFromRepo, type RepoFile } from "../src/generate.js";
import { parseDict } from "../src/parse.js";

const SEED = 0x1b873593;
const utf8 = new TextEncoder();

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function pick<T>(rand: () => number, xs: readonly T[]): T {
	return xs[Math.floor(rand() * xs.length)] as T;
}

const SEGMENTS = [
	"packages",
	"src",
	"server",
	"coding-agent",
	"database",
	"connection",
	"migrations",
	"handler",
	"routes",
	"index",
	"config",
	"app",
	"module",
	"deep",
	"very",
	"x",
	"y",
	"z",
];
const COMMANDS = [
	"bunx tsgo --noEmit",
	"CARGO_TARGET_DIR=/dev/null bun test",
	"git commit -m 'wip'",
	"psql --host localhost",
	"npm run build --workspaces",
];
const PROSE = [
	"fix the pool size",
	"reconnect and retry",
	"just some ordinary words here",
	"the quick brown fox",
	"nothing structured at all",
];

function randomPath(rand: () => number): string {
	const depth = 2 + Math.floor(rand() * 5);
	const parts: string[] = [];
	for (let i = 0; i < depth; i++) parts.push(pick(rand, SEGMENTS));
	return `${parts.join("/")}.ts`;
}

/** A random corpus: a mix of recurring paths, commands, and prose lines. */
function randomCorpus(rand: () => number): string[] {
	const lines: number = 3 + Math.floor(rand() * 40);
	// A small pool of paths so some of them actually recur (that is what earns a handle).
	const pool = Array.from({ length: 1 + Math.floor(rand() * 6) }, () => randomPath(rand));
	const out: string[] = [];
	for (let i = 0; i < lines; i++) {
		const r = rand();
		if (r < 0.5) out.push(`edit ${pick(rand, pool)} now`);
		else if (r < 0.7) out.push(pick(rand, COMMANDS));
		else if (r < 0.85) out.push(pick(rand, pool));
		else out.push(pick(rand, PROSE));
	}
	return out;
}

/** Assert every generator guarantee for one result. */
function assertGuarantees(result: ReturnType<typeof generateDict>, budget: number, caseId: number): void {
	// Budget is never exceeded.
	if (result.dictTokens > budget) {
		throw new Error(`case ${caseId}: dictTokens ${result.dictTokens} > budget ${budget}`);
	}
	// Empty result is the empty string, and re-parses to nothing.
	if (result.handles.length === 0) {
		expect(result.toml).toBe("");
		return;
	}
	// Round-trip: the emitted TOML re-parses to the same vocabulary.
	const reparsed = parseDict(result.toml, "AGENTS.dict");
	expect(reparsed.sigil).toBe(result.vocab.sigil);
	expect([...reparsed.handles.entries()].sort()).toEqual([...result.vocab.handles.entries()].sort());
	// Every handle is well formed: valid name, sigil-free non-empty expansion within the byte limit.
	const names = new Set<string>();
	for (const h of result.handles) {
		expect(HANDLE_NAME_RE.test(h.name)).toBe(true);
		expect(names.has(h.name)).toBe(false);
		names.add(h.name);
		expect(h.expansion.length).toBeGreaterThan(0);
		expect(h.expansion).not.toContain(result.vocab.sigil);
		expect(utf8.encode(h.expansion).length).toBeLessThanOrEqual(MAX_EXPANSION_BYTES);
	}
	// Handles are ordered by estimated savings, highest first.
	for (let i = 1; i < result.handles.length; i++) {
		const prev = result.handles[i - 1];
		const cur = result.handles[i];
		if (prev && cur) expect(prev.savedTokens).toBeGreaterThanOrEqual(cur.savedTokens);
	}
}

describe("generateDict property fuzz", () => {
	test("every generated dictionary re-parses and stays under budget across 2000 random corpora", () => {
		const rand = mulberry32(SEED);
		for (let n = 0; n < 2000; n++) {
			const corpus = randomCorpus(rand);
			const budget = 40 + Math.floor(rand() * 2000);
			const result = generateDict(corpus, { tokenBudget: budget });
			assertGuarantees(result, budget, n);
		}
	});

	test("is deterministic: the same corpus and budget yield identical TOML", () => {
		const rand = mulberry32(SEED ^ 0x99);
		for (let n = 0; n < 500; n++) {
			const corpus = randomCorpus(rand);
			const budget = 100 + Math.floor(rand() * 1500);
			const a = generateDict(corpus, { tokenBudget: budget });
			const b = generateDict(corpus, { tokenBudget: budget });
			expect(a.toml).toBe(b.toml);
			expect(a.handles).toEqual(b.handles);
		}
	});
});

describe("generateDictFromRepo property fuzz", () => {
	test("every repo-derived dictionary re-parses and stays under budget", () => {
		const rand = mulberry32(SEED ^ 0xabcd);
		for (let n = 0; n < 1000; n++) {
			const fileCount = 1 + Math.floor(rand() * 12);
			const files: RepoFile[] = Array.from({ length: fileCount }, () => {
				const path = randomPath(rand);
				// Half the files carry content that references other paths.
				return rand() < 0.5 ? { path } : { path, content: `import '${randomPath(rand)}';\n// ${path}` };
			});
			const budget = 40 + Math.floor(rand() * 2000);
			const result = generateDictFromRepo(files, { tokenBudget: budget });
			assertGuarantees(result, budget, n);
		}
	});
});
