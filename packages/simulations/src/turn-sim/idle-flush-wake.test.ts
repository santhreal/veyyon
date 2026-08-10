/**
 * The agent waking up on its own because something finished.
 *
 * WHY THIS FILE EXISTS. A background job completing, an MCP notification, a late
 * diagnostic: none of them is a user prompt, and all of them reach the model
 * through the yield queue's idle flush, which starts a whole new agent turn with
 * nobody typing. That is the loudest thing this product does without being asked,
 * and every way it can go wrong is silent. A wake that never fires is a job the
 * operator watched finish and the agent never mentions. A wake that fires while a
 * turn is alive is a second turn racing the first, which is the stranding shape
 * behind a session that sits at "Working...". A wake per entry instead of per
 * batch is one extra full-priced request for every job in a fan-out. A wake for a
 * delivery that was already suppressed is the agent reporting a result the user
 * cancelled.
 *
 * The queue's own unit tests drive `injectIdle` and `scheduleIdleFlush` as
 * callbacks. Nothing there can see what the session does with them, which is the
 * whole question here: whether a REQUEST happens, when, how many, carrying what.
 *
 * WHAT IS ASSERTED. Which requests the provider actually served and what they
 * carried; whether the delivery landed inside the prompt that was already running
 * or in a turn of its own (measured by reading the request count at the moment
 * `prompt()` resolves, which is the only thing that tells the two apart); that
 * the wake keeps the conversation's cache identity rather than opening a cold
 * one; and which queued kinds a new conversation drops.
 *
 * The rows register their own dispatchers on the live `session.yieldQueue`, which
 * is exactly how the production producers attach (`async-result` for job
 * completions, `mcp-notification`, late LSP diagnostics, and `advisor` with
 * `skipIdleFlush`). The kind strings are the production keys, because the session
 * clears the queue BY KIND across a conversation boundary. Nothing here asserts a
 * producer's message wording, which belongs to that producer.
 *
 * NOT asserted: the staleness predicate of any real producer (the rows supply
 * their own, so the class under test stays "a stale-only batch must not wake the
 * agent"), and the streaming-mode dispatch, which injects into a live turn
 * through a different path and is the aside matrix's subject.
 *
 * RED PROOFS, every one of them run rather than predicted.
 *   - Emptying the aside provider's `thunks.push(...this.yieldQueue.drainLazy())`
 *     reds all three rows whose delivery comes from a live turn's own boundary,
 *     and leaves the three wake rows green. That split is the file's shape: the
 *     wake and the drain are two different deliveries of the same queue.
 *   - Ignoring the `isStale` filter in `YieldQueue.#build` reds the
 *     suppressed-delivery row, which then wakes the agent for a job whose
 *     delivery the user cancelled.
 *   - Widening the conversation boundary's `this.yieldQueue.clear("advisor")` to
 *     `clear()` reds the survives-a-new-conversation row: the job completion is
 *     dropped along with the advice.
 *   - Removing BOTH post-prompt guards in `#schedulePostPromptTask` (the
 *     abort-signalled wait and the `signal.aborted` re-check) also reds the
 *     new-conversation row, because the wake pending against the conversation
 *     that ended now fires into the one that replaced it.
 *   - The two streaming guards (`enqueue`'s `!isStreaming()` gate and the
 *     re-check inside the scheduled run) are redundant with each other: removing
 *     either alone changes nothing, and removing both reds the retry row only.
 *     The mid-answer row survives even that, because the turn's stop boundary has
 *     already taken the entry by the time a 1ms flush could run. Nobody should
 *     read that row as covering the streaming gate.
 *   - The `#idleFlushPending` dedupe is NOT what turns two completions into one
 *     wake; removing it changes nothing, because the batching comes from the
 *     drain taking every queued entry at once.
 *
 * A post-dispose row was written and then deleted rather than kept: the harness
 * detaches its provider script on `dispose()`, so no request can be observed
 * after it either way, and the row passed with both post-prompt guards removed.
 * The guards it was meant to cover are the ones the new-conversation row reds.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import { createSimulation, type Simulation, whenSessionEvent } from "./harness";
import { describeViolations, turnViolations } from "./invariants";

/** What a producer queues: one finished job. */
interface JobEntry {
	readonly id: string;
	/** The delivery was cancelled while the job was in flight. */
	readonly suppressed?: boolean;
}

