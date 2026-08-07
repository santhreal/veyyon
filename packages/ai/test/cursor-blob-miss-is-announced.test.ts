/**
 * A Cursor blob the client cannot supply is announced, and a missing SYSTEM PROMPT fails the turn.
 *
 * WHY THIS SUITE EXISTS. Cursor requests do not carry the system prompt. They carry content-addressed
 * blob IDS, and the server then asks for the CONTENT over the kv channel. `handleKvServerMessage`
 * answered a miss with `create(GetBlobResultSchema, {})` and said nothing: no throw, and the only log
 * line on that path is `log(...)`, which is a no-op unless `DEBUG_CURSOR` is set. So the server asked
 * for the system prompt, was handed an empty result, and built the prompt without it. The model then
 * ran with no system prompt and no AGENTS.md, and the run looked completely normal.
 *
 * The tell is that the SAME fact is fatal four hundred lines away: `readCursorBlob` throws
 * `Cursor blob not found`. One path failed closed and loud, the other failed open and silent.
 *
 * WHAT IS PINNED. The WIRE BYTES, because "returned an empty result" and "returned the content" are
 * both a successful `getBlobResult` and only the frame distinguishes them. A hit is a 94-byte frame
 * carrying the 81-byte system-prompt JSON; a miss is an 11-byte frame carrying nothing. Both are
 * asserted exactly, so a change that made a miss merely quieter rather than louder would fail here.
 *
 * The system-prompt/history distinction is pinned too. A missing history entry degrades the
 * transcript and the turn is still worth having; a missing system prompt is not degradation, so it
 * fails the turn. The kv channel sees only an opaque id, so the classification depends on the id set
 * the request minted being carried through, and that plumbing is what the fatal cases exercise.
 */
import { describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import { create, fromBinary } from "@bufbuild/protobuf";
import { buildCursorSystemPromptJsons, handleServerMessage } from "@veyyon/ai/providers/cursor";
import type { AssistantMessage } from "@veyyon/ai/types";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import {
	AgentClientMessageSchema,
	AgentServerMessageSchema,
	GetBlobArgsSchema,
	KvServerMessageSchema,
} from "@veyyon/catalog/discovery/cursor-gen/agent_pb";
import { logger } from "@veyyon/utils";

const SYSTEM_PROMPT = "ALWAYS reply in French. This is the AGENTS.md rule.";

/** The exact bytes the provider stores for a system prompt, and the id it derives from them. */
function systemPromptBlob(): { key: string; bytes: Uint8Array } {
	const [json] = buildCursorSystemPromptJsons([SYSTEM_PROMPT]);
	const bytes = new TextEncoder().encode(json);
	return { key: createHash("sha256").update(bytes).digest("hex"), bytes };
}

function getBlobRequest(blobIdHex: string) {
	return create(AgentServerMessageSchema, {
		message: {
			case: "kvServerMessage",
			value: create(KvServerMessageSchema, {
				id: 7,
				message: {
					case: "getBlobArgs",
					value: create(GetBlobArgsSchema, { blobId: Buffer.from(blobIdHex, "hex") }),
				},
			}),
		},
	});
}

type Answer = { frameBytes: number; blobDataLength: number; fatal: Error[] };

async function askForBlob(
	blobIdHex: string,
	store: Map<string, Uint8Array>,
	systemPromptBlobIds: ReadonlySet<string>,
): Promise<Answer> {
	const frames: Buffer[] = [];
	const fatal: Error[] = [];
	const h2 = { write: (buf: Buffer) => frames.push(Buffer.from(buf)) } as never;
	const output = { role: "assistant", content: [], stopReason: "stop" } as unknown as AssistantMessage;

	await handleServerMessage(
		getBlobRequest(blobIdHex),
		output,
		new AssistantMessageEventStream(),
		{} as never,
		store,
		h2,
		undefined,
		undefined,
		[],
		[],
		undefined,
		{ systemPromptBlobIds, onFatal: (error: Error) => fatal.push(error) },
	);

	expect(frames).toHaveLength(1);
	const frame = frames[0];
	// Strip the 5-byte Connect envelope before decoding.
	const message = fromBinary(AgentClientMessageSchema, new Uint8Array(frame.subarray(5)));
	const kv = message.message.value as { message: { case?: string; value: { blobData?: Uint8Array } } };
	expect(kv.message.case).toBe("getBlobResult");
	return { frameBytes: frame.length, blobDataLength: kv.message.value.blobData?.length ?? 0, fatal };
}

describe("Cursor blob misses", () => {
	it("serves a known system-prompt blob as content, not an empty result", async () => {
		const { key, bytes } = systemPromptBlob();
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

		const answer = await askForBlob(key, new Map([[key, bytes]]), new Set([key]));

		expect(bytes.length).toBe(81);
		expect(answer.blobDataLength).toBe(81);
		expect(answer.frameBytes).toBe(94);
		expect(answer.fatal).toEqual([]);
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it("announces a missing system-prompt blob and fails the turn", async () => {
		const { key } = systemPromptBlob();
		const warned: Array<{ message: string; fields: Record<string, unknown> }> = [];
		const warn = vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
			warned.push({ message, fields: fields ?? {} });
		});

		// A cold store: the id the server asks for is not held by this process.
		const answer = await askForBlob(key, new Map(), new Set([key]));

		// The reply is still protocol-legal, so the wire shape is unchanged: an empty result.
		expect(answer.blobDataLength).toBe(0);
		expect(answer.frameBytes).toBe(11);

		// What changed is that it is no longer silent.
		expect(warned).toHaveLength(1);
		expect(warned[0].message).toBe(
			"Cursor asked for a system-prompt blob this process does not hold; the model would have run with no system prompt",
		);
		expect(warned[0].fields).toEqual({ blobId: key, systemPrompt: true, knownBlobs: 0 });

		// And that the turn is abandoned rather than answered without instructions.
		expect(answer.fatal).toHaveLength(1);
		expect(answer.fatal[0].message).toContain(key);
		expect(answer.fatal[0].message).toContain("would have run with no system prompt");
		warn.mockRestore();
	});

	it("announces a missing history blob but lets the turn continue", async () => {
		const { key: systemKey } = systemPromptBlob();
		const historyKey = createHash("sha256").update("some earlier turn").digest("hex");
		const warned: Array<{ message: string; fields: Record<string, unknown> }> = [];
		const warn = vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
			warned.push({ message, fields: fields ?? {} });
		});

		const answer = await askForBlob(historyKey, new Map(), new Set([systemKey]));

		expect(answer.blobDataLength).toBe(0);
		expect(warned).toHaveLength(1);
		expect(warned[0].message).toBe(
			"Cursor asked for a blob this process does not hold; that part of the conversation is missing from the prompt",
		);
		expect(warned[0].fields).toEqual({ blobId: historyKey, systemPrompt: false, knownBlobs: 0 });
		// Degradable: a lost history entry is not worth throwing away a working turn.
		expect(answer.fatal).toEqual([]);
		warn.mockRestore();
	});
});
