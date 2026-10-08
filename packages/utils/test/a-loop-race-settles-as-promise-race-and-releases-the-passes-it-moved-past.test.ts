/**
 * WHY. A loop that awaits `Promise.race([pass, longLived])` once per pass attaches one reaction to
 * `longLived` per pass, and while `longLived` is pending each reaction holds that pass's settled
 * value. The agent turn loop raced every streamed event against one abort promise this way and held
 * every event of a turn until the turn ended. `LoopRace` replaces that pattern, so it has to settle
 * exactly as `Promise.race` would and hold nothing of a pass the loop has moved past.
 *
 * The parity suite derives its scenarios from the product of every settle kind and every settle
 * moment, for the pass and the outcome, in both settle orders, and compares each against
 * `Promise.race` run under the same script. The retention suite holds a weak reference to every
 * pass's value while the outcome stays pending and counts the values still reachable. The collector
 * scans the native stack conservatively, so a stale slot can keep a few values alive in any run; the
 * defect keeps every pass, so the bound is a small constant far below the pass count.
 *
 * Not caught: a caller that still races a long-lived promise with `Promise.race` directly. The agent
 * loop suite (`a-streamed-event-is-released-once-the-loop-has-handled-it`) covers that caller.
 */
import { describe, expect, it } from "bun:test";
import { setImmediate } from "node:timers/promises";
import { LoopRace } from "@veyyon/utils";

const SETTLE_KINDS = ["fulfill", "reject"] as const;
/** When a side settles relative to the `race` call; `microN` is N microtask hops after it. */
const SETTLE_MOMENTS = ["before", "sync", "micro1", "micro2", "micro4", "never"] as const;
type SettleKind = (typeof SETTLE_KINDS)[number];
type SettleMoment = (typeof SETTLE_MOMENTS)[number];

/** Values a conservative stack scan may keep through stale slots, plus the latest pass's waiter. */
const STRAY_SURVIVORS = 4;

interface Scenario {
	pass: SettleKind;
	passAt: SettleMoment;
	outcome: SettleKind;
	outcomeAt: SettleMoment;
	outcomeFirst: boolean;
}

function scenarios(): Scenario[] {
	const all: Scenario[] = [];
	for (const pass of SETTLE_KINDS)
		for (const passAt of SETTLE_MOMENTS)
			for (const outcome of SETTLE_KINDS)
				for (const outcomeAt of SETTLE_MOMENTS)
					for (const outcomeFirst of [false, true]) {
						if (passAt === "never" && outcomeAt === "never") continue;
						all.push({ pass, passAt, outcome, outcomeAt, outcomeFirst });
					}
	return all;
}

function describeScenario(scenario: Scenario): string {
	const order = scenario.outcomeFirst ? "outcome first" : "pass first";
	return `pass ${scenario.pass}@${scenario.passAt}, outcome ${scenario.outcome}@${scenario.outcomeAt}, ${order}`;
}

type Racer = "Promise.race" | "LoopRace";

/** Runs `scenario` against one racer and returns how the race settled. */
async function settleOf(racer: Racer, scenario: Scenario): Promise<string> {
	const pass = Promise.withResolvers<string>();
	const settlePass = scenario.pass === "fulfill" ? () => pass.resolve("pass") : () => pass.reject(new Error("pass"));
	let settleOutcome: () => void;
	let start: () => Promise<string>;
	if (racer === "Promise.race") {
		const outcome = Promise.withResolvers<string>();
		settleOutcome =
			scenario.outcome === "fulfill" ? () => outcome.resolve("outcome") : () => outcome.reject(new Error("outcome"));
		start = () => Promise.race([pass.promise, outcome.promise]);
	} else {
		const loop = new LoopRace<string>();
		settleOutcome =
			scenario.outcome === "fulfill" ? () => loop.resolve("outcome") : () => loop.reject(new Error("outcome"));
		start = () => loop.race(pass.promise);
	}
	const at = (moment: SettleMoment): void => {
		const steps = scenario.outcomeFirst
			? [
					[scenario.outcomeAt, settleOutcome],
					[scenario.passAt, settlePass],
				]
			: [
					[scenario.passAt, settlePass],
					[scenario.outcomeAt, settleOutcome],
				];
		for (const [when, settle] of steps as Array<[SettleMoment, () => void]>) if (when === moment) settle();
	};

	at("before");
	const settled = start().then(
		value => `fulfilled ${value}`,
		(error: Error) => `rejected ${error.message}`,
	);
	at("sync");
	for (let hop = 1; hop <= 4; hop++) {
		await null;
		if (hop === 1) at("micro1");
		if (hop === 2) at("micro2");
		if (hop === 4) at("micro4");
	}
	return await settled;
}

