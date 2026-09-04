/**
 * What the loop promises about running several tool calls from one turn.
 *
 * WHY THIS FILE EXISTS. `AgentTool.concurrency` is a two-value contract: a
 * `shared` tool may run alongside other shared tools, an `exclusive` one runs
 * alone and everything else waits. That is the only guarantee a tool author can
 * rely on when their tool is not safe to run beside anything, and nothing in this
 * tree checked it. The neighbouring suites cover a tool that hangs, one that
 * throws, and one that is cancelled: all single-call shapes. Scheduling defects
 * need a BATCH, and they are invisible in the ordinary case because a fast tool
 * usually finishes before the next one is dispatched, so an exclusive tool that
 * is quietly being run in parallel looks exactly like one that is not.
 *
 * HOW OVERLAP IS OBSERVED, without a clock. Every tool here awaits a fixed number
 * of microtask ticks between recording its entry and its exit. Under a parallel
 * dispatch that is enough for the whole batch to be inside `execute` at once, and
 * it costs no wall-clock time, so a violation is a recorded overlap rather than a
 * race the test hopes to catch. The ledger keeps the peak in-flight count over
 * each call's span, which is what an exclusivity claim is made of.
 *
 * ASSERTED: every call answered exactly once, results in call order, an exclusive
 * call never shared its span with another, a per-call `concurrency` resolver is
 * consulted in both directions, and a resolver that throws leaves the call
 * running alone rather than beside its siblings. NOT asserted: that shared tools
 * DO run in parallel beyond the one control below. Parallelism is a performance
 * property the product may tune; exclusivity is a correctness one.
 *
 * RED PROOF. Dropping the shared-task wait from the exclusive start gate in
 * `executeToolCalls` (`Promise.all([lastExclusive, ...sharedTasks])` to plain
 * `lastExclusive`) reds 6 of the 16 matrix cells, reporting the real overlap
 * (`call-2-exclusive peak=3`). A mutation that makes the resolver's verdict
 * unreachable reds the two resolver cells instead.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { AgentTool } from "@veyyon/agent-core";
import { createSimulation, type Simulation, scriptTurns, simTool } from "./harness";
import { describeViolations, turnViolations } from "./invariants";

let sim: Simulation | undefined;

afterEach(async () => {
	await sim?.dispose();
	sim = undefined;
});

/** Enough microtask turns for a parallel dispatch to interleave the whole batch. */
const INTERLEAVE_TICKS = 8;

/** What every call did, and how many calls shared its span. */
interface Span {
	readonly id: string;
	readonly name: string;
	peakInFlight: number;
}

class Ledger {
	readonly spans: Span[] = [];
	#live = new Set<Span>();

