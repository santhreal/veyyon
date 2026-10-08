/**
 * A scalar reference lookup over the bundled catalog parses the models its keys reach, never the
 * whole document.
 *
 * WHY: a custom or discovered model inherits its pricing and limits from the bundled model its id
 * resolves to, so a launch with a custom provider resolves a reference for every custom model. Each
 * first lookup parsed all of `models.json` (4,406 specs, about 49,600 objects and 4.5 MiB of heap,
 * held for the hold window) and indexed every spec, about 10 ms of the launch, to answer a handful
 * of keys.
 *
 * Class closed: a lazy index whose answer differs from the eager index for any key (a seeded sweep
 * over candidate sets built to collide: ids equal up to case across providers, ranking ties that keep
 * the earlier candidate, excluded zero-cost `xai-oauth` members first in their group, which moves the
 * group in the eager map's order, and suffix aliases shared across groups), a lazy index that reads a
 * candidate its key does not reach or reads one twice, a model-span index that is wrong for any model
 * of the committed catalog (swept from the file, so a regenerated model is covered) or whose ids are
 * not the ids the lookup ranks, a layout the model index misreads instead of refusing, a cold bundled
 * lookup that answers differently from the full index for any bundled id or proxy variant, and a cold
 * bundled lookup that falls back to a parse of the whole document.
 *
 * Not caught: a lookup made while a whole parse is held reads the held records; the existing sweep
 * in `bundled-reference-index.test.ts` covers that arm. How often a burst re-reads the file is not
 * observed.
 */
import { describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { indexCatalogModelSpans, indexCatalogSpans } from "../src/catalog-spans";
import { getLongestModelLikeIdSegment } from "../src/identity/id";
import {
	buildModelReferenceIndex,
	createLazyModelReferenceIndex,
	type ModelReferenceCandidate,
	type ModelReferenceLookup,
	resolveModelReference,
} from "../src/identity/reference";

const run = promisify(execFile);
const CATALOG_ROOT = path.join(import.meta.dirname, "..");
const MODELS_JSON = path.join(CATALOG_ROOT, "src", "models.json");
const FRESH_PROCESS_TIMEOUT_MS = 60_000;

/** What `scripts/generate-models.ts` writes. */
function generated(doc: unknown): Buffer {
	return Buffer.from(JSON.stringify(doc, null, "\t"));
}

/** Every model span parses to the model a whole-document parse enumerates at that ordinal. */
function modelSpansRoundTrip(bytes: Buffer): void {
	const spans = indexCatalogSpans(bytes);
	expect(spans).not.toBeNull();
	const models = indexCatalogModelSpans(bytes, spans!);
	expect(models).not.toBeNull();
	const whole = JSON.parse(bytes.toString("utf8")) as Record<string, Record<string, unknown>>;
	const expected = Object.values(whole).flatMap(provider => Object.entries(provider));
	expect(models!.ids).toEqual(expected.map(([id]) => id));
	expect(models!.starts.length).toBe(expected.length);
	expect(models!.ends.length).toBe(expected.length);
	for (let ordinal = 0; ordinal < expected.length; ordinal++) {
		const text = bytes.toString("utf8", models!.starts[ordinal], models!.ends[ordinal]);
		expect(JSON.parse(text)).toEqual(expected[ordinal]![1]);
	}
}

describe("the model-span index of the committed catalog", () => {
	const bytes = readFileSync(MODELS_JSON);

	it("indexes every model, each span parsing to that model of the whole document, in its order", () => {
		modelSpansRoundTrip(bytes);
	});

	it("keys every model by the id the reference lookup ranks it under", () => {
		const whole = JSON.parse(bytes.toString("utf8")) as Record<string, Record<string, { id: string }>>;
		const mismatched = Object.values(whole).flatMap(provider =>
			Object.entries(provider).filter(([key, spec]) => spec.id !== key),
		);
		expect(mismatched).toEqual([]);
	});
});

describe("a model-span index of a catalog in the generator's layout", () => {
	const cases: Record<string, unknown> = {
		"no providers": {},
		"an empty provider": { empty: {} },
		"an empty model object": { a: { x: {}, y: { id: "y" } } },
		"empty providers around models": { e1: {}, a: { x: { id: "x" } }, e2: {}, b: { y: { id: "y" } }, e3: {} },
		"keys and values that imitate the layout": {
			p: {
				'm": {\n\t\t}': { name: 'a "quoted" \\ value\n\t\t}\n\t}', tags: ['\n\t\t"x": {', "\t\t}"] },
				"back\\slash\\": { nested: { deeper: {}, list: [{ a: "\n\t\t}," }] } },
			},
		},
		"unicode keys": { "ünïcödé ✓": { 模型: { name: "café" }, "ascii-after": {} } },
	};
	for (const [name, doc] of Object.entries(cases)) {
		it(`indexes ${name}`, () => {
			modelSpansRoundTrip(generated(doc));
		});
	}
});

describe("a model-span index of a catalog whose enumeration a scan cannot reproduce", () => {
	const rejected: Record<string, string> = {
		"a duplicate model key": `{\n\t"a": {\n\t\t"x": {},\n\t\t"x": {}\n\t}\n}`,
		"an array-index model key after another key": `{\n\t"a": {\n\t\t"x": {},\n\t\t"7": {}\n\t}\n}`,
		"an array-index model key alone": `{\n\t"a": {\n\t\t"0": {}\n\t}\n}`,
		"an array-index provider key": `{\n\t"5": {\n\t\t"x": {}\n\t}\n}`,
		"a model on one line": `{\n\t"a": {\n\t\t"x": {"id": "x"}\n\t}\n}`,
		"a model that is not an object": `{\n\t"a": {\n\t\t"x": 1\n\t}\n}`,
		"a model key at the wrong depth": `{\n\t"a": {\n\t\t\t"x": {}\n\t}\n}`,
		"a model whose brace closes past its provider": `{\n\t"a": {\n\t\t"x": {\n\t}\n}`,
		"a model whose brace is found in the next provider": `{\n\t"a": {\n\t\t"x": {\n\t},\n\t"b": {\n\t\t"y": {\n\t\t\t"id": "y"\n\t\t},\n\t\t"z": {}\n\t}\n}`,
	};
	for (const [name, text] of Object.entries(rejected)) {
		it(`refuses ${name}`, () => {
			const bytes = Buffer.from(text);
			const spans = indexCatalogSpans(bytes);
			// Either level may refuse; a refused provider index leaves nothing to scan.
			expect(spans === null ? null : indexCatalogModelSpans(bytes, spans)).toBeNull();
		});
	}
});

/** A deterministic 32-bit generator, so a failing seed reproduces. */
function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const PREFIXES = ["", "vendor/", "Vendor/", "other/", "a/b/", " "];
const BASES = ["claude-x-1", "Claude-X-1", "gpt-4o", "gpt-4o-mini", "llama-3", "grok-2", "plain", "CLAUDE-x-1"];
const SUFFIXES = ["", "-thinking", ":free", " "];
const PROVIDERS = ["openai", "azure", "xai-oauth", "xai", "p1"];
const WINDOWS = [undefined, 100, 200, null];
const MAX_TOKENS = [undefined, 10, 20];

function pick<T>(random: () => number, values: readonly T[]): T {
	return values[Math.floor(random() * values.length)]!;
}

/** Candidates built to collide on every ranking rule and on group and alias order. */
function collidingCandidates(seed: number): ModelReferenceCandidate[] {
	const random = mulberry32(seed);
	const candidates: ModelReferenceCandidate[] = [];
	const count = 20 + Math.floor(random() * 200);
	for (let i = 0; i < count; i++) {
		const free = random() < 0.4;
		const cached = random() < 0.4;
		candidates.push({
			id: pick(random, PREFIXES) + pick(random, BASES) + pick(random, SUFFIXES),
			provider: pick(random, PROVIDERS),
			cost: {
				input: free ? 0 : 1,
				output: free ? 0 : 2,
				cacheRead: free ? 0 : cached ? 0.5 : 0,
				cacheWrite: free ? 0 : cached ? 0.5 : 0,
			},
			// `models.json` writes an unknown limit as null; the eager index compares it as given.
			contextWindow: pick(random, WINDOWS) as number | undefined,
			maxTokens: pick(random, MAX_TOKENS),
		});
	}
	return candidates;
}

describe("the lazy reference index", () => {
	const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);

	it("answers every exact key and suffix alias as the eager index does", () => {
		const mismatches: string[] = [];
		for (const seed of SEEDS) {
			const candidates = collidingCandidates(seed);
			const eager = buildModelReferenceIndex(candidates);
			const lazy = createLazyModelReferenceIndex(
				candidates.map(candidate => candidate.id),
				ordinal => candidates[ordinal]!,
			);
			const keys = new Set<string>([...eager.exact.keys(), ...eager.suffixAlias.keys()]);
			for (const candidate of candidates) {
				keys.add(candidate.id.trim().toLowerCase());
				keys.add(candidate.id);
			}
			for (const prefix of PREFIXES) for (const base of BASES) keys.add((prefix + base).trim().toLowerCase());
			keys.add("absent-key");
			for (const key of keys) {
				if (lazy.exact.get(key) !== eager.exact.get(key))
					mismatches.push(`seed ${seed} exact ${JSON.stringify(key)}`);
				if (lazy.suffixAlias.get(key) !== eager.suffixAlias.get(key)) {
					mismatches.push(`seed ${seed} alias ${JSON.stringify(key)}`);
				}
			}
			for (const candidate of candidates) {
				for (const query of [candidate.id, `[Kiro] ${candidate.id}`, `proxy/${candidate.id}:cloud`]) {
					if (resolveModelReference(query, lazy) !== resolveModelReference(query, eager)) {
						mismatches.push(`seed ${seed} resolve ${JSON.stringify(query)}`);
					}
				}
			}
		}
		expect(mismatches).toEqual([]);
	});

	it("reads only the candidates a key reaches, each at most once", () => {
		const overreads: string[] = [];
		const groupOf = (id: string): string => id.trim().toLowerCase();
		const aliasOf = (id: string): string | undefined => {
			const slash = id.lastIndexOf("/");
			return slash === -1 ? undefined : getLongestModelLikeIdSegment(id.slice(slash + 1));
		};
		for (const seed of SEEDS) {
			const candidates = collidingCandidates(seed);
			const ids = candidates.map(candidate => candidate.id);
			/** A fresh index per phase, so one phase's reads cannot hide the next one's. */
			const instrumented = (): { lazy: ModelReferenceLookup<ModelReferenceCandidate>; reads: number[] } => {
				const reads: number[] = [];
				const lazy = createLazyModelReferenceIndex(ids, ordinal => {
					reads.push(ordinal);
					return candidates[ordinal]!;
				});
				return { lazy, reads };
			};
			const checkReads = (reads: readonly number[], phase: string, reached: (ordinal: number) => boolean): void => {
				if (new Set(reads).size !== reads.length) overreads.push(`seed ${seed} ${phase} read a candidate twice`);
				for (const ordinal of reads) {
					if (!reached(ordinal)) overreads.push(`seed ${seed} ${phase} read ${ordinal}`);
				}
			};

			const exact = instrumented();
			expect(exact.reads).toEqual([]);
			for (const key of new Set(ids.map(groupOf))) {
				const from = exact.reads.length;
				exact.lazy.exact.get(key);
				checkReads(
					exact.reads.slice(from),
					`exact ${JSON.stringify(key)}`,
					ordinal => groupOf(ids[ordinal]!) === key,
				);
			}
			const aliases = new Set(ids.map(aliasOf).filter(alias => alias !== undefined));
			// Every lookup again, exact and alias, on the same index: everything it needs is already read.
			for (const key of new Set(ids.map(groupOf))) exact.lazy.exact.get(key);
			for (const key of aliases) exact.lazy.suffixAlias.get(key);
			checkReads(exact.reads, "exact phase and repeat", () => true);

			for (const key of aliases) {
				const alias = instrumented();
				alias.lazy.suffixAlias.get(key);
				// A group is reached when one of its members has the key as its own alias.
				const reachedGroups = new Set(ids.filter(id => aliasOf(id) === key).map(groupOf));
				checkReads(alias.reads, `alias ${JSON.stringify(key)}`, ordinal =>
					reachedGroups.has(groupOf(ids[ordinal]!)),
				);
			}

			const miss = instrumented();
			miss.lazy.exact.get("absent-key");
			miss.lazy.suffixAlias.get("absent-key");
			checkReads(miss.reads, "miss", () => false);
		}
		expect(overreads).toEqual([]);
	});
});

