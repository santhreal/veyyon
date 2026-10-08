/**
 * Whatever a tool returns, reports as a partial update, or an `afterToolCall` hook substitutes, the loop emits a result
 * a session can persist: a `content` array of text and image blocks only, and `isError` set exactly when that result
 * is an error.
 *
 * WHY THIS SUITE EXISTS. Third-party tools (MCP, extensions, user tools) return untyped values, and a result persisted
 * with no `content` array corrupts the session file. `coerceToolResult` in `agent-loop.ts` normalizes every result at
 * the boundary, and no suite pinned what it emits: a missing-content report, a dropped block counted in a note, a
 * sanitized text, an error with no substantive content replaced by `EMPTY_ERROR_TOOL_RESULT_TEXT`, a `useless` flag
 * cleared on an error, `details` read only when present.
 *
 * CLASS CLOSED. Every content of up to two blocks over ten block kinds, plus a missing, string or object `content`,
 * under every combination of `isError`, `useless` and `details`, plus five non-object results, is returned by a tool
 * and reported as its partial; every content is also substituted by an `afterToolCall` hook with each `isError` and
 * `useless` it may set. Each `tool_execution_update` and `tool_execution_end` is compared against a reference reading
 * of the rules above, and the sweep fails when a rule is never exercised.
 *
 * NOT CAUGHT. The cap applied to the persisted copy of a large result (`tool-result-cap.test.ts` owns it).
 */
import { describe, expect, it } from "bun:test";
import { agentLoop } from "@veyyon/agent-core/agent-loop";
import type {
	AfterToolCallResult,
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolResult,
} from "@veyyon/agent-core/types";
import type { Message } from "@veyyon/ai";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { EMPTY_ERROR_TOOL_RESULT_TEXT } from "@veyyon/ai/types";
import { formatCount, sanitizeText } from "@veyyon/utils";
import { type } from "arktype";
import { createUserMessage } from "./helpers";

const BLOCKS: Record<string, unknown> = {
	text: { type: "text", text: "found it" },
	"text with a control character": { type: "text", text: "bell\u0007 rang" },
	"blank text": { type: "text", text: "   " },
	"text without a string": { type: "text", text: 7 },
	image: { type: "image", data: "AAAA", mimeType: "image/png" },
	"image without a mime type": { type: "image", data: "AAAA" },
	"unknown type": { type: "audio", data: "AAAA" },
	"no type": { text: "untyped" },
	null: null,
	number: 5,
};

const MISSING = "Tool returned an invalid result: missing content array.";
const OK_CONTENT = [{ type: "text", text: "ok" }];

interface Expected {
	result: Record<string, unknown>;
	isError: boolean;
	rules: string[];
}

/** The rules in the header, read independently of the loop. */
function reference(raw: unknown): Expected {
	const obj = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
	const details = obj !== undefined && "details" in obj ? obj.details : {};
	const rules: string[] = [];
	if (obj === undefined || !Array.isArray(obj.content)) {
		return {
			result: { content: [{ type: "text", text: MISSING }], details, isError: true },
			isError: true,
			rules: ["missing"],
		};
	}
	let content: Array<Record<string, unknown>> = [];
	let invalid = 0;
	for (const value of obj.content) {
		const block = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
		if (block?.type === "text" && typeof block.text === "string") {
			if (sanitizeText(block.text) !== block.text) rules.push("sanitized");
			content.push({ type: "text", text: sanitizeText(block.text) });
		} else if (block?.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
			content.push(block);
		} else {
			invalid++;
		}
	}
	if (invalid > 0) {
		rules.push("dropped");
		content.push({
			type: "text",
			text: `Tool returned an invalid result: ${formatCount("content block", invalid)} had an unsupported shape.`,
		});
	}
	const isError = Boolean(obj.isError) || invalid > 0;
	const substantive = content.some(
		block => block.type === "image" || (block.type === "text" && String(block.text).trim().length > 0),
	);
	if (isError && !substantive) {
		rules.push("empty error");
		content = [{ type: "text", text: EMPTY_ERROR_TOOL_RESULT_TEXT }];
	}
	const useless = Boolean(obj.useless) && !isError;
	if (obj.useless && isError) rules.push("useless error");
	if (useless) rules.push("useless");
	return {
		result: { content, details, ...(isError ? { isError: true } : {}), ...(useless ? { useless: true } : {}) },
		isError,
		rules,
	};
}

function contents(): unknown[] {
	const kinds = Object.values(BLOCKS);
	const out: unknown[] = [undefined, "a string", { 0: "not an array" }, []];
	for (const a of kinds) {
		out.push([a]);
		for (const b of kinds) out.push([a, b]);
	}
	return out;
}

