/**
 * Interjection and mid-conversation stall simulations.
 *
 * WHY THIS FILE EXISTS. The operator symptom: a veyyon session stops making
 * progress — "Working…" forever — almost always right after an interjection
 * (a message typed mid-turn, or Esc-cancel then retry), but sometimes with no
 * interjection at all, mid-conversation, across every provider and model.
 * Cancelling and retrying recovers it. A suite that only exercises healthy
 * turns cannot see this class: the stall lives in the state a disturbed turn
 * leaves behind (abort signals, queued steers, retry promises, semaphore
 * slots, partial assistant messages).
 *
 * Every scenario here drives a REAL AgentSession through the turn-sim harness
 * (real Agent, real settings-aware stream stack, scripted bedrock transport)
 * and asserts one contract: THE TURN SETTLES. A hang fails by test timeout;
 * no assertion in this file can be satisfied by a stuck session.
 *
 * Determinism: no wall-clock sleeps. Scripts block on gates the test resolves
 * from session events, and the only real timers are the product's own
 * watchdogs and retry backoffs, run on the harness's shrunk budgets.
 * Randomized scenarios use a fixed-seed RNG; the seed is in every failure
 * message so a red run can be replayed verbatim.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import { USER_INTERRUPT_LABEL } from "@veyyon/coding-agent/session/messages";
import {
	createSimulation,
	lastAssistantText,
	type Simulation,
	scriptTurns,
	simTool,
	whenSessionEvent,
} from "./harness";

let sim: Simulation | undefined;

afterEach(async () => {
	await sim?.dispose();
	sim = undefined;
});

/** mulberry32: tiny seeded RNG so storm scenarios are replayable. */
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

/**
 * Wait until the session is idle AND every queued steer/follow-up has been
 * drained into its own turn. Each queued message spawns a continuation run,
 * so this waits one run-ending event at a time; if a queued message never
 * starts a turn (the stranded-queue stall), the wait never resolves and the
 * test times out.
 */
async function settleSession(simulation: Simulation): Promise<void> {
	while (simulation.session.isStreaming || simulation.session.agent.hasQueuedMessages()) {
		await whenSessionEvent(simulation.session, event => event.type === "agent_end");
	}
}

/** True when a message is a user-role message whose text mentions `needle`. */
function userMessageMentions(message: AgentMessage, needle: string): boolean {
	if (message.role !== "user") return false;
	const content = message.content;
	if (typeof content === "string") return content.includes(needle);
	return content.some(block => block.type === "text" && block.text.includes(needle));
}

