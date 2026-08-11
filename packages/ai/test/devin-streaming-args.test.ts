import { describe, expect, it } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { streamDevin } from "@veyyon/ai/providers/devin";
import type { Context, Model, ToolCall } from "@veyyon/ai/types";
import { getStreamingPartialJson } from "@veyyon/ai/utils/block-symbols";
import { buildModel } from "@veyyon/catalog/build";
import { GetChatMessageResponseSchema } from "@veyyon/catalog/discovery/devin-gen/exa/api_server_pb/api_server_pb";
import { GetUserJwtResponseSchema } from "@veyyon/catalog/discovery/devin-gen/exa/auth_pb/auth_pb";
import {
	ChatToolCallSchema,
	StopReason,
} from "@veyyon/catalog/discovery/devin-gen/exa/codeium_common_pb/codeium_common_pb";

function frameConnectMessage(payload: Uint8Array): Uint8Array {
	const out = new Uint8Array(5 + payload.length);
	const view = new DataView(out.buffer);
	view.setUint8(0, 0);
	view.setUint32(1, payload.length, false);
	out.set(payload, 5);
	return out;
}

function toolCallDelta(argumentsJson: string, stopReason = StopReason.UNSPECIFIED): Uint8Array {
	const msg = create(GetChatMessageResponseSchema, {
		messageId: "msg-1",
		stopReason,
		deltaToolCalls: [create(ChatToolCallSchema, { id: "call-1", name: "task", argumentsJson })],
	});
	return frameConnectMessage(toBinary(GetChatMessageResponseSchema, msg));
}

/** A terminal frame carrying only the stop reason, the way the wire ends a
 *  tool call after its last argument fragment. */
function stopFrame(): Uint8Array {
	const msg = create(GetChatMessageResponseSchema, { messageId: "msg-1", stopReason: StopReason.FUNCTION_CALL });
	return frameConnectMessage(toBinary(GetChatMessageResponseSchema, msg));
}

const devinModel: Model<"devin-agent"> = buildModel({
	id: "devin-test",
	name: "Devin Test",
	api: "devin-agent",
	provider: "devin",
	baseUrl: "https://server.codeium.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1,
	maxTokens: 1,
});

const context: Context = { messages: [{ role: "user", content: "call tool", timestamp: 1 }] };

describe("streamDevin args streaming", () => {
	it("throttles tiny mid-stream arg reparses but flushes final args", async () => {
		const authPayload = toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: "jwt" }));
		const chunks = [
			toolCallDelta(`{"agent":"task","note":"initial"`),
			toolCallDelta(`{"agent":"task","note":"initial","step":1`),
			toolCallDelta(`{"agent":"task","note":"initial","step":12`, StopReason.FUNCTION_CALL),
		];
		const fetchImpl = (async (input: string | URL | Request) => {
			const url = String(input);
			if (url.includes("GetUserJwt")) return new Response(authPayload);
			let index = 0;
			return new Response(
				new ReadableStream<Uint8Array>({
					async pull(controller) {
						await Bun.sleep(1);
						const chunk = chunks[index++];
						if (chunk) controller.enqueue(chunk);
						else controller.close();
					},
				}),
				{ status: 200 },
			);
		}) as typeof fetch;

		const stream = streamDevin(devinModel, context, { apiKey: "token", fetch: fetchImpl });
		const snapshots: unknown[] = [];
		for await (const event of stream) {
			if (event.type === "toolcall_delta") {
				const block = event.partial.content.find(item => item.type === "toolCall") as ToolCall | undefined;
				snapshots.push(block?.arguments);
			}
		}
		const result = await stream.result();

		expect(snapshots[0]).toEqual({ agent: "task", note: "initial" });
		expect(snapshots[1]).toBe(snapshots[0]);
		expect(snapshots[2]).toBe(snapshots[0]);
		expect(result.content[0]?.type).toBe("toolCall");
		expect((result.content[0] as ToolCall).arguments).toEqual({ agent: "task", note: "initial", step: 12 });
	});

	/**
	 * WHY. `arguments` is deliberately frozen between throttled reparses (the row
	 * above pins that), so it is not what a live preview can read. The preview
	 * reads the block's own accumulation marker, and devin kept its accumulation
	 * in a provider-local Map and never wrote the marker — so `event-controller`
	 * saw no streamed buffer, fell back to the frozen `arguments`, and every bash
	 * preview rendered `$ …` until the call closed and popped its command in.
	 *
	 * The gate below is the test's own correctness, not pacing: `partial` is the
	 * LIVE message, so a producer that runs to completion before the consumer
	 * drains would be observed only in its final state — every frame reading the
	 * cleared marker and the assertion passing or failing for the wrong reason.
	 * Chunk N+1 is withheld until frame N has been read.
	 *
	 * WHAT IT DOES NOT CATCH. Only this provider. The same hole in another
	 * provider is a separate row.
	 */
	it("publishes the accumulated argument text on the block at every delta", async () => {
		const authPayload = toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: "jwt" }));
		const fragments = [`{"command":"git `, `{"command":"git status `, `{"command":"git status --short"}`];
		// The stop reason rides its own frame: a terminal frame that also carried
		// the last fragment would let the producer close the call (and clear the
		// marker) before the consumer had read that frame.
		const chunks = [...fragments.map(json => toolCallDelta(json)), stopFrame()];
		const observed = fragments.map(() => Promise.withResolvers<void>());
		const fetchImpl = (async (input: string | URL | Request) => {
			if (String(input).includes("GetUserJwt")) return new Response(authPayload);
			let index = 0;
			return new Response(
				new ReadableStream<Uint8Array>({
					async pull(controller) {
						const chunk = chunks[index];
						if (!chunk) {
							controller.close();
							return;
						}
						if (index > 0) await observed[index - 1]?.promise;
						index++;
						controller.enqueue(chunk);
					},
				}),
				{ status: 200 },
			);
		}) as typeof fetch;

		const stream = streamDevin(devinModel, context, { apiKey: "token", fetch: fetchImpl });
		const published: (string | undefined)[] = [];
		for await (const event of stream) {
			if (event.type !== "toolcall_delta") continue;
			const block = event.partial.content.find(item => item.type === "toolCall");
			published.push(getStreamingPartialJson(block));
			observed[published.length - 1]?.resolve();
		}
		const result = await stream.result();
		const finalCall = result.content.find(item => item.type === "toolCall");

		// Every frame carries exactly the bytes received so far, so a renderer
		// decoding it draws `git`, then `git status`, then the whole command.
		expect(published).toEqual(fragments);
		// The marker is evidence the call was still streaming. Leaving it set on a
		// closed call is what makes `agent-loop.ts` report a finished call as one
		// whose arguments never finished.
		expect(getStreamingPartialJson(finalCall)).toBeUndefined();
		expect(finalCall?.arguments).toEqual({ command: "git status --short" });
	});
});
