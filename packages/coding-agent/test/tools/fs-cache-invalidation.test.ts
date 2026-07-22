import { beforeEach, describe, expect, it, mock } from "bun:test";

/**
 * The fs-cache-invalidation helpers bust the shared native filesystem scan cache
 * after a write, delete, or rename. They had no test. The only branch worth
 * defending is rename: it must invalidate BOTH the old and new path so stale
 * watchers on either end are cleared, but it must NOT redundantly invalidate
 * twice when the two paths are identical (a no-op move). We mock @veyyon/natives
 * to record exactly which paths were invalidated and in what order.
 */

const calls: string[] = [];
mock.module("@veyyon/natives", () => ({
	invalidateFsScanCache: (path: string) => {
		calls.push(path);
	},
}));

const { invalidateFsScanAfterWrite, invalidateFsScanAfterDelete, invalidateFsScanAfterRename } = await import(
	"@veyyon/coding-agent/tools/fs-cache-invalidation"
);

beforeEach(() => {
	calls.length = 0;
});

describe("fs-cache invalidation", () => {
	it("invalidates the written path once", () => {
		invalidateFsScanAfterWrite("/repo/a.ts");
		expect(calls).toEqual(["/repo/a.ts"]);
	});

	it("invalidates the deleted path once", () => {
		invalidateFsScanAfterDelete("/repo/gone.ts");
		expect(calls).toEqual(["/repo/gone.ts"]);
	});

	it("invalidates both endpoints of a rename, old path first", () => {
		invalidateFsScanAfterRename("/repo/old.ts", "/repo/new.ts");
		expect(calls).toEqual(["/repo/old.ts", "/repo/new.ts"]);
	});

	it("invalidates only once when the rename endpoints are identical", () => {
		// A no-op move must not do the redundant second invalidation.
		invalidateFsScanAfterRename("/repo/same.ts", "/repo/same.ts");
		expect(calls).toEqual(["/repo/same.ts"]);
	});
});