describe("interjections mid-turn", () => {
	it("settles when the user steers after the first token, then the run continues", async () => {
		// The interjection lands while the first provider call is still open.
		// The run must finish call 1, fold the steer in, answer it in call 2,
		// and go idle.
		const interjectionLanded = Promise.withResolvers<void>();
		sim = await createSimulation({
			settings: { "retry.enabled": false },
			script: scriptTurns(
				async turn => {
					turn.text("first half.");
					await interjectionLanded.promise;
					turn.text(" Second half.");
					turn.finish();
				},
				turn => {
					const sawSteer = turn.context.messages.some(message => userMessageMentions(message, "hold on"));
					turn.text(sawSteer ? "answered the interjection" : "steer never reached the provider");
					turn.finish();
				},
			),
		});

		const first = sim.session.prompt("go");
		await whenSessionEvent(sim.session, event => event.type === "message_update");
		const forwarded = await sim.session.prompt("hold on, also do this", { streamingBehavior: "steer" });
		expect(forwarded).toBe(true);
		interjectionLanded.resolve();

		await first;

		expect(sim.session.isStreaming).toBe(false);
		expect(sim.providerCalls()).toBe(2);
		expect(lastAssistantText(sim.session)).toBe("answered the interjection");
	});

	it("settles when Esc cancels mid-stream and the user immediately prompts again", async () => {
		// The first stream is open and producing when the cancel lands; the
		// script never closes it. The abort must tear it down, and the next
		// prompt must reach the provider on a fresh, un-aborted signal.
		const observed: Array<{ call: number; aborted: boolean | undefined }> = [];
		sim = await createSimulation({
			settings: { "retry.enabled": false },
			script: scriptTurns(
				async turn => {
					observed.push({ call: turn.call, aborted: turn.signal?.aborted });
					turn.text("partial answer");
					await Promise.withResolvers<never>().promise;
				},
				turn => {
					observed.push({ call: turn.call, aborted: turn.signal?.aborted });
					turn.text("post-cancel answer");
					turn.finish();
				},
			),
		});

		const first = sim.session.prompt("go");
		await whenSessionEvent(sim.session, event => event.type === "message_update");
		await sim.session.abort({ reason: USER_INTERRUPT_LABEL });
		await first;

		expect(sim.session.isStreaming).toBe(false);
		await sim.session.prompt("again");

		expect(sim.session.isStreaming).toBe(false);
		const followUp = observed.at(-1);
		expect(followUp?.call).toBe(2);
		expect(followUp?.aborted).toBe(false);
		expect(lastAssistantText(sim.session)).toBe("post-cancel answer");
	});

	it("settles when the user steers while a tool call is running", async () => {
		// The tool is mid-execution when the steer lands. The tool is not
		// interruptible, so the steer must wait out the tool, fold into the
		// next provider call, and the run must answer it.
		const toolEntered = Promise.withResolvers<void>();
		const releaseTool = Promise.withResolvers<void>();
		sim = await createSimulation({
			settings: { "retry.enabled": false },
			tools: [
				simTool("slow", async () => {
					toolEntered.resolve();
					await releaseTool.promise;
					return { content: [{ type: "text", text: "tool done" }] };
				}),
			],
			script: scriptTurns(
				turn => {
					turn.toolCall("slow", {});
					turn.finish();
				},
				turn => {
					const sawSteer = turn.context.messages.some(message => userMessageMentions(message, "redirect"));
					turn.text(sawSteer ? "answered after tool" : "steer never reached the provider");
					turn.finish();
				},
			),
		});

		const first = sim.session.prompt("go");
		await toolEntered.promise;
		await sim.session.prompt("redirect: do the other thing", { streamingBehavior: "steer" });
		releaseTool.resolve();

		await first;

		expect(sim.session.isStreaming).toBe(false);
		expect(sim.providerCalls()).toBe(2);
		expect(lastAssistantText(sim.session)).toBe("answered after tool");
	});

	it("settles when the user steers while an interruptible tool is running", async () => {
		// Interruptible tools (job/irc-style waits) take the steering abort
		// mid-flight. The tool never returns a result; the loop must record the
		// interruption, inject the steer, and answer on the next provider call.
		const toolEntered = Promise.withResolvers<void>();
		let toolSawAbort = false;
		sim = await createSimulation({
			settings: { "retry.enabled": false },
			tools: [
				simTool(
					"waiter",
					async (_id, _args, signal) => {
						toolEntered.resolve();
						const held = Promise.withResolvers<never>();
						signal?.addEventListener(
							"abort",
							() => {
								toolSawAbort = true;
								held.reject(new Error("tool aborted"));
							},
							{ once: true },
						);
						await held.promise;
						return { content: [{ type: "text", text: "never reached" }] };
					},
					{ interruptible: true },
				),
			],
			script: scriptTurns(
				turn => {
					turn.toolCall("waiter", {});
					turn.finish();
				},
				turn => {
					turn.text("answered the steer");
					turn.finish();
				},
			),
		});

		const first = sim.session.prompt("go");
		await toolEntered.promise;
		await sim.session.prompt("stop waiting, answer now", { streamingBehavior: "steer" });

		await first;

		expect(sim.session.isStreaming).toBe(false);
		expect(toolSawAbort).toBe(true);
		expect(sim.providerCalls()).toBe(2);
		expect(lastAssistantText(sim.session)).toBe("answered the steer");
	});

	it("settles when Esc cancels during a tool call and the user prompts again", async () => {
		const toolEntered = Promise.withResolvers<void>();
		sim = await createSimulation({
			settings: { "retry.enabled": false },
			tools: [
				simTool("wedge", async (_id, _args, signal) => {
					toolEntered.resolve();
					const held = Promise.withResolvers<never>();
					signal?.addEventListener("abort", () => held.reject(new Error("tool aborted")), { once: true });
					await held.promise;
					return { content: [{ type: "text", text: "never reached" }] };
				}),
			],
			script: scriptTurns(
				turn => {
					turn.toolCall("wedge", {});
					turn.finish();
				},
				turn => {
					turn.text("post-cancel tool answer");
					turn.finish();
				},
			),
		});

		const first = sim.session.prompt("go");
		await toolEntered.promise;
		await sim.session.abort({ reason: USER_INTERRUPT_LABEL });
		await first;

		expect(sim.session.isStreaming).toBe(false);
		await sim.session.prompt("again");
		expect(lastAssistantText(sim.session)).toBe("post-cancel tool answer");
		expect(sim.session.isStreaming).toBe(false);
	});

	it("settles when the user steers during retry backoff and the retry proceeds", async () => {
		// The first attempt errors retryably; while the session sits in
		// backoff, the user types. The steer must ride into the retried turn
		// and the retried turn must answer it. The 200ms backoff is the
		// product's own retry timer on a shrunk budget, not a test sleep.
		sim = await createSimulation({
			settings: { "retry.baseDelayMs": 200, "retry.maxDelayMs": 1000, "retry.maxRetries": 2 },
			script: scriptTurns(
				turn => {
					turn.fail("503 Service Unavailable: upstream overloaded");
				},
				turn => {
					const sawSteer = turn.context.messages.some(message => userMessageMentions(message, "while you wait"));
					turn.text(sawSteer ? "retry answered the steer" : "steer never reached the provider");
					turn.finish();
				},
			),
		});

		const first = sim.session.prompt("go");
		await whenSessionEvent(sim.session, event => event.type === "auto_retry_start");
		expect(sim.session.isRetrying).toBe(true);
		await sim.session.steer("while you wait, also check this");

		await first;

		expect(sim.session.isStreaming).toBe(false);
		expect(sim.session.isRetrying).toBe(false);
		expect(sim.providerCalls()).toBe(2);
		expect(lastAssistantText(sim.session)).toBe("retry answered the steer");
	});

	it("settles when the user queues a fresh message during retry backoff", async () => {
		// isStreaming stays true across the backoff (the retry is part of the
		// open run), so a typed message takes the follow-up queue. The retried
		// turn must settle, the queued message must drain into its own turn,
		// and the retry promise must resolve — a dangling retry promise blocks
		// every later prompt in #waitForPostPromptRecovery.
		sim = await createSimulation({
			settings: { "retry.baseDelayMs": 200, "retry.maxDelayMs": 1000, "retry.maxRetries": 2 },
			script: scriptTurns(
				turn => {
					turn.fail("503 Service Unavailable: upstream overloaded");
				},
				turn => {
					turn.text(`call ${turn.call} answered`);
					turn.finish();
				},
				turn => {
					turn.text("follow-up answered");
					turn.finish();
				},
			),
		});

		const first = sim.session.prompt("go");
		await whenSessionEvent(sim.session, event => event.type === "auto_retry_start");
		const interjected = sim.session.prompt("never mind, do this instead", { streamingBehavior: "followUp" });

		await Promise.all([first, interjected]);
		await settleSession(sim);

		expect(sim.session.isStreaming).toBe(false);
		expect(sim.session.isRetrying).toBe(false);
		expect(sim.session.agent.hasQueuedMessages()).toBe(false);
		expect(lastAssistantText(sim.session)).toContain("answered");
	});

	it("settles when Esc cancels during retry backoff and the user prompts again", async () => {
		// The cancel lands in the same microtask drain as the auto_retry_start
		// emit, before the retry handler assigns its backoff AbortController. A
		// cancel lost there left the 60s backoff to run out while abort()
		// awaited the handler — the session hung until a second Esc.
		sim = await createSimulation({
			settings: { "retry.baseDelayMs": 60_000, "retry.maxDelayMs": 120_000, "retry.maxRetries": 2 },
			script: scriptTurns(
				turn => {
					turn.fail("503 Service Unavailable: upstream overloaded");
				},
				turn => {
					turn.text("answer after cancelled retry");
					turn.finish();
				},
			),
		});

		const first = sim.session.prompt("go");
		await whenSessionEvent(sim.session, event => event.type === "auto_retry_start");
		await sim.session.abort({ reason: USER_INTERRUPT_LABEL });
		await first;

		expect(sim.session.isRetrying).toBe(false);
		expect(sim.session.isStreaming).toBe(false);
		await sim.session.prompt("again");
		expect(lastAssistantText(sim.session)).toBe("answer after cancelled retry");
	});

	it("settles when Esc cancels during compaction and the user prompts again", async () => {
		// Manual /compact drives a summarization provider call. The cancel
		// lands while the summary stream is open. Compaction must unwind as
		// cancelled, and the next prompt must reach the provider normally.
		const summaryStarted = Promise.withResolvers<void>();
		sim = await createSimulation({
			settings: { "retry.enabled": false, "compaction.enabled": true, "compaction.thresholdTokens": 15_000 },
			model: { contextWindow: 20_000 },
			script: scriptTurns(
				turn => {
					turn.text(`answer one. ${"bulk ".repeat(3500)}`);
					turn.finish();
				},
				turn => {
					turn.text(`answer two. ${"bulk ".repeat(3500)}`);
					turn.finish();
				},
				turn => {
					turn.text(`answer three. ${"bulk ".repeat(3500)}`);
					turn.finish();
				},
				async turn => {
					summaryStarted.resolve();
					turn.text("partial summary");
					await Promise.withResolvers<never>().promise;
				},
				turn => {
					turn.text("answer after cancelled compaction");
					turn.finish();
				},
			),
		});

		await sim.session.prompt("one");
		await sim.session.prompt("two");
		await sim.session.prompt("three");
		expect(sim.providerCalls()).toBe(3);

		const compacting = sim.session.compact();
		await summaryStarted.promise;
		await sim.session.abort({ reason: USER_INTERRUPT_LABEL });
		await expect(compacting).rejects.toThrow(/cancel/i);

		expect(sim.session.isCompacting).toBe(false);
		expect(sim.session.isStreaming).toBe(false);
		await sim.session.prompt("after the cancelled compaction");
		expect(lastAssistantText(sim.session)).toBe("answer after cancelled compaction");
		expect(sim.session.isStreaming).toBe(false);
	});
});

