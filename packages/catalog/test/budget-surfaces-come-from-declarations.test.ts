/**
 * Whole-catalog guards for a budget transport's effort surface.
 *
 * This contract has been argued twice and reversed once, so both turns are
 * recorded here rather than in a commit nobody reads.
 *
 * First turn. f07786fe6 mapped a models.dev `budget_tokens` declaration (a token
 * RANGE, no levels) to the fixed `[high, max]` pair, matching opencode's
 * budgetVariants. A change that computed a ladder instead was reverted, on the
 * theory that naming levels over a range offers tiers nobody declared.
 *
 * Second turn, which is the contract now. The pair does not survive its own
 * argument: it also names levels over the same range, just two of them, and one
 * of them is `max`. What a budget model accepts is `thinking.budget_tokens`, any
 * legal integer, and Veyyon owns the effort→budget schedule
 * (`ANTHROPIC_THINKING_BUDGETS` and friends), so minimal/low/medium/high/xhigh
 * are five DISTINCT requests the endpoint cannot reject. The pair made those
 * five into two on the most used models in the catalog: `claude-sonnet-4-5` and
 * `claude-haiku-4-5` offered high and max only, `medium` clamped up to `high`,
 * and eleven session, compaction and handoff tests failed because an operator's
 * explicit choice silently became a different one.
 *
 * So a declaration still wins, and a row with none gets the tiers its transport
 * can express. `max` is excluded from the computed ladder: the Anthropic and
 * Bedrock schedules give `max` the same 32768 tokens as `xhigh`, so offering
 * both puts a selection in the picker that cannot change a single byte.
 *
 * Three layers, because the bug lived between them:
 *  1. Every bundled budget-mode row without an explicit effort declaration
 *     carries exactly the budget ladder — never a pair copied from another
 *     tool, never a ladder derived from the model id (see
 *     no-identity-derived-thinking.test.ts).
 *  2. No computed budget ladder carries a dead top tier (`xhigh` and `max`
 *     together), which is what "just add max as well" would produce.
 *  3. Every bundled row whose reasoningOptions declare efforts bakes exactly
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

/** The tiers a budget transport can express; `max` would repeat `xhigh`'s budget. */
const BUDGET_LADDER = [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh];

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

describe("a budget transport's effort surface", () => {
	it("gives every budget-mode row without an explicit declaration exactly the budget ladder", () => {
		const offenders: string[] = [];
		for (const { provider, model } of allBundledRows()) {
			const thinking = model.thinking;
			if (thinking?.mode !== "budget") continue;
			// A row with an explicit effort declaration is checked by the drift
			// guard below; a routed row's surface is its collapse table's.
			if (model.reasoningOptions?.efforts !== undefined) continue;
			if (thinking.effortRouting !== undefined) continue;
			const authored = familyAuthoredLadder(provider, model.id);
			const expected = authored ?? BUDGET_LADDER;
			if (
				expected.length === thinking.efforts.length &&
				expected.every((effort, index) => effort === thinking.efforts[index])
			) {
				continue;
			}
			offenders.push(`${provider}/${model.id} [${thinking.efforts.join(",")}]`);
		}
		expect(
			offenders,
			`budget-mode rows with no declared efforts must carry exactly [${BUDGET_LADDER.join(",")}]; ` +
				"a two-tier pair here is another tool's picker, and a different ladder is a surface nobody owns",
		).toEqual([]);
	});

	it("never computes a ladder whose top tier repeats the tier below it", () => {
		// `xhigh` and `max` are the same 32768-token budget on the Anthropic and
		// Bedrock schedules, so a computed ladder carrying both offers a selection
		// that cannot change the request. A declared ladder is upstream's business
		// and is checked verbatim below.
		const dead: string[] = [];
		for (const { provider, model } of allBundledRows()) {
			const thinking = model.thinking;
			if (thinking?.mode !== "budget") continue;
			if (model.reasoningOptions?.efforts !== undefined || thinking.effortRouting !== undefined) continue;
			if (thinking.efforts.includes(Effort.XHigh) && thinking.efforts.includes(Effort.Max)) {
				dead.push(`${provider}/${model.id} [${thinking.efforts.join(",")}]`);
			}
		}
		expect(dead, "a computed budget ladder must not offer both xhigh and max").toEqual([]);
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

	it("pins the rows this class of bug was found on: sonnet and haiku 4.5 keep five tiers", () => {
		for (const id of ["claude-sonnet-4-5", "claude-haiku-4-5"]) {
			const model = getBundledModel("anthropic", id);
			expect(model, id).toBeDefined();
			// No declaration survives for these rows: a token range declares no
			// levels, so the mapper reports nothing and the mode supplies the ladder.
			expect(model?.reasoningOptions, id).toBeUndefined();
			expect(model?.thinking?.mode, id).toBe("budget");
			expect(model?.thinking?.efforts, id).toEqual(BUDGET_LADDER);
		}
	});
});
