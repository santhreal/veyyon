/**
 * `contextPromotion.enabled`: moving to a larger-context model instead of
 * summarizing the history away.
 *
 * WHY THIS FILE EXISTS. Promotion is the FIRST rung of every context ladder in
 * the session (the pre-prompt threshold check, the mid-run check inside a tool
 * chain, the post-turn threshold check, and the provider's own overflow error all
 * call `#promoteContextModel` before they reach compaction), and it is the only
 * rung that costs the operator nothing: nothing is summarized, nothing is
 * dropped, the next request simply goes to a model with more room. Until now no
 * simulation could reach it. The rung resolves `contextPromotionTarget` off the
 * ACTIVE model and looks the named model up in the registry's available set, and
 * a synthetic simulated model is in neither the catalog nor the registry, so
 * every scenario here promoted nothing and fell through to compaction. The
 * sibling suite `overflow-recovery.test.ts` says so in its header and leaves the
 * rung to unit tests.
 *
 * It is reachable, and this suite reaches it: the harness writes a real
 * `models.yml` (`modelsConfig`), which overrides two BUNDLED bedrock models into
 * a two-rung ladder (a 16000-token primary whose `contextPromotionTarget` names a
 * 40000-token model that declares no target of its own), and the session is set
 * to the primary through the registry. Both models keep the
 * `bedrock-converse-stream` api, so the scripted transport still serves every
 * request and every model switch is visible on the wire.
 *
 * ROWS. One growing session that crosses an 85% trigger, run with promotion on
 * and off; the same session grown far enough to cross the PROMOTED model's own
 * trigger; and a provider overflow error, also both arms. The pairs matter more
 * than the rows: each crossing happens on the same request number in both arms,
 * so the difference between them is the setting and not the arithmetic.
 *
 * WHAT IS ASSERTED. Which model served each request, whether a request carried no
 * tools (that is how the loop identifies its own summarization request), the
 * `model_change` entries the transcript kept, and that the compaction events
 * fired only where a summary was actually the answer. Wire pairing is checked on
 * every live request, because a promotion re-sends the same history to a
 * different model and a promotion that dropped a tool result would be invisible
 * otherwise.
 *
 * NOT asserted: what the summary says (`keep-recent-budget.test.ts` owns size,
 * `midrun-compaction-in-a-tool-chain.test.ts` owns placement), and which of the
 * four ladder sites promoted. The rung is one function and the growth rows enter
 * it from a threshold while the overflow rows enter it from a provider error,
 * which covers both entry shapes; pinning the exact call site would assert the
 * ladder's internal structure rather than its behaviour.
 *
 * MEASURED FACTS worth keeping in one place, because each one is a trap for the
 * next scenario: promotion emits NO session event, so the only traces are the
 * model on the wire and a `model_change` entry, and that entry's role is
 * `fallback` (the temporary-model slot promotion shares with a retry fallback),
 * not `default`; the operator's configured default model role is never rewritten;
 * and an ABSOLUTE trigger (`compaction.threshold: "12000"`) makes promotion
 * pointless by construction, because the promoted model's larger window does not
 * move a fixed token count, so the very next check compacts anyway. This suite
 * runs a percentage trigger for that reason.
 *
 * RED PROOFS, measured. (a) Making `#promoteContextModel` return before it reads
 * the setting reds exactly the three promotion rows and leaves both off-arm rows
 * green. (b) Making it ignore a disabled setting reds exactly the two off-arm
 * rows. The pair is what makes each row evidence about the setting rather than
 * about the threshold arithmetic. (c) Promoting with `setModel` instead of
 * `setModelTemporary` reds the same three promotion rows, on the `model_change`
 * role: a promotion that rewrote the operator's default slot would survive the
 * session and outlive the context that caused it.
 *
 * WHAT THIS SUITE DOES NOT CATCH. The strictly-larger-window guard in
 * `#resolveContextPromotionTarget`: this ladder's two windows differ, so removing
 * the guard changes nothing here, and the bundled catalog is where that matters
 * (19 of its 26 declared promotion targets are NOT larger than the model naming
 * them, so the guard is what makes those declarations inert). A row for it needs
 * an equal-window pair, and the resolver's unit tests own it.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createSimulation, type Simulation, simTool } from "./harness";
import { describeViolations, pairingViolations, turnViolations } from "./invariants";

const PRIMARY = "anthropic.claude-opus-4-7";
const TARGET = "anthropic.claude-sonnet-5";
const PRIMARY_WINDOW = 16_000;
/** Small enough that a grown session crosses the promoted model's trigger too. */
const TARGET_WINDOW = 40_000;
/** Bedrock's wording. The classifier flags it as a context overflow. */
const OVERFLOW_MESSAGE = "input is too long for requested model";
const SUMMARY_TEXT = "SUMMARY-OF-THE-WORK";
/** About 4000 tokens of tool output a prompt, so the 85% crossing is reached. */
const BULK = `worked. ${"tool output line. ".repeat(900)}`;

