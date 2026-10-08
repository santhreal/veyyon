/**
 * WHY: `wrapLeakedThinkingStream` relays a provider stream into a new one. A provider stream ends in
 * one of five ways: a `done` event, an `error` event, `end(result)` with no terminal event, `end()`
 * with no result, or `fail(err)`. The defect class is an ending the relay does not carry across: the
 * wrapped stream never settles (its reader and every `result()` caller hang), it settles with the
 * leaked fence still in the visible text, or it reports a different failure than the provider did.
 * Every ending is swept after every prefix of streamed events; the ending table is typed over the
 * ending union, so a new ending fails the type check until it has a row.
 *
 * Not caught: an ending that arrives while the reader is parked on a tool-call event, and endings of a
 * stream that is still being written after it ended.
 */
import { describe, expect, it } from "bun:test";
import * as AIError from "@veyyon/ai/error";
import type { AssistantMessage, AssistantMessageEvent } from "@veyyon/ai/types";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { wrapLeakedThinkingStream } from "@veyyon/ai/utils/leaked-thinking-stream";

function msg(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "mock",
		provider: "mock",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	};
}

const LEAKED = "Intro.```thinking\nquiet\n```Outro.";
const HEALED: AssistantMessage["content"] = [
	{ type: "text", text: "Intro." },
	{ type: "thinking", thinking: "quiet\n" },
	{ type: "text", text: "Outro." },
];

type Prefix = "nothing" | "start only" | "the whole text as deltas" | "the text up to inside the fence as deltas";
const PREFIXES: Record<Prefix, string | undefined> = {
	nothing: undefined,
	"start only": "",
	"the whole text as deltas": LEAKED,
	"the text up to inside the fence as deltas": LEAKED.slice(0, 9),
};

function feedPrefix(inner: AssistantMessageEventStream, prefix: Prefix): void {
	const streamed = PREFIXES[prefix];
	if (streamed === undefined) return;
	inner.push({ type: "start", partial: msg() });
	if (streamed === "") return;
	inner.push({ type: "text_start", contentIndex: 0, partial: msg({ content: [{ type: "text", text: "" }] }) });
	let sent = "";
	for (const delta of [streamed.slice(0, 4), streamed.slice(4)]) {
		sent += delta;
		inner.push({
			type: "text_delta",
			contentIndex: 0,
			delta,
			partial: msg({ content: [{ type: "text", text: sent }] }),
		});
	}
}

/** What the wrapped stream must settle with: a healed message with this stop reason, or this failure. */
type Outcome = { stopReason: AssistantMessage["stopReason"] } | { failure: unknown };

type Ending = "done event" | "error event" | "end with a result" | "end without a result" | "fail";
const ENDINGS: Record<Ending, (inner: AssistantMessageEventStream) => Promise<Outcome>> = {
	"done event": async inner => {
		inner.push({ type: "done", reason: "stop", message: msg({ content: [{ type: "text", text: LEAKED }] }) });
		return { stopReason: "stop" };
	},
	"error event": async inner => {
		const error = msg({ content: [{ type: "text", text: LEAKED }], stopReason: "error", errorMessage: "upstream" });
		inner.push({ type: "error", reason: "error", error });
		return { stopReason: "error" };
	},
	"end with a result": async inner => {
		inner.end(msg({ content: [{ type: "text", text: LEAKED }] }));
		return { stopReason: "stop" };
	},
	"end without a result": async inner => {
		inner.end();
		const failure = await inner.result().catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(AIError.ProviderResponseError);
		return { failure };
	},
	fail: async inner => {
		const failure = new Error("provider stream failed");
		inner.fail(failure);
		return { failure };
	},
};

/** Reads the wrapped stream to its end; a failed stream ends the read with its failure. */
async function drain(
	out: AssistantMessageEventStream,
): Promise<{ events: AssistantMessageEvent[]; failure?: unknown }> {
	const events: AssistantMessageEvent[] = [];
	try {
		for await (const event of out) events.push(event);
		return { events };
	} catch (failure) {
		return { events, failure };
	}
}

describe("a healed stream ends the way its provider stream ends", () => {
	for (const ending of Object.keys(ENDINGS) as Ending[]) {
		for (const prefix of Object.keys(PREFIXES) as Prefix[]) {
			it(`${ending} after ${prefix}`, async () => {
				const inner = new AssistantMessageEventStream();
				const out = wrapLeakedThinkingStream(inner);
				feedPrefix(inner, prefix);
				const outcome = await ENDINGS[ending](inner);

				const read = await drain(out);
				const settled = await out.result().then(
					message => ({ message }),
					(failure: unknown) => ({ failure }),
				);

				if ("failure" in outcome) {
					expect(read.failure).toBe(outcome.failure);
					expect(settled).toEqual({ failure: outcome.failure });
					return;
				}
				expect(read.failure).toBeUndefined();
				if (!("message" in settled)) throw new Error(`wrapped stream failed: ${String(settled.failure)}`);
				expect(settled.message.content).toEqual(HEALED);
				expect(settled.message.stopReason).toBe(outcome.stopReason);
				// The reader saw the same healed blocks the result reports.
				const ended = read.events.filter(event => event.type === "text_end" || event.type === "thinking_end");
				expect(ended.map(event => event.content)).toEqual(["Intro.", "quiet\n", "Outro."]);
			});
		}
	}
});
