/**
 * WHY: an agent configured as `kimi-code/k3.1-pro:high` ran `kimi-code/k3.1-pro-highspeed`. The
 * pattern parser matched the whole pattern loosely before splitting the effort suffix off, and
 * `k3.1-pro:high` is a fuzzy subsequence of `k3.1-pro-highspeed`, so the suffix chose the model.
 *
 * THE CLASS THIS CLOSES. Any catalog model whose `provider/id:<level>` or `id:<level>` selector
 * resolves to a different model, or drops the level, because a sibling id happens to contain the
 * level's letters. Every bundled model is swept against every level the parser accepts, read from
 * the catalog and the level enum at run time, so a new model or a new level is covered without a
 * list.
 *
 * WHAT IT DOES NOT CATCH. Models a provider discovers at run time and the bundled catalog lacks;
 * the parser is the same code for them, so they share the invariant without being enumerated.
 * Each provider's catalog is parsed on its own, so which provider a bare id shared by several
 * providers selects is outside this suite.
 */
import { describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@veyyon/agent-core";
import type { Api, Model } from "@veyyon/ai";
import { getBundledModels, getBundledProviders } from "@veyyon/catalog/models";
import { parseModelPattern } from "@veyyon/coding-agent/config/model-resolver";
import { AUTO_THINKING } from "@veyyon/coding-agent/thinking";

const catalogs: Model<Api>[][] = getBundledProviders().map(provider => getBundledModels(provider));
const models: Model<Api>[] = catalogs.flat();
const LEVELS: readonly string[] = [...new Set<string>([...Object.values(ThinkingLevel), AUTO_THINKING])];
const key = (model: Model<Api>): string => `${model.provider}/${model.id}`;

/**
 * Each provider's catalog is swept on its own: a sibling the suffix could select shares the
 * provider, and parsing against one catalog keeps the sweep linear in the catalog size. Every
 * model is yielded with the patterns that name it and are not themselves a literal id there.
 */
function* selectors(form: (model: Model<Api>) => string): Generator<[Model<Api>, string, string, Model<Api>[]]> {
	for (const catalog of catalogs) {
		const names = catalog.map(model => form(model).toLowerCase());
		const literal = new Set(names);
		const qualified = new Set(catalog.map(model => key(model).toLowerCase()));
		for (const [index, model] of catalog.entries()) {
			const name = names[index];
			// Two entries one name apart only in case are refused as ambiguous by design.
			if (names.indexOf(name) !== names.lastIndexOf(name)) continue;
			// A bare id such as `openrouter/auto` that is also another entry's `provider/id` reads as that entry.
			if (name !== key(model).toLowerCase() && qualified.has(name)) continue;
			for (const level of LEVELS) {
				const pattern = `${form(model)}:${level}`;
				if (!literal.has(pattern.toLowerCase())) yield [model, level, pattern, catalog];
			}
		}
	}
}

describe("a thinking suffix never selects a sibling model", () => {
	it("enumerates a catalog and the levels the parser accepts", () => {
		expect(models.length).toBeGreaterThan(100);
		expect(LEVELS).toContain("high");
		expect(LEVELS).toContain(AUTO_THINKING);
	});

	// Every bundled model at every level is tens of thousands of parses; a CI runner needs seconds for it.
	const forms: [string, (model: Model<Api>) => string][] = [
		["`provider/id:<level>`", key],
		["a bare `id:<level>`", model => model.id],
	];
	for (const [name, form] of forms) {
		it(`resolves ${name} to that model at that level, for every bundled model`, () => {
			const wrong: string[] = [];
			for (const [model, level, pattern, catalog] of selectors(form)) {
				const parsed = parseModelPattern(pattern, catalog);
				const got = parsed.model ? key(parsed.model) : "none";
				if (got !== key(model) || parsed.thinkingLevel !== level) {
					wrong.push(`${pattern} -> ${got}:${parsed.thinkingLevel ?? "default"}`);
				}
			}
			expect(wrong).toEqual([]);
		}, 60_000);
	}

	it("resolves the reported selector to the model it names", () => {
		const parsed = parseModelPattern("kimi-code/k3.1-pro:high", models);
		expect(parsed.model && key(parsed.model)).toBe("kimi-code/k3.1-pro");
		expect(parsed.thinkingLevel).toBe(ThinkingLevel.High);
	});

	it("drops an unknown suffix with a warning instead of matching it into a sibling id", () => {
		const parsed = parseModelPattern("kimi-code/k3.1-pro:hgh", models);
		expect(parsed.model && key(parsed.model)).toBe("kimi-code/k3.1-pro");
		expect(parsed.warning).toContain('Invalid thinking level "hgh"');
	});
});