	/**
	 * Only spans that are live at the same moment may raise each other's peak, so
	 * the recompute walks the live set rather than every span ever recorded: a
	 * later batch must not inflate an earlier call's number.
	 */
	enter(id: string, name: string): Span {
		const span: Span = { id, name, peakInFlight: 0 };
		this.spans.push(span);
		this.#live.add(span);
		for (const live of this.#live) {
			if (live.peakInFlight < this.#live.size) live.peakInFlight = this.#live.size;
		}
		return span;
	}

	exit(span: Span): void {
		this.#live.delete(span);
	}

	/** The widest overlap seen anywhere in the run. */
	peak(): number {
		return this.spans.reduce((widest, span) => Math.max(widest, span.peakInFlight), 0);
	}
}

/** A tool of one concurrency mode that either returns or refuses. */
function toolFor(mode: "shared" | "exclusive", ledger: Ledger, failing: boolean): AgentTool {
	const name = failing ? `${mode}-fails` : mode;
	return simTool(
		name,
		async id => {
			const span = ledger.enter(id, name);
			try {
				for (let tick = 0; tick < INTERLEAVE_TICKS; tick += 1) await Promise.resolve();
				if (failing) throw new Error(`${name} refused to run`);
				return { content: [{ type: "text", text: `${name} ran with peak ${span.peakInFlight}` }] };
			} finally {
				ledger.exit(span);
			}
		},
		{ concurrency: mode },
	);
}

type Mode = "shared" | "exclusive";

/**
 * A concurrency resolver is handed the RAW, pre-validation arguments, so it reads
 * an untrusted bag rather than a parsed shape. Reading the index through one
 * narrowing helper is what a real resolver has to do too.
 */
function callIndex(args: Partial<unknown>): number | undefined {
	if (!("index" in args)) return undefined;
	const value = args.index;
	return typeof value === "number" ? value : undefined;
}

const COMPOSITIONS: readonly Mode[][] = [
	["shared"],
	["shared", "shared", "shared"],
	["exclusive"],
	["shared", "exclusive", "shared"],
	["exclusive", "shared", "shared"],
	["shared", "shared", "exclusive"],
	["exclusive", "exclusive"],
	["shared", "exclusive", "exclusive", "shared"],
];

/** Whether one member of the batch refuses. A failure must not move the others. */
const FAILURE_MODES = ["all succeed", "the middle call throws"] as const;

function callIds(modes: readonly Mode[]): string[] {
	return modes.map((mode, index) => `call-${index}-${mode}`);
}

describe("a batch of tool calls respects the concurrency each tool declared", () => {
	it("covers a batch of every shape, with and without a failing member", () => {
		expect(COMPOSITIONS.length).toBeGreaterThanOrEqual(8);
		expect(COMPOSITIONS.some(modes => modes.every(mode => mode === "shared"))).toBe(true);
		expect(COMPOSITIONS.some(modes => modes.includes("exclusive"))).toBe(true);
		expect(COMPOSITIONS.some(modes => modes.length >= 4)).toBe(true);
		expect(FAILURE_MODES.length).toBe(2);
	});

	for (const modes of COMPOSITIONS) {
		for (const failureMode of FAILURE_MODES) {
			it(`${modes.join(" + ")}, ${failureMode}`, async () => {
				const cell = `${modes.join(" + ")} / ${failureMode}`;
				const ledger = new Ledger();
				const failingIndex = failureMode === "all succeed" ? -1 : Math.floor(modes.length / 2);
				const ids = callIds(modes);
				sim = await createSimulation({
					settings: { "retry.enabled": false },
					tools: [
						toolFor("shared", ledger, false),
						toolFor("exclusive", ledger, false),
						toolFor("shared", ledger, true),
						toolFor("exclusive", ledger, true),
					],
					script: scriptTurns(
						turn => {
							modes.forEach((mode, index) => {
								const failing = index === failingIndex;
								turn.toolCall(failing ? `${mode}-fails` : mode, { index }, ids[index]);
							});
							turn.finish("toolUse");
						},
						turn => {
							turn.text("batch done");
							turn.finish();
						},
					),
				});

				await sim.session.prompt("go");

				expect(describeViolations(cell, turnViolations(sim))).toEqual([]);
				const results = sim.session.messages.filter(message => message.role === "toolResult");
				// Exactly one result per call, in the order the calls were emitted.
				// A provider reading them out of order pairs the wrong answer with
				// the wrong request, and a duplicate is a second answer to a
				// question that was already settled.
				expect(results.map(result => result.toolCallId)).toEqual(ids);

				for (const [index, mode] of modes.entries()) {
					if (mode !== "exclusive") continue;
					const span = ledger.spans.find(candidate => candidate.id === ids[index]);
					expect(span).toBeDefined();
					// The whole contract, in one number: nothing else was inside
					// `execute` while this call was.
					expect(`${ids[index]} peak=${span?.peakInFlight}`).toBe(`${ids[index]} peak=1`);
				}
			});
		}
	}

	it("really can see an overlap, so the exclusivity cells are not passing on a sequential scheduler", async () => {
		// The control that makes every assertion above meaningful. If the loop ran
		// every tool one at a time, each exclusive span would read 1 for a reason
		// that has nothing to do with exclusivity, and this file would be green
		// while the contract was unimplemented.
		const ledger = new Ledger();
		sim = await createSimulation({
			settings: { "retry.enabled": false },
			tools: [toolFor("shared", ledger, false)],
			script: scriptTurns(
				turn => {
					turn.toolCall("shared", { index: 0 }, "call-a");
					turn.toolCall("shared", { index: 1 }, "call-b");
					turn.toolCall("shared", { index: 2 }, "call-c");
					turn.finish("toolUse");
				},
				turn => {
					turn.text("batch done");
					turn.finish();
				},
			),
		});

		await sim.session.prompt("go");

		expect(ledger.spans.length).toBe(3);
		expect(ledger.peak()).toBeGreaterThanOrEqual(2);
	});

	it("consults a resolver that decides per call, so one call of a tool runs alone and another does not", async () => {
		// `concurrency` may be a function of the call's arguments, which is how a
		// tool that is usually safe declares the one shape that is not. The two
		// halves are asserted in the same run: the resolver returning `exclusive`
		// for `index === 1` must isolate that call, and returning `shared` for the
		// others must leave them free to overlap.
		const ledger = new Ledger();
		const perCall = simTool(
			"per-call",
			async (id, args) => {
				const span = ledger.enter(id, `per-call-${String(args.index)}`);
				try {
					for (let tick = 0; tick < INTERLEAVE_TICKS; tick += 1) await Promise.resolve();
					return { content: [{ type: "text", text: `ran ${String(args.index)}` }] };
				} finally {
					ledger.exit(span);
				}
			},
			{ concurrency: args => (callIndex(args) === 1 ? "exclusive" : "shared") },
		);
		sim = await createSimulation({
			settings: { "retry.enabled": false },
			tools: [perCall],
			script: scriptTurns(
				turn => {
					for (const index of [0, 1, 2, 3]) turn.toolCall("per-call", { index }, `call-${index}`);
					turn.finish("toolUse");
				},
				turn => {
					turn.text("batch done");
					turn.finish();
				},
			),
		});

		await sim.session.prompt("go");

		expect(describeViolations("per-call resolver", turnViolations(sim))).toEqual([]);
		const isolated = ledger.spans.find(span => span.id === "call-1");
		expect(`call-1 peak=${isolated?.peakInFlight}`).toBe("call-1 peak=1");
		// And the calls the resolver called `shared` were not isolated, so the
		// resolver is being consulted rather than ignored in one safe direction.
		expect(ledger.peak()).toBeGreaterThanOrEqual(2);
	});

	it("runs a call serially when its concurrency resolver throws", async () => {
		// A resolver is tool-author code and may fault. The batch must not die with
		// it, and the call must fall back to the SAFE mode: running alone. A
		// fallback to `shared` would run a call that declared itself unsafe beside
		// others, which is the failure this branch exists to prevent.
		const ledger = new Ledger();
		const brittleMode = simTool(
			"brittle-mode",
			async (id, args) => {
				const span = ledger.enter(id, `brittle-${String(args.index)}`);
				try {
					for (let tick = 0; tick < INTERLEAVE_TICKS; tick += 1) await Promise.resolve();
					return { content: [{ type: "text", text: `ran ${String(args.index)}` }] };
				} finally {
					ledger.exit(span);
				}
			},
			{
				concurrency: args => {
					if (callIndex(args) === 1) throw new Error("resolver could not decide");
					return "shared";
				},
			},
		);
		sim = await createSimulation({
			settings: { "retry.enabled": false },
			tools: [brittleMode],
			script: scriptTurns(
				turn => {
					for (const index of [0, 1, 2]) turn.toolCall("brittle-mode", { index }, `call-${index}`);
					turn.finish("toolUse");
				},
				turn => {
					turn.text("batch done");
					turn.finish();
				},
			),
		});

		await sim.session.prompt("go");

		expect(describeViolations("throwing resolver", turnViolations(sim))).toEqual([]);
		// Every call still answered: a faulting resolver is not a lost result.
		const results = sim.session.messages.filter(message => message.role === "toolResult");
		expect(results.map(result => result.toolCallId)).toEqual(["call-0", "call-1", "call-2"]);
		const fellBack = ledger.spans.find(span => span.id === "call-1");
		expect(`call-1 peak=${fellBack?.peakInFlight}`).toBe("call-1 peak=1");
	});
});