/** Marker text the scripts look for in the outbound request. */
const JOBS = "JOBS-DONE";
const ADVICE = "ADVICE-NOTE";

function customMessage(customType: string, content: string): AgentMessage {
	return {
		role: "custom",
		customType,
		display: true,
		attribution: "agent",
		timestamp: Date.now(),
		content,
	} as AgentMessage;
}

/**
 * Register the job-completion channel: no `skipIdleFlush`, a staleness filter,
 * and a batched message. This is the shape `async-result` uses in production.
 */
function registerJobs(simulation: Simulation): void {
	simulation.session.yieldQueue.register<JobEntry>("async-result", {
		isStale: entry => entry.suppressed === true,
		build: entries =>
			entries.length === 0 ? null : customMessage("async-result", `${JOBS} ${entries.map(e => e.id).join("+")}`),
	});
}

/** Register the advisor channel: `skipIdleFlush`, so it never wakes anyone. */
function registerAdvice(simulation: Simulation): void {
	simulation.session.yieldQueue.register<JobEntry>("advisor", {
		skipIdleFlush: true,
		build: entries =>
			entries.length === 0 ? null : customMessage("advisor", `${ADVICE} ${entries.map(e => e.id).join("+")}`),
	});
}

/** What one request carried, as the marker names present in its messages. */
function carried(messages: readonly unknown[]): string {
	const text = JSON.stringify(messages);
	const marks = [text.includes(JOBS) ? "job" : "", text.includes(ADVICE) ? "advice" : ""].filter(Boolean);
	return marks.length === 0 ? "plain" : marks.join("+");
}

let sim: Simulation | undefined;

afterEach(async () => {
	await sim?.dispose();
	sim = undefined;
});

describe("a finished job wakes the agent when nothing else is running", () => {
	it("earns a request of its own, on the conversation's own cache identity", async () => {
		const served: string[] = [];
		const routing: Array<string | undefined> = [];
		sim = await createSimulation({
			settings: { "retry.enabled": false },
			script: turn => {
				served.push(carried(turn.context.messages));
				routing.push(turn.cacheRouting.promptCacheKey ?? turn.cacheRouting.sessionId);
				turn.text(`answer ${turn.call}`);
				turn.finish();
			},
		});
		registerJobs(sim);

		await sim.session.prompt("one");
		const beforeWake = served.length;
		sim.session.yieldQueue.enqueue<JobEntry>("async-result", { id: "job-a" });
		await whenSessionEvent(sim.session, event => event.type === "agent_end");

		// The user typed once and the provider was called twice: the second call is
		// the wake, and it carries the completion.
		expect(beforeWake).toBe(1);
		expect(served).toEqual(["plain", "job"]);
		// The completion is a message in the conversation, between the two answers,
		// rather than something the transcript only mentions.
		expect(sim.session.messages.map(message => message.role)).toEqual(["user", "assistant", "custom", "assistant"]);
		// A wake that opened a fresh cache identity would re-read the whole
		// conversation at full input price on every job completion.
		expect(routing[1]).toBe(routing[0]);
		expect(routing[0]).toBeTruthy();
		expect(describeViolations("a woken turn", turnViolations(sim))).toEqual([]);
	});

	it("batches everything that finished into one wake, not one request per job", async () => {
		const served: string[] = [];
		sim = await createSimulation({
			settings: { "retry.enabled": false },
			script: turn => {
				served.push(carried(turn.context.messages));
				turn.text(`answer ${turn.call}`);
				turn.finish();
			},
		});
		registerJobs(sim);

		await sim.session.prompt("one");
		sim.session.yieldQueue.enqueue<JobEntry>("async-result", { id: "job-a" });
		sim.session.yieldQueue.enqueue<JobEntry>("async-result", { id: "job-b" });
		await whenSessionEvent(sim.session, event => event.type === "agent_end");

		expect(served).toEqual(["plain", "job"]);
		const customs = sim.session.messages
			.filter(message => message.role === "custom")
			.map(message => (message as { content?: string }).content);
		expect(customs).toEqual([`${JOBS} job-a+job-b`]);
	});

	it("never wakes the agent for a delivery that was suppressed", async () => {
		const served: string[] = [];
		sim = await createSimulation({
			settings: { "retry.enabled": false },
			script: turn => {
				served.push(carried(turn.context.messages));
				turn.text(`answer ${turn.call}`);
				turn.finish();
			},
		});
		registerJobs(sim);

		await sim.session.prompt("one");
		sim.session.yieldQueue.enqueue<JobEntry>("async-result", { id: "job-dead", suppressed: true });
		// The flush is scheduled with a 1ms delay, so this outlives it by an order
		// of magnitude: nothing here waits on an event that must never arrive.
		await new Promise(resolve => setTimeout(resolve, 60));

		expect(served).toEqual(["plain"]);
		// The entry is consumed rather than left behind to surface on a later turn.
		expect(sim.session.yieldQueue.has("async-result")).toBe(false);
		expect(sim.session.messages.some(message => message.role === "custom")).toBe(false);
	});
});

