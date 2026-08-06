/**
 * The `<invoke>` wire syntax, and the guards over the values a request may carry.
 *
 * WHY THIS SUITE EXISTS. Three dialects speak Anthropic's tool-call syntax: `anthropic`
 * itself, the generic `xml` one, and `minimax`, which wraps the same invokes in a tag of its
 * own. Each of the three carried a byte-identical private copy of the invoke renderer, the
 * invoke-list renderer, the single-call renderer and the transcript wrapper, and two of them
 * also had the same `<function_results>` block. That is a wire format restated three times,
 * and a change to the escaping or to the string-argument rule in one copy leaves the other
 * two emitting a shape the model was never prompted for. The failure is not an exception: the
 * model simply starts calling tools badly, or stops.
 *
 * The same pattern held for two value lists. Both OpenAI-compatible servers spelled out the
 * six reasoning-effort levels and the five service tiers in comparison chains, next to the
 * canonical `THINKING_EFFORTS` list and `ServiceTier` type that already owned them, so a new
 * level was accepted by the type system and silently dropped from an incoming request.
 *
 * The renderers are asserted as exact bytes on the shared owner, then each dialect is checked
 * to render the same bytes through it, since "they all import it" is only worth as much as the
 * output being identical.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import { isEffort, THINKING_EFFORTS } from "@veyyon/catalog/effort";
import anthropicDialect from "../src/dialect/anthropic";
import deepseekDialect from "../src/dialect/deepseek";
import geminiDialect from "../src/dialect/gemini";
import gemmaDialect from "../src/dialect/gemma";
import glmDialect from "../src/dialect/glm";
import hermesDialect from "../src/dialect/hermes";
import kimiDialect from "../src/dialect/kimi";
import minimaxDialect from "../src/dialect/minimax";
import piNativeDialect from "../src/dialect/pi-native";
import qwen3Dialect from "../src/dialect/qwen3";
import {
	renderFunctionResults,
	renderInvoke,
	renderInvokes,
	renderInvokeToolCall,
	renderThinkTags,
	renderToolResponseResults,
	renderXmlThinkingTags,
} from "../src/dialect/rendering";
import * as rendering from "../src/dialect/rendering";
import xmlDialect from "../src/dialect/xml";
import { parseRequest as parseChatRequest } from "../src/providers/openai-chat-server";
import { parseRequest as parseResponsesRequest } from "../src/providers/openai-responses-server";
import type { Tool, ToolCall } from "../src/types";
import { isServiceTier, SERVICE_TIERS } from "../src/types";

afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * The two servers, addressed through the entry point a caller reaches: a request body in,
 * a `ParsedRequest` out. The guards are asserted through this rather than against the
 * source text, because a hand-written comparison chain and a call to the shared guard are
 * the same bytes to a reader and differ only in which values survive the parse.
 */
const SERVER_PARSERS = [
	["openai-responses-server", parseResponsesRequest],
	["openai-chat-server", parseChatRequest],
] as const;

/** The minimum body each server accepts. The two wire shapes differ, so the model is all they share. */
function baseRequest(server: string): Record<string, unknown> {
	return server === "openai-chat-server"
		? { model: "gpt-5", messages: [{ role: "user", content: "hi" }] }
		: { model: "gpt-5", input: "hi" };
}

/** The effort field is nested under `reasoning` on the Responses wire and flat on Chat Completions. */
function effortRequest(server: string, effort: string): Record<string, unknown> {
	return server === "openai-chat-server"
		? { ...baseRequest(server), reasoning_effort: effort }
		: { ...baseRequest(server), reasoning: { effort } };
}

/** The dialects whose thinking is the bare `<think>` envelope, so all six must share one renderer. */
const THINK_TAG_DIALECTS = [
	["qwen3", qwen3Dialect],
	["kimi", kimiDialect],
	["pi-native", piNativeDialect],
	["hermes", hermesDialect],
	["glm", glmDialect],
	["deepseek", deepseekDialect],
] as const;

