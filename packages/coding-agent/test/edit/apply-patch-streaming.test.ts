import { describe, expect, it } from "bun:test";
import { parseApplyPatchStreaming } from "../../src/edit/apply-patch/parser";

/**
 * parseApplyPatchStreaming is the best-effort parser used to PREVIEW an apply_patch
 * envelope while the model is still streaming it. Unlike the strict parseApplyPatch (which
 * throws on any malformed envelope), the streaming variant must degrade gracefully so a
 * half-written patch renders a partial preview instead of blowing up the TUI. The strict
 * parser is well tested; this lenient path was not. Its tolerances are pinned here so a
 * regression that makes it throw (or silently swallow a complete hunk) is caught:
 *   - missing `*** Begin Patch` first line yields [] rather than an error;
 *   - a missing `*** End Patch` trailer is accepted and the body still parses;
 *   - an Add File with only some of its `+` lines so far yields those lines;
 *   - an Update File with an empty body yields an empty-diff update (strict would throw);
 *   - a `*** Move to:` line becomes the update's rename target;
 *   - an incomplete trailing hunk header stops parsing but keeps the hunks already seen.
 */

describe("parseApplyPatchStreaming", () => {
	it("returns an empty list when the Begin Patch marker is absent", () => {
		expect(parseApplyPatchStreaming("just some text\nnot a patch")).toEqual([]);
		expect(parseApplyPatchStreaming("")).toEqual([]);
	});

	it("parses a complete Add File even without the End Patch trailer", () => {
		expect(parseApplyPatchStreaming("*** Begin Patch\n*** Add File: a.txt\n+hello\n+world")).toEqual([
			{ path: "a.txt", op: "create", diff: "hello\nworld\n" },
		]);
	});

	it("accepts a partially-streamed Add File body", () => {
		expect(parseApplyPatchStreaming("*** Begin Patch\n*** Add File: a.txt\n+x")).toEqual([
			{ path: "a.txt", op: "create", diff: "x\n" },
		]);
	});

	it("yields an empty-diff update for an Update File with no body yet", () => {
		expect(parseApplyPatchStreaming("*** Begin Patch\n*** Update File: b.txt\n*** End Patch")).toEqual([
			{ path: "b.txt", op: "update", rename: undefined, diff: "" },
		]);
	});

	it("captures a Move to line as the update rename target", () => {
		expect(
			parseApplyPatchStreaming(
				"*** Begin Patch\n*** Update File: b.txt\n*** Move to: c.txt\n@@\n-old\n+new\n*** End Patch",
			),
		).toEqual([{ path: "b.txt", op: "update", rename: "c.txt", diff: "@@\n-old\n+new" }]);
	});

	it("parses a Delete File hunk", () => {
		expect(parseApplyPatchStreaming("*** Begin Patch\n*** Delete File: d.txt\n*** End Patch")).toEqual([
			{ path: "d.txt", op: "delete" },
		]);
	});

	it("stops at an incomplete trailing hunk header but keeps the completed hunks", () => {
		expect(parseApplyPatchStreaming("*** Begin Patch\n*** Add File: a.txt\n+x\n*** Upda")).toEqual([
			{ path: "a.txt", op: "create", diff: "x\n" },
		]);
	});
});
