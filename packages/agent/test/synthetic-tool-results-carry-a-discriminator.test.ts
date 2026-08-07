import { describe, expect, it } from "bun:test";
import { agentLoop } from "@veyyon/agent-core";
import type {
	AgentContext,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	SteeringQueueState,
	ToolChoiceDirective,
} from "@veyyon/agent-core/types";
import type { Message, ToolResultMessage } from "@veyyon/ai";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { type } from "arktype";
import { createUserMessage } from "./helpers";
import { loopSource, unionMembers } from "./support/invented-tool-result-sources";

/**
 * Every tool result the loop invents for a call it did not run must say so in a
 * STRUCTURED field, for every reason it can invent one.
 *
 * The defect this defends against is a classification defect, not a wording one.
 * `createSkippedToolResult` and `createAbortedToolResult` build a headline that is
 * FIXED PER SOURCE, so two unrelated interrupts produce byte-identical text. A
 * consumer that classifies by reading that text sees one failure repeating, and
 * anything keyed on a repeat then fires on an event that never happened. Measured
 * over real session transcripts the longest run of consecutive byte-identical skip
 * texts was 52.
 *
 * `__synthetic` (never dispatched) and `__skipped` (cut short) exist so a consumer
 * never has to read the text. They were given to two of the three constructors; the
 * third, the pre-dispatch signal-abort placeholder, shipped with `details: {}`, so
 * every consumer keying on the discriminator was blind to the most common skip
 * shape there is: the sibling calls of a batch whose first call cancelled the run.
 *
 * These drive the real `agentLoop` for every member of both source unions and
 * assert on the details the loop actually emitted. Nothing here hand-writes a
 * details literal, so a constructor that stops stamping takes them red.
 *
 * WHAT THIS CANNOT SEE: a consumer that ignores the discriminator. That is the
 * other half, and it is covered on the consumer side
 * (`packages/coding-agent/test/skipped-tool-results-are-not-refusals.test.ts`) and
 * by the source lock (`./no-text-classified-tool-results.test.ts`).
 */

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

/** Details as they arrive on the wire: an opaque bag a consumer must narrow. */
interface EmittedDetails {
	__synthetic?: unknown;
	__skipped?: unknown;
	source?: unknown;
	entered?: unknown;
	executed?: unknown;
}

function detailsOf(message: ToolResultMessage): EmittedDetails {
	const details = message.details;
	if (details == null || typeof details !== "object") return {};
	return details as EmittedDetails;
}

const schema = type({ n: "number" });

/**
 * One turn whose tool call is answered by a placeholder rather than by the tool.
 *
 * `stopReason` is the provider-reported stop, which is the axis
 * `createAbortedToolResult` maps onto its `assistant_stop_*` sources. `soft-gate`
 * is the fourth source and has no stop reason of its own: the model called
 * something while a soft tool requirement was outstanding, so the loop pairs the
 * detour with a placeholder rather than running it.
 */
async function runNeverDispatched(variant: "aborted" | "error" | "length" | "soft-gate"): Promise<ToolResultMessage[]> {
	const tool: AgentTool<typeof schema, { n: number }> = {
		name: "board",
		label: "Board",
		description: "writes the board",
		parameters: schema,
		async execute(_id, params) {
			return { content: [{ type: "text", text: `ran:${params.n}` }], details: params };
		},
	};
	const mock = createMockModel({
		responses: [
			{
				content: [{ type: "toolCall", id: "c1", name: "board", arguments: { n: 1 } }],
				stopReason: variant === "soft-gate" ? "toolUse" : variant,
				...(variant === "error" ? { errorMessage: "websocket closed (1000)" } : {}),
			},
			{ content: ["done"] },
		],
	});
	// The requirement is handed out once. A host that keeps returning it would
	// escalate every turn and the loop would run out of forced turns rather than
	// reaching the placeholder this exercises.
	let softRequirementIssued = false;
	const config: AgentLoopConfig = {
		model: mock.model,
		convertToLlm: identityConverter,
		...(variant === "soft-gate"
			? {
					getToolChoice: (): ToolChoiceDirective | undefined => {
						if (softRequirementIssued) return undefined;
						softRequirementIssued = true;
						return { soft: true, id: "req-1", toolName: "approve", reminder: [] };
					},
				}
			: {}),
	};
	const context: AgentContext = { systemPrompt: ["T"], messages: [], tools: [tool as AgentTool] };
	const messages = await agentLoop([createUserMessage("go")], context, config, undefined, mock.stream)
		.result()
		.catch(() => [] as AgentMessage[]);
	return messages.filter((m): m is ToolResultMessage => m.role === "toolResult");
}

