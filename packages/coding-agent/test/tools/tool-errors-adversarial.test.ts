import { describe, expect, it } from "bun:test";
import { renderError, ToolAbortError, ToolError, throwIfAborted } from "@veyyon/coding-agent/tools/tool-errors";

/**
 * ToolError/ToolAbortError/renderError/throwIfAborted exact contracts.
 */

describe("ToolError", () => {
	it("exposes message and optional context", () => {
		const err = new ToolError("boom", { path: "/x" });
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("ToolError");
		expect(err.message).toBe("boom");
		expect(err.context).toEqual({ path: "/x" });
		expect(err.render()).toBe("boom");
	});

	it("render defaults to message when not overridden", () => {
		const err = new ToolError("disk full");
		expect(err.render()).toBe("disk full");
	});
});

describe("ToolAbortError", () => {
	it("uses the stable default message", () => {
		const err = new ToolAbortError();
		expect(err.name).toBe("ToolAbortError");
		expect(err.message).toBe(ToolAbortError.MESSAGE);
		expect(err.message).toBe("Operation aborted");
	});

	it("accepts a custom message", () => {
		const err = new ToolAbortError("cancelled by user");
		expect(err.message).toBe("cancelled by user");
	});
});

describe("throwIfAborted", () => {
	it("is a no-op when signal is undefined or not aborted", () => {
		expect(() => throwIfAborted(undefined)).not.toThrow();
		expect(() => throwIfAborted(new AbortController().signal)).not.toThrow();
	});

	it("throws ToolAbortError when signal is aborted without reason", () => {
		const ac = new AbortController();
		ac.abort();
		expect(() => throwIfAborted(ac.signal)).toThrow(ToolAbortError);
	});

	it("re-throws an existing ToolAbortError reason", () => {
		const original = new ToolAbortError("already");
		const ac = new AbortController();
		ac.abort(original);
		try {
			throwIfAborted(ac.signal);
			expect(true).toBe(false);
		} catch (e) {
			expect(e).toBe(original);
		}
	});
});

describe("renderError", () => {
	it("uses ToolError.render", () => {
		expect(renderError(new ToolError("tool-msg"))).toBe("tool-msg");
	});

	it("uses Error.message for plain errors", () => {
		expect(renderError(new Error("plain"))).toBe("plain");
	});

	it("stringifies non-error values", () => {
		expect(renderError("string-fail")).toBe("string-fail");
		expect(renderError(42)).toBe("42");
	});
});
