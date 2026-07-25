/**
 * Every field of a streamed assistant-message event is decoded, not just the one
 * the current TUI happens to read.
 *
 * WHY THIS SUITE EXISTS. A `message_update` carries several views of the same
 * text at once: the increment for this delta, a `partial` snapshot of the whole
 * message so far, and, at a block boundary, the finished text or the assembled
 * tool call. Different front ends read different ones. The TUI re-renders from
 * `partial`, `--print --mode json` reconstructs from `delta` alone, and a
 * consumer that only cares about completed blocks reads `content` or `toolCall`.
 *
 * Decoding was originally added for `delta` and the accumulated message, so the
 * raw `§handle` form kept resurfacing wherever a front end read one of the other
 * fields. A sweep over the events of a real session found it in nine places at
 * once, including `partial`, `text_end.content`, `toolcall_end.toolCall` and the
 * whole message on `done`.
 *
 * The rule these tests pin is that decoding is a property of the EVENT, not of a
 * chosen field, so the same suite covers every variant. Mid-stream fields go
 * through the stream decoder, which withholds a fragment that could still grow
 * into a handle; final fields expand wholesale, because nothing more is coming.
 */

import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@veyyon/ai";
import { ArgotStreamDisplayDecoder } from "@veyyon/coding-agent/argot-wire";
import { ArgotSession, type Vocabulary } from "argot";

const CONN = "packages/server/src/database/connection.ts";

function loadedCodec(): ArgotSession {
	const vocab: Vocabulary = {
		version: 1,
		sigil: "§",
		handles: new Map([
			["db", "src/db.ts"],
			["dbconn", CONN],
		]),
		meta: new Map(),
	};
	const codec = new ArgotSession();
	codec.loadVocab(vocab);
	return codec;
}

/** An assistant message whose single block is the given text. */
function partialWith(content: AssistantMessage["content"]): AssistantMessage {
	return { role: "assistant", content } as AssistantMessage;
}

/** The text of the first text block of a message. */
function textOf(message: AssistantMessage | undefined): string {
	const block = message?.content.find(b => b.type === "text");
	return block?.type === "text" ? block.text : "";
}

