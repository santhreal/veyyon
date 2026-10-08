/**
 * An aborted turn keeps exactly the tool calls the provider closed before the abort.
 *
 * WHY. An abort decides which tool calls of a turn survive: a call whose `toolcall_end` the provider
 * delivered keeps its block and is answered with an aborted placeholder result, and a call it never
 * closed is dropped and named in `incompleteToolCalls`. The loop decided by how far it had READ when
 * it noticed the abort, so a `toolcall_end` already sitting in the stream buffer was thrown away and
 * its complete call was reported as never finished. A provider pushes a whole parsed chunk at once,
 * and an abort raised from an earlier event of the chunk (a TTSR match on an argument delta) fires
 * with the rest of the chunk buffered, so which way the turn went depended on microtask order alone:
 * the TTSR interrupt suite in coding-agent went red when the event stream's reader got faster.
 *
 * CLASS. For every interleaving of provider chunks, microtask gaps and abort point (raised from
 * outside between chunks, in the middle of a chunk, or from the loop's own per-event hook the way a
 * TTSR match is), the committed turn keeps exactly the calls whose `toolcall_end` was pushed before
 * `abort()` ran, in content order, names every other call as incomplete, and answers each kept call
 * with one placeholder result. Events the provider pushes after the abort count for nothing.
 *
 * GAP. A provider abort listener registered ahead of the loop's that pushed a NON-terminal event
 * synchronously would have that event counted as delivered before the abort. No provider does; the
 * generator's listener pushes only the terminal `error` a provider answers an abort with.
 */
import { describe, expect, it } from "bun:test";
import { agentLoop } from "@veyyon/agent-core/agent-loop";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, StreamFn } from "@veyyon/agent-core/types";
import type { AssistantMessage, Message, ToolCall } from "@veyyon/ai";
import { createMockModel } from "@veyyon/ai/providers/mock";
import {
	clearStreamingPartialJson,
	getStreamingPartialJson,
	setStreamingPartialJson,
} from "@veyyon/ai/utils/block-symbols";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { createUserMessage } from "./helpers";

/** Deterministic 32-bit generator, so a failing interleaving reproduces from its seed. */
function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const NO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

interface PlannedCall {
	id: string;
	args: Record<string, unknown>;
	/** Argument JSON less its last character: a streaming marker holding it never parses. */
	deltas: string[];
	closes: boolean;
}

/**
 * One provider action. `close` appends the final argument character and pushes the call's last
 * delta and its `toolcall_end` together, as a provider does when one chunk finishes a call, so the
 * marker never holds parseable JSON for a call that has not closed.
 */
type Step =
	| { kind: "start" }
	| { kind: "open"; call: PlannedCall }
	| { kind: "delta"; call: PlannedCall; text: string }
	| { kind: "close"; call: PlannedCall };

type Trigger =
	/** Abort from outside after `offset` steps of chunk `chunk` (0 = before the chunk). */
	| { kind: "outside"; chunk: number; offset: number }
	/** Abort `hops` microtasks after the loop hands the `event`-th streamed event to its hook. */
	| { kind: "hook"; event: number; hops: number };

interface Scenario {
	steps: Step[];
	chunks: number[];
	hops: number[];
	trigger: Trigger;
	/** The provider answers the abort with a terminal `error` from its own listener. */
	listenerError: boolean;
}