const READ_TOOL: Tool = {
	name: "read",
	description: "Read a file",
	parameters: {
		type: "object",
		properties: { path: { type: "string" }, limit: { type: "number" } },
	},
};

const CALL: ToolCall = { type: "toolCall", id: "call_1", name: "read", arguments: { path: "src/a.ts", limit: 20 } };

describe("one tool call as an invoke element", () => {
	/**
	 * The exact bytes, because this IS the wire format. A prompt tells the model to emit this
	 * shape and a scanner parses it back, so a stray newline or a changed attribute order is a
	 * protocol change even when it still round-trips locally.
	 */
	it("renders the name and every argument as attributes and parameter elements", () => {
		expect(renderInvoke(CALL, undefined)).toBe(
			'<invoke name="read"><parameter name="path">"src/a.ts"</parameter><parameter name="limit">20</parameter></invoke>',
		);
	});

	/**
	 * An argument the tool declares as a string is emitted verbatim, so a code snippet keeps
	 * its newlines and quotes instead of arriving JSON-escaped. This is the rule that would
	 * drift silently between copies.
	 */
	it("emits a declared string argument verbatim and everything else as JSON", () => {
		const rendered = renderInvokeToolCall(CALL, { tools: [READ_TOOL] });

		expect(rendered).toBe(
			'<invoke name="read"><parameter name="path">src/a.ts</parameter><parameter name="limit">20</parameter></invoke>',
		);
	});

	/** A name or a key with XML syntax in it must not break out of the attribute. */
	it("escapes the tool name and the argument names", () => {
		const hostile: ToolCall = { type: "toolCall", id: "c", name: 'a"b<c', arguments: { 'k"<': 1 } };

		expect(renderInvoke(hostile, undefined)).toBe(
			'<invoke name="a&quot;b&lt;c"><parameter name="k&quot;&lt;">1</parameter></invoke>',
		);
	});

	it("renders a call with no arguments as an empty invoke", () => {
		expect(renderInvoke({ type: "toolCall", id: "c", name: "ls", arguments: {} }, undefined)).toBe(
			'<invoke name="ls"></invoke>',
		);
	});

	it("puts one invoke per line when a turn holds several", () => {
		const second: ToolCall = { type: "toolCall", id: "c2", name: "ls", arguments: {} };

		expect(renderInvokes([CALL, second], [])).toBe(
			`${renderInvoke(CALL, undefined)}\n${renderInvoke(second, undefined)}`,
		);
	});

	it("renders no invokes for an empty turn", () => {
		expect(renderInvokes([], [])).toBe("");
	});
});

describe("the three dialects that speak it", () => {
	/**
	 * The point of one owner: identical output, not merely a shared import. Each dialect adds
	 * its own wrapper around the invokes, and that wrapper is the ONLY thing that may differ.
	 */
	it("render a single tool call byte-identically", () => {
		const expected = renderInvokeToolCall(CALL, { tools: [READ_TOOL] });

		for (const dialect of [anthropicDialect, xmlDialect, minimaxDialect]) {
			expect(dialect.renderToolCall(CALL, { tools: [READ_TOOL] })).toBe(expected);
		}
	});

	it("wrap a turn's invokes in their own tag, and only that differs", () => {
		const invokes = renderInvokes([CALL], []);

		expect(xmlDialect.renderAssistantToolCalls([CALL], {})).toBe(invokes);
		expect(anthropicDialect.renderAssistantToolCalls([CALL], {})).toBe(
			`<function_calls>\n${invokes}\n</function_calls>`,
		);
		expect(minimaxDialect.renderAssistantToolCalls([CALL], {})).toBe(
			`<minimax:tool_call>\n${invokes}\n</minimax:tool_call>`,
		);
	});

	/** Both wrapping dialects answer an empty turn with nothing, not with an empty wrapper. */
	it("render an empty turn as nothing at all", () => {
		for (const dialect of [anthropicDialect, xmlDialect, minimaxDialect]) {
			expect(dialect.renderAssistantToolCalls([], {})).toBe("");
		}
	});

	it("share the thinking-tag renderer", () => {
		const thinking = anthropicDialect.renderThinking("weighing it up");

		expect(xmlDialect.renderThinking("weighing it up")).toBe(thinking);
		expect(minimaxDialect.renderThinking("weighing it up")).toBe(thinking);
	});
});