describe("plain multi-turn sessions without interjection", () => {
	it("settles a five-turn chain of mixed text and tool turns", async () => {
		sim = await createSimulation({
			settings: { "retry.enabled": false },
			tools: [
				simTool("lookup", async (_id, args) => ({
					content: [{ type: "text", text: `looked up ${String(args.q)}` }],
				})),
			],
			script: turn => {
				if (turn.call % 2 === 1) {
					turn.text(`text answer ${turn.call}`);
				} else {
					turn.toolCall("lookup", { q: turn.call });
				}
				turn.finish();
			},
		});

		// Odd calls answer in text; even calls invoke the tool and then the
		// loop re-calls the provider for the post-tool answer, so each prompt
		// settles with the tail assistant message from its own turn.
		for (let round = 1; round <= 5; round++) {
			await sim.session.prompt(`round ${round}`);
			expect(sim.session.isStreaming).toBe(false);
			expect(sim.session.messages.at(-1)?.role).toBe("assistant");
		}
	});

	it("settles when the provider goes silent after N bytes mid-session", async () => {
		// Turn 1 is healthy; turn 2 streams real content then the socket dies.
		// The idle watchdog must kill it, the retry must re-sample, and the
		// session must settle with the recovered answer.
		const stalled = Promise.withResolvers<never>();
		sim = await createSimulation({
			script: scriptTurns(
				turn => {
					turn.text("healthy turn");
					turn.finish();
				},
				async turn => {
					turn.text("half an answer");
					await stalled.promise;
				},
				turn => {
					turn.text("recovered mid-session");
					turn.finish();
				},
			),
		});

		await sim.session.prompt("first");
		expect(lastAssistantText(sim.session)).toBe("healthy turn");

		await sim.session.prompt("second");

		expect(sim.session.isStreaming).toBe(false);
		expect(sim.providerCalls()).toBe(3);
		expect(lastAssistantText(sim.session)).toBe("recovered mid-session");
	});

	it("settles when the provider never sends a first byte mid-session", async () => {
		const never = Promise.withResolvers<never>();
		sim = await createSimulation({
			script: scriptTurns(
				turn => {
					turn.text("healthy turn");
					turn.finish();
				},
				async turn => {
					void turn;
					await never.promise;
				},
				turn => {
					turn.text("recovered after silence");
					turn.finish();
				},
			),
		});

		await sim.session.prompt("first");
		await sim.session.prompt("second");

		expect(sim.session.isStreaming).toBe(false);
		expect(sim.providerCalls()).toBe(3);
		expect(lastAssistantText(sim.session)).toBe("recovered after silence");
	});

	it("settles a slow-drip turn of many small deltas", async () => {
		// 300 deltas with a macrotask between each: the stream is always
		// moving, so no watchdog may fire, and the assembled answer must be
		// exactly the concatenation of the deltas.
		const deltas = Array.from({ length: 300 }, (_, index) => `d${index} `);
		sim = await createSimulation({
			settings: { "retry.enabled": false },
			script: async turn => {
				for (const delta of deltas) {
					turn.text(delta);
					await Promise.resolve();
				}
				turn.finish();
			},
		});

		await sim.session.prompt("go");

		expect(sim.session.isStreaming).toBe(false);
		expect(lastAssistantText(sim.session)).toBe(deltas.join(""));
	});

	it("settles a tool-heavy chain of sequential tool calls in one prompt", async () => {
		// One prompt, six provider calls: five tool calls chained by the loop,
		// then the final text answer. Every intermediate turn must hand back to
		// the loop, not wedge between tool boundary and next call.
		const toolRuns: string[] = [];
		sim = await createSimulation({
			settings: { "retry.enabled": false },
			tools: [
				simTool("step", async (_id, args) => {
					toolRuns.push(String(args.n));
					return { content: [{ type: "text", text: `step ${String(args.n)} done` }] };
				}),
			],
			script: turn => {
				if (turn.call <= 5) {
					turn.toolCall("step", { n: turn.call });
				} else {
					turn.text("all steps done");
				}
				turn.finish();
			},
		});

		await sim.session.prompt("go");

		expect(sim.session.isStreaming).toBe(false);
		expect(sim.providerCalls()).toBe(6);
		expect(toolRuns).toEqual(["1", "2", "3", "4", "5"]);
		expect(lastAssistantText(sim.session)).toBe("all steps done");
	});

	it("settles a manual compaction mid-session and continues afterwards", async () => {
		// No interjection anywhere: three turns, a successful compaction, then
		// a fourth turn. The summarization call is a provider call like any
		// other, and the session must stay drivable after it.
		sim = await createSimulation({
			settings: { "retry.enabled": false, "compaction.enabled": true, "compaction.thresholdTokens": 15_000 },
			model: { contextWindow: 20_000 },
			script: scriptTurns(
				turn => {
					turn.text(`answer one. ${"bulk ".repeat(3500)}`);
					turn.finish();
				},
				turn => {
					turn.text(`answer two. ${"bulk ".repeat(3500)}`);
					turn.finish();
				},
				turn => {
					turn.text(`answer three. ${"bulk ".repeat(3500)}`);
					turn.finish();
				},
				turn => {
					turn.text("a compact summary of the earlier turns");
					turn.finish();
				},
				turn => {
					turn.text("answer after compaction");
					turn.finish();
				},
			),
		});

		await sim.session.prompt("one");
		await sim.session.prompt("two");
		await sim.session.prompt("three");

		const result = await sim.session.compact();
		expect(result.summary).toContain("compact summary");

		await sim.session.prompt("four");
		expect(sim.session.isStreaming).toBe(false);
		expect(lastAssistantText(sim.session)).toBe("answer after compaction");
	});
});

