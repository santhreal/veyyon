/**
 * validateRelativePath is the only check between an internal URL path and the
 * filesystem for skill://, local://, memory:// and vault://. It used to live in
 * the skill handler, so a rejected vault URL said skill:// in the message.
 * The scheme argument is now the name in the error; that part is the fix.
 *
 * THE CHECK. Absolute paths are refused with path.isAbsolute. Everything else
 * is path.normalize'd, then refused if the result startsWith("..") or
 * includes("/../") or includes("/..").
 *
 * That last predicate is not "the normalized path escapes the root". It is
 * "the bytes slash-dot-dot appear anywhere". A legal relative name whose
 * last component starts with .. (foo/..bar, foo/.../bar, ..foo) is therefore
 * refused as traversal. path.normalize does not rewrite those names: they are
 * not .. components.
 *
 * Meanwhile a real Windows-style traversal (foo\\..\\bar) is allowed on
 * POSIX, because path.normalize does not treat backslash as a separator here,
 * and includes("/..") does not see backslashes. C:\\Windows is also not
 * path.isAbsolute on Linux, so a vault URL carrying a drive path is a
 * relative leaf.
 *
 * foo/../bar is allowed: normalize collapses it to bar, which is inside the
 * root. That is POSIX path identity, not a hole.
 *
 * The over-refusals and the backslash miss stay red until the check is
 * "normalized path is inside the root", not a substring hunt for ...
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
	it("says vault:// when the caller passed vault", () => {
		expect(thrown("/etc/passwd", "vault")).toBe("Absolute paths are not allowed in vault:// URLs");
		expect(thrown("../x", "vault")).toBe("Path traversal (..) is not allowed in vault:// URLs");
	});

	it("says memory:// when the caller passed memory", () => {
		expect(thrown("../x", "memory")).toBe("Path traversal (..) is not allowed in memory:// URLs");
	});

	it("still says skill:// when the caller omitted the scheme", () => {
		expect(() => validateRelativePath("../x")).toThrow("Path traversal (..) is not allowed in skill:// URLs");
	});
});

describe("real escapes are refused", () => {
	it("refuses a POSIX absolute path", () => {
		expect(() => validateRelativePath("/etc/passwd", "vault")).toThrow(/Absolute paths/);
	});

	it("refuses a path whose normalize still starts with ..", () => {
		expect(() => validateRelativePath("../x", "vault")).toThrow(/traversal/i);
		expect(() => validateRelativePath("nested/../../escape.md", "vault")).toThrow(/traversal/i);
		expect(() => validateRelativePath("..", "vault")).toThrow(/traversal/i);
	});

	it("allows foo/../bar because normalize collapses it to bar, which is inside the root", () => {
		expect(() => validateRelativePath("foo/../bar", "vault")).not.toThrow();
		expect(() => validateRelativePath("foo/bar/..", "vault")).not.toThrow();
		expect(() => validateRelativePath("foo/..", "vault")).not.toThrow();
	});

	it("allows an ordinary relative leaf", () => {
		expect(() => validateRelativePath("ok/file.md", "vault")).not.toThrow();
		expect(() => validateRelativePath("foo/bar../baz", "vault")).not.toThrow();
	});
});

describe("a name that contains .. as filename bytes is not traversal", () => {
	it("allows ..foo, a legal relative filename that merely begins with two dots", () => {
		expect(() => validateRelativePath("..foo", "vault")).not.toThrow();
	});

	it("allows foo/..bar, whose normalize is still foo/..bar", () => {
		expect(() => validateRelativePath("foo/..bar", "vault")).not.toThrow();
	});

	it("allows foo/.../bar, a triple-dot directory name, not a parent hop", () => {
		expect(() => validateRelativePath("foo/.../bar", "vault")).not.toThrow();
	});

	it("allows ..bar as a leaf under the scheme root", () => {
		expect(() => validateRelativePath("..bar", "local")).not.toThrow();
	});
});

describe("backslash hops are traversal on a URL that may have come from Windows", () => {
	it("refuses foo backslash-dot-dot-backslash bar rather than treating the backslash as a filename character", () => {
		expect(() => validateRelativePath("foo\\..\\bar", "vault")).toThrow(/traversal/i);
	});

	it("refuses a drive-prefixed path rather than storing it as a relative leaf on POSIX", () => {
		expect(() => validateRelativePath("C:\\Windows", "vault")).toThrow(/Absolute paths|traversal/i);
	});
});
