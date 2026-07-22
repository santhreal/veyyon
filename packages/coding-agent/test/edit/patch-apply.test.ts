import { describe, expect, it } from "bun:test";
import { applyPatch, type FileSystem, type PatchInput, previewPatch } from "@veyyon/coding-agent/edit/modes/patch";

/**
 * applyPatch is the operator path for the `patch` edit mode: it creates, deletes,
 * updates, and moves files by applying diff hunks. Despite being the most
 * consequential write path in the tool (a wrong match silently corrupts a file), the
 * public entry point had no dedicated end-to-end suite. Because ApplyPatchOptions.fs
 * is injectable, these drive the REAL applyPatch through an in-memory filesystem and
 * assert both the resulting bytes and the safety guards that stop a patch from
 * clobbering data it should not touch:
 *
 *  - create writes exactly the content (with a trailing newline) and, per the
 *    apply_patch envelope, refuses to overwrite an existing file UNLESS the JSON
 *    patch mode opts in via allowCreateOverwrite.
 *  - update replaces the matched hunk, preserves the file's line ending (CRLF) and
 *    its trailing-newline state, and REFUSES an ambiguous match (same line twice, no
 *    context) rather than editing the wrong occurrence.
 *  - delete returns the old content and removes the file; a missing file is a clean
 *    "File not found" error, not a crash.
 *  - a rename (move) writes the destination and removes the source, but refuses to
 *    overwrite an existing destination or to rename a file onto itself.
 *  - previewPatch (dryRun) computes the new content WITHOUT mutating the filesystem.
 */

const CWD = "/w";

/** Minimal in-memory FileSystem so the real applyPatch runs with no disk I/O. */
function memFs(initial: Record<string, string> = {}): { files: Map<string, string>; fs: FileSystem } {
	const files = new Map<string, string>(Object.entries(initial));
	const fs: FileSystem = {
		async exists(p) {
			return files.has(p);
		},
		async read(p) {
			const value = files.get(p);
			if (value === undefined) throw new Error(`File not found: ${p}`);
			return value;
		},
		async write(p, content) {
			files.set(p, content);
		},
		async delete(p) {
			files.delete(p);
		},
		async mkdir() {},
	};
	return { files, fs };
}

