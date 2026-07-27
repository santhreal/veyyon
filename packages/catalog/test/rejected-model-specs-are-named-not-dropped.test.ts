/**
 * A model spec the manager cannot use must be reported by id and field, and a payload where NOTHING
 * survives must not be recorded as a successful discovery.
 *
 * WHY THIS SUITE EXISTS. `normalizeModelList` ran every discovered spec through a boolean gate and
 * `continue`d past whatever failed it, with no report of any kind. That gate is strict: `cost` must carry all
 * four of `input`, `output`, `cacheRead` and `cacheWrite` as finite numbers, `contextWindow` and `maxTokens`
 * must be finite positive numbers or null, `input` must be a non-empty array of "text"/"image". So a provider
 * that answered 200 with a real model list whose cost omitted `cacheRead`, or whose `contextWindow` arrived
 * as the string "8192", produced an EMPTY catalog while the fetch counted as a success: the discovery-failure
 * channel stayed quiet, an AUTHORITATIVE cache row was written from the empty merge, and the user got a model
 * picker with nothing in it and nothing anywhere saying why. The next run then trusted that cache and did not
 * even retry.
 *
 * Two things are pinned here. First, every rejected spec is named with the id it claimed and the exact field
 * that disqualified it, because "the picker is empty" and "this provider renamed a cost field" are the same
 * symptom otherwise. Second, a wholly rejected payload is reported as a `payload` failure and treated as "no
 * models from this source" rather than as an empty success, so the cache stays non-authoritative and the
 * merge falls back to the static catalog.
 *
 * The partial case matters just as much in the other direction: one bad spec among good ones must NOT
 * discard the good ones. A fix that failed closed on any rejection would break every provider that ships one
 * malformed entry, which is why that case is asserted alongside.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DiscoveryFailure } from "../src/discovery/failure";
import { readModelCache } from "../src/model-cache";
import { createModelManager } from "../src/model-manager";
import type { Api, ModelSpec } from "../src/types";

/** A spec that passes every check, used as the baseline to mutate one field at a time. */
function goodSpec(id: string): ModelSpec<"openai-completions"> {
	return {
		id,
		name: `Model ${id}`,
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://models.example.com",
		reasoning: false,
		contextWindow: 8192,
		maxTokens: 1024,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} as ModelSpec<"openai-completions">;
}

/** The same spec with one field replaced by something the gate rejects. */
function specWithout(id: string, mutate: (spec: Record<string, unknown>) => void): ModelSpec<"openai-completions"> {
	const spec = goodSpec(id) as unknown as Record<string, unknown>;
	mutate(spec);
	return spec as unknown as ModelSpec<"openai-completions">;
}

interface RefreshOutcome {
	failures: DiscoveryFailure[];
	modelIds: string[];
	/** The cache row after the refresh, which is what the NEXT run trusts or retries past. */
	cache: { models: number; authoritative: boolean } | null;
	stale: boolean;
}

/**
 * Refresh once through the real manager and report what the operator and the next run would see.
 *
 * Each call gets its own cache database, because the manager skips the network entirely when a fresh
 * authoritative cache exists and a shared database would let a later case pass without a fetch.
 */
async function refresh(specs: readonly ModelSpec<"openai-completions">[]): Promise<RefreshOutcome> {
	const failures: DiscoveryFailure[] = [];
	const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "veyyon-catalog-rejected-")), "models.db");
	const manager = createModelManager<Api>({
		providerId: "openai",
		staticModels: [],
		cacheDbPath: dbPath,
		fetchDynamicModels: async () => specs as unknown as readonly ModelSpec<Api>[],
		onDiscoveryFailure: failure => failures.push(failure),
	});
	const result = await manager.refresh("online");
	const cache = readModelCache<Api>("openai", 60_000, () => Date.now(), dbPath);
	return {
		failures,
		modelIds: result.models.map(model => model.id),
		cache: cache ? { models: cache.models.length, authoritative: cache.authoritative } : null,
		stale: result.stale,
	};
}

/** The one `payload` failure a rejected list produces. */
function payloadFailure(failures: DiscoveryFailure[]): DiscoveryFailure {
	const found = failures.filter(failure => failure.stage === "payload");
	if (found.length !== 1) throw new Error(`expected exactly one payload failure, got ${found.length}`);
	return found[0] as DiscoveryFailure;
}