function returnedResults(): unknown[] {
	const out: unknown[] = [undefined, null, 0, "a string", []];
	for (const content of contents()) {
		for (const isError of [undefined, true, false, "yes"]) {
			for (const useless of [undefined, true]) {
				for (const details of ["absent", { path: "a" }, undefined]) {
					const raw: Record<string, unknown> = {};
					if (content !== undefined) raw.content = content;
					if (isError !== undefined) raw.isError = isError;
					if (useless !== undefined) raw.useless = useless;
					if (details !== "absent") raw.details = details;
					out.push(raw);
				}
			}
		}
	}
	return out;
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

const BATCH = 60;

/** Runs one turn of `count` `probe` calls (`call-0`, `call-1`, ...) and returns each call's update and end events. */
async function runBatch(
	count: number,
	tool: AgentTool<typeof PROBE_SCHEMA, unknown>,
	config: Partial<AgentLoopConfig>,
): Promise<Map<string, AgentEvent[]>> {
	const calls = Array.from({ length: count }, (_, index) => ({
		type: "toolCall" as const,
		id: `call-${index}`,
		name: "probe",
		arguments: { index },
	}));
	const mock = createMockModel({ responses: [{ content: calls }, { content: ["done"] }] });
	const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
	const stream = agentLoop(
		[createUserMessage("probe")],
		context,
		{ model: mock.model, convertToLlm: identityConverter, ...config },
		undefined,
		mock.stream,
	);
	const byCall = new Map<string, AgentEvent[]>();
	for await (const event of stream) {
		if (event.type !== "tool_execution_update" && event.type !== "tool_execution_end") continue;
		const list = byCall.get(event.toolCallId) ?? [];
		list.push(event);
		byCall.set(event.toolCallId, list);
	}
	return byCall;
}

const PROBE_SCHEMA = type({ index: "number" });

function probe(execute: (index: number, onUpdate?: (partial: AgentToolResult<unknown>) => void) => unknown) {
	return {
		name: "probe",
		label: "Probe",
		description: "Returns a prepared result",
		parameters: PROBE_SCHEMA,
		async execute(_id, params, _signal, onUpdate) {
			return execute(params.index, onUpdate) as AgentToolResult<unknown>;
		},
	} satisfies AgentTool<typeof PROBE_SCHEMA, unknown>;
}

describe("a tool result of any shape reaches the loop as one a session can persist", () => {
	it("from what a tool returns and reports as its partial", async () => {
		const results = returnedResults();
		const exercised = new Set<string>();
		for (let start = 0; start < results.length; start += BATCH) {
			const slice = results.slice(start, start + BATCH);
			const tool = probe((index, onUpdate) => {
				onUpdate?.(structuredClone(slice[index]) as AgentToolResult<unknown>);
				return structuredClone(slice[index]);
			});
			const events = await runBatch(slice.length, tool, {});
			slice.forEach((raw, index) => {
				const expected = reference(raw);
				for (const rule of expected.rules) exercised.add(rule);
				const label = JSON.stringify(raw) ?? String(raw);
				const [update, end] = events.get(`call-${index}`) ?? [];
				expect<unknown>(update?.type === "tool_execution_update" && update.partialResult, label).toEqual(
					expected.result,
				);
				expect<unknown>(end?.type === "tool_execution_end" && end.result, label).toEqual(expected.result);
				expect(end?.type === "tool_execution_end" && end.isError, label).toBe(expected.isError);
			});
		}
		expect([...exercised].sort()).toEqual([
			"dropped",
			"empty error",
			"missing",
			"sanitized",
			"useless",
			"useless error",
		]);
	});

	it("from what an afterToolCall hook substitutes", async () => {
		const hooked: Array<{ content: unknown; isError: boolean | undefined; useless: boolean | undefined }> = [];
		for (const content of contents()) {
			for (const isError of [undefined, true, false]) {
				for (const useless of [undefined, true]) hooked.push({ content, isError, useless });
			}
		}
		const exercised = new Set<string>();
		for (let start = 0; start < hooked.length; start += BATCH) {
			const slice = hooked.slice(start, start + BATCH);
			const tool = probe(() => ({ content: structuredClone(OK_CONTENT), details: {} }));
			const events = await runBatch(slice.length, tool, {
				afterToolCall: async ({ toolCall }) => {
					const index = Number(toolCall.id.slice("call-".length));
					const { content, isError, useless } = structuredClone(slice[index]);
					return { content, isError, useless } as AfterToolCallResult;
				},
			});
			slice.forEach((hook, index) => {
				const expected = reference({
					content: hook.content ?? OK_CONTENT,
					details: {},
					isError: hook.isError,
					useless: hook.useless,
				});
				for (const rule of expected.rules) exercised.add(rule);
				const label = JSON.stringify(hook);
				const end = events.get(`call-${index}`)?.find(event => event.type === "tool_execution_end");
				expect<unknown>(end?.type === "tool_execution_end" && end.result, label).toEqual(expected.result);
				expect(end?.type === "tool_execution_end" && end.isError, label).toBe(expected.isError);
			});
		}
		expect([...exercised].sort()).toEqual([
			"dropped",
			"empty error",
			"missing",
			"sanitized",
			"useless",
			"useless error",
		]);
	});
});
