/**
 * A Cursor turn that never delivered the caller's instructions fails loudly.
 *
 * WHY THIS SUITE EXISTS. `requestContext.rules` is the ONLY channel Cursor honors for client
 * instructions: the system-prompt blobs at the `rootPromptMessagesJson` head are fetched and then
 * replaced by the server's own canned prompt, and on a cursor-agent model the coding-agent
 * therefore inlines no context files in the prompt at all (`sdk.ts`, `usesCursorRuleDelivery`).
 * So the rules array carries the whole of it: veyyon's system prompt and the operator's global and
 * profile `AGENTS.md`.
 *
 * Nothing in the client pushes that array. `handleExecServerMessage` answers a `requestContextArgs`
 * ask, and if the ask never arrives the array is composed, logged at a level nobody has on, and
 * dropped. The turn then completes with `stopReason: "stop"` and the model runs on Cursor's canned
 * CLI prompt with none of the operator's instructions. An operator hit exactly that and reported
 * "No AGENTS.md content is present in my current context"; the run looked completely normal.
 *
 * The tell is that the SAME fact is already fatal on the other channel: a missing system-prompt
 * blob fails the turn (`cursor-blob-miss-is-announced.test.ts`). One channel failed closed, the
 * other failed open and silent.
 *
 * WHAT IS PINNED, and why each case has to exist:
 *  - Never asked, rules pending  -> the turn is an error naming the drop. This is the regression.
 *  - Asked                       -> the rules reach the wire verbatim and the turn is a clean stop.
 *                                   Without this the fix could be "always fail", which is useless.
 *  - Asked, then a later turn in the SAME conversation is not asked -> clean stop. A server that
 *                                   fetches context once per conversation is not a drop, and
 *                                   failing it would break every multi-turn Cursor session.
 *  - A DIFFERENT conversation that is never asked -> error. Proves the ledger is keyed by
 *                                   conversation and is not a process-wide "someone delivered once".
 *  - Nothing to deliver          -> clean stop. An empty rules array is not an undelivered one.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as http2 from "node:http2";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { buildCursorRules, handleServerMessage, streamCursor } from "@veyyon/ai/providers/cursor";
import type { AssistantMessage, Context, Model } from "@veyyon/ai/types";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { buildModel } from "@veyyon/catalog/build";
import {
	AgentClientMessageSchema,
	AgentServerMessageSchema,
	type CursorRule,
	ExecServerMessageSchema,
	InteractionUpdateSchema,
	RequestContextArgsSchema,
	type RequestContextSuccess,
	TurnEndedUpdateSchema,
} from "@veyyon/catalog/discovery/cursor-gen/agent_pb";

const SYSTEM_PROMPT = "You are veyyon. NEVER guess file contents.";
const GLOBAL_PATH = "/home/operator/.veyyon/AGENTS.md";
const GLOBAL_BODY = "# Global standing orders\nMarker: GLOBAL-SCOPE-BYTES-c3f1.";
const PROFILE_PATH = "/home/operator/.veyyon/profiles/work/agent/AGENTS.md";
const PROFILE_BODY = "# Work profile orders\nMarker: PROFILE-SCOPE-BYTES-9a20.";

const OPERATOR_RULES = [
	{ fullPath: PROFILE_PATH, content: PROFILE_BODY },
	{ fullPath: GLOBAL_PATH, content: GLOBAL_BODY },
];

function frame(payload: Uint8Array): Buffer {
	const header = Buffer.alloc(5);
	header.writeUInt8(0, 0);
	header.writeUInt32BE(payload.length, 1);
	return Buffer.concat([header, Buffer.from(payload)]);
}

/** The server asking the client for this request's context. The only trigger for rule delivery. */
function requestContextAskFrame(): Buffer {
	const message = create(AgentServerMessageSchema, {
		message: {
			case: "execServerMessage",
			value: create(ExecServerMessageSchema, {
				execId: "ctx-1",
				message: { case: "requestContextArgs", value: create(RequestContextArgsSchema, {}) },
			}),
		},
	});
	return frame(toBinary(AgentServerMessageSchema, message));
}

function turnEndedFrame(): Buffer {
	const message = create(AgentServerMessageSchema, {
		message: {
			case: "interactionUpdate",
			value: create(InteractionUpdateSchema, {
				message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
			}),
		},
	});
	return frame(toBinary(AgentServerMessageSchema, message));
}

