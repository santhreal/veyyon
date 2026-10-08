/**
 * WHY. The turn loop raced every `iterator.next()` of a provider stream against one abort promise
 * with `Promise.race`. The abort promise stays pending for the whole turn, and each race attached a
 * reaction to it that held the race's result: the streamed event. A turn of 20,000 deltas held
 * 20,000 events, 120,000 heap objects and 4 MiB until it ended, and eight subagents streaming at once
 * held eight such chains.
 *
 * The class: any configuration that gives the loop a request signal. The signal comes from the
 * caller, from the harmony-leak mitigation controller of an `openai-codex` model, or from both
 * merged, and the sweep below runs every combination of the two inputs that select it, including
 * neither. Each run streams events one at a time through the real `agentLoop`, holds a weak reference
 * to each, and counts the events still reachable before the terminal event arrives. The collector
 * scans the native stack conservatively, so a stale slot can keep a few events alive in any run; the
 * defect keeps every event, so the bound is a small constant far below the stream length.
 *
 * Not caught: retention by a consumer of the loop's own event feed, or by a provider stream that
 * buffers its events; this suite drains the feed and pushes each event only after the loop took the
 * previous one.
 */
import { describe, expect, it } from "bun:test";
import { setImmediate } from "node:timers/promises";
import { agentLoop } from "@veyyon/agent-core/agent-loop";
import type { AgentContext, AgentLoopConfig } from "@veyyon/agent-core/types";
import type { AssistantMessage, Model } from "@veyyon/ai";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { isHarmonyLeakMitigationTarget } from "@veyyon/ai/utils/harmony-leak";
import { createAssistantMessage, createUserMessage } from "./helpers";

const EVENTS = 300;
/** Events a conservative stack scan may keep through stale slots, independent of {@link EVENTS}. */
const STRAY_SURVIVORS = 4;

interface Variant {
	callerSignal: boolean;
	harmonyTarget: boolean;
}

const VARIANTS: Variant[] = [false, true].flatMap(callerSignal =>
	[false, true].map(harmonyTarget => ({ callerSignal, harmonyTarget })),
);

function modelFor(variant: Variant): Model {
	const model = createMockModel().model;
	return variant.harmonyTarget ? { ...model, provider: "openai-codex" } : model;
}

/** Streams {@link EVENTS} deltas through the loop and returns the indexes of events still reachable. */
async function reachableEventsBeforeTheEnd(variant: Variant): Promise<number[]> {
	let delivered: (() => void) | undefined;
	let reachable: number[] | undefined;
	const model = modelFor(variant);
	const context: AgentContext = { systemPrompt: [""], messages: [], tools: [] };
	const config: AgentLoopConfig = {
		model,
		convertToLlm: messages => messages as never,
		onAssistantMessageEvent: () => delivered?.(),
	};
	const streamFn = () => {
		const stream = new AssistantMessageEventStream();
		void (async () => {
			const partial: AssistantMessage = createAssistantMessage([{ type: "text", text: "" }]);
			stream.push({ type: "start", partial });
			const refs: WeakRef<object>[] = [];
			for (let index = 0; index < EVENTS; index++) {
				const handled = Promise.withResolvers<void>();
				delivered = handled.resolve;
				const event = { type: "text_delta", contentIndex: 0, delta: `delta ${index} `, partial } as const;
				refs.push(new WeakRef(event));
				stream.push(event);
				await handled.promise;
			}
			// A weak reference keeps its target alive until the current job ends, so collect after one.
			await setImmediate();
			Bun.gc(true);
			reachable = [];
			for (let index = 0; index < EVENTS; index++) if (refs[index]!.deref() !== undefined) reachable.push(index);
			stream.push({
				type: "done",
				reason: "stop",
				message: createAssistantMessage([{ type: "text", text: "done" }]),
			});
		})();
		return stream;
	};
	const controller = variant.callerSignal ? new AbortController() : undefined;
	const loop = agentLoop([createUserMessage("stream")], context, config, controller?.signal, streamFn);
	for await (const _event of loop) {
		// Drain the feed; the assertion reads what the loop itself still holds.
	}
	if (reachable === undefined) throw new Error("the stream never reached its terminal event");
	return reachable;
}

describe("a streamed event is released once the loop has handled it", () => {
	it("sweeps both inputs that select the loop's request signal", () => {
		expect(VARIANTS.map(variant => isHarmonyLeakMitigationTarget(modelFor(variant)))).toEqual([
			false,
			true,
			false,
			true,
		]);
	});

	for (const variant of VARIANTS) {
		const name = `${variant.callerSignal ? "with" : "without"} a caller signal, ${variant.harmonyTarget ? "a" : "no"} harmony target`;
		it(`holds a bounded number of events ${name}`, async () => {
			const reachable = await reachableEventsBeforeTheEnd(variant);
			expect(reachable.length).toBeLessThanOrEqual(STRAY_SURVIVORS);
		});
	}
});
