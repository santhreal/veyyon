/**
 * WHY: `collectPromptEvents` armed a deadline, and on expiry called `client.abort?.()` and rejected
 * the wait for `agent_end` — but it was awaiting `client.prompt()` at that moment, not the wait. The
 * rejection was swallowed by the guard against unhandled rejections, so a client that declares no
 * `abort` (the member is optional), or whose abort does not unblock its own stream, held that await
 * with its deadline already spent. Nothing above this layer bounds a TypeScript-edit trial: the
 * scheduler awaits `runSingleTask`, which awaits the prompt, so one such client stopped the whole
 * benchmark with no report and no error.
 *
 * The class this closes: every await inside one prompt attempt now ends when the attempt's deadline
 * ends, whichever of the two delivery kinds is in flight, and a client that never unwinds costs the
 * grace rather than the run.
 *
 * What it does not catch: the deadline itself. A `config.timeout` larger than the operator's
 * patience still expires only when it expires, and a client that emits events forever without
 * `agent_end` is bounded by that timeout, not by an activity window.
 */

import { describe, expect, it } from "bun:test";
import { setTimeout as sleepFor } from "node:timers/promises";
import { collectPromptEvents, PROMPT_UNWIND_GRACE_MS } from "../../../suites/typescript-edit/runner/events";
import type { BenchmarkPromptDelivery } from "../../../suites/typescript-edit/runner/prompt-delivery";
import { PromptTimeoutError } from "../../../suites/typescript-edit/runner/telemetry";
import type { BenchmarkClient, BenchmarkConfig } from "../../../suites/typescript-edit/runner/types";

/** Long enough for a bounded attempt to finish, short enough that an unbounded one is observed. */
const OBSERVATION_MS = 3000;
const CONNECTION_TIMEOUT_MS = 20;
const ACTIVITY_TIMEOUT_MS = 40;
/** How long a modelled client takes to unwind its stream after an abort. */
const UNWIND_MS = 60;

type StreamEvent = { type: string; [key: string]: unknown };

type StubOptions = {
	/**
	 * How the delivery promise behaves: never settles, fails immediately with this error, or fails a
	 * short while after `abort()` reaches the client, the way a real stream unwinds.
	 */
	readonly delivery: "never" | "unwindsOnAbort" | Error;
	/** Emitted synchronously once a listener is attached. */
	readonly emit?: readonly StreamEvent[];
	/** Whether the client declares `abort` at all. */
	readonly abortable: boolean;
};

type Stub = {
	readonly client: BenchmarkClient;
	/** One entry per `abort()` the collector made. */
	readonly aborts: string[];
	/** One entry once the delivery promise has settled. */
	readonly unwound: string[];
};

function stubClient(options: StubOptions): Stub {
	const aborts: string[] = [];
	const unwound: string[] = [];
	const unreached = (member: string): never => {
		throw new Error(`collectPromptEvents does not call ${member}`);
	};
	const pending = Promise.withResolvers<void>();
	const deliver = (): Promise<void> => {
		if (options.delivery instanceof Error) return Promise.reject(options.delivery);
		// A pending promise the abort settles, or one nothing ever settles: either way the test holds
		// no resource waiting for it.
		return pending.promise;
	};
	const unwind = () => {
		// A real client's stream unwinds a moment after the abort, not in the same tick. The delay is
		// modelled with a timer because that ordering is the behaviour under test; no case asserts how
		// long it took, only whether the collector returned before it happened.
		void sleepFor(UNWIND_MS).then(() => {
			pending.reject(new Error("aborted mid-stream"));
		});
	};
	const client: BenchmarkClient = {
		start: () => unreached("start"),
		setThinkingLevel: () => unreached("setThinkingLevel"),
		onEvent: listener => {
			for (const event of options.emit ?? []) listener(event);
			return () => {};
		},
		prompt: deliver,
		followUp: deliver,
		getSessionStats: () => unreached("getSessionStats"),
		getLastAssistantText: () => unreached("getLastAssistantText"),
		getMessages: () => unreached("getMessages"),
		getState: () => unreached("getState"),
		dispose: () => unreached("dispose"),
		...(options.abortable
			? {
					abort: () => {
						aborts.push("abort");
						if (options.delivery === "unwindsOnAbort") unwind();
					},
				}
			: {}),
	};
	pending.promise.then(
		() => {
			unwound.push("unwound");
		},
		() => {
			unwound.push("unwound");
		},
	);
	return { client, aborts, unwound };
}

const config: BenchmarkConfig = {
	provider: "stub",
	model: "stub",
	runsPerTask: 1,
	timeout: ACTIVITY_TIMEOUT_MS,
	connectionTimeout: CONNECTION_TIMEOUT_MS,
	taskConcurrency: 1,
};

const delivery = (kind: "prompt" | "followUp"): BenchmarkPromptDelivery => ({
	kind,
	message: "edit the file",
});

