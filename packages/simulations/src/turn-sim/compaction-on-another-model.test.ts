/**
 * Who writes the summary: the session's model, the model its catalog row
 * recommends, or the one the operator named in `compaction.model`.
 *
 * WHY THIS FILE EXISTS. Compaction can run on a DIFFERENT model from the
 * conversation, and three owners have an opinion about which: the
 * `compaction.model` setting, the active model's own `compactionModel` row, and
 * `compaction.modelFallbackStrategy`, which decides whether the tail of that
 * chain is consulted at all. The existing coverage
 * (`compaction-model-chain.test.ts`, `compaction-prefer-current-model.test.ts`)
 * spies on the compaction engine and asserts the CANDIDATE LIST, which is the
 * right test for the resolver and cannot see two things that matter more to an
 * operator: whether the summarization request actually went to that model, and
 * whether the conversation came back. A swap that leaked into the session model
 * would move every following request onto the summarizer's account, and a
 * candidate-list assertion is green while it happens.
 *
 * REACHING IT. A `compactionModel` recommendation is a field on a CATALOG model,
 * resolved against the registry's available set, so a synthetic simulated model
 * can never carry one. The harness writes a real `models.yml` (`modelsConfig`)
 * that overrides bundled bedrock models, and the session is set to the primary
 * through the registry. Every model here keeps the `bedrock-converse-stream` api,
 * so the scripted transport serves the summarization request too and the model
 * that wrote the summary is a fact on the wire.
 *
 * ROWS, one per owner, all crossing the same trigger on the same request number
 * so the only difference is who was asked: the row's recommendation under `auto`;
 * the `compaction.model` setting, which must beat that recommendation; and
 * `configured-only` with nothing configured, which must not consult the
 * recommendation at all and summarizes on the session's own model.
 *
 * WHAT IS ASSERTED. Which model served every request, which request carried no
 * tools (the loop's own summarization request), that the requests after the
 * rewrite carry the summary rather than the history it replaced, that the session
 * model is the primary before and after, and wire pairing on every live request.
 *
 * NOT asserted: the candidate chain's lower tiers (a session role, the widest
 * authenticated window) and the cross-provider refusal under `auto`. Those need a
 * second provider holding a credential, and a custom provider cannot declare the
 * `bedrock-converse-stream` api in `models.yml` (the loader's api union refuses
 * it), so the scripted transport could not serve it. `compaction-model-chain.test.ts`
 * owns those tiers at the resolver.
 *
 * RED PROOFS, measured. Each owner has a mutant that reds its row and only its
 * row, which is what makes the three rows a precedence order rather than three
 * ways of saying the same thing. Emptying the configured-pattern list in
 * `#resolveCompactionModelCandidates` reds the `compaction.model` row; refusing
 * the row recommendation there reds the recommendation row; ignoring
 * `configured-only` reds the inherit row, because the chain then reaches the
 * recommendation nobody asked for.
 *
 * MEASURED FACT. The `compaction` entry the transcript keeps records the summary,
 * the first kept entry and the token count, but NOT the model that wrote it, so
 * "which model summarized" is only recoverable from the wire. Nothing here
 * depends on that gap; it is written down so the next scenario does not go looking
 * for an author field that has never existed.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { bulkTool, createSimulation, type Simulation } from "./harness";
import { describeViolations, pairingViolations, turnViolations } from "./invariants";

/** The conversation's model. Its row recommends {@link RECOMMENDED}. */
const PRIMARY = "anthropic.claude-opus-4-7";
/** The recommendation, reachable under `auto` because it shares the provider. */
const RECOMMENDED = "anthropic.claude-sonnet-5";
/** What the operator names in `compaction.model`, which must win. */
const CONFIGURED = "anthropic.claude-opus-4-8";
const SUMMARY_TEXT = "SUMMARY-OF-THE-WORK";
const SUMMARIZED_ELSEWHERE = {
	providers: {
		"amazon-bedrock": {
			modelOverrides: {
				[PRIMARY]: { contextWindow: 16_000, compactionModel: `amazon-bedrock/${RECOMMENDED}` },
			},
		},
	},
};

/** A percentage trigger and a local summarizer, so the summary is a request. */
const PERCENT_TRIGGER = {
	"compaction.enabled": true,
	"compaction.threshold": "85%",
	"compaction.keepRecentTokens": 2_000,
	"compaction.remote": false,
} as const;

interface Served {
	readonly call: number;
	readonly model: string;
	readonly summarizer: boolean;
	readonly carriesSummary: boolean;
	readonly violations: readonly string[];
}

