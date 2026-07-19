import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { calculateCost, emptyCost, emptyUsage, modelsAreEqual } from "../src/models";
import type { Api, Model, Usage } from "../src/types";

const model = {
	id: "test-model",
	provider: "test-provider",
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
} as unknown as Model<Api>;

// Dogfood the owner: the local fixture starts from emptyUsage() and overlays the
// partial, so the test constructs its zeroed Usage the same one way production does.
function usage(partial: Partial<Usage>): Usage {
	return { ...emptyUsage(), ...partial };
}

describe("emptyCost", () => {
	it("returns every cost bucket zeroed, including total", () => {
		expect(emptyCost()).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
	});

	it("returns a fresh object each call, so mutating one never leaks into the next", () => {
		const a = emptyCost();
		a.input = 42;
		a.total = 42;
		expect(emptyCost()).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
		expect(emptyCost()).not.toBe(a);
	});
});

describe("emptyUsage", () => {
	it("returns every required token bucket and cost field zeroed", () => {
		expect(emptyUsage()).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
	});

	it("leaves optional fields absent, not zeroed (undefined means unknown, not zero)", () => {
		const u = emptyUsage();
		expect(u.reasoningTokens).toBeUndefined();
		expect(u.orchestration).toBeUndefined();
		expect(u.premiumRequests).toBeUndefined();
		expect(u.cttl).toBeUndefined();
		expect(u.server).toBeUndefined();
	});

	it("returns a fresh object AND a fresh nested cost each call, so the streaming accumulator never aliases", () => {
		const a = emptyUsage();
		a.input = 100;
		a.cost.input = 5;
		const b = emptyUsage();
		expect(b.input).toBe(0);
		expect(b.cost.input).toBe(0);
		expect(b).not.toBe(a);
		expect(b.cost).not.toBe(a.cost);
	});

	it("is priced as zero by calculateCost", () => {
		expect(calculateCost(model, emptyUsage()).total).toBe(0);
	});
});

describe("calculateCost", () => {
	it("prices each bucket at per-million rates and totals them", () => {
		const u = usage({ input: 1_000_000, output: 200_000, cacheRead: 500_000, cacheWrite: 100_000 });
		const cost = calculateCost(model, u);
		expect(cost.input).toBeCloseTo(3, 10);
		expect(cost.output).toBeCloseTo(3, 10); // 0.2M * $15
		expect(cost.cacheRead).toBeCloseTo(0.15, 10);
		expect(cost.cacheWrite).toBeCloseTo(0.375, 10);
		expect(cost.total).toBeCloseTo(3 + 3 + 0.15 + 0.375, 10);
		expect(u.cost).toBe(cost); // mutates in place
	});

	it("adds orchestration tokens to input/output/cacheRead but never cacheWrite", () => {
		const withOrchestration = usage({
			input: 1_000_000,
			orchestration: { input: 1_000_000, output: 100_000, cacheRead: 1_000_000 },
		});
		const cost = calculateCost(model, withOrchestration);
		expect(cost.input).toBeCloseTo(6, 10); // 2M billed input
		expect(cost.output).toBeCloseTo(1.5, 10);
		expect(cost.cacheRead).toBeCloseTo(0.3, 10);
		expect(cost.cacheWrite).toBe(0);
	});

	it("prices zero usage as zero", () => {
		expect(calculateCost(model, usage({})).total).toBe(0);
	});
});

describe("modelsAreEqual", () => {
	const other = { ...model, provider: "different-provider" } as unknown as Model<Api>;

	it("compares by id AND provider", () => {
		expect(modelsAreEqual(model, { ...model } as Model<Api>)).toBe(true);
		expect(modelsAreEqual(model, other)).toBe(false);
		expect(modelsAreEqual(model, { ...model, id: "other-id" } as Model<Api>)).toBe(false);
	});

	it("is false when either side is null or undefined", () => {
		expect(modelsAreEqual(null, model)).toBe(false);
		expect(modelsAreEqual(model, undefined)).toBe(false);
		expect(modelsAreEqual(null, undefined)).toBe(false);
	});
});

// Repo-wide source lock: emptyCost / emptyUsage in catalog/src/models.ts are the
// ONE owner for the fully-zeroed Usage["cost"] literal. Every zeroed cost object
// (standalone, or nested inside a zeroed Usage a provider installs before
// calculateCost overwrites it) must come from emptyCost() / emptyUsage(), not a
// hand-written `{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }`.
//
// The zeroed-cost literal is the precise discriminator. It appears in every
// zeroed Usage (via its cost) and every standalone zeroed cost, and is ABSENT
// from the look-alikes that legitimately can't use these owners: UsageStatistics
// (orchestrationInput/Output/CacheRead flat, no `cost`) and Model["cost"] pricing
// (four buckets, no `total`). Matching `total: 0` after the four buckets excludes
// both. The grandfathered set is empty: any new zeroed-cost literal outside the
// owner must import emptyCost / emptyUsage from @veyyon/catalog/models.
const PACKAGES_DIR = path.join(import.meta.dir, "../..");
const ZERO_COST_LITERAL = /input:\s*0,\s*output:\s*0,\s*cacheRead:\s*0,\s*cacheWrite:\s*0,\s*total:\s*0/;

async function walk(dir: string, out: string[]): Promise<void> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "vendor") continue;
			await walk(full, out);
		} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".bench.ts")) {
			out.push(full);
		}
	}
}

describe("emptyCost / emptyUsage source lock", () => {
	it("no production source hand-writes a zeroed cost literal outside catalog/src/models.ts", async () => {
		const offenders: string[] = [];
		for (const pkg of await readdir(PACKAGES_DIR, { withFileTypes: true })) {
			if (!pkg.isDirectory()) continue;
			const files: string[] = [];
			try {
				await walk(path.join(PACKAGES_DIR, pkg.name, "src"), files);
			} catch {
				// Package without a src/ directory (assets-only): nothing to scan.
			}
			for (const file of files) {
				const rel = path.relative(PACKAGES_DIR, file).replaceAll(path.sep, "/");
				if (rel === "catalog/src/models.ts") continue;
				if (ZERO_COST_LITERAL.test(await readFile(file, "utf8"))) offenders.push(rel);
			}
		}
		expect(
			offenders,
			"hand-written zeroed cost literal: import emptyCost / emptyUsage from @veyyon/catalog/models instead",
		).toEqual([]);
	});
});