describe("tool results as a function-results block", () => {
	/**
	 * A failed call is reported as `<error>` with its text on `<stderr>`. Collapsing that into
	 * the success shape is how a model ends up retrying a call that worked, or reading an error
	 * message as data, so both tags are asserted literally.
	 */
	it("marks a success and a failure with different tags", () => {
		expect(renderFunctionResults([{ id: "1", index: 0, name: "read", text: "ok", isError: false }])).toBe(
			"<function_results>\n<result>\n<tool_name>read</tool_name>\n<stdout>ok</stdout>\n</result>\n</function_results>",
		);
		expect(renderFunctionResults([{ id: "1", index: 0, name: "read", text: "boom", isError: true }])).toBe(
			"<function_results>\n<error>\n<tool_name>read</tool_name>\n<stderr>boom</stderr>\n</error>\n</function_results>",
		);
	});

	it("escapes the tool name, which arrives from the model", () => {
		const rendered = renderFunctionResults([{ id: "1", index: 0, name: "a<b&c", text: "ok", isError: false }]);

		expect(rendered).toContain("<tool_name>a&lt;b&amp;c</tool_name>");
	});

	it("is what both dialects that use it produce", () => {
		const results = [{ id: "1", index: 0, name: "read", text: "ok", isError: false }];

		expect(anthropicDialect.renderToolResults(results, {})).toBe(renderFunctionResults(results));
		expect(minimaxDialect.renderToolResults(results, {})).toBe(renderFunctionResults(results));
	});
});

describe("the reasoning-effort guard", () => {
	/** Derived from the canonical ladder, so it cannot fall behind it. */
	it("accepts every effort on the ladder", () => {
		for (const effort of THINKING_EFFORTS) expect(isEffort(effort)).toBe(true);
	});

	it("rejects a level that is not on the ladder, and every non-string", () => {
		for (const value of ["", "MEDIUM", "highest", "none", 1, null, undefined, {}, ["high"]]) {
			expect(isEffort(value)).toBe(false);
		}
	});

	/**
	 * The lock. Both servers hand-wrote the six comparisons, so adding a level to the ladder
	 * left them silently rejecting it: a request naming the new effort was answered as if it
	 * had named none.
	 */
	it("is what both servers actually run, so every ladder level survives a request", () => {
		for (const [name, parseRequest] of SERVER_PARSERS) {
			for (const effort of THINKING_EFFORTS) {
				const parsed = parseRequest(effortRequest(name, effort));
				expect(parsed.options.reasoning, `${name} dropped ${effort}`).toBe(effort);
			}
		}
	});

	/**
	 * The negative control, and it is not the same on both wires. The Chat Completions
	 * body is validated by an arktype schema that enumerates the ladder, so an unknown
	 * level is refused outright; the Responses body admits any string and the guard is
	 * what drops it. Both are stated, because a change that made either silently accept
	 * an off-ladder level would satisfy every acceptance above.
	 */
	it("refuses a level that is not on the ladder, in each wire's own way", () => {
		expect(parseResponsesRequest(effortRequest("openai-responses-server", "sideways")).options.reasoning)
			.toBeUndefined();
		expect(() => parseChatRequest(effortRequest("openai-chat-server", "sideways"))).toThrow(/reasoning_effort/);
	});
});

