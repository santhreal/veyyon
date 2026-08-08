/**
 * Whole-catalog guards for the declared-surface contract.
 *
 * The class of bug these pin: f07786fe6 mapped a models.dev `budget_tokens`
 * declaration (a token RANGE, no levels) to the fixed high/max pair, matching
 * opencode's budgetVariants. A later change "fixed" that by COMPUTING a
 * ladder — minimal through high, plus xhigh on Anthropic — for any budget-mode
 * row, on the theory that a token range can be labeled with level names. That
 * is a ladder nobody declared: the endpoint documents a budget, not levels,
 * and the operator was offered tiers indistinguishable from real ones. It was
 * reverted, and these guards exist so the next well-argued version of the
 * same idea fails a test instead of shipping.
 *
 * Two layers, because the bug lived between them:
 *  1. Every bundled budget-mode row without an explicit effort declaration
 *     carries exactly the [high, max] pair — never a computed ladder.
 *  2. Every bundled row whose reasoningOptions declare efforts bakes exactly
 *     that declaration (canonicalized) — the declaration and the baked row
 *     cannot drift apart.
 */
import { describe, expect, it } from "bun:test";
import { Effort } from "@veyyon/catalog/effort";
import { getBundledModel, getBundledModels, getBundledProviders } from "@veyyon/catalog/models";
import {
	ANTIGRAVITY_VARIANT_COLLAPSE_TABLE,
	GEMINI_CLI_VARIANT_COLLAPSE_TABLE,
} from "@veyyon/catalog/variant-collapse";

const BUDGET_PAIR = [Effort.High, Effort.Max];

/**
 * Authored budget ladders live in the variant-collapse families, not in
 * models.dev: Cloud Code Assist carries per-effort thinking as a
 * `thinkingBudget` in the request body, an endpoint-verified host fact the
 * family comments document. A budget row may carry a family-authored ladder
 * only when the provider's own collapse table authors that exact ladder for
 * that id — which keeps the exception tied to the declaration and makes
 * deleting the family fail this guard.
 */
const AUTHORED_FAMILY_TABLES: Record<
	string,
	{ families: ReadonlyArray<{ id: string; thinking?: { efforts: readonly Effort[] } }> }
> = {
	"google-antigravity": ANTIGRAVITY_VARIANT_COLLAPSE_TABLE,
	"google-gemini-cli": GEMINI_CLI_VARIANT_COLLAPSE_TABLE,
};

function familyAuthoredLadder(provider: string, modelId: string): readonly Effort[] | undefined {
	for (const family of AUTHORED_FAMILY_TABLES[provider]?.families ?? []) {
		if (family.id === modelId && family.thinking !== undefined) return family.thinking.efforts;
	}
	return undefined;
}

function allBundledRows() {
	return getBundledProviders().flatMap(provider => getBundledModels(provider).map(model => ({ provider, model })));
}

describe("the baked catalog honors declared surfaces only", () => {
	it("gives every budget-mode row without an explicit declaration exactly the high/max pair", () => {
		const offenders: string[] = [];
		for (const { provider, model } of allBundledRows()) {
			const thinking = model.thinking;
			if (thinking?.mode !== "budget") continue;
			// A row with an explicit effort declaration is checked by the drift
			// guard below; a routed row's surface is its collapse table's.
			if (model.reasoningOptions?.efforts !== undefined) continue;
			if (thinking.effortRouting !== undefined) continue;
			if (
				thinking.efforts.length === 2 &&
				thinking.efforts[0] === Effort.High &&
				thinking.efforts[1] === Effort.Max
			) {
				continue;
			}
			const authored = familyAuthoredLadder(provider, model.id);
			if (
				authored !== undefined &&
				authored.length === thinking.efforts.length &&
				authored.every((e, i) => e === thinking.efforts[i])
			) {
				continue;
			}
			offenders.push(`${provider}/${model.id} [${thinking.efforts.join(",")}]`);
		}
		expect(
			offenders,
			"budget-mode rows with no declared efforts must carry exactly the high/max pair; " +
				"a wider ladder here is a computed surface nobody declared",
		).toEqual([]);
	});

	it("bakes every declared effort ladder verbatim, with no drift between declaration and row", () => {
		const drifted: string[] = [];
		for (const { provider, model } of allBundledRows()) {
			const declared = model.reasoningOptions?.efforts;
			if (declared === undefined || model.thinking?.effortRouting !== undefined) continue;
			const baked = model.thinking?.efforts ?? [];
			if (baked.length !== declared.length || baked.some((effort, i) => effort !== declared[i])) {
				drifted.push(`${provider}/${model.id} declared [${declared.join(",")}] baked [${baked.join(",")}]`);
			}
		}
		expect(drifted, "baked ladders must equal the declaration that produced them").toEqual([]);
	});

	it("pins the row this class of bug was found on: claude-sonnet-4-5 is budget with the high/max pair", () => {
		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5");
		expect(sonnet).toBeDefined();
		expect(sonnet?.reasoningOptions).toEqual({ efforts: BUDGET_PAIR });
		expect(sonnet?.thinking?.mode).toBe("budget");
		expect(sonnet?.thinking?.efforts).toEqual(BUDGET_PAIR);
	});
});