describe("a job that finishes while a turn is alive rides that turn", () => {
	it("is delivered before the prompt resolves, and earns no wake of its own", async () => {
		const served: string[] = [];
		let live: Simulation | undefined;
		sim = await createSimulation({
			settings: { "retry.enabled": false },
			script: turn => {
				served.push(carried(turn.context.messages));
				if (turn.call === 1) {
					// The completion lands while the model is mid-answer, which is when
					// the queue must not schedule a turn of its own.
					live?.session.yieldQueue.enqueue<JobEntry>("async-result", { id: "job-mid" });
				}
				turn.text(`answer ${turn.call}`);
				turn.finish();
			},
		});
		live = sim;
		registerJobs(sim);

		await sim.session.prompt("one");
		// Read inside the same tick the prompt resolved on: the delivery is part of
		// this prompt's work, not a later turn's.
		const atResolve = [...served];
		await new Promise(resolve => setTimeout(resolve, 60));

		expect(atResolve).toEqual(["plain", "job"]);
		expect(served).toEqual(atResolve);
		expect(sim.session.yieldQueue.has("async-result")).toBe(false);
	});

	it("waits out a retry backoff rather than racing the retry", async () => {
		const served: string[] = [];
		sim = await createSimulation({
			settings: { "retry.maxRetries": 2, "retry.baseDelayMs": 30, "retry.maxDelayMs": 30 },
			script: turn => {
				served.push(carried(turn.context.messages));
				if (turn.call === 1) {
					turn.fail("500 Internal Server Error from bedrock");
					return;
				}
				turn.text(`answer ${turn.call}`);
				turn.finish();
			},
		});
		registerJobs(sim);

		const pending = sim.session.prompt("one");
		await whenSessionEvent(sim.session, event => event.type === "auto_retry_start");
		// A retry backoff looks idle from outside and is not: the turn is still
		// streaming, and a wake here would put two turns on one conversation.
		expect(sim.session.isRetrying).toBe(true);
		sim.session.yieldQueue.enqueue<JobEntry>("async-result", { id: "job-mid" });
		await pending;
		const atResolve = [...served];
		await new Promise(resolve => setTimeout(resolve, 60));

		// The failed attempt, the retry, and then the completion on the retried
		// turn's own stop boundary. All three before the prompt resolves.
		expect(atResolve).toEqual(["plain", "plain", "job"]);
		expect(served).toEqual(atResolve);
	});
});

describe("a new conversation keeps what belongs to the session", () => {
	it("carries a finished job across, and drops the advisor note", async () => {
		const served: string[] = [];
		sim = await createSimulation({
			settings: { "retry.enabled": false },
			script: turn => {
				served.push(carried(turn.context.messages));
				turn.text(`answer ${turn.call}`);
				turn.finish();
			},
		});
		registerJobs(sim);
		registerAdvice(sim);

		await sim.session.prompt("one");
		sim.session.yieldQueue.enqueue<JobEntry>("advisor", { id: "note-a" });
		sim.session.yieldQueue.enqueue<JobEntry>("async-result", { id: "job-a" });
		expect(await sim.session.newSession()).toBe(true);

		// The advice was about the conversation that is over. The job is the
		// operator's, and it belongs to the session that is still running.
		expect(sim.session.yieldQueue.has("advisor")).toBe(false);
		expect(sim.session.yieldQueue.has("async-result")).toBe(true);

		await sim.session.prompt("two");
		await new Promise(resolve => setTimeout(resolve, 60));

		// Request 1 was the old conversation. Requests 2 and 3 are the new one, and
		// the completion reaches it without the advice.
		expect(served).toEqual(["plain", "plain", "job"]);
	});
});
