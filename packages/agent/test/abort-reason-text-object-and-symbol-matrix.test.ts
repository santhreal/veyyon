/**
 * abortReasonText on non-string/non-Error reasons: numbers, objects, symbols, arrays.
 * Why: AbortController.abort accepts any; only string/Error message paths surface.
 */
import { describe, expect, it } from "bun:test";
import { abortReasonText } from "@veyyon/agent-core/agent-loop";

const GENERIC = "Request was aborted";

describe("abortReasonText object and symbol matrix", () => {
	const nonStringReasons: unknown[] = [
		0,
		1,
		-1,
		NaN,
		true,
		false,
		null,
		undefined,
		{},
		{ message: "nope" },
		[],
		["x"],
		Symbol("abort"),
		() => "fn",
		BigInt(1),
	];

	for (const reason of nonStringReasons) {
		it(`non-string ${Object.prototype.toString.call(reason)} → generic`, () => {
			const c = new AbortController();
			c.abort(reason as never);
			expect(abortReasonText(c.signal)).toBe(GENERIC);
		});
	}

	it("Error with name not AbortError and message keeps message", () => {
		const c = new AbortController();
		const e = new Error("custom stop");
		e.name = "TimeoutError";
		c.abort(e);
		expect(abortReasonText(c.signal)).toBe("custom stop");
	});

	it("DOMException-like AbortError name falls back even with useful message", () => {
		const c = new AbortController();
		const e = new Error("user cancelled");
		e.name = "AbortError";
		c.abort(e);
		expect(abortReasonText(c.signal)).toBe(GENERIC);
	});

	const strings = [
		["Interrupted by user", "Interrupted by user"],
		["stop", "stop"],
		["  x  ", "  x  "],
		["\t", GENERIC],
		["\n", GENERIC],
		[" \t\n ", GENERIC],
	] as const;

	for (const [raw, expected] of strings) {
		it(`string ${JSON.stringify(raw)} → ${JSON.stringify(expected)}`, () => {
			const c = new AbortController();
			c.abort(raw);
			expect(abortReasonText(c.signal)).toBe(expected);
		});
	}
});