const expectThrows = async (fn: () => Promise<unknown>): Promise<string> => {
	try {
		await fn();
		return "__did_not_throw__";
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
};

const update = (path: string, diff: string, rename?: string): PatchInput => ({ path, op: "update", diff, rename });

describe("applyPatch create", () => {
	it("writes the content with a trailing newline and reports the change", async () => {
		const { files, fs } = memFs();
		const result = await applyPatch({ path: "a.txt", op: "create", diff: "hello\nworld" }, { cwd: CWD, fs });
		expect(files.get("/w/a.txt")).toBe("hello\nworld\n");
		expect(result.change.type).toBe("create");
		expect(result.change.newContent).toBe("hello\nworld\n");
	});

	it("refuses to overwrite an existing file by default", async () => {
		const { files, fs } = memFs({ "/w/a.txt": "original\n" });
		const message = await expectThrows(() =>
			applyPatch({ path: "a.txt", op: "create", diff: "new" }, { cwd: CWD, fs }),
		);
		expect(message).toBe("Cannot create a.txt: file already exists. Use *** Update File to modify it in place.");
		expect(files.get("/w/a.txt")).toBe("original\n");
	});

	it("overwrites an existing file only when allowCreateOverwrite is set", async () => {
		const { files, fs } = memFs({ "/w/a.txt": "original\n" });
		await applyPatch({ path: "a.txt", op: "create", diff: "new" }, { cwd: CWD, fs, allowCreateOverwrite: true });
		expect(files.get("/w/a.txt")).toBe("new\n");
	});

	it("rejects a create with no diff content", async () => {
		const { fs } = memFs();
		expect(await expectThrows(() => applyPatch({ path: "a.txt", op: "create" }, { cwd: CWD, fs }))).toBe(
			"Create operation requires diff (file content)",
		);
	});
});

describe("applyPatch update", () => {
	it("replaces the matched line and returns old and new content", async () => {
		const { files, fs } = memFs({ "/w/a.txt": "line1\nline2\nline3\n" });
		const result = await applyPatch(update("a.txt", "-line2\n+CHANGED\n"), { cwd: CWD, fs });
		expect(files.get("/w/a.txt")).toBe("line1\nCHANGED\nline3\n");
		expect(result.change.oldContent).toBe("line1\nline2\nline3\n");
		expect(result.change.newContent).toBe("line1\nCHANGED\nline3\n");
	});

	it("preserves CRLF line endings", async () => {
		const { files, fs } = memFs({ "/w/a.txt": "foo\r\nbar\r\n" });
		await applyPatch(update("a.txt", "-foo\n+FOO\n"), { cwd: CWD, fs });
		expect(files.get("/w/a.txt")).toBe("FOO\r\nbar\r\n");
	});

	it("preserves the absence of a trailing newline", async () => {
		const { files, fs } = memFs({ "/w/a.txt": "foo\nbar" });
		await applyPatch(update("a.txt", "-bar\n+BAR\n"), { cwd: CWD, fs });
		expect(files.get("/w/a.txt")).toBe("foo\nBAR");
	});

	it("refuses an ambiguous match rather than editing the wrong occurrence", async () => {
		const { files, fs } = memFs({ "/w/a.txt": "dup\nmid\ndup\n" });
		const message = await expectThrows(() => applyPatch(update("a.txt", "-dup\n+X\n"), { cwd: CWD, fs }));
		expect(message).toContain("Found 2 occurrences in a.txt");
		expect(files.get("/w/a.txt")).toBe("dup\nmid\ndup\n");
	});

	it("reports a missing file as File not found and rejects a missing diff", async () => {
		expect(await expectThrows(() => applyPatch(update("gone.txt", "-a\n+b\n"), { cwd: CWD, fs: memFs().fs }))).toBe(
			"File not found: gone.txt",
		);
		const { fs } = memFs({ "/w/a.txt": "x\n" });
		expect(await expectThrows(() => applyPatch({ path: "a.txt", op: "update" }, { cwd: CWD, fs }))).toBe(
			"Update operation requires diff (hunks)",
		);
	});
});

describe("applyPatch delete", () => {
	it("removes the file and returns its old content", async () => {
		const { files, fs } = memFs({ "/w/a.txt": "bye\n" });
		const result = await applyPatch({ path: "a.txt", op: "delete" }, { cwd: CWD, fs });
		expect(files.has("/w/a.txt")).toBe(false);
		expect(result.change.oldContent).toBe("bye\n");
	});

	it("reports a missing file as File not found", async () => {
		expect(
			await expectThrows(() => applyPatch({ path: "gone.txt", op: "delete" }, { cwd: CWD, fs: memFs().fs })),
		).toBe("File not found: gone.txt");
	});
});

describe("applyPatch rename (move)", () => {
	it("writes the destination, removes the source, and sets newPath", async () => {
		const { files, fs } = memFs({ "/w/a.txt": "foo\nbar\n" });
		const result = await applyPatch(update("a.txt", "-foo\n+FOO\n", "b.txt"), { cwd: CWD, fs });
		expect(files.has("/w/a.txt")).toBe(false);
		expect(files.get("/w/b.txt")).toBe("FOO\nbar\n");
		expect(result.change.newPath).toBe("/w/b.txt");
	});

	it("refuses to overwrite an existing destination", async () => {
		const { files, fs } = memFs({ "/w/a.txt": "foo\n", "/w/b.txt": "existing\n" });
		const message = await expectThrows(() => applyPatch(update("a.txt", "-foo\n+F\n", "b.txt"), { cwd: CWD, fs }));
		expect(message).toBe("Cannot rename a.txt to b.txt: destination already exists.");
		expect(files.get("/w/a.txt")).toBe("foo\n");
		expect(files.get("/w/b.txt")).toBe("existing\n");
	});

	it("refuses to rename a file onto itself", async () => {
		const { fs } = memFs({ "/w/a.txt": "foo\n" });
		expect(await expectThrows(() => applyPatch(update("a.txt", "-foo\n+F\n", "a.txt"), { cwd: CWD, fs }))).toBe(
			"rename path is the same as source path",
		);
	});
});

describe("previewPatch", () => {
	it("computes the new content without mutating the filesystem", async () => {
		const { files, fs } = memFs({ "/w/a.txt": "foo\nbar\n" });
		const result = await previewPatch(update("a.txt", "-foo\n+FOO\n"), { cwd: CWD, fs });
		expect(result.change.newContent).toBe("FOO\nbar\n");
		expect(files.get("/w/a.txt")).toBe("foo\nbar\n");
	});
});
