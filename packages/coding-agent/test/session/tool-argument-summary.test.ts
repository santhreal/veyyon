import { describe, expect, it } from "bun:test";
import { summarizeToolArguments } from "@veyyon/coding-agent/session/exit-diagnostics";

/**
 * summarizeToolArguments projects a persisted tool-call's full argument object down to just the
 * fields the resume "pending tool call" warning renders (command/path), truncated. It had no direct
 * test. It runs over legacy sessions that stored whole argument objects, so it must ignore
 * non-record input, skip absent/empty/non-string fields, and truncate long values, and return
 * undefined when nothing renderable survives (so the warning stays quiet rather than printing an
 * empty summary). These pin each of those rules and the 200-char truncation with an ellipsis.
 */

describe("summarizeToolArguments", () => {
	it("returns undefined for any non-record input", () => {
		expect(summarizeToolArguments(null)).toBeUndefined();
		expect(summarizeToolArguments("command")).toBeUndefined();
		expect(summarizeToolArguments(42)).toBeUndefined();
		expect(summarizeToolArguments(["command"])).toBeUndefined();
	});

	it("returns undefined when neither a command nor a path field survives", () => {
		expect(summarizeToolArguments({})).toBeUndefined();
		expect(summarizeToolArguments({ command: "", path: "" })).toBeUndefined();
		expect(summarizeToolArguments({ other: "ignored" })).toBeUndefined();
	});

	it("keeps only the command and path string fields, dropping everything else and non-strings", () => {
		expect(summarizeToolArguments({ command: "ls -la" })).toEqual({ command: "ls -la" });
		expect(summarizeToolArguments({ path: "/a/b" })).toEqual({ path: "/a/b" });
		expect(summarizeToolArguments({ command: "ls", path: "/x", extra: "ignored" })).toEqual({
			command: "ls",
			path: "/x",
		});
		// A non-string command is dropped, but a valid path still survives.
		expect(summarizeToolArguments({ command: 123, path: "/ok" })).toEqual({ path: "/ok" });
	});

	it("truncates a long field to 200 characters plus an ellipsis", () => {
		const summary = summarizeToolArguments({ command: "a".repeat(500) });
		expect(summary?.command).toBe(`${"a".repeat(200)}…`);
		expect(summary?.command?.length).toBe(201);
	});
});
