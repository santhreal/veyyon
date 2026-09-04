/**
 * WHY THIS SUITE EXISTS:
 * When external tools, extensions, hooks, or libraries throw non-Error objects,
 * strings, numbers, or Error instances with empty messages (like `new TypeError()`),
 * converting them via ad-hoc `String(error)` or `error.message` yields unhelpful text
 * like `[object Object]` or empty strings trailing a colon.
 *
 * `renderError`, `toolFailure`, and `formatCliFatal` are the central choke points
 * through which error strings reach the LLM, the terminal UI, and stderr.
 * This suite proves that non-Error thrown values and empty-message errors surface
 * meaningful readable error text at every choke point.
 */

import { describe, expect, it } from "bun:test";
import { formatCliFatal } from "@veyyon/coding-agent/cli";
import { renderError, ToolError, toolFailure } from "@veyyon/coding-agent/tools/core/tool-errors";
import { errorMessage } from "@veyyon/utils";

describe("error rendering choke points surface readable error text", () => {
	it("renders Error instances with their message", () => {
		const err = new Error("permission denied");
		expect(renderError(err)).toBe("permission denied");
		expect(errorMessage(err)).toBe("permission denied");
	});

	it("falls back to error constructor name when message is empty", () => {
		const typeErr = new TypeError();
		expect(renderError(typeErr)).toBe("TypeError");
		expect(errorMessage(typeErr)).toBe("TypeError");

		const customErr = new RangeError("");
		expect(renderError(customErr)).toBe("RangeError");
		expect(errorMessage(customErr)).toBe("RangeError");
	});

	it("renders non-Error string throws verbatim", () => {
		const rawString = "connection reset by peer";
		expect(renderError(rawString)).toBe("connection reset by peer");
		expect(errorMessage(rawString)).toBe("connection reset by peer");
	});

	it("renders non-Error number throws as numeric strings", () => {
		expect(renderError(404)).toBe("404");
		expect(errorMessage(500)).toBe("500");
	});

	it("renders ToolError via its specialized render() method", () => {
		const toolErr = new ToolError("file not found", { path: "src/foo.ts" });
		expect(renderError(toolErr)).toBe(toolErr.render());
	});

	it("extracts error message in toolFailure for non-Error and empty-message Error values", () => {
		const emptyErr = new SyntaxError();
		const wrapped1 = toolFailure(emptyErr);
		expect(wrapped1.message).toBe("SyntaxError");

		const stringThrow = "disk full";
		const wrapped2 = toolFailure(stringThrow);
		expect(wrapped2.message).toBe("disk full");
	});

	it("formats CLI fatal errors with proper error text for non-Error values and causes", () => {
		const nonErrorFatal = formatCliFatal("fatal database corruption", { stack: false, colors: false });
		expect(nonErrorFatal).toContain("Error: fatal database corruption");
		expect(nonErrorFatal).not.toContain("[object Object]");

		const errorWithNonErrorCause = new Error("top-level failure", { cause: "network timeout" });
		const formattedCause = formatCliFatal(errorWithNonErrorCause, { stack: false, colors: false });
		expect(formattedCause).toContain("caused by: network timeout");
	});
});