describe("cancel and interjection storms", () => {
	it("settles every round of a seeded cancel+retry storm", async () => {
		// Each round: prompt, wait for the first visible token, sometimes
		// Esc-cancel, then release the stream and prompt the next round. The
		// seed is fixed and named in every failure so the sequence replays.
		const seed = 0xc0ffee;
		const random = seededRandom(seed);
		let roundGate = Promise.withResolvers<void>();
		sim = await createSimulation({
			settings: { "retry.enabled": false },
			script: async turn => {
				turn.text(`answer ${turn.call}`);
				// The stream stays open until the test has made its cancel
				// decision for the round, so a cancel always lands mid-stream.
				await roundGate.promise;
				turn.finish();
			},
		});

		for (let round = 1; round <= 10; round++) {
			const pending = sim.session.prompt(`round ${round}`);
			await whenSessionEvent(sim.session, event => event.type === "message_update");
			if (random() < 0.6) {
				await sim.session.abort({ reason: USER_INTERRUPT_LABEL });
			}
			roundGate.resolve();
			roundGate = Promise.withResolvers<void>();
			await pending;
			expect(sim.session.isStreaming).toBe(false);
		}

		await sim.session.prompt("final");
		expect(sim.session.isStreaming).toBe(false);
		expect(lastAssistantText(sim.session)).toContain("answer");
	});

	it("settles every round of a seeded steer/follow-up storm", async () => {
		// Each round interjects at a randomized point in a tool-call turn.
		// Steers interrupt the run; follow-ups queue behind it and drain into
		// their own turn, which calls the tool again — so gates are released
		// by event-stream count, never by round, or a follow-up turn wedges on
		// a gate nobody releases. Every round must end idle, queue empty.
		const seed = 0x5eed;
		const random = seededRandom(seed);
		let toolGate = Promise.withResolvers<void>();
		sim = await createSimulation({
			settings: { "retry.enabled": false },
			tools: [
				simTool("work", async () => {
					await toolGate.promise;
					return { content: [{ type: "text", text: "worked" }] };
				}),
			],
			script: turn => {
				if (turn.call % 2 === 1) {
					turn.toolCall("work", {});
				} else {
					turn.text(`answer ${turn.call}`);
				}
				turn.finish();
			},
		});

		// Every turn in this storm opens with a tool call and every tool call
		// gets exactly one gate release. Reading the recorded event stream
		// (not a fresh subscription) cannot miss an execution that started
		// before the loop looked.
		const simulation = sim;
		let releasedToolExecutions = 0;
		const releasePendingToolGates = (): void => {
			const started = simulation.eventsOfType("tool_execution_start").length;
			while (releasedToolExecutions < started) {
				toolGate.resolve();
				toolGate = Promise.withResolvers<void>();
				releasedToolExecutions++;
			}
		};
		const waitForToolExecution = async (count: number): Promise<void> => {
			while (simulation.eventsOfType("tool_execution_start").length < count) {
				await whenSessionEvent(simulation.session, event => event.type === "tool_execution_start");
			}
		};
		// The drain owns both gate releases and the prompt await: a follow-up
		// turn calls the tool again, and its gate can only be released while
		// the loop — not an awaited prompt — is what blocks the round.
		const drainRound = async (pending: Promise<unknown>): Promise<void> => {
			for (;;) {
				releasePendingToolGates();
				if (!simulation.session.isStreaming && !simulation.session.agent.hasQueuedMessages()) {
					await pending;
					return;
				}
				await whenSessionEvent(simulation.session, () => true);
			}
		};

		for (let round = 1; round <= 8; round++) {
			const pending = simulation.session.prompt(`round ${round}`);
			await waitForToolExecution(releasedToolExecutions + 1);
			const mode = random();
			if (mode < 0.4) {
				await simulation.session.prompt(`steer ${round}`, { streamingBehavior: "steer" });
			} else if (mode < 0.8) {
				await simulation.session.prompt(`follow ${round}`, { streamingBehavior: "followUp" });
			}
			releasePendingToolGates();
			await drainRound(pending);
			expect(simulation.session.isStreaming).toBe(false);
			expect(simulation.session.agent.hasQueuedMessages()).toBe(false);
		}
	});
});

