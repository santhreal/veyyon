/**
 * WHY THIS SUITE EXISTS AND WHICH CLASS IT CLOSES.
 *
 * A Cursor conversation is a sequence of `Run` requests, and the server keeps state between them
 * in two places this process holds for it: the conversation checkpoint it sends during a turn, and
 * the blobs it stores with `setBlobArgs`. The next turn of the same conversation starts from that
 * checkpoint and answers `getBlobArgs` from those blobs. The class this closes is "state the server
 * handed over in one turn is missing from the next": a checkpoint that is not kept, or a blob store
 * that is rebuilt per turn, each pass every single-turn test and degrade the second turn silently.
 *
 * The control cases pin the scope: state belongs to its conversation id and does not reach another.
 *
 * WHAT IT DOES NOT CATCH: eviction from the bounded caches, which `cursor-conversation-cache-bounds`
 * covers.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { clone, create } from "@bufbuild/protobuf";
import { ConversationStateStructureSchema } from "@veyyon/catalog/discovery/cursor-gen/agent_pb";
import {
	type CursorH2Server,
	respondConnect,
	runCursorTurn,
	serverFrame,
	startCursorH2Server,
	turnEndedFrame,
} from "./helpers/cursor-h2-server";

let server: CursorH2Server | undefined;

afterEach(async () => {
	await server?.close();
	server = undefined;
});

const BLOB_ID = Buffer.from("blob-the-server-stored");

describe("a Cursor conversation across turns", () => {
	it("starts the next turn from the checkpoint the server sent", async () => {
		const seen: number[] = [];
		server = await startCursorH2Server(({ request, stream }) => {
			const state = request.conversationState ?? create(ConversationStateStructureSchema);
			seen.push(state.selfSummaryCount);
			respondConnect(stream);
			// The server echoes the state it was sent, with a field of its own changed.
			const checkpoint = clone(ConversationStateStructureSchema, state);
			checkpoint.selfSummaryCount = 7;
			stream.end(
				Buffer.concat([
					serverFrame({ message: { case: "conversationCheckpointUpdate", value: checkpoint } }),
					turnEndedFrame(),
				]),
			);
		});
		const conversationId = crypto.randomUUID();

		await runCursorTurn(server.baseUrl, { apiKey: "test-token", conversationId });
		await runCursorTurn(server.baseUrl, { apiKey: "test-token", conversationId });
		await runCursorTurn(server.baseUrl, { apiKey: "test-token", conversationId: crypto.randomUUID() });

		expect(seen).toEqual([0, 7, 0]);
	});

	it("serves a blob the server stored in an earlier turn", async () => {
		const served: (string | undefined)[] = [];
		let turns = 0;
		server = await startCursorH2Server(async ({ stream, nextClientMessage }) => {
			const turn = ++turns;
			respondConnect(stream);
			const kv =
				turn === 1
					? ({
							case: "setBlobArgs",
							value: { blobId: BLOB_ID, blobData: Buffer.from("stored in turn 1") },
						} as const)
					: ({ case: "getBlobArgs", value: { blobId: BLOB_ID } } as const);
			stream.write(serverFrame({ message: { case: "kvServerMessage", value: { id: turn, message: kv } } }));
			const reply = await nextClientMessage();
			if (turn > 1) {
				const result = reply.message.case === "kvClientMessage" ? reply.message.value.message : undefined;
				const data = result?.case === "getBlobResult" ? result.value.blobData : undefined;
				// A miss answers with an empty `GetBlobResult`, whose bytes field decodes as zero length.
				served.push(data?.length ? Buffer.from(data).toString("utf8") : undefined);
			}
			stream.end(turnEndedFrame());
		});
		const conversationId = crypto.randomUUID();

		await runCursorTurn(server.baseUrl, { apiKey: "test-token", conversationId });
		await runCursorTurn(server.baseUrl, { apiKey: "test-token", conversationId });
		await runCursorTurn(server.baseUrl, { apiKey: "test-token", conversationId: crypto.randomUUID() });

		expect(served).toEqual(["stored in turn 1", undefined]);
	});
});