interface Run {
	/** `8:recommended:summary` or `9:primary:carries-summary`, in wire order. */
	readonly served: string[];
	readonly modelNow: string | undefined;
	readonly violations: string[];
}

let sim: Simulation | undefined;

afterEach(async () => {
	await sim?.dispose();
	sim = undefined;
});

function label(modelId: string): string {
	if (modelId === PRIMARY) return "primary";
	if (modelId === RECOMMENDED) return "recommended";
	if (modelId === CONFIGURED) return "configured";
	return modelId;
}

/**
 * Grow a session on the primary until it crosses the trigger, under one owner's
 * settings, and report every request the provider served.
 */
async function summarize(settings: Record<string, unknown>): Promise<Run> {
	const served: Served[] = [];
	sim = await createSimulation({
		settings: { ...PERCENT_TRIGGER, ...settings },
		modelsConfig: SUMMARIZED_ELSEWHERE,
		tools: [bulkTool()],
		script: turn => {
			const tools = turn.context.tools?.length ?? 0;
			served.push({
				call: turn.call,
				model: turn.model.id,
				summarizer: tools === 0,
				carriesSummary: JSON.stringify(turn.context.messages).includes(SUMMARY_TEXT),
				violations:
					tools === 0 ? [] : describeViolations(`request ${turn.call}`, pairingViolations(turn.context.messages)),
			});
			if (tools === 0) {
				turn.text(SUMMARY_TEXT);
				turn.finish();
				return;
			}
			turn.usage({ input: 400, output: 40 });
			if (turn.call % 2 === 1) {
				turn.toolCall("work", {}, "call_0");
				turn.finish("toolUse");
				return;
			}
			turn.text(`answer ${turn.call}`);
			turn.finish();
		},
	});
	const primary = sim.modelRegistry.find("amazon-bedrock", PRIMARY);
	if (!primary) throw new Error(`the registry does not know amazon-bedrock/${PRIMARY}`);
	await sim.session.setModel(primary);
	for (let index = 0; index < 5; index += 1) await sim.session.prompt(`ask ${index}`);
	return {
		served: served.map(entry => {
			const suffix = entry.summarizer ? ":summary" : entry.carriesSummary ? ":carries-summary" : "";
			return `${entry.call}:${label(entry.model)}${suffix}`;
		}),
		modelNow: sim.session.model?.id,
		violations: [...served.flatMap(entry => entry.violations), ...describeViolations("session", turnViolations(sim))],
	};
}

describe("a summary written by a model the conversation is not on", () => {
	it("summarizes on the model the active model's row recommends", async () => {
		const run = await summarize({});

		// Call 8 is the summarization request and the only one off the primary; the
		// four requests after it are the conversation, back on the primary, carrying
		// the summary the other model wrote.
		expect(run.served).toEqual([
			"1:primary",
			"2:primary",
			"3:primary",
			"4:primary",
			"5:primary",
			"6:primary",
			"7:primary",
			"8:recommended:summary",
			"9:primary:carries-summary",
			"10:primary:carries-summary",
			"11:primary:carries-summary",
			"12:primary:carries-summary",
		]);
		expect(run.modelNow).toBe(PRIMARY);
		expect(run.violations).toEqual([]);
	});

	it("prefers the configured compaction model over the row's recommendation", async () => {
		const run = await summarize({ "compaction.model": `amazon-bedrock/${CONFIGURED}` });

		expect(run.served.slice(7)).toEqual([
			"8:configured:summary",
			"9:primary:carries-summary",
			"10:primary:carries-summary",
			"11:primary:carries-summary",
			"12:primary:carries-summary",
		]);
		expect(run.served.slice(0, 7).every(entry => entry.endsWith(":primary"))).toBe(true);
		expect(run.modelNow).toBe(PRIMARY);
		expect(run.violations).toEqual([]);
	});

	it("never consults the recommendation under configured-only with nothing configured", async () => {
		const run = await summarize({ "compaction.modelFallbackStrategy": "configured-only" });

		// Nobody named a model, so `compaction.model` means inherit: the session's own
		// model writes the summary and the recommendation is not reached.
		expect(run.served.slice(7)).toEqual([
			"8:primary:summary",
			"9:primary:carries-summary",
			"10:primary:carries-summary",
			"11:primary:carries-summary",
			"12:primary:carries-summary",
		]);
		expect(run.modelNow).toBe(PRIMARY);
		expect(run.violations).toEqual([]);
	});
});
