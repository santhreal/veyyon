/**
 * WHY THIS SUITE EXISTS (AN EFFORT CHOSEN FROM OUTSIDE NARROWS TOO).
 *
 * Every interactive effort surface refuses a level the model does not declare: `/effort` says
 * "Choose one of: …", the pickers do not offer it, and ACP's `thought_level` config option throws with
 * the accepted list. RPC mode — the headless embedding protocol — applied whatever arrived and answered
 * `success`, while `AgentSession.setThinkingLevel` quietly clamped it to a supported neighbour or
 * dropped it and wrote a log line the client never reads. So an embedder was told `xhigh` was set on a
 * model with no such wire field, and every request after that ran at an effort nobody chose. The
 * neighbouring `set_model` arm of the same switch already refuses an unknown model, which is the shape
 * this restores.
 *
 * The variant space is DERIVED: every model in the bundled catalog crossed with the whole thinking
 * vocabulary, with the expected answer computed from `configuredThinkingLevelsForModel` — the same
 * reader every other surface uses. That is what closes the class rather than the reported level on the
 * reported provider: a catalog row whose declared efforts change, a level added to the ladder, and a
 * newly bundled provider are all covered the moment they land, and a second narrowing rule invented
 * here instead of read from the catalog fails on thousands of rows at once.
 */
import { describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@veyyon/agent-core";
import type { Api, Model } from "@veyyon/ai";
import { type GeneratedProvider, getBundledModels, getBundledProviders } from "@veyyon/catalog/models";
import { rpcThinkingLevelRefusal } from "@veyyon/coding-agent/modes/rpc/rpc-mode";
import { CONFIGURED_THINKING_LEVELS, configuredThinkingLevelsForModel } from "@veyyon/coding-agent/thinking";

const ALL_LEVELS: readonly ThinkingLevel[] = Object.values(ThinkingLevel);

/**
 * Every bundled model, read from the catalog rather than a fixture list.
 *
 * `getBundledProviders` declares the wider `KnownProvider`, but its runtime values are the keys of the
 * generated catalog, which is what `getBundledModels` indexes.
 */
function bundledModels(): Model<Api>[] {
	return (getBundledProviders() as GeneratedProvider[]).flatMap(provider => getBundledModels(provider));
}

describe("RPC set_thinking_level accepts exactly what the model declares", () => {
	/**
	 * The sweep. For each model and each level, accepted-ness must equal what the catalog says, so the
	 * protocol cannot develop a second opinion about which levels exist.
	 */
	it("agrees with the catalog for every bundled model and every level", () => {
		const models = bundledModels();
		// Guards against the whole sweep silently becoming a no-op if catalog loading changes.
		expect(models.length).toBeGreaterThan(100);
		expect(ALL_LEVELS).toContain(ThinkingLevel.Inherit);

		const disagreements: string[] = [];
		for (const model of models) {
			const declared = new Set<string>(configuredThinkingLevelsForModel(model).map(String));
			for (const level of ALL_LEVELS) {
				const accepted = rpcThinkingLevelRefusal(model, level) === undefined;
				const shouldAccept = level === ThinkingLevel.Inherit || declared.has(level);
				if (accepted !== shouldAccept) {
					disagreements.push(
						`${model.provider}/${model.id} ${level}: refusal says ${accepted ? "accept" : "refuse"}, catalog says ${shouldAccept ? "accept" : "refuse"}`,
					);
				}
			}
		}

		expect(disagreements).toEqual([]);
	});

	/**
	 * The sweep above would also pass on a rule that accepts everything IF every bundled model declared
	 * every level. Counting non-uniform rows is too weak to see that: one odd row keeps a count above
	 * zero while a whole ladder shape quietly leaves the catalog. So the models are partitioned by the
	 * SHAPE of their declared ladder and every shape must be present, which turns this RED when a
	 * catalog refresh stops supplying one and the sweep silently stops discriminating.
	 */
	it("covers every shape of ladder the catalog can hold", () => {
		const vocabulary = CONFIGURED_THINKING_LEVELS.map(String).join(",");
		const plainLevels = ["low", "medium", "high"];
		const shapeOf = (model: Model<Api>): string => {
			const declared = configuredThinkingLevelsForModel(model).map(String);
			if (declared.length === 0) return "declares-nothing";
			if (declared.join(",") === vocabulary) return "declares-the-whole-vocabulary";
			if (!declared.some(level => plainLevels.includes(level))) return "reasons-without-plain-levels";
			return "declares-a-strict-subset";
		};

		const shapes = new Set(bundledModels().map(shapeOf));

		expect([...shapes].sort()).toEqual([
			"declares-a-strict-subset",
			"declares-nothing",
			"declares-the-whole-vocabulary",
			"reasons-without-plain-levels",
		]);
	});

	/**
	 * `inherit` is how a client CLEARS its choice, not a level to run at. No picker narrows it away
	 * either, and refusing it would leave an embedder with no way back to the saved default — a stricter
	 * check that breaks the surface is not a fix.
	 */
	it("always accepts inherit, on a model that declares nothing at all", () => {
		const model = bundledModels().find(candidate => configuredThinkingLevelsForModel(candidate).length === 0);
		if (!model) throw new Error("the bundled catalog declares an effort ladder for every model");

		expect(rpcThinkingLevelRefusal(model, ThinkingLevel.Inherit)).toBeUndefined();
	});

	/**
	 * The refusal has to be actionable, so it names the model, the level that was asked for, and what
	 * would have worked — the same three facts `/effort` and ACP give. A bare "invalid" would leave the
	 * embedder guessing, which is barely better than the silent clamp it replaced.
	 */
	it("names the model, the rejected level, and the accepted ones", () => {
		const model = bundledModels().find(candidate => {
			const declared = configuredThinkingLevelsForModel(candidate);
			return declared.length > 0 && !declared.includes(ThinkingLevel.Max);
		});
		if (!model) throw new Error("no bundled model declares a ladder that stops short of max");

		const refusal = rpcThinkingLevelRefusal(model, ThinkingLevel.Max);

		expect(refusal).toContain(`${model.provider}/${model.id}`);
		expect(refusal).toContain(ThinkingLevel.Max);
		for (const level of configuredThinkingLevelsForModel(model)) {
			expect(refusal, level).toContain(level);
		}
	});

	/** A model that declares nothing gets told so, rather than an empty "Accepted: " tail. */
	it("says the model exposes no effort control when its ladder is empty", () => {
		const model = bundledModels().find(candidate => configuredThinkingLevelsForModel(candidate).length === 0);
		if (!model) throw new Error("the bundled catalog declares an effort ladder for every model");

		expect(rpcThinkingLevelRefusal(model, ThinkingLevel.High)).toContain("no effort control");
	});

	/**
	 * No model in scope means no row to narrow against — the same rule
	 * `configuredThinkingLevelsForModel` applies. Refusing here would break a client that sets an effort
	 * before a model resolves, and the level is clamped against whatever model actually runs anyway.
	 */
	it("refuses nothing when there is no model to narrow against", () => {
		for (const level of ALL_LEVELS) {
			expect(rpcThinkingLevelRefusal(undefined, level), level).toBeUndefined();
		}
	});
});
