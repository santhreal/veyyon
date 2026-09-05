import { describe, expect, it } from "bun:test";
import * as child_process from "node:child_process";
import * as path from "node:path";
import { getBundledModelReferenceIndex } from "../src/identity/bundled";
import {
	buildModelReferenceIndex,
	type ModelReferenceCandidate,
	resolveModelReference,
} from "../src/identity/reference";

const EXEC_TIMEOUT_MS = 30_000;

describe("getBundledModelReferenceIndex", () => {
	it("materializes a populated exact-id lookup over the bundled catalog", () => {
		const index = getBundledModelReferenceIndex();
		expect(index.exact.size).toBeGreaterThan(0);
		// Every exact entry keys a real bundled model whose id round-trips through
		// the same lowercase-normalized key.
		for (const [key, model] of index.exact) {
			expect(typeof model.id).toBe("string");
			expect(model.id.length).toBeGreaterThan(0);
			expect(key).toBe(key.toLowerCase());
			expect(index.exact.get(key)).toBe(model);
		}
	});

	it("memoizes: repeated calls return the identical index and inner maps", () => {
		const first = getBundledModelReferenceIndex();
		const second = getBundledModelReferenceIndex();
		expect(second).toBe(first);
		expect(second.exact).toBe(first.exact);
		expect(second.suffixAlias).toBe(first.suffixAlias);
	});
});

