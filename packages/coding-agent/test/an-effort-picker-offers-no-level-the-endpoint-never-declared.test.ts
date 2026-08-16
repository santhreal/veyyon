/**
 * WHY THIS EXISTS.
 *
 * An effort picker showed `minimal` for Kimi K3. No K3 row in the catalog declares `minimal` —
 * `moonshotai/kimi-k3` declares `low, high, max`, `cloudflare-ai-gateway/moonshotai/kimi-k3` declares
 * `max` alone — so the level came from nowhere the operator could act on: picking it stored a value
 * every K3 endpoint then clamped away. The source was `configuredThinkingLevelsForModel(undefined)`
 * answering with `CONFIGURED_THINKING_LEVELS`, the configuration VOCABULARY, whenever a surface
 * failed to resolve a model. A vocabulary is the set of spellings the config file accepts; it is not
 * a statement that any endpoint accepts them.
 *
 * THE CLASS THIS CLOSES: an effort level reaching a user that nothing in scope declared. Every
 * member of the class is one of three shapes, and all three are swept below from the catalog at run
 * time rather than from a list written here:
 *
 *  1. A MODEL'S OWN LADDER. Every bundled model, through every effort surface, offers exactly what
 *     that model declares. Sweeping the whole catalog is what makes a new row with a new ladder
 *     shape covered on the day it lands.
 *  2. AN ID THAT CARRIES ITS EFFORT. `cursor-grok-4.6-medium`, `gpt-5.4-high`, `o4-mini-high`: the
 *     id IS the effort, the row exposes no effort field, and a picker that reads a ladder out of the
 *     id would be inventing one from a naming convention. These narrow to nothing and say so.
 *  3. NO MODEL AT ALL. The two rows that have no model and never will (`subagent.thinkingLevel` with
 *     no chain, `defaultEffort`'s any-model `*` row) offer the union of what the session's catalog
 *     declares — every row addressable on something the operator can select — and a session with no
 *     catalog offers nothing rather than a constant.
 *
 * FAIL BY DEFAULT: the surface list is enumerated from a table each case walks, and
 * `every narrowing export is swept` pins that table against the module's own exports, so a new
 * effort-producing helper turns this suite red until it is either swept or recorded as not one.
 *
 * WHAT IT DOES NOT CATCH: what the RUNTIME does with a level once stored. Clamping, the `:level`
 * suffix on a chain entry, and the resolver's precedence are `task/subagent-settings.test.ts` and
 * `config/effort-resolver.test.ts`. This suite is about what a user is OFFERED.
 */

import { describe, expect, it } from "bun:test";
import type { Api, Model } from "@veyyon/ai";
import { type GeneratedProvider, getBundledModels, getBundledProviders } from "@veyyon/catalog/models";
import * as thinking from "@veyyon/coding-agent/thinking";

const VOCABULARY: readonly string[] = thinking.CONFIGURED_THINKING_LEVELS.map(String);

function bundledModels(): Model<Api>[] {
	return (getBundledProviders() as GeneratedProvider[]).flatMap(provider => getBundledModels(provider));
}

const MODELS: Model<Api>[] = bundledModels();