describe("provider concurrency wrapper", () => {
	it("releases the semaphore slot when Esc cancels mid-stream, so the next turn runs", async () => {
		// The production stream path wraps every provider call in a per-provider
		// semaphore (sdk.ts). With the cap at 1, a slot leaked by the cancelled
		// turn would queue the next prompt's provider call behind a release that
		// never comes — the exact "stuck after cancel" shape.
		sim = await createSimulation({
			providerConcurrency: true,
			model: { provider: "ollama-cloud" },
			settings: { "retry.enabled": false, "providers.ollama-cloud.maxConcurrency": 1 },
			script: scriptTurns(
				async turn => {
					turn.text("partial");
					await Promise.withResolvers<never>().promise;
				},
				turn => {
					turn.text("acquired after cancel");
					turn.finish();
				},
			),
		});

		const first = sim.session.prompt("go");
		await whenSessionEvent(sim.session, event => event.type === "message_update");
		await sim.session.abort({ reason: USER_INTERRUPT_LABEL });
		await first;

		await sim.session.prompt("again");

		expect(sim.session.isStreaming).toBe(false);
		expect(sim.providerCalls()).toBe(2);
		expect(lastAssistantText(sim.session)).toBe("acquired after cancel");
	});

	it("releases the semaphore slot when the user steers mid-stream under a cap of 1", async () => {
		const interjectionLanded = Promise.withResolvers<void>();
		sim = await createSimulation({
			providerConcurrency: true,
			model: { provider: "ollama-cloud" },
			settings: { "retry.enabled": false, "providers.ollama-cloud.maxConcurrency": 1 },
			script: scriptTurns(
				async turn => {
					turn.text("first half.");
					await interjectionLanded.promise;
					turn.finish();
				},
				turn => {
					turn.text("steer answered under cap");
					turn.finish();
				},
			),
		});

		const first = sim.session.prompt("go");
		await whenSessionEvent(sim.session, event => event.type === "message_update");
		await sim.session.prompt("hold on", { streamingBehavior: "steer" });
		interjectionLanded.resolve();

		await first;

		expect(sim.session.isStreaming).toBe(false);
		expect(sim.providerCalls()).toBe(2);
		expect(lastAssistantText(sim.session)).toBe("steer answered under cap");
	});
});