describe("pure candidate reference index builder and resolver", () => {
	it("indexes and resolves metadata-only candidate records without Model fields", () => {
		const candidates: ModelReferenceCandidate[] = [
			{
				id: "custom-candidate-a",
				provider: "provider-a",
				cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
			{
				id: "vendor/claude-fixture-4",
				provider: "provider-b",
				cost: { input: 3, output: 4, cacheRead: 0.5, cacheWrite: 0.5 },
				contextWindow: 200000,
				maxTokens: 8192,
			},
		];

		const index = buildModelReferenceIndex(candidates);
		expect(index.exact.get("custom-candidate-a")).toBe(candidates[0]);
		expect(index.exact.get("vendor/claude-fixture-4")).toBe(candidates[1]);
		expect(index.suffixAlias.get("claude-fixture-4")).toBe(candidates[1]);

		expect(resolveModelReference("custom-candidate-a", index)).toBe(candidates[0]);
		expect(resolveModelReference("[Proxy] claude-fixture-4", index)).toBe(candidates[1]);
		expect(resolveModelReference("claude-fixture-4-thinking", index)).toBe(candidates[1]);
		expect(resolveModelReference("unknown-model", index)).toBeUndefined();
	});

	it("preserves candidate ranking rules: contextWindow, maxTokens, cache pricing, and OpenAI preference", () => {
		// Context window priority
		const smallWindow: ModelReferenceCandidate = {
			id: "rank-test-1",
			provider: "provider-a",
			cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100000,
			maxTokens: 4096,
		};
		const largeWindow: ModelReferenceCandidate = {
			id: "rank-test-1",
			provider: "provider-b",
			cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 4096,
		};
		const index1 = buildModelReferenceIndex([smallWindow, largeWindow]);
		expect(index1.exact.get("rank-test-1")).toBe(largeWindow);

		// maxTokens priority when contextWindow equal
		const smallMax: ModelReferenceCandidate = {
			id: "rank-test-2",
			provider: "provider-a",
			cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};
		const largeMax: ModelReferenceCandidate = {
			id: "rank-test-2",
			provider: "provider-b",
			cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 16384,
		};
		const index2 = buildModelReferenceIndex([smallMax, largeMax]);
		expect(index2.exact.get("rank-test-2")).toBe(largeMax);

		// Cache pricing preference when limits equal
		const noCache: ModelReferenceCandidate = {
			id: "rank-test-3",
			provider: "provider-a",
			cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};
		const withCache: ModelReferenceCandidate = {
			id: "rank-test-3",
			provider: "provider-b",
			cost: { input: 1, output: 1, cacheRead: 0.5, cacheWrite: 0.5 },
			contextWindow: 128000,
			maxTokens: 4096,
		};
		const index3 = buildModelReferenceIndex([noCache, withCache]);
		expect(index3.exact.get("rank-test-3")).toBe(withCache);

		// First-party OpenAI tie break when all else equal
		const nonOpenai: ModelReferenceCandidate = {
			id: "rank-test-4",
			provider: "azure",
			cost: { input: 1, output: 1, cacheRead: 0.5, cacheWrite: 0.5 },
			contextWindow: 128000,
			maxTokens: 4096,
		};
		const openai: ModelReferenceCandidate = {
			id: "rank-test-4",
			provider: "openai",
			cost: { input: 1, output: 1, cacheRead: 0.5, cacheWrite: 0.5 },
			contextWindow: 128000,
			maxTokens: 4096,
		};
		const index4 = buildModelReferenceIndex([nonOpenai, openai]);
		expect(index4.exact.get("rank-test-4")).toBe(openai);

		// Zero-cost xai-oauth exclusion
		const zeroCostXai: ModelReferenceCandidate = {
			id: "grok-beta",
			provider: "xai-oauth",
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 1000000,
		};
		const paidGrok: ModelReferenceCandidate = {
			id: "grok-beta",
			provider: "xai",
			cost: { input: 5, output: 15, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 131072,
			maxTokens: 8192,
		};
		const index5 = buildModelReferenceIndex([zeroCostXai, paidGrok]);
		expect(index5.exact.get("grok-beta")).toBe(paidGrok);
	});
});

/**
 * Scalar reference lookup must preserve catalog ranking without constructing every
 * provider on a miss. Fresh processes prevent an earlier full-index lookup from
 * masking enrichment. This covers bundled records and an installed snapshot;
 * persisted snapshot validation is covered by the snapshot suite.
 */
describe("fresh-process scalar metadata resolution and corpus sweep", () => {
	it("resolves every metadata ID and marker variant BEFORE full index construction, matching identity against full index", () => {
		const script = `
			import { iterateBundledModelMetadata } from "./src/models";
			import { getBundledModelReferenceIndex, resolveBundledModelReference } from "./src/identity/bundled";
			import { resolveModelReference } from "./src/identity/reference";

			const candidates = Array.from(iterateBundledModelMetadata());
			const seenIds = new Set();
			const queries = [];

			for (const c of candidates) {
				if (seenIds.has(c.id)) continue;
				seenIds.add(c.id);

				queries.push(c.id);
				queries.push("[Kiro] " + c.id);
				queries.push(c.id + "-thinking");
				queries.push(c.id + ":cloud");
				queries.push(c.id.toUpperCase());
				queries.push("proxy/" + c.id);
			}

			const misses = [
				"completely-unknown-custom-model-404",
				"proxy/unmatched-custom-model-xyz",
				"[Custom] non-existent-model",
			];

			// 1. Resolve every query via scalar resolver BEFORE constructing full index
			const scalarMap = new Map();
			for (const q of queries) {
				scalarMap.set(q, resolveBundledModelReference(q));
			}
			const missMap = new Map();
			for (const m of misses) {
				missMap.set(m, resolveBundledModelReference(m));
			}

			// 2. Construct full index for the first time
			const fullIndex = getBundledModelReferenceIndex();

			// 3. Verify parity and collect detailed mismatch diagnostics
			const mismatches = [];

			for (const m of misses) {
				const res = missMap.get(m);
				if (res !== undefined) {
					mismatches.push({ query: m, expected: "undefined", actualId: res?.id, actualProvider: res?.provider });
				}
			}

			for (const q of queries) {
				const scalar = scalarMap.get(q);
				const full = resolveModelReference(q, fullIndex);

				if (scalar !== full) {
					mismatches.push({
						query: q,
						scalarId: scalar?.id,
						scalarProvider: scalar?.provider,
						fullId: full?.id,
						fullProvider: full?.provider,
					});
				}
			}

			process.stdout.write(JSON.stringify({
				totalCandidates: seenIds.size,
				totalQueries: queries.length,
				mismatches,
			}));
		`;

		const stdout = child_process.execFileSync(process.execPath, ["-e", script], {
			cwd: path.resolve(__dirname, ".."),
			encoding: "utf8",
			timeout: EXEC_TIMEOUT_MS,
		});

		const res = JSON.parse(stdout);
		expect(res.totalCandidates).toBeGreaterThan(0);
		expect(res.totalQueries).toBeGreaterThan(0);
		expect(res.mismatches).toEqual([]);
	});
});

describe("fresh-process buildModel instrumentation and snapshot store isolation", () => {
	it("in a cold process, a miss performs zero Model constructions and a hit enriches only the selected provider", () => {
		const script = `
			import { spyOn } from "bun:test";
			import * as buildModule from "./src/build";
			import { resolveBundledModelReference } from "./src/identity/bundled";

			const calls = [];
			const original = buildModule.buildModel;
			spyOn(buildModule, "buildModel").mockImplementation((spec) => {
				calls.push({ id: spec.id, provider: spec.provider });
				return original(spec);
			});

			// Test miss: zero model constructions
			calls.length = 0;
			const miss = resolveBundledModelReference("completely-unknown-custom-model-id");
			const missCalls = [...calls];

			// Test hit: constructions scoped strictly to the matched provider
			calls.length = 0;
			const hit = resolveBundledModelReference("claude-3-5-sonnet-20241022");
			const hitCalls = [...calls];

			process.stdout.write(JSON.stringify({
				missFound: miss !== undefined,
				missConstructionCount: missCalls.length,
				hitFound: hit !== undefined,
				hitId: hit?.id,
				hitProvider: hit?.provider,
				hitConstructionCount: hitCalls.length,
				hitNonAnthropicConstructions: hitCalls.filter(c => c.provider !== "anthropic"),
			}));
		`;

		const stdout = child_process.execFileSync(process.execPath, ["-e", script], {
			cwd: path.resolve(__dirname, ".."),
			encoding: "utf8",
			timeout: EXEC_TIMEOUT_MS,
		});

		const res = JSON.parse(stdout);
		expect(res.missFound).toBe(false);
		expect(res.missConstructionCount).toBe(0);
		expect(res.hitFound).toBe(true);
		expect(res.hitId).toBe("claude-3-5-sonnet-20241022");
		expect(res.hitProvider).toBe("anthropic");
		expect(res.hitConstructionCount).toBeGreaterThan(0);
		expect(res.hitNonAnthropicConstructions).toEqual([]);
	});

	it("in a cold process with an in-memory snapshot store, resolves references from the snapshot records", () => {
		const script = `
			import { setEnrichedRegistrySnapshotStore, enrichedRegistryFingerprint } from "./src/models";
			import { resolveBundledModelReference } from "./src/identity/bundled";
			import { buildModel } from "./src/build";

			const customSpec = {
				id: "snapshot-custom-model-id",
				name: "Snapshot Custom Model",
				provider: "custom-snapshot-provider",
				api: "openai-completions",
				baseUrl: "https://api.example.com/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 2, output: 4, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			};
			const builtModel = buildModel(customSpec);

			const snapshotMap = new Map([
				[enrichedRegistryFingerprint(), new Map([
					["custom-snapshot-provider", new Map([["snapshot-custom-model-id", builtModel]])]
				])]
			]);

			const inMemoryStore = {
				read: (fp) => snapshotMap.get(fp) ?? null,
				write: (registry, fp) => { snapshotMap.set(fp, registry); },
			};

			setEnrichedRegistrySnapshotStore(inMemoryStore);
			const resolved = resolveBundledModelReference("snapshot-custom-model-id");

			process.stdout.write(JSON.stringify({
				id: resolved?.id,
				provider: resolved?.provider,
				contextWindow: resolved?.contextWindow,
				name: resolved?.name,
			}));
		`;

		const stdout = child_process.execFileSync(process.execPath, ["-e", script], {
			cwd: path.resolve(__dirname, ".."),
			encoding: "utf8",
			timeout: EXEC_TIMEOUT_MS,
		});

		const res = JSON.parse(stdout);
		expect(res).toEqual({
			id: "snapshot-custom-model-id",
			provider: "custom-snapshot-provider",
			contextWindow: 128000,
			name: "Snapshot Custom Model",
		});
	});
});