interface FakeCursorServer {
	baseUrl: string;
	/** Every Connect frame the CLIENT wrote, in order. */
	clientFrames: Buffer[];
	close: () => Promise<void>;
}

/**
 * A localhost h2c server that asks (or does not ask) for the request context, records what the
 * client answers, and only then ends the turn.
 *
 * The ordering is the point. `turnEnded` is what completes the round on the client, so writing it
 * up front would race the client's `requestContextResult` and the recorded frames would be empty
 * whether or not delivery happened. Ending the turn once the answer has ARRIVED is both
 * deterministic and what a real server does: it wants the context before it finishes.
 *
 * The server does not end its own side; the provider treats `turnEnded`, not stream end, as
 * completion.
 */
function startH2Server(options: { askForContext: boolean }): Promise<FakeCursorServer> {
	const clientFrames: Buffer[] = [];
	const server = http2.createServer();
	server.on("stream", (stream: http2.ServerHttp2Stream) => {
		let turnEnded = false;
		const endTurn = () => {
			if (turnEnded) return;
			turnEnded = true;
			stream.write(turnEndedFrame());
		};
		stream.on("data", (chunk: Buffer) => {
			clientFrames.push(Buffer.from(chunk));
			if (options.askForContext && answeredRules(clientFrames) !== undefined) endTurn();
		});
		stream.on("error", () => {});
		stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
		if (options.askForContext) stream.write(requestContextAskFrame());
		else endTurn();
	});
	const { promise, resolve } = Promise.withResolvers<FakeCursorServer>();
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		const close = () => {
			const done = Promise.withResolvers<void>();
			server.close(() => done.resolve());
			return done.promise;
		};
		resolve({ baseUrl: `http://127.0.0.1:${port}`, clientFrames, close });
	});
	return promise;
}

const cursorModel = (baseUrl: string): Model<"cursor-agent"> =>
	buildModel({
		id: "cursor-composer-2.5",
		name: "Cursor Composer 2.5",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	});

interface TurnInput {
	baseUrl: string;
	conversationId: string;
	systemPrompt?: string[];
	cursorRules?: { fullPath: string; content: string }[];
}

async function runTurn(input: TurnInput): Promise<AssistantMessage> {
	const context: Context = {
		messages: [{ role: "user", content: "hi", timestamp: 1 }],
		systemPrompt: input.systemPrompt,
	};
	let message: AssistantMessage | undefined;
	for await (const event of streamCursor(cursorModel(input.baseUrl), context, {
		apiKey: "test-token",
		conversationId: input.conversationId,
		cursorRules: input.cursorRules,
	})) {
		if (event.type === "done") message = event.message;
		if (event.type === "error") message = event.error;
	}
	if (!message) throw new Error("stream produced no terminal event");
	return message;
}

/**
 * The rules the client answered with, or `undefined` when it has not answered yet.
 *
 * The distinction is load-bearing twice over: the server ends the turn on an ANSWER, and an empty
 * answer is a real answer that must not be mistaken for silence. Chunks are concatenated first,
 * because a Connect frame is not a TCP chunk and reading a length prefix out of the middle of a
 * split message finds nothing.
 */
function answeredRules(clientFrames: Buffer[]): CursorRule[] | undefined {
	let buffer = Buffer.concat(clientFrames);
	while (buffer.length >= 5) {
		const length = buffer.readUInt32BE(1);
		if (buffer.length < 5 + length) break;
		const body = buffer.subarray(5, 5 + length);
		buffer = buffer.subarray(5 + length);
		const message = fromBinary(AgentClientMessageSchema, new Uint8Array(body));
		if (message.message.case !== "execClientMessage") continue;
		const exec = message.message.value;
		if (exec.message.case !== "requestContextResult") continue;
		const result = exec.message.value.result;
		if (result.case !== "success") throw new Error(`requestContext failed: ${result.case}`);
		return (result.value as RequestContextSuccess).requestContext?.rules ?? [];
	}
	return undefined;
}

let srv: FakeCursorServer | undefined;
let conversationSeq = 0;

/** A fresh id per case: the delivery ledger is keyed by conversation and outlives one turn. */
function nextConversationId(): string {
	conversationSeq += 1;
	return `delivery-suite-${conversationSeq}`;
}

beforeEach(() => {
	srv = undefined;
});

afterEach(async () => {
	await srv?.close();
});