function selectorOf(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

/** The levels a model's own catalog row declares, as plain words. The answer every surface owes. */
function declared(model: Model<Api>): string[] {
	return thinking.configuredThinkingLevelsForModel(model).map(String);
}

/**
 * Every model whose selector contains an effort word: `cursor/grok-4.6-medium`, `openai/o4-mini-high`,
 * `azure/gpt-5.4-xhigh`. Shape 2 of the class. Drawn from the catalog, so a provider that starts
 * publishing suffixed ids is swept the day the catalog carries them.
 */
const EFFORT_IN_ID: Model<Api>[] = MODELS.filter(model =>
	VOCABULARY.some(word => new RegExp(`\\b${word}\\b`).test(selectorOf(model))),
);

// ─────────────────────────────────────────────────────────────────────────────
// The corpus itself. A sweep over an empty or degenerate corpus proves nothing.
// ─────────────────────────────────────────────────────────────────────────────

describe("the corpus this suite sweeps", () => {
	it("carries the K3 rows this defect was reported on, and none of them declares minimal", () => {
		const k3 = MODELS.filter(model => /kimi-?k3/i.test(selectorOf(model)));

		expect(k3.length).toBeGreaterThan(0);
		expect(k3.filter(model => declared(model).includes("minimal")).map(selectorOf)).toEqual([]);
		// The other half: these rows are not simply empty. `max` is declared, and `max` is precisely
		// the level a hardcoded low/medium/high ladder omits.
		expect(k3.some(model => declared(model).includes("max"))).toBe(true);
	});

	it("carries ids that embed an effort word", () => {
		expect(EFFORT_IN_ID.length).toBeGreaterThan(0);
	});

	it("carries models with genuinely different ladders", () => {
		const shapes = new Set(MODELS.map(model => declared(model).join(",")));

		// More than one shape, and not one shape per model either: a corpus where every row declares
		// something unique would make the sweeps below trivially true.
		expect(shapes.size).toBeGreaterThan(3);
		expect(shapes.size).toBeLessThan(MODELS.length);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Shape 1: a model's own ladder, swept over every model in the catalog.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Each surface that turns a model into offered levels, as a function of that model.
 *
 * These are the module-level producers. The rendered screens that consume them are driven in
 * `every-effort-surface-offers-only-what-the-model-declares.test.ts`; running a TUI component once
 * per bundled model would be a sweep of the renderer, not of the ladder.
 */
const SURFACES: Readonly<Record<string, (model: Model<Api>) => string[]>> = {
	"the narrowing helper itself": model => declared(model),
	"a picker's rows": model =>
		thinking
			.configuredThinkingLevelOptions({ model })
			.map(option => option.value)
			.filter(value => value !== thinking.INHERIT_EFFORT_OPTION_VALUE),
	"the /effort argument hint": model => {
		const hint = thinking.thinkingLevelArgHint(model);
		return hint === undefined ? [] : hint.slice(1, -1).split("|");
	},
};

describe("every bundled model is offered exactly what it declares", () => {
	for (const [surface, offered] of Object.entries(SURFACES)) {
		it(`${surface} matches the catalog row for all ${MODELS.length} models`, () => {
			const wrong = MODELS.filter(model => offered(model).join(",") !== declared(model).join(","));

			expect(wrong.map(selectorOf)).toEqual([]);
		});

		it(`${surface} offers no level outside the vocabulary`, () => {
			const invented = new Set<string>();
			for (const model of MODELS) {
				for (const level of offered(model)) if (!VOCABULARY.includes(level)) invented.add(level);
			}

			expect([...invented]).toEqual([]);
		});
	}

	/**
	 * The reported defect, stated as its own case so a failure names it. `minimal` is not special —
	 * it is the level K3 was offered — and the assertion is the general one: no surface offers a
	 * level the row does not declare, for any model and any level.
	 */
	it("offers minimal only where the row declares minimal", () => {
		for (const [surface, offered] of Object.entries(SURFACES)) {
			const wrong = MODELS.filter(
				model => offered(model).includes("minimal") !== declared(model).includes("minimal"),
			);

			expect(wrong.map(selectorOf), surface).toEqual([]);
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Shape 2: an id that carries its own effort.
// ─────────────────────────────────────────────────────────────────────────────

describe("a model id that embeds an effort gets no ladder read out of it", () => {
	/**
	 * The id is a NAME. A picker that parsed `cursor-grok-4.6-medium` into a ladder would be reading
	 * a provider's naming convention as an API contract, and the next provider to ship
	 * `model-max-context` would get `max` offered on a row with no effort field at all.
	 */
	it("offers a suffixed id exactly what its own row declares, never the suffix", () => {
		const invented = EFFORT_IN_ID.filter(model => {
			const rows = thinking
				.configuredThinkingLevelOptions({ model })
				.map(option => option.value)
				.filter(value => value !== thinking.INHERIT_EFFORT_OPTION_VALUE);
			return rows.join(",") !== declared(model).join(",");
		});

		expect(invented.map(selectorOf)).toEqual([]);
	});

	/**
	 * The half that matters for a routed row: a suffixed id whose own row declares nothing must offer
	 * NOTHING, not the tier in its name. Asserted non-empty first, so the case cannot pass by
	 * sweeping an empty set.
	 */
	it("offers nothing at all for a suffixed id whose row declares no effort", () => {
		const silent = EFFORT_IN_ID.filter(model => declared(model).length === 0);

		expect(silent.length).toBeGreaterThan(0);
		for (const model of silent) {
			expect(thinking.thinkingLevelArgHint(model), selectorOf(model)).toBeUndefined();
			expect(thinking.hasConfigurableThinkingEffort(model), selectorOf(model)).toBe(false);
			expect(
				thinking.configuredThinkingLevelOptions({ model }).map(option => option.value),
				selectorOf(model),
			).toEqual([thinking.INHERIT_EFFORT_OPTION_VALUE]);
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Shape 3: no model at all.
// ─────────────────────────────────────────────────────────────────────────────

describe("a surface with no model invents nothing", () => {
	it("narrows an absent model to nothing, not to the vocabulary", () => {
		expect(thinking.configuredThinkingLevelsForModel(undefined)).toEqual([]);
		expect(thinking.thinkingLevelArgHint(undefined)).toBeUndefined();
		expect(thinking.configuredThinkingLevelOptions().map(option => option.value)).toEqual([
			thinking.INHERIT_EFFORT_OPTION_VALUE,
		]);
	});

	it("narrows an empty or absent catalog to nothing", () => {
		expect(thinking.configuredThinkingLevelsInScope(undefined)).toEqual([]);
		expect(thinking.configuredThinkingLevelsInScope([])).toEqual([]);
	});

	/**
	 * The union is the only answer a model-less row may give, and it is a fact about the catalog: a
	 * level appears iff some model in scope declares it. Driven over the WHOLE bundled catalog and
	 * over every single-model scope, so a union that quietly widened would fail here.
	 */
	it("offers exactly the union of what the models in scope declare", () => {
		const union = thinking.configuredThinkingLevelsInScope(MODELS).map(String);
		const everyDeclared = new Set(MODELS.flatMap(declared));

		expect(union).toEqual(VOCABULARY.filter(level => everyDeclared.has(level)));
		for (const model of MODELS) {
			expect(thinking.configuredThinkingLevelsInScope([model]).map(String), selectorOf(model)).toEqual(
				declared(model),
			);
		}
	});

	/**
	 * A scope built ONLY from K3 rows is the reported session, reconstructed. `minimal` may not
	 * appear, and `max` must, or the fix has traded one wrong answer for another.
	 */
	it("offers a K3-only session no minimal and a real max", () => {
		const k3 = MODELS.filter(model => /kimi-?k3/i.test(selectorOf(model)));
		const union = thinking.configuredThinkingLevelsInScope(k3).map(String);

		expect(union).not.toContain("minimal");
		expect(union).toContain("max");
	});

	/**
	 * A row description is as visible as a row label. `auto`'s description names the levels it
	 * chooses between, so on a K3-only session it may not name `minimal` either — the level would be
	 * on the screen, in prose, for a session where nothing accepts it.
	 */
	it("names no undeclared level in a row description either", () => {
		const k3 = MODELS.filter(model => /kimi-?k3/i.test(selectorOf(model)));
		const text = thinking
			.configuredThinkingLevelOptions({ scope: k3 })
			.map(option => `${option.label} ${option.description}`)
			.join(" ");
		const union = thinking.configuredThinkingLevelsInScope(k3).map(String);

		expect(VOCABULARY.filter(word => new RegExp(`\\b${word}\\b`).test(text)).sort()).toEqual([...union].sort());
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Fail by default: a new producer must be swept or recorded.
// ─────────────────────────────────────────────────────────────────────────────

describe("the vocabulary owner grows no unswept effort producer", () => {
	/**
	 * Every export of `thinking.ts` that can hand a caller a LEVEL, enumerated from the module at run
	 * time and pinned by exact equality. A new helper that produces levels lands here red, which is
	 * the only mechanism that keeps this suite honest as the module grows: a hardcoded list of
	 * surfaces stops covering the module the moment someone adds a fourth one.
	 */
	it("declares every level-producing export, and each is swept above or recorded here", () => {
		const producers = Object.entries(thinking)
			.filter(([, value]) => typeof value === "function")
			.filter(([, value]) => {
				const probe = (value as (...args: unknown[]) => unknown)(undefined);
				if (typeof probe === "string") return VOCABULARY.some(word => probe.includes(word));
				return Array.isArray(probe);
			})
			.map(([name]) => name)
			.sort();

		/**
		 * Not a picker. `clampAutoThinkingEffort` maps the auto-classifier's request onto a level to
		 * send on the wire; nothing it returns is ever printed as a choice, and its model-less branch
		 * is pinned by `thinking.test.ts` because the classifier resolves a level before a session
		 * has settled on a model. It is listed rather than filtered out so removing this line is a
		 * decision someone makes on purpose.
		 */
		const notOffered = ["clampAutoThinkingEffort"];

		expect(producers).toEqual(
			[
				"configuredThinkingLevelOptions",
				"configuredThinkingLevelsForModel",
				"configuredThinkingLevelsInScope",
				...notOffered,
			].sort(),
		);
	});

	/** The constant stays a constant: nothing may narrow to it, and it may not shrink by accident. */
	it("keeps the vocabulary a superset of everything the catalog declares", () => {
		const everyDeclared = new Set(MODELS.flatMap(declared));

		expect([...everyDeclared].filter(level => !VOCABULARY.includes(level))).toEqual([]);
	});
});
