/**
 * WHY: `toAcpLocationPath` resolved a tool-call path against cwd and nothing
 * else, so a read of `src/foo.ts:50-200` reached the ACP client as
 * `ToolCallLocation.path = "<cwd>/src/foo.ts:50-200"`. A client that follows a
 * location (Zed, or VSCode over ACP) then navigates to a file whose name ends
 * in a colon and a line range, which does not exist, and offers to create it.
 *
 * The class this closes is a read selector surviving into a field typed as a
 * filesystem path. `toAcpLocationPath` is the single choke point every ACP
 * location passes through — the args extractor, the result-details extractor
 * and the per-file-results loop all call it — so the suite asserts the
 * invariant there and sweeps the selector grammar the read tool documents
 * rather than pinning the one form from the report.
 *
 * What it does not catch: a selector reaching a different ACP field (diff
 * `path`, tool titles), and a client that mishandles a correct location.
 */

import { describe, expect, it } from "bun:test";
import { mapAgentSessionEventToAcpSessionUpdates } from "@veyyon/coding-agent/modes/acp/acp-event-mapper";
import type { AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session";

const CWD = "/repo";

function locationsForReadOf(rawPath: string): string[] {
	const updates = mapAgentSessionEventToAcpSessionUpdates(
		{
			type: "tool_execution_start",
			toolCallId: "tc-read",
			toolName: "read",
			args: { path: rawPath },
		} as AgentSessionEvent,
		"session-1",
		{ cwd: CWD },
	);
	const update = updates[0]?.update as { locations?: { path: string }[] } | undefined;
	return (update?.locations ?? []).map(location => location.path);
}

/**
 * Every selector form `read` documents, paired with the path that must reach
 * the client. Sweeping the grammar rather than one example is what makes a
 * newly supported selector shape fail here instead of leaking silently.
 */
const SELECTOR_FORMS: Record<string, string> = {
	"src/foo.ts:50": "/repo/src/foo.ts",
	"src/foo.ts:50-": "/repo/src/foo.ts",
	"src/foo.ts:50-200": "/repo/src/foo.ts",
	"src/foo.ts:50+150": "/repo/src/foo.ts",
	"src/foo.ts:20+1": "/repo/src/foo.ts",
	"src/foo.ts:5-16,960-973": "/repo/src/foo.ts",
	"src/foo.ts:raw": "/repo/src/foo.ts",
	"src/foo.ts:raw:2-4": "/repo/src/foo.ts",
	"src/foo.ts:2-4:raw": "/repo/src/foo.ts",
	"src/foo.ts:conflicts": "/repo/src/foo.ts",
};

describe("an ACP location names a file, not a line range", () => {
	for (const [raw, expected] of Object.entries(SELECTOR_FORMS)) {
		it(`peels the selector from ${raw}`, () => {
			expect(locationsForReadOf(raw)).toEqual([expected]);
		});
	}

	it("leaves a path carrying no selector untouched", () => {
		expect(locationsForReadOf("src/foo.ts")).toEqual(["/repo/src/foo.ts"]);
	});

	it("keeps an absolute path absolute", () => {
		expect(locationsForReadOf("/elsewhere/foo.ts:10-20")).toEqual(["/elsewhere/foo.ts"]);
	});

	it("keeps a colon that is part of the filename", () => {
		// The strict grammar is what makes this safe: `notes` is not a selector,
		// so a legal POSIX filename survives instead of being truncated.
		expect(locationsForReadOf("src/weird:notes.ts")).toEqual(["/repo/src/weird:notes.ts"]);
	});

	it("peels the selector from an edit result's per-file paths", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-edit",
				toolName: "edit",
				isError: false,
				result: {
					content: [{ type: "text", text: "applied" }],
					details: {
						perFileResults: [{ path: "a.ts:1-5" }, { path: "b.ts:raw" }],
					},
				},
			} as AgentSessionEvent,
			"session-1",
			{ cwd: CWD },
		);
		const update = updates[0]?.update as { locations?: { path: string }[] };
		expect(update.locations).toEqual([{ path: "/repo/a.ts" }, { path: "/repo/b.ts" }]);
	});

	it("collapses two selector views of one file into a single location", () => {
		// Both reads name the same file, so an editor should be pointed at it once.
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-edit-dupe",
				toolName: "edit",
				isError: false,
				result: {
					content: [{ type: "text", text: "applied" }],
					details: {
						perFileResults: [{ path: "same.ts:1-5" }, { path: "same.ts:90-95" }],
					},
				},
			} as AgentSessionEvent,
			"session-1",
			{ cwd: CWD },
		);
		const update = updates[0]?.update as { locations?: { path: string }[] };
		expect(update.locations).toEqual([{ path: "/repo/same.ts" }]);
	});

	it("still peels the selector when no cwd is supplied", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "tc-nocwd",
				toolName: "read",
				args: { path: "src/foo.ts:50-200" },
			} as AgentSessionEvent,
			"session-1",
		);
		const update = updates[0]?.update as { locations?: { path: string }[] };
		expect(update.locations).toEqual([{ path: "src/foo.ts" }]);
	});
});
