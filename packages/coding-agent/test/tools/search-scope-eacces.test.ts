/**
 * resolveToolSearchScope does not mask permission errors as "Path not found".
 *
 * The bug this suite locks out (HUNT2-errdir-search-scope-eacces-as-notfound,
 * found 2026-07-22): the final existence probe wrapped `Bun.file(searchPath)
 * .stat()` in a bare `catch { throw new ToolError("Path not found: ...") }`,
 * mapping EVERY stat failure — EACCES on a parent dir without +x, EIO, ELOOP —
 * to "Path not found". That contradicts the module's own convention (only
 * ENOENT/ENOTDIR mean missing; everything else propagates, partitionExistingPaths
 * at :1105) and sends the operator hunting for a path that actually exists but is
 * unreadable. The fix rethrows any non-ENOENT/ENOTDIR error unchanged.
 *
 * A genuinely missing path must still produce the clean "Path not found" message.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveToolSearchScope } from "@veyyon/coding-agent/tools/path-utils";
import { removeWithRetries } from "@veyyon/utils";

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe("resolveToolSearchScope error mapping", () => {
	it("reports a genuinely missing path as Path not found", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "scope-missing-"));
		try {
			await expect(
				resolveToolSearchScope({
					rawPaths: [path.join(tempDir, "does-not-exist.ts")],
					cwd: tempDir,
					internalUrlAction: "search",
				}),
			).rejects.toThrow(/Path not found/);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	// Root ignores directory permission bits, so EACCES cannot be provoked there;
	// the probe would see ENOENT instead. Skip rather than assert a false contract.
	it.skipIf(isRoot)("propagates a permission error instead of masking it as Path not found", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "scope-eacces-"));
		const locked = path.join(tempDir, "locked");
		await fs.mkdir(locked);
		// A child of a directory with no execute/search bit cannot be stat'd: the
		// kernel returns EACCES (not ENOENT — the entry may well exist).
		await fs.chmod(locked, 0o000);
		try {
			let caught: unknown;
			try {
				await resolveToolSearchScope({
					rawPaths: [path.join(locked, "child.ts")],
					cwd: tempDir,
					internalUrlAction: "search",
				});
			} catch (err) {
				caught = err;
			}
			expect(caught).toBeDefined();
			// The error is NOT the masked "Path not found" — the real EACCES surfaces.
			expect(String((caught as Error).message)).not.toContain("Path not found");
		} finally {
			await fs.chmod(locked, 0o755).catch(() => {});
			await removeWithRetries(tempDir);
		}
	});
});
