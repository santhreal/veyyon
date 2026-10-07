import { describe, expect, it } from "bun:test";
import type { ResponseInput } from "@veyyon/ai/providers/openai-responses-wire";
import { buildResponsesInput } from "@veyyon/ai/providers/openai-shared";
import type { AssistantMessage, Context, Message, Model, ModelSpec, ToolCall } from "@veyyon/ai/types";
import { createOpenAIResponsesHistoryPayload } from "@veyyon/ai/utils";
import { buildModel } from "@veyyon/catalog/build";

/**
 * WHY: `buildResponsesInput` decides how to emit each tool result from the call ids it has seen so far. Under
 * strict pairing a result whose call is absent becomes a `<stale-tool-result>` user note, and a result for a
 * freeform custom call becomes a `custom_tool_call_output`. Those ids enter the input from four places: a call
 * converted from content blocks, a replayed incremental (`dt`) assistant snapshot, a replayed full snapshot that
 * discards everything before it, and a replayed user-message payload such as a compaction. The builder records the
 * ids each replay appends instead of rescanning the input, so a missed or stale record surfaces here as an
 * unpaired output, a note for a call the input carries, or an output of the wrong kind.
 *
 * THE CLASS: any divergence between the call ids the builder believes the input carries and the calls the built
 * input carries. The oracle reads only the built input, so it holds whichever entry point recorded the id.
 *
 * WHAT THIS DOES NOT CATCH: a call id reused across kinds (one id issued as both a custom and a function call),
 * which the generator excludes because the endpoint never issues one, and the order of items beyond pairing.
 */

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function responsesModel(freeform: boolean): Model<"openai-responses"> {
	return buildModel({
		id: "test-responses",
		name: "Test Responses",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16000,
		...(freeform ? { applyPatchToolType: "freeform" as const } : {}),
	} satisfies ModelSpec<"openai-responses">);
}

/** Deterministic 32-bit generator, so a failing session reproduces from its seed. */
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

const CALL_POOL = 6;
const isCustomCall = (n: number) => n % 3 === 0;

function payloadCallItem(n: number): Record<string, unknown> {
	return isCustomCall(n)
		? { type: "custom_tool_call", call_id: `call_${n}`, name: "apply_patch", input: `patch ${n}` }
		: { type: "function_call", call_id: `call_${n}`, name: "read", arguments: `{"n":${n}}` };
}

function contentToolCall(n: number): ToolCall {
	return isCustomCall(n)
		? {
				type: "toolCall",
				id: `call_${n}|ctc_${n}`,
				name: "edit",
				customWireName: "apply_patch",
				arguments: { input: `patch ${n}` },
			}
		: { type: "toolCall", id: `call_${n}|fc_${n}`, name: "read", arguments: { n } };
}

const visibleReply = {
	type: "message",
	role: "assistant",
	status: "completed",
	content: [{ type: "output_text", text: "reply", annotations: [] }],
};
const hiddenEmptyReply = {
	type: "message",
	role: "assistant",
	status: "completed",
	content: [{ type: "output_text", text: " ", annotations: [] }],
};

type PayloadShape = "none" | "incremental" | "snapshot" | "hidden-empty";
const PAYLOAD_SHAPES: readonly PayloadShape[] = ["none", "incremental", "snapshot", "hidden-empty"];

interface Session {
	context: Context;
	resultTexts: Set<string>;
}

function generateSession(random: () => number, modelId: string): Session {
	const pick = (n: number) => Math.floor(random() * n);
	const calls = (max: number) => Array.from({ length: pick(max + 1) }, () => pick(CALL_POOL));
	const messages: Message[] = [];
	const resultTexts = new Set<string>();
	const steps = 3 + pick(8);
	for (let step = 0; step < steps; step++) {
		const kind = pick(3);
		if (kind === 0) {
			messages.push({ role: "user", content: `question ${step}`, timestamp: step });
			continue;
		}
		if (kind === 1) {
			const items = [{ type: "compaction", encrypted_content: `summary ${step}` }, ...calls(2).map(payloadCallItem)];
			messages.push({
				role: "user",
				content: `summary ${step}`,
				providerPayload: createOpenAIResponsesHistoryPayload("openai", items),
				timestamp: step,
			});
			continue;
		}
		// Content calls and payload calls are drawn independently: a payload that omits a call the content issued,
		// or issues one the content lacks, is what tells a stale record from a correct one.
		const contentCalls = [...new Set(calls(2))];
		const shape = PAYLOAD_SHAPES[pick(PAYLOAD_SHAPES.length)]!;
		const payloadItems: Record<string, unknown>[] = [{ type: "reasoning", summary: [], encrypted_content: "r" }];
		if (shape === "hidden-empty") payloadItems.push(hiddenEmptyReply);
		else payloadItems.push(...calls(2).map(payloadCallItem), visibleReply);
		const assistant: AssistantMessage = {
			role: "assistant",
			content: contentCalls.length > 0 ? contentCalls.map(contentToolCall) : [{ type: "text", text: "reply" }],
			api: "openai-responses",
			provider: "openai",
			// A turn from another model replays from its content blocks, never from its payload.
			model: pick(5) === 0 ? "other-model" : modelId,
			usage,
			stopReason: contentCalls.length > 0 ? "toolUse" : "stop",
			...(shape === "none"
				? {}
				: { providerPayload: createOpenAIResponsesHistoryPayload("openai", payloadItems, shape !== "snapshot") }),
			timestamp: step,
		};
		messages.push(assistant);
		for (const n of contentCalls) {
			const text = `result ${step} ${n}`;
			resultTexts.add(text);
			messages.push({
				role: "toolResult",
				toolCallId: contentToolCall(n).id,
				toolName: isCustomCall(n) ? "edit" : "read",
				content: [{ type: "text", text }],
				isError: false,
				timestamp: step,
			});
		}
	}
	return { context: { messages }, resultTexts };
}

