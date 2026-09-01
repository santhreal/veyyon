/**
 * WHY: on resume the session has no memory, only the entries an earlier run
 * wrote. Where the last checkpoint began and whether a rewind completed are
 * recovered by reading those entries back, so a reader that accepts the wrong
 * entry, or reads the right entry the wrong way, silently reports a rewind that
 * never finished or a checkpoint that never started.
 *
 * The class this closes is the entry-shape space, not one recorded session.
 * Each reader is fed the entry kinds next to it in the log, entries missing
 * each field it depends on, and both spellings of the fields it does have:
 * a rewind report carries its body in structured `details` on new entries and
 * only in rendered content on old ones, and a checkpoint carries `startedAt` in
 * `details` on new entries and only as the entry timestamp on old ones. Reading
 * one spelling and not the other is the defect that survives a single fixture.
 *
 * Own-property reads are pinned too: these entries are parsed from a session
 * file, and `JSON.parse` puts a `__proto__` key on the object as an own
 * property, so a reader that walks the prototype chain answers a missing field
 * with an inherited value.
 *
 * Not covered: writing these entries, and what the session does with the values
 * once it has them. This is the read side only.
 */

import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import {
	checkpointStartedAtFromEntry,
	completedRewindFromEntry,
	isSuccessfulCheckpointEntry,
} from "../../src/session/rewind-checkpoint";
import type { SessionEntry } from "../../src/session/session-entries";

const base = { id: "e1", parentId: null, timestamp: "2024-01-01T00:00:00.000Z" };

const rewindReport = (details: unknown, content: string | { type: "text"; text: string }[] = ""): SessionEntry =>
	({
		...base,
		type: "custom_message",
		customType: "rewind-report",
		content,
		details,
		display: true,
	}) as SessionEntry;

const checkpointResult = (
	overrides: { isError?: boolean; details?: unknown; toolName?: string; timestamp?: string } = {},
): SessionEntry =>
	({
		...base,
		timestamp: overrides.timestamp ?? base.timestamp,
		type: "message",
		message: {
			role: "toolResult",
			toolName: overrides.toolName ?? "checkpoint",
			toolCallId: "c1",
			content: "ok",
			isError: overrides.isError,
			details: overrides.details,
		} as unknown as AgentMessage,
	}) as SessionEntry;