describe("decodeStreamEvent", () => {
	/**
	 * The `partial` snapshot is what an interactive renderer re-renders from on
	 * every update, so a handle left in it is on screen for the whole stream.
	 */
	it("decodes the partial snapshot every variant carries", () => {
		const decoder = new ArgotStreamDisplayDecoder(loadedCodec());
		const out = decoder.decodeStreamEvent({
			type: "text_delta",
			contentIndex: 0,
			delta: "Opening §db ",
			partial: partialWith([{ type: "text", text: "Opening §db " }]),
		});
		expect(textOf(out.partial)).toBe("Opening src/db.ts ");
	});

	/**
	 * A block that arrives whole, with no deltas behind it, still has to be
	 * decoded. Providers differ on whether they stream a block or deliver it in
	 * one piece, and the display cannot depend on which.
	 */
	it("decodes a partial block the decoder was never fed deltas for", () => {
		const decoder = new ArgotStreamDisplayDecoder(loadedCodec());
		const out = decoder.decodeStreamEvent({
			type: "text_start",
			contentIndex: 0,
			partial: partialWith([{ type: "text", text: "Opening §db " }]),
		});
		expect(textOf(out.partial)).toBe("Opening src/db.ts ");
	});

	/**
	 * `text_end` reports the finished block. It is final, so it expands wholesale:
	 * withholding a trailing fragment here would drop text that is never coming
	 * back, which is the one case where holding back is wrong.
	 */
	it("expands the finished block text on text_end, including a trailing handle", () => {
		const decoder = new ArgotStreamDisplayDecoder(loadedCodec());
		const out = decoder.decodeStreamEvent({
			type: "text_end",
			contentIndex: 0,
			content: "all done in §db",
			partial: partialWith([{ type: "text", text: "all done in §db" }]),
		});
		expect(out.content).toBe("all done in src/db.ts");
	});

	/** Thinking ends the same way, and for the same reason. */
	it("expands the finished block text on thinking_end", () => {
		const decoder = new ArgotStreamDisplayDecoder(loadedCodec());
		const out = decoder.decodeStreamEvent({
			type: "thinking_end",
			contentIndex: 0,
			content: "the pool is in §dbconn",
			partial: partialWith([]),
		});
		expect(out.content).toBe(`the pool is in ${CONN}`);
	});

	/**
	 * The assembled call on `toolcall_end` is what a consumer records as "this is
	 * the call that was made", so its arguments and its intent both expand.
	 */
	it("expands the assembled tool call's arguments and intent on toolcall_end", () => {
		const decoder = new ArgotStreamDisplayDecoder(loadedCodec());
		const out = decoder.decodeStreamEvent({
			type: "toolcall_end",
			contentIndex: 0,
			toolCall: { type: "toolCall", id: "t1", name: "read", arguments: { path: "§db" }, intent: "open §dbconn" },
			partial: partialWith([]),
		});
		const call = out.toolCall as { arguments: { path: string }; intent: string };
		expect(call.arguments.path).toBe("src/db.ts");
		expect(call.intent).toBe(`open ${CONN}`);
	});

	/**
	 * Argument JSON arrives in fragments and a handle can straddle two of them, so
	 * the increment for a fragment is only decodable against the accumulation. The
	 * expansion is JSON-escaped for the same reason it is everywhere else: the
	 * fragment stream has to stay parseable.
	 */
	it("decodes a tool-call argument fragment against the accumulation, never mid-handle", () => {
		const decoder = new ArgotStreamDisplayDecoder(loadedCodec());
		const first = decoder.decodeStreamEvent({
			type: "toolcall_delta",
			contentIndex: 0,
			delta: '{"path":"§d',
			partial: partialWith([]),
		});
		const second = decoder.decodeStreamEvent({
			type: "toolcall_delta",
			contentIndex: 0,
			delta: 'bconn "}',
			partial: partialWith([]),
		});
		expect(first.delta).toBe('{"path":"');
		expect(second.delta).toBe(`${CONN} "}`);
		expect(`${first.delta}${second.delta}`).toBe(`{"path":"${CONN} "}`);
	});

	/** The terminal `done` event repeats the whole message, so it repeats every handle unless expanded. */
	it("expands the whole message on done", () => {
		const decoder = new ArgotStreamDisplayDecoder(loadedCodec());
		const out = decoder.decodeStreamEvent({
			type: "done",
			reason: "stop",
			message: partialWith([{ type: "text", text: "finished §db" }]),
		});
		expect(textOf(out.message)).toBe("finished src/db.ts");
	});

	/** An errored turn still shows its text to the operator, so it is decoded like any other. */
	it("expands the message on error", () => {
		const decoder = new ArgotStreamDisplayDecoder(loadedCodec());
		const out = decoder.decodeStreamEvent({
			type: "error",
			reason: "error",
			error: partialWith([{ type: "text", text: "failed reading §db" }]),
		});
		expect(textOf(out.error)).toBe("failed reading src/db.ts");
	});

	/**
	 * An event with nothing to decode comes back by reference. Every stream update
	 * passes through here, so the no-handle case must not allocate a copy per
	 * token.
	 */
	it("returns the same event reference when nothing decodes", () => {
		const decoder = new ArgotStreamDisplayDecoder(loadedCodec());
		const event = {
			type: "text_delta" as const,
			contentIndex: 0,
			delta: "plain text",
			partial: partialWith([{ type: "text", text: "plain text" }]),
		};
		expect(decoder.decodeStreamEvent(event)).toBe(event);
	});

	/** Argot off is a pure pass-through: the event is not even inspected. */
	it("is inert with no codec", () => {
		const event = { type: "text_delta" as const, contentIndex: 0, delta: "§db", partial: partialWith([]) };
		expect(new ArgotStreamDisplayDecoder(undefined).decodeStreamEvent(event)).toBe(event);
	});

	/**
	 * The delta stream and the accumulated snapshot must agree at every step, since
	 * a consumer may reconstruct the message from either. They come from the same
	 * decoder, and this pins that they stay that way.
	 */
	it("keeps the summed deltas equal to the decoded snapshot at every step", () => {
		const decoder = new ArgotStreamDisplayDecoder(loadedCodec());
		let raw = "";
		let summed = "";
		for (const fragment of ["open §d", "b", "conn now, then ", "§db done"]) {
			raw += fragment;
			const out = decoder.decodeStreamEvent({
				type: "text_delta",
				contentIndex: 0,
				delta: fragment,
				partial: partialWith([{ type: "text", text: raw }]),
			});
			summed += out.delta ?? "";
			expect(textOf(out.partial)).toBe(summed);
			expect(summed).not.toContain("§");
		}
		expect(summed).toBe(`open ${CONN} now, then src/db.ts done`);
	});
});