describe("the service-tier guard", () => {
	it("accepts every tier and rejects anything else", () => {
		for (const tier of SERVICE_TIERS) expect(isServiceTier(tier)).toBe(true);
		for (const value of ["", "Auto", "fast", 0, null, undefined, {}]) expect(isServiceTier(value)).toBe(false);
	});

	/** The type is derived from the list, so there is one place to add a tier. */
	it("covers exactly the five tiers the wire accepts", () => {
		expect([...SERVICE_TIERS]).toEqual(["auto", "default", "flex", "scale", "priority"]);
	});

	it("is what both servers actually run, so every tier survives a request", () => {
		for (const [name, parseRequest] of SERVER_PARSERS) {
			for (const tier of SERVICE_TIERS) {
				const parsed = parseRequest({ ...baseRequest(name), service_tier: tier });
				expect(parsed.options.serviceTier, `${name} dropped ${tier}`).toBe(tier);
			}
		}
	});

	/** The same split for the tier: the Chat schema refuses it, the Responses guard drops it. */
	it("refuses a tier that is not on the list, in each wire's own way", () => {
		expect(
			parseResponsesRequest({ ...baseRequest("openai-responses-server"), service_tier: "gold" }).options
				.serviceTier,
		).toBeUndefined();
		expect(() => parseChatRequest({ ...baseRequest("openai-chat-server"), service_tier: "gold" })).toThrow(
			/service_tier/,
		);
	});
});

describe("the dialect modules", () => {
	/**
	 * The lock for the renderers, asserted as function IDENTITY rather than as the absence of a
	 * `function renderInvoke(` string in the source.
	 *
	 * A reintroduced private copy renders the same bytes on the day it is written -- which is exactly
	 * the state the three dialects were already in, and why every byte assertion above stayed green
	 * through it -- but it is a different function OBJECT. Identity separates the two the moment the
	 * copy exists rather than on the day it drifts, and it does so without caring how the copy is
	 * spelled, which a `not.toContain("function renderInvoke(")` scan does.
	 */
	it("expose the shared renderers themselves, not copies of them", () => {
		for (const dialect of [anthropicDialect, minimaxDialect, xmlDialect]) {
			expect(dialect.renderToolCall, dialect.dialect).toBe(renderInvokeToolCall);
			expect(dialect.renderThinking, dialect.dialect).toBe(renderXmlThinkingTags);
		}
		// `<function_results>` is built in one place. `xml` deliberately answers with the bare
		// `<tool_response>` form instead, and asserting that difference is what keeps the two
		// equalities above from being satisfiable by every dialect sharing one renderer by accident.
		expect(anthropicDialect.renderToolResults).toBe(renderFunctionResults);
		expect(minimaxDialect.renderToolResults).toBe(renderFunctionResults);
		expect(xmlDialect.renderToolResults).toBe(renderToolResponseResults);
		expect(xmlDialect.renderToolResults).not.toBe(renderFunctionResults);
	});

	/** Every one of the pass-through `renderThinking` wrappers is gone, in all six dialects. */
	it("reference the shared thinking renderer directly", () => {
		for (const [name, dialect] of THINK_TAG_DIALECTS) {
			expect(dialect.renderThinking, name).toBe(renderThinkTags);
		}
	});

	/**
	 * And the three per-model turn delimiters live only in `rendering.ts`, proved by making the
	 * shared function answer differently and watching each dialect's transcript change with it.
	 *
	 * A private copy is byte-identical on the day it is written, so comparing output against
	 * `kimiTurn(...)` would pass straight through one. Redirecting the shared function is what
	 * separates "calls the owner" from "happens to agree with it": a dialect holding its own copy
	 * keeps emitting the real envelope and fails here.
	 */
	it.each([
		["kimi", kimiDialect, "kimiTurn"],
		["gemma", gemmaDialect, "gemmaTurn"],
		["gemini", geminiDialect, "geminiTurn"],
	] as const)("%s takes its turn delimiter from the shared module", (_name, dialect, symbol) => {
		const marker = `[${symbol}-was-here]`;
		vi.spyOn(rendering, symbol).mockReturnValue(marker);

		const out = dialect.renderTranscript?.([
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 0 },
		] as never);

		expect(out, `${symbol} is not what ${_name} renders a turn with`).toContain(marker);
	});
});
