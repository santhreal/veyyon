/**
 * No model plans to send more INPUT than the provider will accept.
 *
 * WHY THIS SUITE EXISTS. Every budgeting path read `model.contextWindow` and treated it as the
 * room available to history. It is not. Providers charge input and output against one window and
 * reject a request whose input leaves no space for the output allocation — OpenAI answers "Your
 * input exceeds the context window of this model", Anthropic requires `input + max_tokens <=
 * context window`. On a codex-class model that is 128k of a 272k window, so history was allowed to
 * reach ~231k (window minus the flat 15% reserve) against a real ceiling near 144k. The request
 * died before compaction's threshold was ever crossed, and because `generateBranchSummary` sized
 * its own request the same way, the one operation that could have shrunk the session was rejected
 * too: an unrecoverable session with no way out.
 *
 * THE CLASS. Not "codex overflows". Any model whose output allocation is a large fraction of its
 * window, on any provider, present or future. The variant space is therefore swept from the
 * bundled catalog at run time rather than from a list written today, so a newly generated model
 * with an aggressive allocation turns this suite red instead of shipping the same defect.
 *
 * WHAT THIS DOES NOT CATCH. It proves the budget we compute is under the provider's arithmetic
 * ceiling; it cannot prove the provider's real reservation matches its advertised `maxTokens`, or
 * that a backend which strips the caller's output cap reserves exactly that much. It also does not
 * cover per-request output overrides, which lower the ceiling further. The larger gap: 522 bundled
 * models advertise `maxTokens >= contextWindow`, which cannot be a real allocation, so no
 * allocation can be derived for them and they keep the full window — those models are still
 * budgeted optimistically, and the fix reaches only models whose catalog metadata is coherent.
 */

import { describe, expect, it } from "bun:test";
import { DEFAULT_COMPACTION_SETTINGS, resolveThresholdTokens, usableInputWindow } from "@veyyon/agent-core/compaction";
import type { Model } from "@veyyon/ai";
import { getBundledModels, getBundledProviders } from "@veyyon/catalog/models";

function everyBundledModel(): Model[] {
	const models: Model[] = [];
	for (const provider of getBundledProviders()) models.push(...getBundledModels(provider));
	return models;
}

/** A model can only be budgeted if it states a positive window. */
function budgetable(model: Model): boolean {
	return typeof model.contextWindow === "number" && Number.isFinite(model.contextWindow) && model.contextWindow > 0;
}

describe("usableInputWindow", () => {
	it("subtracts the output allocation, because it is charged against the same window", () => {
		expect(usableInputWindow(272_000, 128_000)).toBe(144_000);
		expect(usableInputWindow(200_000, 64_000)).toBe(136_000);
	});

	it("keeps the whole window when no allocation is advertised", () => {
		// An unknown allocation must not silently shrink a budget that works today.
		expect(usableInputWindow(200_000, undefined)).toBe(200_000);
		expect(usableInputWindow(200_000, 0)).toBe(200_000);
	});

	it("keeps the whole window when the advertised allocation is incoherent", () => {
		// Bad catalog metadata must not drive the budget to zero or negative, which
		// would make every percentage of it meaningless.
		expect(usableInputWindow(200_000, 200_000)).toBe(200_000);
		expect(usableInputWindow(200_000, 500_000)).toBe(200_000);
	});

	it("leaves a degenerate window untouched rather than inventing one", () => {
		expect(usableInputWindow(0, 128_000)).toBe(0);
		expect(usableInputWindow(-1, 128_000)).toBe(-1);
	});
});

describe("every bundled model", () => {
	const models = everyBundledModel().filter(budgetable);

	it("sweeps a catalog that is actually populated", () => {
		// Guards the sweep itself: an empty catalog would make every case below
		// vacuously true, which is the quiet way this suite could stop testing.
		expect(models.length).toBeGreaterThan(100);
	});

	it("never budgets history above the provider's usable input", () => {
		const overruns: string[] = [];
		for (const model of models) {
			const window = model.contextWindow as number;
			const maxOut = typeof model.maxTokens === "number" ? model.maxTokens : undefined;
			const usable = usableInputWindow(window, maxOut);
			// The fire point is what history is allowed to reach before compaction
			// intervenes. Above the usable input, the request is rejected first.
			const firePoint = resolveThresholdTokens(usable, DEFAULT_COMPACTION_SETTINGS);
			if (firePoint > usable) overruns.push(`${model.provider}/${model.id}: fires at ${firePoint} of ${usable}`);
		}
		expect(overruns).toEqual([]);
	});

	it("reserves the advertised output allocation on every model that states one", () => {
		const unreserved: string[] = [];
		for (const model of models) {
			const window = model.contextWindow as number;
			const maxOut = model.maxTokens;
			if (typeof maxOut !== "number" || maxOut <= 0 || maxOut >= window) continue;
			if (usableInputWindow(window, maxOut) !== window - maxOut) {
				unreserved.push(`${model.provider}/${model.id}`);
			}
		}
		expect(unreserved).toEqual([]);
	});

	it("keeps the full window for a model whose advertised allocation would consume it", () => {
		// 522 bundled models state `maxTokens >= contextWindow`, which cannot describe
		// a real allocation — a model cannot emit its entire window on top of its
		// input. The allocation is unknowable for these, and guessing one would shrink
		// budgets that work today, so the window stands. Asserted as a POLICY rather
		// than a pinned roster: the roster is regenerated by `gen:models` and belongs
		// to the catalog, not to this suite.
		const incoherent = models.filter(
			m => typeof m.maxTokens === "number" && m.maxTokens > 0 && m.maxTokens >= (m.contextWindow as number),
		);
		expect(incoherent.length).toBeGreaterThan(0);
		const shrunk = incoherent
			.filter(m => usableInputWindow(m.contextWindow as number, m.maxTokens) !== m.contextWindow)
			.map(m => `${m.provider}/${m.id}`);
		expect(shrunk).toEqual([]);
	});
});
