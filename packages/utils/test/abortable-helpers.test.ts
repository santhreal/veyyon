import { describe, expect, it } from "bun:test";
import { AbortError, cancellationError, isAbortError, isCancellation, isTimeoutError } from "../src/abortable";

describe("cancellationError", () => {
	it("creates an error with default message", () => {
		const error = cancellationError();
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toBe("Request was aborted");
		expect(error.name).toBe("AbortError");
	});

	it("creates an error with custom message", () => {
		const error = cancellationError("Custom cancellation reason");
		expect(error.message).toBe("Custom cancellation reason");
		expect(error.name).toBe("AbortError");
	});

	it("creates an error with empty message", () => {
		const error = cancellationError("");
		expect(error.message).toBe("");
		expect(error.name).toBe("AbortError");
	});

	it("returns a new Error instance each call", () => {
		const a = cancellationError();
		const b = cancellationError();
		expect(a).not.toBe(b);
	});
});

describe("isAbortError", () => {
	it("returns true for AbortError name", () => {
		const error = cancellationError();
		expect(isAbortError(error)).toBe(true);
	});

	it("returns true for ToolAbortError name", () => {
		const error = new Error("tool aborted");
		error.name = "ToolAbortError";
		expect(isAbortError(error)).toBe(true);
	});

	it("returns true for AbortError class instance", () => {
		const controller = new AbortController();
		controller.abort();
		const error = new AbortError(controller.signal);
		expect(isAbortError(error)).toBe(true);
	});

	it("returns false for generic Error", () => {
		expect(isAbortError(new Error("something"))).toBe(false);
	});

	it("returns false for TypeError", () => {
		expect(isAbortError(new TypeError("type error"))).toBe(false);
	});

	it("returns false for null", () => {
		expect(isAbortError(null)).toBe(false);
	});

	it("returns false for undefined", () => {
		expect(isAbortError(undefined)).toBe(false);
	});

	it("returns false for string", () => {
		expect(isAbortError("AbortError")).toBe(false);
	});

	it("returns false for number", () => {
		expect(isAbortError(42)).toBe(false);
	});

	it("returns false for object without name", () => {
		expect(isAbortError({})).toBe(false);
	});

	it("returns false for object with non-string name", () => {
		expect(isAbortError({ name: 123 })).toBe(false);
	});
});

describe("isTimeoutError", () => {
	it("returns true for TimeoutError name", () => {
		const error = new Error("timed out");
		error.name = "TimeoutError";
		expect(isTimeoutError(error)).toBe(true);
	});

	it("returns false for AbortError name", () => {
		const error = cancellationError();
		expect(isTimeoutError(error)).toBe(false);
	});

	it("returns false for generic Error", () => {
		expect(isTimeoutError(new Error("something"))).toBe(false);
	});

	it("returns false for null", () => {
		expect(isTimeoutError(null)).toBe(false);
	});

	it("returns false for undefined", () => {
		expect(isTimeoutError(undefined)).toBe(false);
	});

	it("returns false for string", () => {
		expect(isTimeoutError("TimeoutError")).toBe(false);
	});

	it("returns false for object without name", () => {
		expect(isTimeoutError({})).toBe(false);
	});
});

describe("isCancellation", () => {
	it("returns true for AbortError", () => {
		expect(isCancellation(cancellationError())).toBe(true);
	});

	it("returns true for ToolAbortError", () => {
		const error = new Error("tool aborted");
		error.name = "ToolAbortError";
		expect(isCancellation(error)).toBe(true);
	});

	it("returns true for TimeoutError", () => {
		const error = new Error("timed out");
		error.name = "TimeoutError";
		expect(isCancellation(error)).toBe(true);
	});

	it("returns false for generic Error", () => {
		expect(isCancellation(new Error("something"))).toBe(false);
	});

	it("returns false for null", () => {
		expect(isCancellation(null)).toBe(false);
	});

	it("returns false for undefined", () => {
		expect(isCancellation(undefined)).toBe(false);
	});

	it("returns false for string", () => {
		expect(isCancellation("error")).toBe(false);
	});

	it("returns false for object without name", () => {
		expect(isCancellation({})).toBe(false);
	});
});