interface Outcome {
	committed: AssistantMessage;
	closedBeforeAbort: string[];
	placeholderIds: string[];
	finalBlockIds: string[];
	/** Calls whose `toolcall_end` the loop read and reported before the abort. */
	readCloses: Set<string>;
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

function planCalls(random: () => number, prefix: string): PlannedCall[] {
	const count = 1 + Math.floor(random() * 4);
	const calls: PlannedCall[] = [];
	for (let n = 0; n < count; n++) {
		const args = { command: `run ${prefix}${n}`, timeout: 10 + n };
		const json = JSON.stringify(args);
		const body = json.slice(0, -1);
		const pieces = 1 + Math.floor(random() * 3);
		const deltas: string[] = [];
		for (let p = 0; p < pieces; p++) {
			deltas.push(body.slice(Math.floor((body.length * p) / pieces), Math.floor((body.length * (p + 1)) / pieces)));
		}
		calls.push({ id: `${prefix}${n}`, args, deltas, closes: random() < 0.6 });
	}
	return calls;
}

function stepsFor(calls: PlannedCall[]): Step[] {
	const steps: Step[] = [];
	for (const call of calls) {
		steps.push({ kind: "open", call });
		for (const text of call.deltas) steps.push({ kind: "delta", call, text });
		if (call.closes) steps.push({ kind: "close", call });
	}
	return steps;
}

function generateScenario(seed: number): Scenario {
	const random = mulberry32(seed);
	const steps: Step[] = [{ kind: "start" }, ...stepsFor(planCalls(random, "call-"))];
	const chunks: number[] = [];
	for (let left = steps.length; left > 0; ) {
		const size = Math.min(left, 1 + Math.floor(random() * 4));
		chunks.push(size);
		left -= size;
	}
	const hops = chunks.map(() => Math.floor(random() * 4));
	let streamedEvents = 0;
	for (const step of steps) streamedEvents += step.kind === "close" ? 2 : step.kind === "start" ? 0 : 1;
	const outsideChunk = Math.floor(random() * (chunks.length + 1));
	const trigger: Trigger =
		random() < 0.5
			? {
					kind: "outside",
					chunk: outsideChunk,
					offset: outsideChunk < chunks.length ? Math.floor(random() * chunks[outsideChunk]) : 0,
				}
			: { kind: "hook", event: Math.floor(random() * streamedEvents), hops: Math.floor(random() * 5) };
	return { steps, chunks, hops, trigger, listenerError: random() < 0.3 };
}

async function hop(count: number): Promise<void> {
	for (let n = 0; n < count; n++) await Promise.resolve();
}

async function runScenario(scenario: Scenario): Promise<Outcome> {
	const controller = new AbortController();
	const closedBeforeAbort: string[] = [];
	const blocks = new Map<string, ToolCall>();
	let partial: AssistantMessage | undefined;
	/** The message whose `start` was the last one pushed before the abort: the one the turn commits. */
	let deliveredPartial: AssistantMessage | undefined;
	let hookEvents = 0;

	const perform = (stream: AssistantMessageEventStream, step: Step): void => {
		switch (step.kind) {
			case "start": {
				partial = {
					role: "assistant",
					content: [],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude",
					usage: NO_USAGE,
					stopReason: "toolUse",
					timestamp: Date.now(),
				};
				blocks.clear();
				if (!controller.signal.aborted) {
					deliveredPartial = partial;
					closedBeforeAbort.length = 0;
				}
				stream.push({ type: "start", partial });
				return;
			}
			case "open": {
				const block: ToolCall = { type: "toolCall", id: step.call.id, name: "bash", arguments: {} };
				setStreamingPartialJson(block, "");
				blocks.set(step.call.id, block);
				partial!.content.push(block);
				stream.push({ type: "toolcall_start", contentIndex: partial!.content.length - 1, partial: partial! });
				return;
			}
			case "delta": {
				const block = blocks.get(step.call.id)!;
				setStreamingPartialJson(block, `${getStreamingPartialJson(block) ?? ""}${step.text}`);
				stream.push({
					type: "toolcall_delta",
					contentIndex: partial!.content.indexOf(block),
					delta: step.text,
					partial: partial!,
				});
				return;
			}
			case "close": {
				const block = blocks.get(step.call.id)!;
				const contentIndex = partial!.content.indexOf(block);
				stream.push({ type: "toolcall_delta", contentIndex, delta: "}", partial: partial! });
				block.arguments = step.call.args;
				clearStreamingPartialJson(block);
				if (!controller.signal.aborted) closedBeforeAbort.push(step.call.id);
				stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: partial! });
				return;
			}
		}
	};

	const streamFn: StreamFn = (_model, _context, options) => {
		const stream = new AssistantMessageEventStream();
		if (scenario.listenerError) {
			options?.signal?.addEventListener(
				"abort",
				() => {
					const content = partial?.content ?? [];
					stream.push({
						type: "error",
						reason: "aborted",
						error: { ...(partial ?? emptyPartial()), content, stopReason: "aborted" },
					});
				},
				{ once: true },
			);
		}
		queueMicrotask(async () => {
			// A provider pushes after its transport answers, by which time the loop is reading the
			// stream. Aborting before the loop reads anything is the pre-aborted path, covered elsewhere.
			for (let waited = 0; stream.waiting.length === 0; waited++) {
				if (waited > 100) throw new Error("the loop never started reading the stream");
				await Promise.resolve();
			}
			let index = 0;
			for (let chunk = 0; chunk < scenario.chunks.length; chunk++) {
				const trigger = scenario.trigger;
				for (let offset = 0; offset < scenario.chunks[chunk]; offset++) {
					if (trigger.kind === "outside" && trigger.chunk === chunk && trigger.offset === offset) {
						controller.abort();
					}
					perform(stream, scenario.steps[index++]);
				}
				// A provider stops reading its transport once the request is aborted; whatever it
				// pushed in the same synchronous chunk after the abort has already been pushed.
				if (controller.signal.aborted) return;
				await hop(scenario.hops[chunk]);
				if (controller.signal.aborted) return;
			}
			if (scenario.trigger.kind === "outside") controller.abort();
		});
		return stream;
	};

	const config: AgentLoopConfig = {
		model: createMockModel().model,
		convertToLlm: identityConverter,
		onAssistantMessageEvent: () => {
			const trigger = scenario.trigger;
			if (trigger.kind !== "hook" || hookEvents++ !== trigger.event) return;
			if (trigger.hops === 0) {
				controller.abort();
				return;
			}
			void hop(trigger.hops).then(() => controller.abort());
		},
	};
	const context: AgentContext = { systemPrompt: [""], messages: [], tools: [] };
	const events: AgentEvent[] = [];
	for await (const event of agentLoop([createUserMessage("go")], context, config, controller.signal, streamFn)) {
		events.push(event);
	}

	const ended = events.flatMap(e => (e.type === "message_end" ? [e.message] : []));
	const committed = ended.findLast((m): m is AssistantMessage => m.role === "assistant");
	if (!committed) throw new Error("the loop committed no assistant message");
	const placeholderIds = ended.flatMap(m => (m.role === "toolResult" ? [m.toolCallId] : []));
	const readCloses = new Set(
		events.flatMap(e =>
			e.type === "message_update" && e.assistantMessageEvent.type === "toolcall_end"
				? [e.assistantMessageEvent.toolCall.id]
				: [],
		),
	);
	const finalBlockIds = (deliveredPartial?.content ?? []).flatMap(block =>
		block.type === "toolCall" ? [block.id] : [],
	);
	return { committed, closedBeforeAbort: [...closedBeforeAbort], placeholderIds, finalBlockIds, readCloses };
}