type SkipVariant = "user" | "system" | "unknown" | "irc" | "cancelled-run";

/**
 * Two serial calls where the first triggers an interrupt and the second is never
 * run. `exclusive` concurrency is what makes the second call reach dispatch AFTER
 * the first has settled, which is the ordering every one of these paths needs, and
 * it is also the shape the field data is full of: one cancel, a run of siblings
 * that all read the same.
 */
async function runInterruptedBatch(variant: SkipVariant, siblings = 1): Promise<ToolResultMessage[]> {
	const controller = new AbortController();
	let interruptArmed = false;
	const tool: AgentTool<typeof schema, { n: number }> = {
		name: "board",
		label: "Board",
		description: "writes the board",
		parameters: schema,
		concurrency: "exclusive",
		async execute(_id, params, signal) {
			if (params.n === 1) {
				interruptArmed = true;
				if (variant === "cancelled-run") {
					controller.abort(new Error("Interrupted by user"));
					const error = new Error("aborted");
					error.name = "AbortError";
					throw error;
				}
			}
			if (signal?.aborted) {
				const error = new Error("aborted");
				error.name = "AbortError";
				throw error;
			}
			return { content: [{ type: "text", text: `ran:${params.n}` }], details: params };
		},
	};
	const calls = Array.from({ length: siblings + 1 }, (_unused, index) => ({
		type: "toolCall" as const,
		id: `c${index + 1}`,
		name: "board",
		arguments: { n: index + 1 },
	}));
	const mock = createMockModel({
		responses: [{ content: calls, stopReason: "toolUse" }, { content: ["done"] }],
	});
	const steeringSource = variant === "unknown" ? undefined : variant === "system" ? "system" : "user";
	const config: AgentLoopConfig = {
		model: mock.model,
		convertToLlm: identityConverter,
		...(variant === "user" || variant === "system" || variant === "unknown"
			? {
					hasSteeringMessages: (): SteeringQueueState => ({
						queued: interruptArmed,
						...(steeringSource ? { source: steeringSource } : {}),
					}),
				}
			: {}),
		...(variant === "irc" ? { hasIrcInterrupts: (): boolean => interruptArmed } : {}),
	};
	const context: AgentContext = { systemPrompt: ["T"], messages: [], tools: [tool as AgentTool] };
	const messages = await agentLoop([createUserMessage("go")], context, config, controller.signal, mock.stream)
		.result()
		.catch(() => [] as AgentMessage[]);
	return messages.filter((m): m is ToolResultMessage => m.role === "toolResult");
}

