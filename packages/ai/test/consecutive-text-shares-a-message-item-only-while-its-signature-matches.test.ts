/**
 * The auth-gateway's OpenAI Responses encoders put consecutive text blocks into one `message` output item
 * exactly while their text signatures match, and both encoders draw the same boundaries.
 *
 * WHY THIS SUITE EXISTS. The rule is decided twice: once by `buildOutputItems`, which writes the
 * non-streamed response and the terminal frame of a streamed one, and once by the stream writer when a
 * `text_start` arrives. The two decisions used to be spelled separately, so a stream could close a message
 * item the final response kept open, and a client reading `response.output_item.done` would rebuild a
 * different history than one reading `response.completed`. Both now ask `sameMessageSignature`.
 *
 * The class it closes: any divergence between the two encoders, or between either and the rule, over every
 * sequence of up to three content blocks drawn from every content block kind. A text block opens a new item
 * when no message is open or its signature differs from the open one; "no signature" matches only "no
 * signature", a legacy plain-id signature matches a v1 signature with the same id and no phase, and two v1
 * signatures match when id and phase both do. Reasoning and tool calls end the open message; redacted
 * thinking and the Anthropic fallback marker produce no item and leave it open. `BLOCKS` is keyed by the
 * content union, so a new block kind fails the type check until it is given a variant here.
 *
 * WHAT IT DOES NOT CATCH. The fields of reasoning and tool-call items beyond their kind, and sequences of
 * four or more blocks.
 */

import { describe, expect, it } from "bun:test";
import type { AssistantMessage, AssistantMessageEvent } from "@veyyon/ai";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { encodeResponse } from "../src/providers/openai-responses-server-output";
import { encodeStream } from "../src/providers/openai-responses-server-stream";
import { encodeTextSignatureV1 } from "../src/providers/openai-shared";

type Block = AssistantMessage["content"][number];

interface Variant {
	label: string;
	block: (text: string) => Block;
	/** For a text block: the identity its message item takes. `id` absent means a minted id. */
	message?: { key: string; id?: string; phase?: "commentary" | "final_answer" };
	/** For a block that ends the open message with an item of its own: that item's type. */
	item?: "reasoning" | "function_call";
}

const BLOCKS: { [K in Block["type"]]: Variant[] } = {
	text: [
		{ label: "unsigned", block: text => ({ type: "text", text }), message: { key: "none" } },
		{
			label: "legacy item_a",
			block: text => ({ type: "text", text, textSignature: "item_a" }),
			message: { key: "item_a|", id: "item_a" },
		},
		{
			label: "v1 item_a",
			block: text => ({ type: "text", text, textSignature: encodeTextSignatureV1("item_a") }),
			message: { key: "item_a|", id: "item_a" },
		},
		{
			label: "v1 item_a commentary",
			block: text => ({ type: "text", text, textSignature: encodeTextSignatureV1("item_a", "commentary") }),
			message: { key: "item_a|commentary", id: "item_a", phase: "commentary" },
		},
		{
			label: "v1 item_a final_answer",
			block: text => ({ type: "text", text, textSignature: encodeTextSignatureV1("item_a", "final_answer") }),
			message: { key: "item_a|final_answer", id: "item_a", phase: "final_answer" },
		},
		{
			label: "v1 item_b commentary",
			block: text => ({ type: "text", text, textSignature: encodeTextSignatureV1("item_b", "commentary") }),
			message: { key: "item_b|commentary", id: "item_b", phase: "commentary" },
		},
	],
	thinking: [{ label: "thinking", block: thinking => ({ type: "thinking", thinking }), item: "reasoning" }],
	toolCall: [
		{
			label: "tool call",
			block: id => ({ type: "toolCall", id: `call_${id}`, name: "read", arguments: { path: id } }),
			item: "function_call",
		},
	],
	redactedThinking: [{ label: "redacted thinking", block: data => ({ type: "redactedThinking", data }) }],
	fallback: [
		{
			label: "fallback marker",
			block: () => ({ type: "fallback", from: { model: "a" }, to: { model: "b" } }),
		},
	],
};

const VARIANTS = Object.values(BLOCKS).flat();

function sequences(maxLength: number): Variant[][] {
	const out: Variant[][] = [];
	let frontier: Variant[][] = [[]];
	for (let length = 1; length <= maxLength; length++) {
		frontier = frontier.flatMap(prefix => VARIANTS.map(variant => [...prefix, variant]));
		out.push(...frontier);
	}
	return out;
}

/** An output item reduced to what the grouping rule decides. */
interface ItemShape {
	type: string;
	id?: string;
	phase?: string;
	texts?: string[];
}