describe("a loop race settles as Promise.race settles", () => {
	const all = scenarios();

	it("covers every pair of settle kind and moment in both orders", () => {
		const sides = SETTLE_KINDS.length * SETTLE_MOMENTS.length;
		// Both sides pending forever is the one combination with nothing to settle.
		expect(all.length).toBe((sides * sides - SETTLE_KINDS.length * SETTLE_KINDS.length) * 2);
	});

	it("settles with the value or error Promise.race settles with in every scenario", async () => {
		const mismatches: string[] = [];
		for (const scenario of all) {
			const expected = await settleOf("Promise.race", scenario);
			const actual = await settleOf("LoopRace", scenario);
			if (actual !== expected) mismatches.push(`${describeScenario(scenario)}: ${actual}, expected ${expected}`);
		}
		expect(mismatches).toEqual([]);
	});

	it("settles every later pass that is still pending with the outcome", async () => {
		const loop = new LoopRace<string>();
		expect(await loop.race(Promise.resolve("first"))).toBe("first");
		loop.resolve("stopped");
		expect(loop.settled).toBe(true);
		const pending = Promise.withResolvers<string>();
		expect(await loop.race(pending.promise)).toBe("stopped");
		expect(await loop.race(pending.promise)).toBe("stopped");
	});

	it("applies only the first settle", async () => {
		const resolvedFirst = new LoopRace<string>();
		resolvedFirst.resolve("first");
		resolvedFirst.reject(new Error("second"));
		expect(await resolvedFirst.race(Promise.withResolvers<string>().promise)).toBe("first");

		const rejectedFirst = new LoopRace<string>();
		rejectedFirst.reject(new Error("first"));
		rejectedFirst.resolve("second");
		expect(
			await rejectedFirst.race(Promise.withResolvers<string>().promise).catch((error: Error) => error.message),
		).toBe("first");
	});
});

describe("a loop race releases the passes it moved past", () => {
	const PASSES = 400;

	async function aliveAfterPasses(settle: "fulfill" | "reject"): Promise<number[]> {
		const loop = new LoopRace<symbol>();
		const refs: WeakRef<object>[] = [];
		for (let index = 0; index < PASSES; index++) {
			const value = { index, payload: `pass ${index} `.repeat(16) };
			refs.push(new WeakRef(value));
			if (settle === "fulfill") await loop.race(Promise.resolve(value));
			else await loop.race(Promise.reject(value)).catch(() => undefined);
		}
		// A weak reference keeps its target alive until the current job ends, so collect after one.
		await setImmediate();
		Bun.gc(true);
		const alive: number[] = [];
		for (let index = 0; index < PASSES; index++) if (refs[index]!.deref() !== undefined) alive.push(index);
		// The outcome stays pending through every pass, which is the condition a long-lived racer leaks under.
		expect(loop.settled).toBe(false);
		return alive;
	}

	it("releases the value of every fulfilled pass the loop moved past", async () => {
		const alive = await aliveAfterPasses("fulfill");
		expect(alive.length).toBeLessThanOrEqual(STRAY_SURVIVORS);
	});

	it("releases the error of every rejected pass the loop moved past", async () => {
		const alive = await aliveAfterPasses("reject");
		expect(alive.length).toBeLessThanOrEqual(STRAY_SURVIVORS);
	});
});
