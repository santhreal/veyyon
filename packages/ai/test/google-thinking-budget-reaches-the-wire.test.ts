/**
 * A thinking effort that cannot change the request is refused, not accepted and ignored.
 *
 * WHY THIS SUITE EXISTS. `getGoogleBudget` hardcoded budgets only for ids containing "2.5-" and
 * returned -1, Gemini's "you decide" sentinel, for everything else. Eleven bundled rows land in that
 * branch: `gemini-flash-latest` and `gemini-flash-lite-latest` on both `google` and `google-vertex`,
 * plus seven `gemma-4` rows. On every one of them `minimal`, `low`, `medium` and `high` produced the
 * byte-identical `{ enabled: true, budgetTokens: -1 }`. The operator set an effort, the request did
 * not change, and nothing anywhere said so.
 *
 * WHY THE OLD COVERAGE MISSED IT, which dictates the shape of this suite: nothing compared TWO
 * EFFORT LEVELS AGAINST EACH OTHER ON THE SAME ROW. Every existing assertion checked one level in
 * isolation, and -1 is a perfectly plausible single value. The defect is only visible as a
 * relationship, so the assertion here is the relationship: distinct efforts must produce distinct
 * budgets wherever the row accepts one.
 *
 * The fix refuses rather than inventing a number, because a budget picked for a row whose underlying
 * model is unknown is a second silent wrong answer. `gemini-flash-latest` is an alias, and the Gemini
 * 3 generation takes `thinkingLevel` rather than `thinkingBudget`, so a plausible-looking value could
 * be wrong in a way nobody would ever observe.
 */
import { describe, expect, it } from "bun:test";
import { mapOptionsForApi } from "@veyyon/ai/stream";
import type { Model } from "@veyyon/ai/types";
import { Effort } from "@veyyon/catalog/effort";
import { getBundledModel, getBundledModels } from "@veyyon/catalog/models";

/** The efforts every row in this suite advertises. */
const EFFORTS = [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] as const;

/** `it.each` widens its columns to `string`; the catalog wants the provider union. */
function bundledRow(provider: string, id: string): Model {
	return getBundledModel(provider as Parameters<typeof getBundledModel>[0], id) as Model;
}

function budgetFor(model: Model, effort: (typeof EFFORTS)[number]): number | undefined {
	const options = mapOptionsForApi(model, { reasoning: effort }, "test-key") as {
		thinking?: { enabled?: boolean; budgetTokens?: number };
	};
	return options.thinking?.budgetTokens;
}

/** Every reasoning row on the two APIs that route through `getGoogleBudget`. */
function budgetApiRows(): Array<{ provider: string; id: string; model: Model }> {
	const rows: Array<{ provider: string; id: string; model: Model }> = [];
	for (const provider of ["google", "google-vertex", "google-antigravity"] as const) {
		for (const model of getBundledModels(provider)) {
			if (model.api !== "google-generative-ai" && model.api !== "google-vertex") continue;
			if (!model.reasoning) continue;
			if (model.thinking?.mode === "google-level") continue;
			rows.push({ provider, id: model.id, model: model as Model });
		}
	}
	return rows;
}

describe("Google thinking budgets reach the wire", () => {
	/**
	 * The relationship assertion. A row that accepts a budget must answer differently for at least
	 * two of the efforts it advertises, or the control is decorative.
	 */
	it.each([
		["google", "gemini-2.5-pro", [128, 2048, 8192, 32_768]],
		["google", "gemini-2.5-flash", [128, 2048, 8192, 24_576]],
	])("gives %s/%s a distinct budget per effort", (provider, id, expected) => {
		const model = bundledRow(provider, id);

		expect(EFFORTS.map(effort => budgetFor(model, effort))).toEqual(expected);
		expect(new Set(expected).size).toBeGreaterThan(1);
	});

	/**
	 * The regression itself, named row by row. A sweep that happened to skip these would still pass
	 * the aggregate below, and these are the alias rows a user is most likely to pick.
	 */
	it.each([
		["google", "gemini-flash-latest"],
		["google", "gemini-flash-lite-latest"],
		["google-vertex", "gemini-flash-latest"],
		["google-vertex", "gemini-flash-lite-latest"],
	])("refuses an effort on %s/%s rather than sending the dynamic sentinel", (provider, id) => {
		const model = bundledRow(provider, id);
		expect(model, `${provider}/${id} is missing from the bundled catalog`).toBeDefined();

		for (const effort of EFFORTS) {
			expect(() => budgetFor(model, effort)).toThrow(/does not accept a thinking budget/);
		}
		// The message has to be actionable, not just loud: it names the row and a way forward.
		expect(() => budgetFor(model, Effort.High)).toThrow(new RegExp(`${provider}/${id}`));
		expect(() => budgetFor(model, Effort.High)).toThrow(/Choose a model that supports budgeted thinking/);
	});

	/**
	 * No row may silently emit the sentinel. This is the aggregate that catches the next spelling,
	 * since the defect was a substring test that agreed with reality on one family and not others.
	 */
	it("emits the dynamic sentinel for no row at all", () => {
		const rows = budgetApiRows();

		expect(rows.length).toBeGreaterThan(10);
		const sentinelRows: string[] = [];
		for (const row of rows) {
			for (const effort of EFFORTS) {
				let budget: number | undefined;
				try {
					budget = budgetFor(row.model, effort);
				} catch {
					continue; // Refused, which is the point.
				}
				if (budget === -1) sentinelRows.push(`${row.provider}/${row.id}@${effort}`);
			}
		}
		expect(sentinelRows).toEqual([]);
	});

	/**
	 * The blast radius. A caller who never asked for an effort must be untouched, or this turns a
	 * silent no-op into a broken default.
	 */
	it.each([
		["google", "gemini-flash-latest"],
		["google", "gemma-4-26b"],
	])("leaves %s/%s working when no effort was requested", (provider, id) => {
		const model = bundledRow(provider, id);
		const options = mapOptionsForApi(model, {}, "test-key") as { thinking?: { enabled?: boolean } };

		expect(options.thinking).toEqual({ enabled: false });
	});

	/**
	 * The escape hatch survives: an explicit per-effort budget is honoured before the refusal, so a
	 * caller who knows the row accepts one is not blocked by our ignorance of the alias.
	 */
	it("honours an explicit thinkingBudgets entry on a row that would otherwise refuse", () => {
		const model = getBundledModel("google", "gemini-flash-latest") as Model;

		const options = mapOptionsForApi(
			model,
			{ reasoning: Effort.High, thinkingBudgets: { [Effort.High]: 4321 } },
			"test-key",
		) as {
			thinking?: { enabled?: boolean; budgetTokens?: number };
		};

		expect(options.thinking).toEqual({ enabled: true, budgetTokens: 4321 });
	});
});
