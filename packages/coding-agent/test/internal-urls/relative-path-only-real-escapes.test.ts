/**
 * validateRelativePath is the only check between an internal URL path and the
 * filesystem. The scheme argument is the name in the error. Real hops (`..`
 * components, drive letters, backslash hops) are refused. `foo/../bar`
 * collapses to `bar`. Filename bytes that merely contain `..` are not hops.
 */
import { describe, expect, it } from "bun:test";
import { validateRelativePath } from "@veyyon/coding-agent/internal-urls/relative-path";

function thrown(pathText: string, scheme = "vault"): string {
	try {
		validateRelativePath(pathText, scheme);
		return "";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

describe("the error names the scheme that was asked, not skill:// by default", () => {
	it("names vault, memory, or the skill:// default", () => {
		expect(thrown("/etc/passwd", "vault")).toBe("Absolute paths are not allowed in vault:// URLs");
		expect(thrown("../x", "vault")).toBe("Path traversal (..) is not allowed in vault:// URLs");
		expect(thrown("../x", "memory")).toBe("Path traversal (..) is not allowed in memory:// URLs");
		expect(() => validateRelativePath("../x")).toThrow("Path traversal (..) is not allowed in skill:// URLs");
	});
});

describe("real escapes are refused; collapsed hops stay inside the root", () => {
	it("refuses POSIX absolute, leftover `..`, backslash hops, and a drive prefix", () => {
		expect(() => validateRelativePath("/etc/passwd", "vault")).toThrow(/Absolute paths/);
		expect(() => validateRelativePath("../x", "vault")).toThrow(/traversal/i);
		expect(() => validateRelativePath("nested/../../escape.md", "vault")).toThrow(/traversal/i);
		expect(() => validateRelativePath("..", "vault")).toThrow(/traversal/i);
		expect(() => validateRelativePath("foo\\..\\bar", "vault")).toThrow(/traversal/i);
		expect(() => validateRelativePath("C:\\Windows", "vault")).toThrow(/Absolute paths|traversal/i);
	});

	it("allows a collapse to a root-relative leaf, and `..` as filename bytes", () => {
		expect(() => validateRelativePath("foo/../bar", "vault")).not.toThrow();
		expect(() => validateRelativePath("foo/bar/..", "vault")).not.toThrow();
		expect(() => validateRelativePath("ok/file.md", "vault")).not.toThrow();
		expect(() => validateRelativePath("..foo", "vault")).not.toThrow();
		expect(() => validateRelativePath("foo/..bar", "vault")).not.toThrow();
		expect(() => validateRelativePath("foo/.../bar", "vault")).not.toThrow();
	});
});