/**
 * Races the attempt against an observation window and reports which ended first, so a build with an
 * unbounded await fails with the wrong outcome instead of hanging the file.
 */
async function outcomeOf(
	attempt: Promise<readonly StreamEvent[]>,
): Promise<"returned" | "timed out" | "failed" | "still waiting"> {
	const observation = new AbortController();
	const raced = await Promise.race([
		attempt.then(
			() => "returned" as const,
			(err: unknown) => (err instanceof PromptTimeoutError ? ("timed out" as const) : ("failed" as const)),
		),
		sleepFor(OBSERVATION_MS, "still waiting" as const, { signal: observation.signal }).catch(
			() => "still waiting" as const,
		),
	]);
	observation.abort();
	return raced;
}

const DELIVERY_KINDS = [["prompt"], ["followUp"]] as ["prompt" | "followUp"][];

describe("a prompt whose client cannot be aborted", () => {
	it.each(DELIVERY_KINDS)("ends at its connection deadline when delivered by %s", async kind => {
		const { client, aborts } = stubClient({ delivery: "never", abortable: false });

		const outcome = await outcomeOf(collectPromptEvents(client, delivery(kind), config, async () => {}));

		expect(outcome).toBe("timed out");
		expect(aborts).toEqual([]);
	});

	it("ends at its activity deadline when abort does not unblock the stream", async () => {
		const { client, aborts } = stubClient({
			delivery: "never",
			abortable: true,
			emit: [{ type: "turn_start" }, { type: "message_end" }],
		});

		const outcome = await outcomeOf(collectPromptEvents(client, delivery("prompt"), config, async () => {}));

		expect(outcome).toBe("timed out");
		expect(aborts).toEqual(["abort"]);
	});

	it("reports what it saw before the deadline", async () => {
		const { client } = stubClient({
			delivery: "never",
			abortable: true,
			emit: [{ type: "turn_start" }, { type: "tool_execution_start", toolName: "read" }],
		});

		const attempt = collectPromptEvents(client, delivery("prompt"), config, async () => {});
		const observation = new AbortController();
		const failure = await Promise.race([
			attempt.then(
				() => null,
				(err: unknown) => err,
			),
			sleepFor(OBSERVATION_MS, null, { signal: observation.signal }).catch(() => null),
		]);
		observation.abort();

		expect(failure).toBeInstanceOf(PromptTimeoutError);
		if (!(failure instanceof PromptTimeoutError)) return;
		expect(failure.telemetry.eventCount).toBe(2);
		expect(failure.telemetry.toolExecutionStarts).toBe(1);
		expect(failure.telemetry.lastEventType).toBe("tool_execution_start");
	});

	it("gives an unwinding client a bounded grace", () => {
		expect(PROMPT_UNWIND_GRACE_MS).toBe(1000);
	});

	it("returns only once its aborted client has unwound, and reports the deadline", async () => {
		const stub = stubClient({
			delivery: "unwindsOnAbort",
			abortable: true,
			emit: [{ type: "turn_start" }],
		});

		const outcome = await outcomeOf(collectPromptEvents(stub.client, delivery("prompt"), config, async () => {}));

		expect(outcome).toBe("timed out");
		expect(stub.unwound).toEqual(["unwound"]);
	});
});

describe("a prompt the client itself ends", () => {
	it("surfaces the client's own failure rather than a deadline", async () => {
		const { client } = stubClient({ delivery: new Error("stream closed"), abortable: true });

		const attempt = collectPromptEvents(client, delivery("prompt"), config, async () => {});

		await expect(attempt).rejects.toThrow("stream closed");
	});

	it("keeps the events an early stop already collected", async () => {
		const { client } = stubClient({
			delivery: new Error("aborted by early stop"),
			abortable: true,
			emit: [
				{ type: "tool_execution_start", toolName: "write" },
				{ type: "tool_execution_end", toolName: "write", isError: false },
			],
		});
		const matched: string[] = [];

		const events = await collectPromptEvents(client, delivery("prompt"), config, async () => {}, {
			check: async () => true,
			onMatch: async () => {
				matched.push("onMatch");
			},
		});

		expect(matched).toEqual(["onMatch"]);
		expect(events.map(event => event.type)).toEqual(["tool_execution_start", "tool_execution_end"]);
	});

	it("returns when the stream reaches agent_end", async () => {
		const settled = Promise.withResolvers<void>();
		const { client } = stubClient({ delivery: "never", abortable: true });
		const delivering: BenchmarkClient = { ...client, prompt: () => settled.promise };
		const attempt = collectPromptEvents(
			{
				...delivering,
				onEvent: listener => {
					listener({ type: "turn_start" });
					listener({ type: "agent_end" });
					settled.resolve();
					return () => {};
				},
			},
			delivery("prompt"),
			config,
			async () => {},
		);

		const outcome = await outcomeOf(attempt);

		expect(outcome).toBe("returned");
	});
});
