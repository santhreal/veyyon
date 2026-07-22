import { afterAll, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import {
	invalidateFsScanAfterDelete,
	invalidateFsScanAfterRename,
	invalidateFsScanAfterWrite,
} from "@veyyon/coding-agent/tools/fs-cache-invalidation";
import * as natives from "@veyyon/natives";

/**
 * Records which paths fs-cache invalidation hits. Spy invalidateFsScanCache
 * (NOT mock.module on the whole natives package) so later suites still see
 * real natives — mock.module is process-global
 * (FINDING-FULL-SUITE-ORDER-DEPENDENT-POLLUTION).
 */

const calls: string[] = [];
let invalidateSpy: ReturnType<typeof spyOn> | undefined;

beforeAll(() => {
	invalidateSpy = spyOn(natives, "invalidateFsScanCache").mockImplementation((path: string) => {
		calls.push(path);
	});
});

afterAll(() => {
	invalidateSpy?.mockRestore();
	invalidateSpy = undefined;
	mock.restore();
});

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
		invalidateFsScanAfterRename("/repo/same.ts", "/repo/same.ts");
		expect(calls).toEqual(["/repo/same.ts"]);
	});
});
