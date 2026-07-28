import { describe, expect, it } from "bun:test";
import {
	formatErrorMessageWithRetryAfter,
	getHeadersFromError,
	getRetryAfterMsFromHeaders,
} from "@veyyon/ai/utils/retry-after";

describe("retry-after parsing", () => {
	/**
	 * RFC Retry-After permits zero, and providers use it to authorize an immediate
	 * retry; treating zero as missing changes a guided 429 into a terminal error.
	 */
	it("preserves explicit zero-delay retry guidance", () => {
		expect(getRetryAfterMsFromHeaders({ "retry-after": "0" })).toBe(0);
		expect(getRetryAfterMsFromHeaders({ "retry-after-ms": "0" })).toBe(0);
	});

	/**
	 * Error formatting runs while another operation is already failing, so unusual
	 * thrown values must not replace the provider failure with a formatter TypeError.
	 */
	it("formats primitive and undefined thrown values without throwing", () => {
		expect(formatErrorMessageWithRetryAfter(undefined, { "retry-after": "1" })).toBe(
			"undefined retry-after-ms=1000",
		);
		expect(formatErrorMessageWithRetryAfter(1n, { "retry-after-ms": "25" })).toBe("1 retry-after-ms=25");
	});

	/**
	 * JavaScript Error causes can be cyclic; header discovery must terminate rather
	 * than overflow the stack and mask the original request error.
	 */
	it("terminates on cyclic error causes while retaining nested headers", () => {
		const first = new Error("first", { cause: undefined });
		const second = Object.assign(new Error("second", { cause: first }), {
			headers: { "retry-after-ms": "12" },
		});
		Object.defineProperty(first, "cause", { value: second, configurable: true });

		expect(getHeadersFromError(first)).toEqual({ "retry-after-ms": "12" });
		Object.defineProperty(second, "headers", { value: undefined, configurable: true });
		expect(getHeadersFromError(first)).toBeUndefined();
	});
});
