import { describe, expect, it } from "bun:test";
import {
	type ApplyPatchEntry,
	expandApplyPatchToEntries,
	expandApplyPatchToPreviewEntries,
} from "@veyyon/coding-agent/edit/modes/apply-patch";

/**
 * The `apply_patch` edit mode accepts one Codex-style `*** Begin Patch ... *** End
 * Patch` envelope and lowers each file hunk to a PatchEditEntry that the shared
 * executePatchSingle machinery applies. These two expansion functions are that lowering
 * step, and they were untested. Two contracts matter and are pinned here:
 *
 *  - Each envelope operation maps to the right entry: Add File -> create (with the `+`
 *    prefixes stripped and a trailing newline), Update File -> update (diff keeps the
 *    `@@` hunk header), Move to -> update + rename, Delete File -> delete, and multiple
 *    file sections expand to one entry each in order.
 *  - The final-apply path (expandApplyPatchToEntries) THROWS "No files were modified."
 *    on an empty envelope so a no-op patch is a loud error, while the streaming preview
 *    path (expandApplyPatchToPreviewEntries) tolerates an incomplete envelope and
 *    returns [] so a half-typed patch renders a clean (empty) live preview instead of
 *    throwing on every keystroke.
 */

const one = (input: string): ApplyPatchEntry => {
	const entries = expandApplyPatchToEntries({ input });
	expect(entries).toHaveLength(1);
	return entries[0]!;
};

describe("expandApplyPatchToEntries operations", () => {
	it("lowers an Add File section to a create entry with a trailing newline", () => {
		expect(one("*** Begin Patch\n*** Add File: foo.txt\n+hello\n+world\n*** End Patch")).toEqual({
			path: "foo.txt",
			op: "create",
			diff: "hello\nworld\n",
		});
	});

	it("lowers an Update File section to an update entry keeping the hunk header", () => {
		expect(one("*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch")).toEqual({
			path: "a.txt",
			op: "update",
			diff: "@@\n-old\n+new",
		});
	});

	it("carries a Move to line as a rename on the update entry", () => {
		expect(one("*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n@@\n-old\n+new\n*** End Patch")).toEqual(
			{
				path: "a.txt",
				op: "update",
				rename: "b.txt",
				diff: "@@\n-old\n+new",
			},
		);
	});

	it("lowers a Delete File section to a delete entry", () => {
		expect(one("*** Begin Patch\n*** Delete File: gone.txt\n*** End Patch")).toEqual({
			path: "gone.txt",
			op: "delete",
		});
	});

	it("expands multiple file sections to one entry each, in order", () => {
		expect(
			expandApplyPatchToEntries({
				input: "*** Begin Patch\n*** Add File: one.txt\n+1\n*** Add File: two.txt\n+2\n*** End Patch",
			}),
		).toEqual([
			{ path: "one.txt", op: "create", diff: "1\n" },
			{ path: "two.txt", op: "create", diff: "2\n" },
		]);
	});

	it("throws when the envelope modifies no files", () => {
		expect(() => expandApplyPatchToEntries({ input: "*** Begin Patch\n*** End Patch" })).toThrow(
			"No files were modified.",
		);
	});
});

describe("expandApplyPatchToPreviewEntries streaming tolerance", () => {
	it("expands a complete envelope the same way as the final path", () => {
		expect(
			expandApplyPatchToPreviewEntries({
				input: "*** Begin Patch\n*** Add File: foo.txt\n+hello\n+world\n*** End Patch",
			}),
		).toEqual([{ path: "foo.txt", op: "create", diff: "hello\nworld\n" }]);
	});

	it("returns [] for an incomplete envelope instead of throwing", () => {
		expect(expandApplyPatchToPreviewEntries({ input: "*** Begin Patch" })).toEqual([]);
	});
});