describe("a payload whose specs are all rejected", () => {
	/**
	 * The regression, in the exact shape that produced it: a `cost` missing `cacheRead`. The report has to
	 * name the field, because the field name is what tells an operator this is a payload drift.
	 */
	it("reports the model id and the missing cost field", async () => {
		const outcome = await refresh([
			specWithout("gpt-x", spec => (spec.cost = { input: 1, output: 2, cacheWrite: 3 })),
		]);

		expect(payloadFailure(outcome.failures).detail).toContain("gpt-x");
		expect(payloadFailure(outcome.failures).detail).toContain("cost.cacheRead");
	});

	/** And it says how much of the payload was lost, not merely that something was. */
	it("reports how many of how many were rejected", async () => {
		const outcome = await refresh([
			specWithout("a", spec => (spec.contextWindow = "8192")),
			specWithout("b", spec => (spec.contextWindow = "8192")),
		]);

		expect(payloadFailure(outcome.failures).detail).toContain("2 of 2 models rejected");
		expect(payloadFailure(outcome.failures).detail).toContain("contextWindow");
	});

	/**
	 * The consequence that made this worse than a missing log line: an empty result used to be a SUCCESS, so
	 * the manager wrote an authoritative cache row from it and the next run trusted the empty catalog instead
	 * of retrying. The row must stay non-authoritative.
	 */
	it("does not leave an authoritative cache row", async () => {
		const outcome = await refresh([specWithout("gpt-x", spec => delete spec.reasoning)]);

		expect(outcome.cache?.authoritative).toBe(false);
		expect(outcome.stale).toBe(true);
	});

	/** A spec so broken it has no usable id is still reported, rather than counted and forgotten. */
	it("names a spec that has no id at all", async () => {
		const outcome = await refresh([specWithout("ignored", spec => (spec.id = ""))]);

		expect(payloadFailure(outcome.failures).detail).toContain("<no id>");
		expect(payloadFailure(outcome.failures).detail).toContain("(id)");
	});

	/** Each rejectable field is named by its own name, so the report points at the right part of the payload. */
	it("names the specific field for each kind of rejection", async () => {
		const cases: Array<[string, (spec: Record<string, unknown>) => void]> = [
			["name", spec => (spec.name = "")],
			["api", spec => (spec.api = "")],
			["provider", spec => (spec.provider = "")],
			["baseUrl", spec => (spec.baseUrl = "")],
			["reasoning", spec => (spec.reasoning = "no")],
			["input", spec => (spec.input = [])],
			["cost", spec => (spec.cost = "free")],
			["cost.output", spec => (spec.cost = { input: 1, cacheRead: 0, cacheWrite: 0 })],
			["cost.cacheWrite", spec => (spec.cost = { input: 1, output: 1, cacheRead: 0 })],
			["contextWindow", spec => (spec.contextWindow = Number.NaN)],
			["maxTokens", spec => (spec.maxTokens = 0)],
		];

		for (const [field, mutate] of cases) {
			const outcome = await refresh([specWithout("m", mutate)]);
			expect(payloadFailure(outcome.failures).detail).toContain(`(${field})`);
		}
	});
});

describe("a payload with one bad spec among good ones", () => {
	/** The good models must still arrive. Failing the whole list closed would break any provider with one bad entry. */
	it("keeps every usable model", async () => {
		const outcome = await refresh([
			goodSpec("one"),
			specWithout("bad", spec => (spec.maxTokens = -1)),
			goodSpec("two"),
		]);

		expect(outcome.modelIds.sort()).toEqual(["one", "two"]);
	});

	/** Only the bad one is named, so the report is about the drift and not about the whole payload. */
	it("reports only the rejected spec", async () => {
		const outcome = await refresh([
			goodSpec("one"),
			specWithout("bad", spec => (spec.maxTokens = -1)),
			goodSpec("two"),
		]);

		const detail = payloadFailure(outcome.failures).detail;
		expect(detail).toContain("1 of 3 models rejected");
		expect(detail).toContain("bad (maxTokens)");
		expect(detail).not.toContain("one");
	});

	/** And discovery still counts as authoritative, because it did produce a usable catalog. */
	it("stays authoritative", async () => {
		const outcome = await refresh([goodSpec("one"), specWithout("bad", spec => (spec.maxTokens = -1))]);

		expect(outcome.cache?.authoritative).toBe(true);
		expect(outcome.stale).toBe(false);
	});
});

describe("the paths that must stay silent", () => {
	/** A payload of entirely valid specs reports nothing at all. */
	it("reports nothing when every spec is usable", async () => {
		const outcome = await refresh([goodSpec("one"), goodSpec("two")]);

		expect(outcome.failures).toEqual([]);
		expect(outcome.modelIds.sort()).toEqual(["one", "two"]);
	});

	/**
	 * An endpoint that honestly lists NO models is not a rejection: zero specs in means zero out, and the
	 * "all rejected" rule must not fire on it, or every provider with an empty catalog is reported broken.
	 */
	it("reports nothing for an empty but successful list", async () => {
		const outcome = await refresh([]);

		expect(outcome.failures).toEqual([]);
		expect(outcome.modelIds).toEqual([]);
		expect(outcome.cache?.authoritative).toBe(true);
	});
});
