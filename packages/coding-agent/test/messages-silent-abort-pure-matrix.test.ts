/**
 * Pure abort-render contracts: silent/user-interrupt aborts stay quiet;
 * resolveAbortLabel generic vs custom vs retry wording.
 */
import { describe, expect, it } from "bun:test";
import {
	GENERIC_ABORT_SENTINEL,
	isSilentAbort,
	isUserInterruptAbort,
	resolveAbortLabel,
	shouldRenderAbortReason,
	SILENT_ABORT_MARKER,
	USER_INTERRUPT_LABEL,
} from "@veyyon/coding-agent/session/messages";

const LEGACY_SILENT = "__omp.silent_abort__";

describe("isSilentAbort pure matrix", () => {
	it("true for current and legacy markers", () => {
		expect(isSilentAbort({ errorMessage: SILENT_ABORT_MARKER })).toBe(true);
		expect(isSilentAbort({ errorMessage: LEGACY_SILENT })).toBe(true);
	});

	it("false for user interrupt and custom and empty", () => {
		expect(isSilentAbort({ errorMessage: USER_INTERRUPT_LABEL })).toBe(false);
		expect(isSilentAbort({ errorMessage: "boom" })).toBe(false);
		expect(isSilentAbort({ errorMessage: undefined })).toBe(false);
		expect(isSilentAbort({ errorMessage: "" })).toBe(false);
	});
});

describe("isUserInterruptAbort pure matrix", () => {
	it("true only for USER_INTERRUPT_LABEL text", () => {
		expect(isUserInterruptAbort({ errorMessage: USER_INTERRUPT_LABEL })).toBe(true);
		expect(isUserInterruptAbort({ errorMessage: SILENT_ABORT_MARKER })).toBe(false);
		expect(isUserInterruptAbort({ errorMessage: "Interrupted by user " })).toBe(false);
		expect(isUserInterruptAbort({ errorMessage: "interrupted by user" })).toBe(false);
	});
});

describe("shouldRenderAbortReason pure matrix", () => {
	it("false for silent and user interrupt", () => {
		expect(shouldRenderAbortReason({ errorMessage: SILENT_ABORT_MARKER })).toBe(false);
		expect(shouldRenderAbortReason({ errorMessage: LEGACY_SILENT })).toBe(false);
		expect(shouldRenderAbortReason({ errorMessage: USER_INTERRUPT_LABEL })).toBe(false);
	});

	it("true for custom and generic sentinel", () => {
		expect(shouldRenderAbortReason({ errorMessage: "network failed" })).toBe(true);
		expect(shouldRenderAbortReason({ errorMessage: GENERIC_ABORT_SENTINEL })).toBe(true);
		expect(shouldRenderAbortReason({ errorMessage: undefined })).toBe(true);
	});
});

describe("resolveAbortLabel pure matrix", () => {
	it("custom non-generic reason verbatim", () => {
		expect(resolveAbortLabel({ errorMessage: "tool timed out" })).toBe("tool timed out");
		expect(resolveAbortLabel({ errorMessage: USER_INTERRUPT_LABEL })).toBe(USER_INTERRUPT_LABEL);
	});

	it("silent marker → Operation aborted (generic path)", () => {
		expect(resolveAbortLabel({ errorMessage: SILENT_ABORT_MARKER })).toBe("Operation aborted");
		expect(resolveAbortLabel({ errorMessage: LEGACY_SILENT })).toBe("Operation aborted");
	});

	it("generic sentinel and empty → Operation aborted", () => {
		expect(resolveAbortLabel({ errorMessage: GENERIC_ABORT_SENTINEL })).toBe("Operation aborted");
		expect(resolveAbortLabel({ errorMessage: undefined })).toBe("Operation aborted");
		expect(resolveAbortLabel({ errorMessage: "" })).toBe("Operation aborted");
	});

	it("retry wording singular and plural on generic path", () => {
		expect(resolveAbortLabel({ errorMessage: SILENT_ABORT_MARKER }, 1)).toBe(
			"Aborted after 1 retry attempt",
		);
		expect(resolveAbortLabel({ errorMessage: SILENT_ABORT_MARKER }, 2)).toBe(
			"Aborted after 2 retry attempts",
		);
		expect(resolveAbortLabel({ errorMessage: GENERIC_ABORT_SENTINEL }, 5)).toBe(
			"Aborted after 5 retry attempts",
		);
	});

	it("retry does not rewrite custom reason", () => {
		expect(resolveAbortLabel({ errorMessage: "disk full" }, 3)).toBe("disk full");
	});
});
