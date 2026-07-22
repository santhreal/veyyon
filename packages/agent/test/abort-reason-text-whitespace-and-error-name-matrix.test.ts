/**
 * abortReasonText additional adversarial: AbortError name always generic;
 * multi-line string reasons preserved; Error subclasses with message.
 */
import { describe, expect, it } from "bun:test";
import { abortReasonText } from "@veyyon/agent-core/agent-loop";

describe("abortReasonText adversarial extras", () => {
	it("preserves multi-line string reason", () => {
		const c = new AbortController();
		c.abort("line1\nline2");
		expect(abortReasonText(c.signal)).toBe("line1\nline2");
	});

	it("TypeError message surfaces", () => {
		const c = new AbortController();
		c.abort(new TypeError("not a function"));
		expect(abortReasonText(c.signal)).toBe("not a function");
	});

	it("DOMException-like AbortError name is generic even with message", () => {
		const c = new AbortController();
		const e = new Error("aborted by browser");
		e.name = "AbortError";
		c.abort(e);
		expect(abortReasonText(c.signal)).toBe("Request was aborted");
	});

	it("object reason without string/error is generic", () => {
		const c = new AbortController();
		c.abort({ reason: "x" } as never);
		expect(abortReasonText(c.signal)).toBe("Request was aborted");
	});
});
