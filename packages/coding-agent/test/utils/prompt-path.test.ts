import { describe, expect, it } from "bun:test";
import { normalizePromptPath } from "../../src/utils/prompt-path";

/**
 * normalizePromptPath converts a filesystem path to the forward-slash form used
 * inside prompt text, so a Windows path (backslash separators) reads the same as
 * a POSIX one. It had no test. The regression to lock is that EVERY backslash is
 * replaced, not just the first: a non-global replace would leave deep Windows
 * paths half-converted ("a/b\\c"). Forward slashes must pass through untouched.
 */

describe("normalizePromptPath", () => {
	it("converts every backslash to a forward slash", () => {
		expect(normalizePromptPath("src\\utils\\prompt-path.ts")).toBe("src/utils/prompt-path.ts");
	});

	it("converts a Windows drive-absolute path", () => {
		expect(normalizePromptPath("C:\\Users\\dev\\project")).toBe("C:/Users/dev/project");
	});

	it("leaves an already-POSIX path unchanged", () => {
		expect(normalizePromptPath("src/utils/prompt-path.ts")).toBe("src/utils/prompt-path.ts");
	});

	it("leaves a path with no separators unchanged", () => {
		expect(normalizePromptPath("README.md")).toBe("README.md");
	});

	it("handles a mixed-separator path by normalizing only the backslashes", () => {
		expect(normalizePromptPath("a/b\\c/d\\e")).toBe("a/b/c/d/e");
	});
});
