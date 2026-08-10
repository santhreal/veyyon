/**
 * A goal's TOKEN BUDGET measured across a compaction that fires INSIDE the turn.
 *
 * Goal accounting is a delta against a baseline, each field clamped at zero, so
 * any event that LOWERS the total the runtime reads can only ever charge the goal
 * nothing: the delta clamps, the flush returns before it advances the baseline,
 * and a budget that charges nothing has stopped binding while the work goes on.
 * Compaction lowers that total, and `compaction.midTurnEnabled` lands it between
 * a tool-call turn and its continuation, which is the one ordering where it can
 * arrive after the baseline was taken. This file arms goal mode over exactly that
 * ordering, which nothing else in the suite does.
 *
 * RED PROOFS, observed rather than predicted. Charging the goal for one fewer
 * usage field (`Math.max(0, current.output - baseline.output)` replaced by `0` in
 * `goalTokenDelta`) reds both rows: the spend row reads 800 per round against 880,
 * and the budget row never reaches `budget-limited` at all inside six rounds. So
 * these rows measure the runtime's own arithmetic, not the simulation's.
 *
 * What this does NOT catch, both measured rather than assumed. Dropping the
 * per-turn baseline reset in `onTurnStart`, and dropping the post-flush baseline
 * advance in `#flushUsageLocked`, each leave both rows green, because exactly one
 * flush per turn sees new usage and the next turn re-baselines from wherever the
 * total then stands. Reverting `getSessionStats` to the live context alone leaves
 * them green too, for the same reason: the round's charge lands before compaction
 * lowers the total, so the clamp never bites. That is the honest finding here.
 * The collision this file was written to hunt does not exist in the shipped
 * ordering, and these rows are what would notice if that ordering changed. The
 * session-spend rows in `growth-compaction.test.ts` cover the reader itself.
 */

import { afterEach, expect, it } from "bun:test";
import { createSimulation, type Simulation, simTool } from "./harness";

let sim: Simulation | undefined;

afterEach(async () => {
	await sim?.dispose();
	sim = undefined;
});

/**
 * Compaction on, reachable, and allowed to fire in the middle of a turn.
 * `compaction.threshold` is the live key: a plain number is a fixed token
 * trigger, and the retired `thresholdTokens` spelling is deliberately not used
 * here so this fixture does not depend on the legacy read.
 */
const MID_TURN_COMPACTING = {
	"compaction.enabled": true,
	"compaction.autoContinue": true,
	"compaction.midTurnEnabled": true,
	"compaction.threshold": "12000",
	"compaction.keepRecentTokens": 2_000,
	"compaction.remote": false,
	"goal.modelBudgetsEnabled": true,
} as const;

const CONTEXT_WINDOW = 16_000;
const TOKEN_BUDGET = 5_000;
/** Two provider calls per round at 400 input and 40 output each. */
const SPEND_PER_ROUND = 880;

/** Registered so the summarizer, which is sent no tools, is unambiguous. */
const WORK = simTool("work", async () => ({ content: [{ type: "text", text: "tool output" }] }));

const ASK = `ask. ${"user chunk. ".repeat(400)}`;

interface Round {
	compactions: number;
	tokensUsed: number;
	status: string;
}

async function runGoalRounds(rounds: number): Promise<Round[]> {
	let awaitingContinuation = false;
	sim = await createSimulation({
		model: { contextWindow: CONTEXT_WINDOW },
		settings: { ...MID_TURN_COMPACTING },
		tools: [WORK],
		script: turn => {
			if ((turn.context.tools?.length ?? 0) === 0) {
				turn.text("SUMMARY-OF-THE-EARLY-ROUNDS");
				turn.finish();
				return;
			}
			turn.usage({ input: 400, output: 40 });
			turn.text(`answer ${turn.call} ${"reply chunk. ".repeat(300)}`);
			// Every round asks for one tool and then answers, so each round holds a
			// step boundary the mid-turn check can compact at.
			if (!awaitingContinuation) {
				awaitingContinuation = true;
				turn.toolCall("work", {}, `call-${turn.call}`);
				turn.finish("toolUse");
				return;
			}
			awaitingContinuation = false;
			turn.finish();
		},
	});

	const now = Date.now();
	sim.session.setGoalModeState({
		enabled: true,
		mode: "active",
		goal: {
			id: "goal-1",
			objective: "keep working",
			status: "active",
			tokenBudget: TOKEN_BUDGET,
			tokensUsed: 0,
			timeUsedSeconds: 0,
			turnsCompleted: 0,
			createdAt: now,
			updatedAt: now,
		},
	});

	const observed: Round[] = [];
	for (let round = 1; round <= rounds; round += 1) {
		await sim.session.prompt(`${ASK} round ${round}`);
		const goal = sim.session.getGoalModeState()?.goal;
		if (!goal) throw new Error("goal mode state was dropped mid-run");
		observed.push({
			compactions: sim.sessionManager.getEntries().filter(entry => entry.type === "compaction").length,
			tokensUsed: goal.tokensUsed,
			status: goal.status,
		});
	}
	return observed;
}

it("keeps charging a goal for the work it does after a mid-run compaction", async () => {
	const rounds = await runGoalRounds(6);

	// Non-vacuity: without a compaction inside the run there is no collision to
	// observe and every assertion below is about an ordinary session.
	expect(rounds.at(-1)?.compactions).toBeGreaterThan(0);

	// The spend is the round number times the per-round cost, with no round that
	// charged nothing. A stalled baseline shows up here as a repeated total.
	expect(rounds.map(round => round.tokensUsed)).toEqual(rounds.map((_round, index) => (index + 1) * SPEND_PER_ROUND));
});

it("still stops a goal that spends past its budget once the history is summarized away", async () => {
	const rounds = await runGoalRounds(6);
	const compacted = rounds.findIndex(round => round.compactions > 0);
	const limited = rounds.findIndex(round => round.status === "budget-limited");

	// The budget binds AFTER the compaction, which is the whole point: a goal
	// whose accounting was reset by a compaction runs on forever.
	expect(compacted).toBeGreaterThanOrEqual(0);
	expect(limited).toBeGreaterThan(compacted);

	// And it binds at the round the total actually crosses, not later.
	const crossing = rounds.findIndex(round => round.tokensUsed >= TOKEN_BUDGET);
	expect(limited).toBe(crossing);
	expect(rounds.slice(limited).every(round => round.status === "budget-limited")).toBe(true);
});