/** The items the rule predicts, computed without either encoder. */
function expectedItems(variants: Variant[]): ItemShape[] {
	const out: ItemShape[] = [];
	let open: { key: string; shape: ItemShape } | undefined;
	variants.forEach((variant, index) => {
		const text = `t${index}`;
		if (variant.message) {
			if (open?.key === variant.message.key) {
				open.shape.texts?.push(text);
				return;
			}
			const shape: ItemShape = { type: "message", id: variant.message.id ?? "<minted>", texts: [text] };
			if (variant.message.phase) shape.phase = variant.message.phase;
			open = { key: variant.message.key, shape };
			out.push(shape);
		} else if (variant.item) {
			open = undefined;
			out.push({ type: variant.item });
		}
	});
	return out;
}

const MINTED_MESSAGE_ID = /^msg_[0-9a-f]{32}$/;

function shapeOf(item: Record<string, unknown>): ItemShape {
	if (item.type !== "message") return { type: String(item.type) };
	const id = String(item.id);
	const shape: ItemShape = {
		type: "message",
		id: MINTED_MESSAGE_ID.test(id) ? "<minted>" : id,
		texts: (item.content as Array<{ text: string }>).map(part => part.text),
	};
	if (item.phase !== undefined) shape.phase = String(item.phase);
	return shape;
}

function finalMessage(variants: Variant[]): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5",
		content: variants.map((variant, index) => variant.block(`t${index}`)),
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1_700_000_000_000,
	};
}

/** The events a provider emits for `message`, block by block, ending with `done`. */
function eventsFor(message: AssistantMessage): AssistantMessageEvent[] {
	const events: AssistantMessageEvent[] = [{ type: "start", partial: message }];
	message.content.forEach((block, contentIndex) => {
		const at = { contentIndex, partial: message };
		if (block.type === "text") {
			events.push({ type: "text_start", ...at });
			events.push({ type: "text_delta", ...at, delta: block.text });
			events.push({ type: "text_end", ...at, content: block.text });
		} else if (block.type === "thinking") {
			events.push({ type: "thinking_start", ...at });
			events.push({ type: "thinking_delta", ...at, delta: block.thinking });
			events.push({ type: "thinking_end", ...at, content: block.thinking });
		} else if (block.type === "toolCall") {
			events.push({ type: "toolcall_start", ...at });
			events.push({ type: "toolcall_delta", ...at, delta: JSON.stringify(block.arguments) });
			events.push({ type: "toolcall_end", ...at, toolCall: block });
		}
	});
	events.push({ type: "done", reason: "stop", message });
	return events;
}

/** The items a streamed response finished, in output order, read from its `response.output_item.done` frames. */
async function streamedItems(message: AssistantMessage): Promise<Record<string, unknown>[]> {
	const source = new AssistantMessageEventStream();
	for (const event of eventsFor(message)) source.push(event);
	const body = await new Response(encodeStream(source, "gpt-5-requested")).text();
	const done: Array<{ output_index: number; item: Record<string, unknown> }> = [];
	for (const frame of body.split("\n\n")) {
		if (!frame.startsWith("event: response.output_item.done\n")) continue;
		done.push(JSON.parse(frame.slice(frame.indexOf("data: ") + "data: ".length)));
	}
	return done.sort((a, b) => a.output_index - b.output_index).map(frame => frame.item);
}

const label = (variants: Variant[]) => variants.map(variant => variant.label).join(" + ");

describe("consecutive text shares a message item only while its signature matches", () => {
	const cases = sequences(3);

	it("covers every content block kind", () => {
		const kinds = new Set<string>(cases.flatMap(variants => finalMessage(variants).content.map(block => block.type)));
		expect([...kinds].sort()).toEqual(Object.keys(BLOCKS).sort());
	});

	it("in a response written whole", () => {
		const mismatches = cases.flatMap(variants => {
			const output = encodeResponse(finalMessage(variants), "gpt-5-requested").output as Record<string, unknown>[];
			const got = output.map(shapeOf);
			const want = expectedItems(variants);
			return Bun.deepEquals(got, want) ? [] : [{ sequence: label(variants), got, want }];
		});
		expect(mismatches).toEqual([]);
	});

	it("in the items a stream finishes", async () => {
		const mismatches: unknown[] = [];
		for (const variants of cases) {
			const got = (await streamedItems(finalMessage(variants))).map(shapeOf);
			const want = expectedItems(variants);
			if (!Bun.deepEquals(got, want)) mismatches.push({ sequence: label(variants), got, want });
		}
		expect(mismatches).toEqual([]);
	});
});
