import { describe, expect, it } from "bun:test";
import { formatApplyCodexPatchSummary } from "@veyyon/coding-agent/edit";

/**
 * formatApplyCodexPatchSummary renders the §9.1 apply_patch success summary the agent sees after a
 * multi-file Codex patch applies: a fixed header followed by one status line per affected file,
 * prefixed `A ` (added), `M ` (modified), `D ` (deleted). It had no direct test. The contracts pinned
 * here are the ones the agent loop's success parsing relies on:
 *   - the header text is exact and always present, even when no files were touched;
 *   - the operation ordering is added -> modified -> deleted (not input/interleaved order), because a
 *     rename is reported under `modified` and the grouped order is the documented contract;
 *   - each group preserves the order of paths within it and each path gets exactly one prefixed line.
 * A regression in the prefix letters or the header would make a successful apply look like a different
 * (or failed) operation to any consumer that reads this text.
 */
describe("formatApplyCodexPatchSummary", () => {
	it("returns only the header when no files were affected", () => {
		expect(formatApplyCodexPatchSummary({ added: [], modified: [], deleted: [] })).toBe(
			"Success. Updated the following files:",
		);
	});

	it("groups files as added, then modified, then deleted, each with its status prefix", () => {
		expect(formatApplyCodexPatchSummary({ added: ["a.ts"], modified: ["b.ts"], deleted: ["c.ts"] })).toBe(
			["Success. Updated the following files:", "A a.ts", "M b.ts", "D c.ts"].join("\n"),
		);
	});

	it("preserves within-group order and emits one prefixed line per path", () => {
		expect(formatApplyCodexPatchSummary({ added: ["x", "y"], modified: ["m"], deleted: [] })).toBe(
			["Success. Updated the following files:", "A x", "A y", "M m"].join("\n"),
		);
	});
});