/**
 * The ladder, as an operator would write it in `models.yml`: two bundled models
 * overridden into windows a simulation can cross, and a promotion edge between
 * them. The target declares no `contextPromotionTarget`, so it is the top.
 */
const LADDER = {
	providers: {
		"amazon-bedrock": {
			modelOverrides: {
				[PRIMARY]: { contextWindow: PRIMARY_WINDOW, contextPromotionTarget: `amazon-bedrock/${TARGET}` },
				[TARGET]: { contextWindow: TARGET_WINDOW },
			},
		},
	},
};

/**
 * A percentage trigger, so the promoted model's larger window really does buy
 * room, and a local summarizer, so a compaction is a request this simulation
 * serves and can place in the order.
 */
const PERCENT_TRIGGER = {
	"compaction.enabled": true,
	"compaction.threshold": "85%",
	"compaction.keepRecentTokens": 2_000,
	"compaction.remote": false,
} as const;

/** One request as the provider received it. */
interface Served {
	readonly call: number;
	readonly model: string;
	/** A request carrying no tools is the loop's own summarization request. */
	readonly summarizer: boolean;
	readonly violations: readonly string[];
}

interface Run {
	/** `8:target` or `8:primary:summary`, in the order the provider saw them. */
	readonly served: string[];
	/** `model@role` for every `model_change` the transcript kept. */
	readonly changes: string[];
	readonly compactions: number;
	readonly modelNow: string | undefined;
	readonly violations: string[];
}

let sim: Simulation | undefined;

afterEach(async () => {
	await sim?.dispose();
	sim = undefined;
});

function label(modelId: string): string {
	if (modelId === PRIMARY || modelId === `amazon-bedrock/${PRIMARY}`) return "primary";
	if (modelId === TARGET || modelId === `amazon-bedrock/${TARGET}`) return "target";
	return modelId;
}

function report(simulation: Simulation, served: Served[]): Run {
	return {
		served: served.map(entry => `${entry.call}:${label(entry.model)}${entry.summarizer ? ":summary" : ""}`),
		changes: simulation.sessionManager
			.getEntries()
			.filter(entry => entry.type === "model_change")
			.map(entry => {
				const change = entry as { model?: string; role?: string };
				return `${label(change.model ?? "none")}@${change.role ?? "none"}`;
			}),
		compactions: simulation.eventsOfType("auto_compaction_start").length,
		modelNow: simulation.session.model?.id,
		violations: [
			...served.flatMap(entry => entry.violations),
			...describeViolations("session", turnViolations(simulation)),
		],
	};
}

/**
 * Start a session on the ladder's primary model, with promotion on or off.
 * `setModel` through the registry is what carries `contextPromotionTarget`: the
 * model the harness builds for the agent is synthetic and has no such field.
 */
async function onTheLadder(
	promotion: boolean,
	script: Parameters<typeof createSimulation>[0]["script"],
): Promise<Simulation> {
	const simulation = await createSimulation({
		settings: { ...PERCENT_TRIGGER, "contextPromotion.enabled": promotion },
		modelsConfig: LADDER,
		tools: [simTool("work", async () => ({ content: [{ type: "text", text: BULK }] }))],
		script,
	});
	const primary = simulation.modelRegistry.find("amazon-bedrock", PRIMARY);
	if (!primary) throw new Error(`the registry does not know amazon-bedrock/${PRIMARY}`);
	await simulation.session.setModel(primary);
	return simulation;
}