interface Tally {
	functionOutputs: number;
	customOutputs: number;
	foldedNotes: number;
}

const STALE_NOTE_ID = /^<stale-tool-result tool="[^"]*" id="([^"]*)"/;

/** Asserts the pairing invariant over the items one built input sends, and counts what it saw. */
function checkPairing(input: ResponseInput, freeform: boolean, session: Session, tally: Tally): void {
	const callKinds = new Map<string, string>();
	const records: Array<Record<string, unknown>> = JSON.parse(JSON.stringify(input));
	for (const record of records) {
		const type = record.type;
		const callId = record.call_id;
		if ((type === "function_call" || type === "custom_tool_call") && typeof callId === "string") {
			expect(callKinds.get(callId) ?? type).toBe(type);
			callKinds.set(callId, type);
			if (!freeform) expect(type).toBe("function_call");
			continue;
		}
		if ((type === "function_call_output" || type === "custom_tool_call_output") && typeof callId === "string") {
			const callKind = callKinds.get(callId);
			// An output never precedes its call, and its kind follows the call's kind.
			expect({ callId, callKind }).toEqual({ callId, callKind: expect.any(String) });
			expect({ callId, type }).toEqual({
				callId,
				type: callKind === "custom_tool_call" ? "custom_tool_call_output" : "function_call_output",
			});
			if (typeof record.output === "string" && session.resultTexts.has(record.output)) {
				if (type === "custom_tool_call_output") tally.customOutputs++;
				else tally.functionOutputs++;
			}
			continue;
		}
		const content = record.content;
		const noteId = typeof content === "string" ? STALE_NOTE_ID.exec(content)?.[1] : undefined;
		if (record.role === "user" && noteId !== undefined) {
			// A result is folded into a note only when the input carries no call for it.
			expect({ noteId, carried: callKinds.has(noteId) }).toEqual({ noteId, carried: false });
			tally.foldedNotes++;
		}
	}
}

const SESSIONS = 600;

describe("a Responses tool result pairs only with a call the input carries", () => {
	for (const freeform of [true, false]) {
		for (const replay of [true, false]) {
			it(`holds across ${SESSIONS} generated sessions (freeform ${freeform}, native replay ${replay})`, () => {
				const model = responsesModel(freeform);
				const random = mulberry32(freeform ? (replay ? 11 : 12) : replay ? 13 : 14);
				const tally: Tally = { functionOutputs: 0, customOutputs: 0, foldedNotes: 0 };
				for (let index = 0; index < SESSIONS; index++) {
					const session = generateSession(random, model.id);
					const input = buildResponsesInput({
						model,
						context: session.context,
						strictResponsesPairing: true,
						supportsImageDetailOriginal: true,
						supportsCustomToolCalls: freeform,
						nativeHistory: { replay, filterReasoning: false },
					});
					checkPairing(input, freeform, session, tally);
				}
				// A sweep that never pairs, never folds, or never emits a custom output proves nothing about them.
				// Without native replay every call is rebuilt from its content block, so no result is folded.
				expect(tally.functionOutputs).toBeGreaterThan(SESSIONS / 2);
				if (replay) expect(tally.foldedNotes).toBeGreaterThan(SESSIONS / 10);
				else expect(tally.foldedNotes).toBe(0);
				if (freeform) expect(tally.customOutputs).toBeGreaterThan(SESSIONS / 10);
				else expect(tally.customOutputs).toBe(0);
			});
		}
	}
});
