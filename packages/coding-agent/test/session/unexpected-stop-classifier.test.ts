import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@veyyon/ai";
import {
	isUnexpectedStopCandidate,
	parseUnexpectedStopClassification,
} from "@veyyon/coding-agent/session/unexpected-stop-classifier";

/**
 * The two pure gates of the unexpected-stop classifier had no direct test: the only reference in the
 * suite is a heavy auto-compaction integration test that mocks the async classifyUnexpectedStop and
 * never exercises these. isUnexpectedStopCandidate decides whether an assistant turn is even worth
 * sending to the (paid) classifier model, and parseUnexpectedStopClassification reads its one-word
 * reply. A regression in the candidate gate either wastes classifier calls on tool-call turns / empty
 * replies or, worse, skips a real premature stop; a regression in the parser flips a yes/no verdict.
 * These pin the exact rules, including the documented prefix-match quirk in the parser.
 */

const message = (stopReason: AssistantMessage["stopReason"], content: AssistantMessage["content"]): AssistantMessage =>
	({ role: "assistant", content, stopReason }) as unknown as AssistantMessage;

const text = (t: string) => ({ type: "text", text: t }) as AssistantMessage["content"][number];
const toolCall = () =>
	({ type: "toolCall", id: "1", name: "x", arguments: {} }) as unknown as AssistantMessage["content"][number];
const thinking = () => ({ type: "thinking", thinking: "x" }) as unknown as AssistantMessage["content"][number];

describe("isUnexpectedStopCandidate", () => {
	it("accepts a plain-stop turn that carries non-whitespace text", () => {
		expect(isUnexpectedStopCandidate(message("stop", [text("hi")]))).toBe(true);
	});

	it("rejects any turn that did not stop on the natural stop reason", () => {
		expect(isUnexpectedStopCandidate(message("length", [text("hi")]))).toBe(false);
	});

	it("rejects a turn containing a tool call even when it also has text before it", () => {
		expect(isUnexpectedStopCandidate(message("stop", [toolCall()]))).toBe(false);
		expect(isUnexpectedStopCandidate(message("stop", [text("hi"), toolCall()]))).toBe(false);
	});

	it("rejects a turn whose only text is whitespace", () => {
		expect(isUnexpectedStopCandidate(message("stop", [text("   \n")]))).toBe(false);
	});

	it("rejects a turn with no text block (thinking-only or empty content)", () => {
		expect(isUnexpectedStopCandidate(message("stop", [thinking()]))).toBe(false);
		expect(isUnexpectedStopCandidate(message("stop", []))).toBe(false);
	});
});

describe("parseUnexpectedStopClassification", () => {
	it("reads a leading yes as true and a leading no as false, ignoring case and surrounding space", () => {
		expect(parseUnexpectedStopClassification("yes")).toBe(true);
		expect(parseUnexpectedStopClassification("  YES please ")).toBe(true);
		expect(parseUnexpectedStopClassification("no")).toBe(false);
	});

	it("returns undefined for a reply that is neither a yes nor a no", () => {
		expect(parseUnexpectedStopClassification("maybe")).toBeUndefined();
		expect(parseUnexpectedStopClassification("   ")).toBeUndefined();
	});

	it("matches on the yes/no PREFIX, so `nope`/`notable` read as false (documented quirk)", () => {
		// The parser only checks startsWith, so any word beginning with "no" collapses to false.
		// The classifier prompt constrains the model to answer exactly yes/no, so this is an
		// accepted tradeoff, not a bug -- pinned here so a future "exact match" refactor is deliberate.
		expect(parseUnexpectedStopClassification("nope")).toBe(false);
		expect(parseUnexpectedStopClassification("notable")).toBe(false);
	});
});