describe("a tool result the loop invented names its reason in a structured field", () => {
	/**
	 * The four `assistant_stop_*` sources, one per way the loop can be left holding
	 * tool calls it will not dispatch. Asserting `source` per variant is what proves
	 * the discriminator carries information: a constant `__synthetic` would let a
	 * consumer tell "not executed" from "failed" and nothing else.
	 */
	const NEVER_DISPATCHED: ReadonlyArray<["aborted" | "error" | "length" | "soft-gate", string]> = [
		["aborted", "assistant_stop_aborted"],
		["error", "assistant_stop_error"],
		["length", "assistant_stop_length"],
		["soft-gate", "assistant_stop_skipped"],
	];

	for (const [variant, expectedSource] of NEVER_DISPATCHED) {
		it(`stamps __synthetic on a call left undispatched by ${variant}`, async () => {
			const results = await runNeverDispatched(variant);
			const placeholder = results.find(r => r.toolCallId === "c1");
			if (!placeholder) throw new Error(`no result for the call (${variant})`);
			const details = detailsOf(placeholder);
			expect(details.__synthetic).toBe(true);
			expect(details.executed).toBe(false);
			expect(details.source).toBe(expectedSource);
			// The placeholder still reports as an error, which is precisely why the
			// discriminator has to exist: `isError` alone cannot separate "the tool
			// refused this payload" from "the tool never saw this payload".
			expect(placeholder.isError).toBe(true);
		});
	}

	/**
	 * Every steering/IRC skip source. `entered: false` is part of the contract, not
	 * decoration: it is the difference between "nothing was applied, retry verbatim"
	 * and "this may have half-applied, go check state", and these calls never
	 * reached `tool.execute()`.
	 */
	const SKIPPED: ReadonlyArray<[Exclude<SkipVariant, "cancelled-run">, string]> = [
		["user", "user"],
		["system", "system"],
		["unknown", "unknown"],
		["irc", "irc"],
	];

	for (const [variant, expectedSource] of SKIPPED) {
		it(`stamps __skipped on a call cut short by ${variant}`, async () => {
			const results = await runInterruptedBatch(variant);
			const cutShort = results.find(r => r.toolCallId === "c2");
			if (!cutShort) throw new Error(`no result for the second call (${variant})`);
			const details = detailsOf(cutShort);
			expect(details.__skipped).toBe(true);
			expect(details.source).toBe(expectedSource);
			expect(details.entered).toBe(false);
		});
	}

	/**
	 * Coverage is derived from the declaration, not from this file's own list.
	 *
	 * The defect being locked is a mechanism applied to some members of a union and
	 * not the rest, so a suite that enumerates the members it happens to know about
	 * reproduces the defect one level up: add a skip reason and everything stays
	 * green. These compare what the tests above actually drove against the union as
	 * declared, in both directions.
	 */
	const SYNTHETIC_DRIVEN = NEVER_DISPATCHED.map(([, source]) => source);
	const SKIPPED_DRIVEN = [...SKIPPED.map(([, source]) => source), "cancelled-run"];
	/**
	 * `"steering"` is `createSkippedToolResult`'s default for an absent source, and
	 * it is not reachable through the loop: `checkSteering` sets
	 * `interruptState.source` to `steeringSource ?? "unknown"` before anything can
	 * build a placeholder, so the parameter is never actually undefined. It is a
	 * defensive default, recorded here rather than silently omitted, and it stays
	 * covered by the type union check in the structural lock.
	 */
	const SKIPPED_UNREACHABLE: readonly string[] = ["steering"];

	it("drives every declared skip source, or records why it cannot", async () => {
		const declared = await unionMembers(await loopSource(), "SkippedToolResultDetails", "source");
		expect(declared.slice().sort()).toEqual([...SKIPPED_DRIVEN, ...SKIPPED_UNREACHABLE].sort());
	});

	it("drives every declared synthetic source", async () => {
		const declared = await unionMembers(await loopSource(), "SyntheticToolResultDetails", "source");
		expect(declared.slice().sort()).toEqual(SYNTHETIC_DRIVEN.slice().sort());
	});

	/**
	 * A bound, not a value. An interrupt that loses a call leaves the provider with
	 * a `tool_use` that has no `tool_result`, which is a 400 on the next request and
	 * a wedged turn rather than a wrong answer; one that duplicates a call is the
	 * same fault in the other direction. Neither is visible to an assertion that
	 * only reads the contents of the results it found.
	 */
	it("answers every call of an interrupted batch exactly once", async () => {
		const results = await runInterruptedBatch("irc", 12);
		const ids = results.map(r => r.toolCallId);
		expect(ids.slice().sort()).toEqual(Array.from({ length: 13 }, (_unused, i) => `c${i + 1}`).sort());
	});

	/**
	 * The cancel splits into two shapes from one event, and they used to be stamped
	 * differently: the call that was mid-execute got `__skipped`, and every sibling
	 * still queued behind it got an empty details bag from the pre-dispatch abort
	 * branch. Both are skips and both must say so.
	 */
	it("stamps __skipped on the running call and on every sibling a cancel never dispatched", async () => {
		const results = await runInterruptedBatch("cancelled-run");
		const running = results.find(r => r.toolCallId === "c1");
		const queued = results.find(r => r.toolCallId === "c2");
		if (!running || !queued) throw new Error("expected a result for both calls");

		expect(detailsOf(running).__skipped).toBe(true);
		expect(detailsOf(running).source).toBe("cancelled-run");
		// It was inside `tool.execute()`, so side effects may be partial.
		expect(detailsOf(running).entered).toBe(true);

		expect(detailsOf(queued).__skipped).toBe(true);
		expect(detailsOf(queued).source).toBe("cancelled-run");
		expect(detailsOf(queued).entered).toBe(false);
	});

	/**
	 * The run, not the pair. Field data shows up to 52 consecutive byte-identical
	 * skip texts in one turn, which is the livelock signature: every call skipped,
	 * the model retries, all skipped again. Whatever the length of the run, each
	 * result has to stay classifiable on its own.
	 */
	it("keeps every result in a long run of identical skips classifiable", async () => {
		const results = await runInterruptedBatch("irc", 12);
		const skips = results.filter(r => r.toolCallId !== "c1");
		expect(skips).toHaveLength(12);

		// The batch ledger rides exactly one placeholder, so the first skip of a run
		// is the only one that says anything the others do not. Every skip after it
		// is byte-identical, which is the collision in its measured form.
		const tail = skips.slice(1);
		const texts = new Set(tail.map(r => (r.content[0]?.type === "text" ? r.content[0].text : "")));
		expect(texts.size).toBe(1);
		for (const skip of skips) {
			expect(detailsOf(skip).__skipped).toBe(true);
			expect(detailsOf(skip).source).toBe("irc");
		}
	});
});