describe("Cursor request-context delivery", () => {
	it("fails the turn when the server never asked and the rules were therefore never sent", async () => {
		srv = await startH2Server({ askForContext: false });

		const message = await runTurn({
			baseUrl: srv.baseUrl,
			conversationId: nextConversationId(),
			systemPrompt: [SYSTEM_PROMPT],
			cursorRules: OPERATOR_RULES,
		});

		// The client never answered at all, which is stronger than answering with nothing and is
		// the whole point of the failure.
		expect(answeredRules(srv.clientFrames)).toBeUndefined();
		expect(message.stopReason).toBe("error");
		// Three rules: the system prompt plus the operator's two files. The count is in the
		// message so an operator reading it knows how much was lost, not merely that something was.
		expect(message.errorMessage).toContain("without ever requesting the request context");
		expect(message.errorMessage).toContain("3 rule(s)");
	});

	it("delivers the system prompt and both operator files verbatim when the server asks", async () => {
		srv = await startH2Server({ askForContext: true });

		const message = await runTurn({
			baseUrl: srv.baseUrl,
			conversationId: nextConversationId(),
			systemPrompt: [SYSTEM_PROMPT],
			cursorRules: OPERATOR_RULES,
		});

		expect(message.stopReason).toBe("stop");
		const rules = answeredRules(srv.clientFrames) ?? [];
		// Order is the delivery contract: ascending authority, so the operator's global file
		// keeps the last and highest-recency slot.
		expect(rules.map(rule => rule.fullPath)).toEqual(["veyyon://system-prompt.mdc", PROFILE_PATH, GLOBAL_PATH]);
		expect(rules.map(rule => rule.content)).toEqual([SYSTEM_PROMPT, PROFILE_BODY, GLOBAL_BODY]);
	});

	it("accepts a later turn with no ask once the conversation has been delivered", async () => {
		const conversationId = nextConversationId();
		srv = await startH2Server({ askForContext: true });
		const first = await runTurn({
			baseUrl: srv.baseUrl,
			conversationId,
			systemPrompt: [SYSTEM_PROMPT],
			cursorRules: OPERATOR_RULES,
		});
		expect(first.stopReason).toBe("stop");
		expect(answeredRules(srv.clientFrames) ?? []).toHaveLength(3);
		await srv.close();

		// Second turn, same conversation, server stays quiet: it already holds the context.
		srv = await startH2Server({ askForContext: false });
		const second = await runTurn({
			baseUrl: srv.baseUrl,
			conversationId,
			systemPrompt: [SYSTEM_PROMPT],
			cursorRules: OPERATOR_RULES,
		});

		expect(second.stopReason).toBe("stop");
	});

	it("fails a later turn whose instructions CHANGED and were never re-delivered", async () => {
		// The sibling of the reported bug, one edit later. The operator edits `AGENTS.md`, or
		// reloads, or moves the session; the caller composes the new bytes, the server does not
		// ask again, and the model keeps running on the old ones. A ledger that recorded only
		// "this conversation received something" would call that delivered, and the operator
		// would again be told nothing.
		const conversationId = nextConversationId();
		srv = await startH2Server({ askForContext: true });
		const first = await runTurn({
			baseUrl: srv.baseUrl,
			conversationId,
			systemPrompt: [SYSTEM_PROMPT],
			cursorRules: OPERATOR_RULES,
		});
		expect(first.stopReason).toBe("stop");
		await srv.close();

		srv = await startH2Server({ askForContext: false });
		const second = await runTurn({
			baseUrl: srv.baseUrl,
			conversationId,
			systemPrompt: [SYSTEM_PROMPT],
			cursorRules: [
				{ fullPath: PROFILE_PATH, content: PROFILE_BODY },
				{ fullPath: GLOBAL_PATH, content: `${GLOBAL_BODY}\nNEW: never ship on a Friday.` },
			],
		});

		expect(second.stopReason).toBe("error");
		expect(second.errorMessage).toContain("without ever requesting the request context");
	});

	it("accepts a quiet turn again once the CHANGED instructions have been re-delivered", async () => {
		// The other half of the case above, and the one that keeps the invariant from being a
		// trap. Once the new bytes actually reach the wire, the conversation is covered by THOSE
		// bytes; a ledger that kept recording the first delivery would fail every quiet turn for
		// the rest of the session and the operator could only get rid of it by starting over.
		const conversationId = nextConversationId();
		const edited = [
			{ fullPath: PROFILE_PATH, content: PROFILE_BODY },
			{ fullPath: GLOBAL_PATH, content: `${GLOBAL_BODY}\nNEW: never ship on a Friday.` },
		];

		srv = await startH2Server({ askForContext: true });
		const first = await runTurn({
			baseUrl: srv.baseUrl,
			conversationId,
			systemPrompt: [SYSTEM_PROMPT],
			cursorRules: OPERATOR_RULES,
		});
		expect(first.stopReason).toBe("stop");
		await srv.close();

		srv = await startH2Server({ askForContext: true });
		const second = await runTurn({
			baseUrl: srv.baseUrl,
			conversationId,
			systemPrompt: [SYSTEM_PROMPT],
			cursorRules: edited,
		});
		expect(second.stopReason).toBe("stop");
		await srv.close();

		srv = await startH2Server({ askForContext: false });
		const third = await runTurn({
			baseUrl: srv.baseUrl,
			conversationId,
			systemPrompt: [SYSTEM_PROMPT],
			cursorRules: edited,
		});

		expect(third.stopReason).toBe("stop");
	});

	it("does not count an empty delivery as covering the instructions that follow it", async () => {
		// A turn with nothing to deliver still answers the ask, with an empty rule set. Arming
		// the ledger on that would make the FIRST turn that actually carries the operator's
		// files eligible to be dropped in silence.
		const conversationId = nextConversationId();
		srv = await startH2Server({ askForContext: true });
		const first = await runTurn({ baseUrl: srv.baseUrl, conversationId });
		expect(first.stopReason).toBe("stop");
		expect(answeredRules(srv.clientFrames) ?? []).toEqual([]);
		await srv.close();

		srv = await startH2Server({ askForContext: false });
		const second = await runTurn({
			baseUrl: srv.baseUrl,
			conversationId,
			systemPrompt: [SYSTEM_PROMPT],
			cursorRules: OPERATOR_RULES,
		});

		expect(second.stopReason).toBe("error");
	});

	it("still fails a different conversation that was never delivered", async () => {
		// Guards the ledger key. A process-wide "delivered at least once" flag would pass the
		// previous case and silently drop every conversation opened after the first.
		srv = await startH2Server({ askForContext: false });

		const message = await runTurn({
			baseUrl: srv.baseUrl,
			conversationId: nextConversationId(),
			systemPrompt: [SYSTEM_PROMPT],
			cursorRules: OPERATOR_RULES,
		});

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("without ever requesting the request context");
	});

	it("accepts a turn with nothing to deliver", async () => {
		// No system prompt and no operator files compose an empty rules array. Nothing was
		// dropped, so nothing is wrong; failing here would break every caller that sends neither.
		srv = await startH2Server({ askForContext: false });

		const message = await runTurn({ baseUrl: srv.baseUrl, conversationId: nextConversationId() });

		expect(message.stopReason).toBe("stop");
	});

	it("reports no delivery when the write that carries the rules fails", async () => {
		// Ordering, asserted directly, because getting it wrong is invisible from the outside:
		// signalling delivery BEFORE the frame is written arms the ledger from a write that
		// threw, and the conversation is then exempt from the invariant for the rest of its
		// life. The turn-level cases cannot see this; only the handler can.
		let delivered = false;
		const h2 = {
			write: () => {
				throw new Error("socket closed under the write");
			},
		} as never;
		const output = { role: "assistant", content: [], stopReason: "stop" } as unknown as AssistantMessage;

		const attempt = handleServerMessage(
			create(AgentServerMessageSchema, {
				message: {
					case: "execServerMessage",
					value: create(ExecServerMessageSchema, {
						execId: "ctx-1",
						message: { case: "requestContextArgs", value: create(RequestContextArgsSchema, {}) },
					}),
				},
			}),
			output,
			new AssistantMessageEventStream(),
			{} as never,
			new Map(),
			h2,
			undefined,
			undefined,
			[],
			buildCursorRules([SYSTEM_PROMPT], OPERATOR_RULES),
			undefined,
			{
				systemPromptBlobIds: new Set<string>(),
				onFatal: () => {},
				onRequestContextDelivered: () => {
					delivered = true;
				},
			},
		);

		await expect(attempt).rejects.toThrow("socket closed under the write");
		expect(delivered).toBe(false);
	});
});
