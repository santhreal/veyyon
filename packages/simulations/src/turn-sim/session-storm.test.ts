/**
 * A wide seeded storm over turn shapes and disturbances, checked by invariant.
 *
 * WHY THIS FILE EXISTS. Every other suite in this directory pins a shape someone
 * thought of. The defects that survive that are combinations: a tool batch that
 * is cut short by a steer while a compaction boundary sits behind it, a provider
 * error arriving on the turn a follow-up was queued into, a duplicate id landing
 * on a turn that was then cancelled. Enumerating those by hand does not scale,
 * and a storm does: it walks a seeded sequence of shapes and disturbances and,
 * after every round, asserts the properties that must hold no matter what
 * happened. A red run names its seed and its round, so the sequence replays.
 *
 * The existing storms in `interjection-settling.test.ts` cover one shape (a tool
 * turn) and assert one property (the session settles). This one varies the shape
 * per round and adds the pairing and delivery properties, which is where a
 * combination defect actually shows up: history that a provider would reject.
 *
 * ASSERTED after every round:
 *   - the session settled: not streaming, no undrained queue.
 *   - stored history pairs 1:1 (every call answered, no orphan result, no
 *     duplicate call id).
 *   - the LAST outbound context pairs 1:1. It is a different list from stored
 *     history: canonicalization renames every id and compaction rewrites the
 *     messages, so a well-formed store can still put a malformed request on the
 *     wire.
 *   - no accepted user text was stored twice. A steer that is delivered twice
 *     asks the model to do the work twice.
 *
 * DETERMINISM. No wall-clock sleeps and no timers of the test's own: the script
 * signals when it has entered a round and then blocks on a gate the test
 * releases, so a disturbance always lands inside an open stream rather than
 * whenever a sleep happened to expire. A round that never settles fails as a
 * test timeout, which is the correct verdict for a stalled session.
 *
 * NOT asserted: that a message queued during a round the user then CANCELLED is
 * still delivered. Cancelling is how an operator withdraws work, and the product
 * is free to drop what was riding on the cancelled run, so those texts are held
 * to "never twice" rather than "exactly once".
 *
 * RED PROOF. Re-injecting the cross-turn half of the duplicate-id fix (passing an
 * empty taken-id set to `disambiguateToolCallIds` in `agent-loop.ts`) reds ALL
 * FIVE seeds, each naming the round that produced it, for example `seed 0xbeef
 * round 5 (one tool / nothing): [unique-call-ids] tool call id call_0 was emitted
 * twice`. Every tool id here comes from a per-message counter that restarts each
 * turn, which is what makes the storm reach that class at all: ids carrying a
 * round number would have hidden it.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import type { Context } from "@veyyon/ai";
import { USER_INTERRUPT_LABEL } from "@veyyon/coding-agent/session/messages";
import { createSimulation, type Simulation, simTool, whenSessionEvent } from "./harness";
import { describeViolations, pairingViolations, turnViolations } from "./invariants";

let sim: Simulation | undefined;

afterEach(async () => {
	await sim?.dispose();
	sim = undefined;
});

/** mulberry32, so a red run replays from its seed. */
function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** What the round's first provider call does. */
type Shape =
	| "text only"
	| "one tool"
	| "two shared tools"
	| "an exclusive tool beside a shared one"
	| "text and a tool in one turn"
	| "a repeated tool-call id"
	| "an empty turn"
	| "a retryable provider failure";

const SHAPES: readonly Shape[] = [
	"text only",
	"one tool",
	"two shared tools",
	"an exclusive tool beside a shared one",
	"text and a tool in one turn",
	"a repeated tool-call id",
	"an empty turn",
	"a retryable provider failure",
];

/** What the user does while the round's first call is open. */
type Disturbance = "nothing" | "steer" | "follow-up" | "cancel";

const DISTURBANCES: readonly Disturbance[] = ["nothing", "steer", "follow-up", "cancel"];

/** The round the script is currently serving. */
interface Round {
	readonly index: number;
	readonly shape: Shape;
	/** Resolves once the first call has emitted its content and is holding. */
	readonly entered: PromiseWithResolvers<void>;
	/** The test releases this to let the first call finish. */
	readonly gate: PromiseWithResolvers<void>;
	opened: boolean;
}