describe("a cold bundled reference lookup in a fresh process", () => {
	const bytes = readFileSync(MODELS_JSON);
	const providerSpans = indexCatalogSpans(bytes)!;
	const modelSpans = indexCatalogModelSpans(bytes, providerSpans)!;
	const anthropic = providerSpans.get("anthropic")!;
	/** The longest parse the provider index makes of its own: a provider key literal. */
	const longestKeyLiteral = Math.max(...Array.from(providerSpans.keys(), key => JSON.stringify(key).length));
	const HIT_ID = "claude-3-5-sonnet-20241022";
	const byLength = (left: number, right: number): number => left - right;

	it(
		"answers every bundled id and proxy variant as the full index does, before any whole parse",
		async () => {
			const script = `
				import { readFileSync } from "node:fs";
				import { getBundledModelReferenceIndex, resolveBundledModelReference } from "./src/identity/bundled";
				import { resolveModelReference } from "./src/identity/reference";
				const whole = JSON.parse(readFileSync("./src/models.json", "utf8"));
				const queries = [];
				for (const provider of Object.values(whole)) {
					for (const id of Object.keys(provider)) {
						queries.push(id, "[Kiro] " + id, id + "-thinking", id + ":cloud", id.toUpperCase(), "proxy/" + id);
					}
				}
				queries.push("completely-unknown-custom-model-404", "proxy/unmatched-custom-model-xyz");
				const scalar = queries.map(query => resolveBundledModelReference(query));
				const full = getBundledModelReferenceIndex();
				const mismatches = [];
				queries.forEach((query, i) => {
					const expected = resolveModelReference(query, full);
					if (scalar[i] !== expected) mismatches.push({ query, scalar: scalar[i]?.provider + "/" + scalar[i]?.id, full: expected?.provider + "/" + expected?.id });
				});
				process.stdout.write(JSON.stringify({ queries: queries.length, hits: scalar.filter(Boolean).length, mismatches }));
			`;
			const { stdout } = await run(process.execPath, ["-e", script], {
				cwd: CATALOG_ROOT,
				timeout: FRESH_PROCESS_TIMEOUT_MS - 5_000,
				killSignal: "SIGKILL",
			});
			const result = JSON.parse(stdout) as { queries: number; hits: number; mismatches: unknown[] };
			expect(result.queries).toBe(modelSpans.ids.length * 6 + 2);
			expect(result.hits).toBeGreaterThan(modelSpans.ids.length);
			expect(result.mismatches).toEqual([]);
		},
		FRESH_PROCESS_TIMEOUT_MS,
	);

	it(
		"parses no model on a miss, and on a hit only the models its key reaches and the matched provider",
		async () => {
			const script = `
				const parse = JSON.parse;
				let lengths = [];
				JSON.parse = (text, reviver) => { lengths.push(String(text).length); return parse(text, reviver); };
				const { resolveBundledModelReference } = await import("./src/identity/bundled");
				const miss = resolveBundledModelReference("completely-unknown-custom-model-404");
				const missLengths = lengths;
				lengths = [];
				await Promise.resolve();
				const hit = resolveBundledModelReference("[Kiro] ${HIT_ID}");
				process.stdout.write(JSON.stringify({ miss: miss?.id ?? null, missLengths, hit: hit?.provider + "/" + hit?.id, hitLengths: lengths }));
			`;
			const { stdout } = await run(process.execPath, ["-e", script], {
				cwd: CATALOG_ROOT,
				timeout: FRESH_PROCESS_TIMEOUT_MS - 5_000,
				killSignal: "SIGKILL",
			});
			const result = JSON.parse(stdout) as {
				miss: string | null;
				missLengths: number[];
				hit: string;
				hitLengths: number[];
			};
			expect(result.miss).toBeNull();
			expect(result.hit).toBe(`anthropic/${HIT_ID}`);
			expect(result.missLengths.filter(length => length > longestKeyLiteral)).toEqual([]);
			const reached = modelSpans.ids.flatMap((id, ordinal) =>
				id.toLowerCase() === HIT_ID ? [modelSpans.ends[ordinal]! - modelSpans.starts[ordinal]!] : [],
			);
			expect(reached.length).toBeGreaterThan(0);
			expect(result.hitLengths.filter(length => length > longestKeyLiteral).sort(byLength)).toEqual(
				[...reached, anthropic.end - anthropic.start].sort(byLength),
			);
		},
		FRESH_PROCESS_TIMEOUT_MS,
	);
});
