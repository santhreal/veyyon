import { describe, expect, it } from "bun:test";
import { createFileRecorder, formatResultPath } from "@veyyon/coding-agent/tools/file-recorder";

/**
 * createFileRecorder collects the paths a tool touched (deduplicated, insertion-ordered)
 * and formatResultPath turns a raw result path into the operator-facing display path.
 * Neither was tested. The display rules have branch asymmetries worth locking: a leading
 * slash is stripped before resolving, a DIRECTORY result resolves basePath + the cleaned
 * path while a FILE result formats basePath alone (its filePath argument is unused), and
 * a path inside cwd becomes relative while one outside cwd stays absolute. A regression
 * would surface confusing absolute paths inside the repo, or paths escaping the display
 * root.
 */

describe("createFileRecorder", () => {
	it("preserves insertion order and ignores duplicates", () => {
		const recorder = createFileRecorder();
		recorder.record("a.ts");
		recorder.record("b.ts");
		recorder.record("a.ts");
		recorder.record("c.ts");
		recorder.record("b.ts");
		expect(recorder.list).toEqual(["a.ts", "b.ts", "c.ts"]);
	});

	it("starts empty", () => {
		expect(createFileRecorder().list).toEqual([]);
	});
});

describe("formatResultPath directories", () => {
	it("resolves basePath + the cleaned path relative to cwd", () => {
		expect(formatResultPath("sub/child", true, "/home/x/proj", "/home/x/proj")).toBe("sub/child");
	});

	it("strips a single leading slash before resolving", () => {
		expect(formatResultPath("/sub/child", true, "/home/x/proj", "/home/x/proj")).toBe("sub/child");
	});

	it("keeps a directory outside cwd absolute", () => {
		expect(formatResultPath("sub", true, "/other/place", "/home/x/proj")).toBe("/other/place/sub");
	});
});

describe("formatResultPath files", () => {
	it("formats basePath alone (ignoring the filePath argument) when inside cwd", () => {
		expect(formatResultPath("ignored", false, "/home/x/proj/file.ts", "/home/x/proj")).toBe("file.ts");
	});

	it("keeps a file outside cwd absolute", () => {
		expect(formatResultPath("x", false, "/other/place/f.ts", "/home/x/proj")).toBe("/other/place/f.ts");
	});
});