function storedUserTexts(messages: readonly AgentMessage[]): string[] {
	const texts: string[] = [];
	for (const message of messages) {
		if (message.role !== "user") continue;
		const content = message.content;
		if (typeof content === "string") {
			texts.push(content);
			continue;
		}
		for (const block of content) {
			if (block.type === "text") texts.push(block.text);
		}
	}
	return texts;
}

function countMentions(messages: readonly AgentMessage[], needle: string): number {
	return storedUserTexts(messages).filter(text => text.includes(needle)).length;
}

/** One round's plan. */
interface Plan {
	readonly shape: Shape;
	readonly disturbance: Disturbance;
}

/**
 * A seeded ROUNDS-long prefix of the shuffled shape times disturbance product.
 *
 * A plain lottery would let a seed draw the same easy pair six times and report
 * a quiet run as coverage. Shuffling the full cross product and taking a prefix
 * keeps every round distinct while the seed still decides which combinations run
 * and in what order, which is what makes several seeds worth running.
 */
function planFor(seed: number, rounds: number): Plan[] {
	const pairs: Plan[] = SHAPES.flatMap(shape => DISTURBANCES.map(disturbance => ({ shape, disturbance })));
	const random = seededRandom(seed);
	for (let index = pairs.length - 1; index > 0; index--) {
		const swap = Math.floor(random() * (index + 1));
		const held = pairs[index];
		pairs[index] = pairs[swap];
		pairs[swap] = held;
	}
	return pairs.slice(0, rounds);
}

const ROUNDS = 12;