/** A tool round per prompt, so the history grows by the tool's output each time. */
async function grow(promotion: boolean, prompts: number): Promise<Run> {
	const served: Served[] = [];
	sim = await onTheLadder(promotion, turn => {
		const tools = turn.context.tools?.length ?? 0;
		served.push({
			call: turn.call,
			model: turn.model.id,
			summarizer: tools === 0,
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
	});
	for (let index = 0; index < prompts; index += 1) await sim.session.prompt(`ask ${index}`);
	return report(sim, served);
}

/** One prompt the provider refuses for size, then an answer on whatever serves it. */
async function overflow(promotion: boolean): Promise<Run> {
	const served: Served[] = [];
	sim = await onTheLadder(promotion, turn => {
		const tools = turn.context.tools?.length ?? 0;
		served.push({
			call: turn.call,
			model: turn.model.id,
			summarizer: tools === 0,
			violations:
				tools === 0 ? [] : describeViolations(`request ${turn.call}`, pairingViolations(turn.context.messages)),
		});
		if (tools === 0) {
			turn.text(SUMMARY_TEXT);
			turn.finish();
			return;
		}
		if (turn.call === 2) {
			turn.fail(OVERFLOW_MESSAGE);
			return;
		}
		turn.usage({ input: 400, output: 40 });
		turn.text(`answer ${turn.call}`);
		turn.finish();
	});
	await sim.session.prompt("first");
	await sim.session.prompt("second");
	return report(sim, served);
}

describe("a session that runs out of room climbs to a larger model before it summarizes", () => {
	it("promotes on the crossing instead of compacting", async () => {
		const run = await grow(true, 5);

		// The switch lands mid-prompt, so the primary serves seven requests and the
		// target serves the eighth: the same request number the off arm summarizes on.
		expect(run.served).toEqual([
			"1:primary",
			"2:primary",
			"3:primary",
			"4:primary",
			"5:primary",
			"6:primary",
			"7:primary",
			"8:target",
			"9:target",
			"10:target",
		]);
		expect(run.compactions).toBe(0);
		expect(run.changes).toEqual(["primary@default", "target@fallback"]);
		expect(run.modelNow).toBe(TARGET);
		expect(run.violations).toEqual([]);
	});

	it("compacts the same crossing when promotion is off", async () => {
		const run = await grow(false, 5);

		expect(run.served).toEqual([
			"1:primary",
			"2:primary",
			"3:primary",
			"4:primary",
			"5:primary",
			"6:primary",
			"7:primary",
			"8:primary:summary",
			"9:primary",
			"10:primary",
			"11:primary",
			"12:primary",
		]);
		expect(run.compactions).toBe(1);
		expect(run.changes).toEqual(["primary@default"]);
		expect(run.modelNow).toBe(PRIMARY);
		expect(run.violations).toEqual([]);
	});

	it("stops at the top of the ladder and compacts on the promoted model", async () => {
		const run = await grow(true, 10);

		// One promotion, then the target's own crossing is summarized rather than
		// promoted again: the target declares no target of its own.
		expect(run.changes).toEqual(["primary@default", "target@fallback"]);
		expect(run.compactions).toBe(1);
		const summaries = run.served.filter(entry => entry.endsWith(":summary"));
		expect(summaries).toEqual(["18:target:summary"]);
		expect(run.modelNow).toBe(TARGET);
		expect(run.violations).toEqual([]);
	});

	it("retries a provider overflow on the promoted model without compacting", async () => {
		const run = await overflow(true);

		expect(run.served).toEqual(["1:primary", "2:primary", "3:target"]);
		expect(run.compactions).toBe(0);
		expect(run.changes).toEqual(["primary@default", "target@fallback"]);
		expect(run.modelNow).toBe(TARGET);
		expect(run.violations).toEqual([]);
	});

	it("compacts a provider overflow in place when promotion is off", async () => {
		const run = await overflow(false);

		expect(run.served).toEqual(["1:primary", "2:primary"]);
		expect(run.compactions).toBe(1);
		expect(run.changes).toEqual(["primary@default"]);
		expect(run.modelNow).toBe(PRIMARY);
		expect(run.violations).toEqual([]);
	});
});