function emptyPartial(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude",
		usage: NO_USAGE,
		stopReason: "aborted",
		timestamp: Date.now(),
	};
}

function expectOutcome(outcome: Outcome, label: string): void {
	const kept = outcome.committed.content.flatMap(block => (block.type === "toolCall" ? [block.id] : []));
	const expectedKept = outcome.finalBlockIds.filter(id => outcome.closedBeforeAbort.includes(id));
	const expectedIncomplete = outcome.finalBlockIds.filter(id => !outcome.closedBeforeAbort.includes(id));
	expect(kept, `${label}: kept calls`).toEqual(expectedKept);
	expect(
		(outcome.committed.incompleteToolCalls ?? []).map(call => call.id),
		`${label}: incomplete calls`,
	).toEqual(expectedIncomplete);
	expect(outcome.placeholderIds, `${label}: placeholder results`).toEqual(expectedKept);
	expect(outcome.committed.stopReason, `${label}: stop reason`).toBe("aborted");
}

describe("an aborted turn keeps exactly the tool calls the provider closed before the abort", () => {
	it("holds for every generated interleaving of chunks, microtask gaps and abort point", async () => {
		const seeds = 600;
		let keptUnread = 0;
		for (let seed = 1; seed <= seeds; seed++) {
			const outcome = await runScenario(generateScenario(seed));
			expectOutcome(outcome, `seed ${seed}`);
			if (outcome.closedBeforeAbort.some(id => !outcome.readCloses.has(id))) keptUnread++;
		}
		// The sweep reaches the case it exists for: a turn keeps a call whose `toolcall_end` the loop
		// never read before the abort.
		expect(keptUnread).toBeGreaterThan(30);
	});

	it("keeps a call whose toolcall_end is buffered behind the delta whose hook aborts the turn", async () => {
		// The TTSR shape: one chunk carries the matching delta and the call's close, and the
		// loop's hook for that delta aborts before the loop reads the close.
		const call: PlannedCall = { id: "call-a", args: { command: "ls" }, deltas: ['{"command":"ls"'], closes: true };
		const outcome = await runScenario({
			steps: [
				{ kind: "start" },
				{ kind: "open", call },
				{ kind: "delta", call, text: call.deltas[0] },
				{ kind: "close", call },
			],
			chunks: [4],
			hops: [0],
			trigger: { kind: "hook", event: 1, hops: 0 },
			listenerError: false,
		});
		expect(outcome.closedBeforeAbort).toEqual(["call-a"]);
		expectOutcome(outcome, "buffered close");
	});

	it("drops a call whose toolcall_end the provider pushed after the abort", async () => {
		const call: PlannedCall = { id: "call-a", args: { command: "ls" }, deltas: ['{"command":"ls"'], closes: true };
		const outcome = await runScenario({
			steps: [
				{ kind: "start" },
				{ kind: "open", call },
				{ kind: "delta", call, text: call.deltas[0] },
				{ kind: "close", call },
			],
			chunks: [4],
			hops: [0],
			trigger: { kind: "outside", chunk: 0, offset: 3 },
			listenerError: false,
		});
		expect(outcome.closedBeforeAbort).toEqual([]);
		expectOutcome(outcome, "close after abort");
	});

	it("forgets a call closed before the provider restarted the message", async () => {
		// A second `start` replaces the message being streamed; a call closed in the first one is
		// not closed in the second, even under the same id.
		const first: PlannedCall = { id: "call-a", args: { command: "ls" }, deltas: ['{"command":"ls"'], closes: true };
		const again: PlannedCall = { ...first, closes: false };
		const outcome = await runScenario({
			steps: [
				{ kind: "start" },
				{ kind: "open", call: first },
				{ kind: "delta", call: first, text: first.deltas[0] },
				{ kind: "close", call: first },
				{ kind: "start" },
				{ kind: "open", call: again },
				{ kind: "delta", call: again, text: again.deltas[0] },
			],
			chunks: [7],
			hops: [0],
			trigger: { kind: "hook", event: 0, hops: 0 },
			listenerError: false,
		});
		expect(outcome.closedBeforeAbort).toEqual([]);
		expect(outcome.finalBlockIds).toEqual(["call-a"]);
		expectOutcome(outcome, "restarted message");
	});
});