describe("a seeded storm of turn shapes and disturbances leaves history a provider would accept", () => {
	const SEEDS = [0x5eed, 0xc0ffee, 0x1337, 0xbeef, 0xfeed] as const;

	it("plans distinct combinations, and the seeds together reach every shape and disturbance", () => {
		expect(SHAPES.length).toBe(8);
		expect(DISTURBANCES.length).toBe(4);
		const visited = new Set<string>();
		for (const seed of SEEDS) {
			const plan = planFor(seed, ROUNDS);
			expect(plan.length).toBe(ROUNDS);
			// No round repeats a pair, so a quiet run is 12 different situations
			// rather than one situation drawn twelve times.
			expect(new Set(plan.map(entry => `${entry.shape}/${entry.disturbance}`)).size).toBe(ROUNDS);
			for (const entry of plan) visited.add(`${entry.shape}/${entry.disturbance}`);
		}
		for (const shape of SHAPES) {
			expect(`${shape} planned`).toBe(
				[...visited].some(pair => pair.startsWith(`${shape}/`)) ? `${shape} planned` : `${shape} never planned`,
			);
		}
		for (const disturbance of DISTURBANCES) {
			expect(`${disturbance} planned`).toBe(
				[...visited].some(pair => pair.endsWith(`/${disturbance}`))
					? `${disturbance} planned`
					: `${disturbance} never planned`,
			);
		}
	});

	for (const seed of SEEDS) {
		it(`settles and stays well paired for ${ROUNDS} rounds from seed 0x${seed.toString(16)}`, async () => {
			const plan = planFor(seed, ROUNDS);
			const contexts: Context[] = [];
			let round: Round = {
				index: 0,
				shape: "text only",
				entered: Promise.withResolvers<void>(),
				gate: Promise.withResolvers<void>(),
				opened: true,
			};

			sim = await createSimulation({
				// Retries stay on: one shape is a retryable failure, and the harness
				// caps the budget at 2 attempts with a 1ms backoff.
				settings: { "retry.enabled": true },
				tools: [
					simTool("work", async () => ({ content: [{ type: "text", text: "worked" }] })),
					simTool("other", async () => ({ content: [{ type: "text", text: "othered" }] }), {
						concurrency: "exclusive",
					}),
				],
				script: async turn => {
					contexts.push(turn.context);
					const current = round;
					if (current.opened) {
						// A continuation, a steered re-ask, or a retry: answer plainly so
						// the round terminates instead of emitting calls forever.
						turn.text(`continuation ${turn.call}`);
						turn.finish();
						return;
					}
					current.opened = true;
					// Every id here is what a per-message counter emits: it restarts at
					// `call_0` on every turn, so ids collide ACROSS rounds by design.
					// That is what real OpenAI-compatible servers send, and it is the
					// shape that used to collapse two calls onto one outbound handle.
					switch (current.shape) {
						case "text only":
							turn.text(`answer ${current.index}`);
							break;
						case "one tool":
							turn.toolCall("work", { round: current.index }, "call_0");
							break;
						case "two shared tools":
							turn.toolCall("work", { round: current.index, n: 1 }, "call_0");
							turn.toolCall("work", { round: current.index, n: 2 }, "call_1");
							break;
						case "an exclusive tool beside a shared one":
							turn.toolCall("work", { round: current.index }, "call_0");
							turn.toolCall("other", { round: current.index }, "call_1");
							break;
						case "text and a tool in one turn":
							turn.text(`thinking about ${current.index}. `);
							turn.toolCall("work", { round: current.index }, "call_0");
							break;
						case "a repeated tool-call id":
							// The provider hands out the same id twice in ONE message; both
							// calls are real and both must keep their own result.
							turn.toolCall("work", { round: current.index, n: 1 }, "call_0");
							turn.toolCall("work", { round: current.index, n: 2 }, "call_0");
							break;
						case "an empty turn":
							break;
						case "a retryable provider failure":
							current.entered.resolve();
							turn.fail(`503 Service Unavailable: round ${current.index}`);
							return;
					}
					current.entered.resolve();
					await current.gate.promise;
					const emittedCall = current.shape !== "text only" && current.shape !== "an empty turn";
					turn.finish(emittedCall ? "toolUse" : "stop");
				},
			});

			const simulation = sim;
			const settle = async (): Promise<void> => {
				while (simulation.session.isStreaming || simulation.session.agent.hasQueuedMessages()) {
					await whenSessionEvent(simulation.session, event => event.type === "agent_end");
				}
			};

			const cancelledTexts: string[] = [];
			const deliveredTexts: string[] = [];

			for (const [offset, entry] of plan.entries()) {
				const index = offset + 1;
				const { shape, disturbance } = entry;
				const where = `seed 0x${seed.toString(16)} round ${index} (${shape} / ${disturbance})`;
				round = {
					index,
					shape,
					entered: Promise.withResolvers<void>(),
					gate: Promise.withResolvers<void>(),
					opened: false,
				};

				// Zero padded: an unpadded `round 1` is a substring of `round 12`, so
				// the exactly-once counts below would credit the wrong message.
				const promptText = `round ${String(index).padStart(2, "0")}`;
				const pending = simulation.session.prompt(promptText).catch(() => undefined);
				await round.entered.promise;

				const disturbanceText = `${disturbance} ${String(index).padStart(2, "0")}`;
				if (disturbance === "steer") {
					const steered = simulation.session
						.prompt(disturbanceText, { streamingBehavior: "steer" })
						.catch(() => undefined);
					round.gate.resolve();
					await steered;
					deliveredTexts.push(disturbanceText);
				} else if (disturbance === "follow-up") {
					const queued = simulation.session
						.prompt(disturbanceText, { streamingBehavior: "followUp" })
						.catch(() => undefined);
					round.gate.resolve();
					await queued;
					deliveredTexts.push(disturbanceText);
				} else if (disturbance === "cancel") {
					await simulation.session.abort({ reason: USER_INTERRUPT_LABEL });
					round.gate.resolve();
					cancelledTexts.push(promptText);
				} else {
					round.gate.resolve();
				}
				if (disturbance !== "cancel") deliveredTexts.push(promptText);

				await pending;
				await settle();

				expect(`${where} isStreaming=${simulation.session.isStreaming}`).toBe(`${where} isStreaming=false`);
				expect(simulation.session.agent.hasQueuedMessages()).toBe(false);
				expect(describeViolations(where, turnViolations(simulation))).toEqual([]);
				expect(describeViolations(`${where} store`, pairingViolations(simulation.session.messages))).toEqual([]);
				const outbound = contexts.at(-1)?.messages ?? [];
				expect(describeViolations(`${where} wire`, pairingViolations(outbound))).toEqual([]);
			}

			// Nothing the user said was stored twice, and everything that rode a
			// round the user did not cancel is there exactly once.
			for (const text of deliveredTexts) {
				expect(`${text} stored ${countMentions(simulation.session.messages, text)}x`).toBe(`${text} stored 1x`);
			}
			for (const text of cancelledTexts) {
				expect(countMentions(simulation.session.messages, text)).toBeLessThanOrEqual(1);
			}
		});
	}
});
