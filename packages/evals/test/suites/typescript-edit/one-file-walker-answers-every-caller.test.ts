/**
 * WHY:
 * `listFiles` in `src/core/fs-walk.ts` is the single owner of recursive directory listing for
 * every suite, so a caller never writes a second walk that sorts differently or throws on a
 * dangling symlink. This suite pins alphabetical order, resolved file symlinks, and skipped
 * dangling symlinks.
 *
 * What it does not catch: a caller that walks a tree without going through `listFiles`.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";
import { listFiles } from "../../../src/core/fs-walk";

describe("one file walker answers every caller", () => {
	it("recursively lists files in alphabetical order", async () => {
		const tempDir = await TempDir.create("@evals-listfiles-");
		try {
			await fs.mkdir(path.join(tempDir.path(), "sub1", "nested"), { recursive: true });
			await fs.mkdir(path.join(tempDir.path(), "sub2"), { recursive: true });

			await fs.writeFile(path.join(tempDir.path(), "z-root.ts"), "content");
			await fs.writeFile(path.join(tempDir.path(), "a-root.ts"), "content");
			await fs.writeFile(path.join(tempDir.path(), "sub1", "nested", "deep.ts"), "content");
			await fs.writeFile(path.join(tempDir.path(), "sub2", "file.ts"), "content");

			const files = await listFiles(tempDir.path());
			expect(files).toEqual(["a-root.ts", "sub1/nested/deep.ts", "sub2/file.ts", "z-root.ts"]);
		} finally {
			await tempDir.remove();
		}
	});

	it("includes valid symlinks pointing to files and skips dangling symlinks", async () => {
		const tempDir = await TempDir.create("@evals-symlink-");
		try {
			const realFile = path.join(tempDir.path(), "real.ts");
			await fs.writeFile(realFile, "export const x = 1;\n");

			// Valid symlink to a file
			const validLink = path.join(tempDir.path(), "link-to-real.ts");
			await fs.symlink(realFile, validLink);

			// Dangling symlink to a non-existent target
			const danglingLink = path.join(tempDir.path(), "dangling-link.ts");
			await fs.symlink(path.join(tempDir.path(), "does-not-exist.ts"), danglingLink);

			const files = await listFiles(tempDir.path());
			expect(files).toContain("real.ts");
			expect(files).toContain("link-to-real.ts");
			expect(files).not.toContain("dangling-link.ts");
		} finally {
			await tempDir.remove();
		}
	});
});
