import { describe, expect, it } from "bun:test";
import {
	namespaceSessionId,
	readInterpreterSetting,
	readSetting,
	toExecutorBackendResult,
} from "@veyyon/coding-agent/eval/backend-helpers";
import type { ToolSession } from "@veyyon/coding-agent/tools";

/**
 * The per-language eval backends (jl/js/py/rb) share these helpers to namespace a
 * session id, read a typed/interpreter setting, and project an executor result. They
 * had no test. namespaceSessionId must be idempotent (double-prefixing a session id
 * would fork one conversation into two on-disk sessions), and readInterpreterSetting
 * must treat a blank or non-string setting as "unset" so a whitespace interpreter
 * path does not get handed to the shell. These pin those edges.
 */

function session(map: Record<string, unknown>): ToolSession {
	return { settings: { get: (key: string) => map[key] } } as unknown as ToolSession;
}

describe("namespaceSessionId", () => {
	it("prepends the prefix to a bare session id", () => {
		expect(namespaceSessionId("abc123", "js:")).toBe("js:abc123");
	});

	it("is idempotent when the id already carries the prefix", () => {
		expect(namespaceSessionId("js:abc123", "js:")).toBe("js:abc123");
	});

	it("does not treat a different prefix as already-namespaced", () => {
		expect(namespaceSessionId("py:abc", "js:")).toBe("js:py:abc");
	});
});

describe("readSetting", () => {
	it("returns the raw setting value", () => {
		expect(readSetting<number>(session({ "a.b": 7 }), "a.b")).toBe(7);
	});

	it("returns undefined for a missing key", () => {
		expect(readSetting(session({}), "missing")).toBeUndefined();
	});
});

describe("readInterpreterSetting", () => {
	it("returns a trimmed string value", () => {
		expect(readInterpreterSetting(session({ interp: "  /usr/bin/py3  " }), "interp")).toBe("/usr/bin/py3");
	});

	it("treats a blank or whitespace-only value as unset", () => {
		expect(readInterpreterSetting(session({ interp: "" }), "interp")).toBeUndefined();
		expect(readInterpreterSetting(session({ interp: "   " }), "interp")).toBeUndefined();
	});

	it("treats a non-string value as unset", () => {
		expect(readInterpreterSetting(session({ interp: 42 }), "interp")).toBeUndefined();
		expect(readInterpreterSetting(session({}), "interp")).toBeUndefined();
	});
});

describe("toExecutorBackendResult", () => {
	it("projects every field through, preserving an undefined artifactId", () => {
		const input = {
			output: "hi",
			exitCode: 0,
			cancelled: false,
			truncated: true,
			artifactId: undefined,
			totalLines: 3,
			totalBytes: 10,
			outputLines: 2,
			outputBytes: 8,
			displayOutputs: [],
		};
		expect(toExecutorBackendResult(input)).toEqual({
			output: "hi",
			exitCode: 0,
			cancelled: false,
			truncated: true,
			artifactId: undefined,
			totalLines: 3,
			totalBytes: 10,
			outputLines: 2,
			outputBytes: 8,
			displayOutputs: [],
		});
	});
});