describe("recovering a completed rewind", () => {
	test("a report with both timestamps and a body is a completed rewind", () => {
		expect(
			completedRewindFromEntry(rewindReport({ startedAt: "A", rewoundAt: "B", report: "what changed" })),
		).toEqual({ report: "what changed", startedAt: "A", rewoundAt: "B" });
	});

	test.each([
		["a plain message entry", { ...base, type: "message", message: {} } as unknown as SessionEntry],
		[
			"a custom message of another type",
			{
				...base,
				type: "custom_message",
				customType: "irc",
				content: "hi",
				details: { startedAt: "A", rewoundAt: "B", report: "r" },
				display: true,
			} as unknown as SessionEntry,
		],
		["a report with no details", rewindReport(undefined, "Report:\nbody")],
		["a report whose details are not an object", rewindReport("nope", "\nReport:\nbody")],
		["a report missing startedAt", rewindReport({ rewoundAt: "B", report: "r" })],
		["a report missing rewoundAt", rewindReport({ startedAt: "A", report: "r" })],
		["a report whose timestamps are not strings", rewindReport({ startedAt: 1, rewoundAt: 2 })],
	])("%s yields no completed rewind", (_label, entry) => {
		expect(completedRewindFromEntry(entry)).toBeUndefined();
	});

	test("a report with both timestamps but no body anywhere yields nothing", () => {
		expect(completedRewindFromEntry(rewindReport({ startedAt: "A", rewoundAt: "B" }, ""))).toBeUndefined();
	});

	test("a whitespace-only body counts as no body", () => {
		expect(
			completedRewindFromEntry(rewindReport({ startedAt: "A", rewoundAt: "B", report: "   \n  " }, "   ")),
		).toBeUndefined();
	});

	test("the structured report wins over the rendered content", () => {
		expect(
			completedRewindFromEntry(
				rewindReport({ startedAt: "A", rewoundAt: "B", report: "structured" }, "\nReport:\nrendered"),
			)?.report,
		).toBe("structured");
	});

	test("a blank structured report falls back to the rendered content", () => {
		expect(
			completedRewindFromEntry(
				rewindReport({ startedAt: "A", rewoundAt: "B", report: "   " }, "preamble\nReport:\nrendered"),
			)?.report,
		).toBe("rendered");
	});

	test("content before the marker is preamble and is dropped", () => {
		expect(
			completedRewindFromEntry(rewindReport({ startedAt: "A", rewoundAt: "B" }, "chatter\nReport:\nthe body"))
				?.report,
		).toBe("the body");
	});

	test("the last marker wins when the body quotes an earlier one", () => {
		expect(
			completedRewindFromEntry(
				rewindReport({ startedAt: "A", rewoundAt: "B" }, "a\nReport:\nquoted\nReport:\nreal body"),
			)?.report,
		).toBe("real body");
	});

	test("content with no marker at all is the whole body", () => {
		expect(completedRewindFromEntry(rewindReport({ startedAt: "A", rewoundAt: "B" }, "  just this  "))?.report).toBe(
			"just this",
		);
	});

	test("block content contributes its text parts joined by newline", () => {
		expect(
			completedRewindFromEntry(
				rewindReport({ startedAt: "A", rewoundAt: "B" }, [
					{ type: "text", text: "\nReport:\nline one" },
					{ type: "text", text: "line two" },
				]),
			)?.report,
		).toBe("line one\nline two");
	});

	test("an inherited field never answers for a missing one", () => {
		// What JSON.parse produces for `{"__proto__": {...}}`: an own key, so the
		// object's prototype is untouched and nothing is polluted globally. The
		// reader must still refuse to see startedAt through a prototype.
		const polluted = Object.create({ startedAt: "inherited", rewoundAt: "inherited" }) as object;
		Object.defineProperty(polluted, "report", { value: "body", enumerable: true });
		expect(completedRewindFromEntry(rewindReport(polluted, "body"))).toBeUndefined();
	});
});

describe("recognising a checkpoint entry", () => {
	test("a successful checkpoint result is one", () => {
		expect(isSuccessfulCheckpointEntry(checkpointResult())).toBe(true);
	});

	test("isError false is still a success", () => {
		expect(isSuccessfulCheckpointEntry(checkpointResult({ isError: false }))).toBe(true);
	});

	test("a failed checkpoint is not one", () => {
		expect(isSuccessfulCheckpointEntry(checkpointResult({ isError: true }))).toBe(false);
	});

	test("another tool's result is not one", () => {
		expect(isSuccessfulCheckpointEntry(checkpointResult({ toolName: "bash" }))).toBe(false);
	});

	test("a non-message entry is not one", () => {
		expect(isSuccessfulCheckpointEntry(rewindReport({ startedAt: "A", rewoundAt: "B" }))).toBe(false);
	});
});

describe("recovering when a checkpoint started", () => {
	test("the recorded startedAt is used when present", () => {
		expect(checkpointStartedAtFromEntry(checkpointResult({ details: { startedAt: "T-0" } }))).toBe("T-0");
	});

	test.each([
		["details are absent", undefined],
		["details are not an object", "nope"],
		["details carry no startedAt", { other: 1 }],
		["startedAt is not a string", { startedAt: 5 }],
		["startedAt is empty", { startedAt: "" }],
	])("the entry timestamp is the fallback when %s", (_label, details) => {
		expect(checkpointStartedAtFromEntry(checkpointResult({ details }))).toBe(base.timestamp);
	});

	test("an inherited startedAt does not stand in for a recorded one", () => {
		const polluted = Object.create({ startedAt: "inherited" }) as object;
		expect(checkpointStartedAtFromEntry(checkpointResult({ details: polluted }))).toBe(base.timestamp);
	});

	test.each([
		["a failed checkpoint", checkpointResult({ isError: true, details: { startedAt: "T-0" } })],
		["another tool's result", checkpointResult({ toolName: "bash", details: { startedAt: "T-0" } })],
		["a rewind report", rewindReport({ startedAt: "T-0", rewoundAt: "B" }, "body")],
	])("%s has no checkpoint start", (_label, entry) => {
		expect(checkpointStartedAtFromEntry(entry)).toBeUndefined();
	});
});
