// WHY: `shortenPath` is a prefix match, and a prefix match on a path is the classic sibling-
// directory defect: with home at `/home/u`, a naive `startsWith` turns `/home/u2/notes` into
// `~2/notes`, which names a directory that does not exist. The class this closes is "a path is
// shortened at somewhere other than a separator" — the whole-segment rule, in both separator
// dialects, plus the exact-home and non-string edges.
//
// It also pins the module's own reason to exist: the launch card's status row needs a shortener
// that costs two node builtins, so this leaf is the owner and `render-utils` re-exports it. A
// second copy appearing behind that barrel is the drift this catches.
//
// Not covered: the real `os.homedir()` default. Every case here passes `homeDir` explicitly, so
// the suite says nothing about how the host resolves a home directory, only what is done with it.

import { describe, expect, it } from "bun:test";
import { shortenPath as reExported } from "../../src/tools/render-utils";
import { shortenPath } from "../../src/tools/shorten-path";

describe("a home directory collapses only on a path boundary", () => {
	it("collapses home when the next character starts a new segment", () => {
		expect(shortenPath("/home/u/src/app.ts", "/home/u")).toBe("~/src/app.ts");
	});

	it("collapses a path that is exactly the home directory", () => {
		expect(shortenPath("/home/u", "/home/u")).toBe("~");
	});

	it("leaves a sibling directory that merely shares the prefix", () => {
		// The defect this module exists to avoid: `~2/notes` is not a real path.
		expect(shortenPath("/home/u2/notes", "/home/u")).toBe("/home/u2/notes");
		expect(shortenPath("/home/username", "/home/user")).toBe("/home/username");
	});

	it("treats a backslash as a boundary and normalizes it", () => {
		expect(shortenPath("C:\\Users\\u\\src\\app.ts", "C:\\Users\\u")).toBe("~/src/app.ts");
	});

	it("does not collapse a win32 sibling either", () => {
		expect(shortenPath("C:\\Users\\u2\\app.ts", "C:\\Users\\u")).toBe("C:\\Users\\u2\\app.ts");
	});

	it("leaves a path that does not start at home", () => {
		expect(shortenPath("/etc/hosts", "/home/u")).toBe("/etc/hosts");
	});

	it("returns an empty string for anything that is not a string", () => {
		// Callers hand this raw tool arguments, so a number or a null must not throw mid-render.
		for (const bad of [undefined, null, 42, {}, ["/home/u"]]) {
			expect(shortenPath(bad, "/home/u")).toBe("");
		}
	});

	it("does not collapse anything when the home directory is empty", () => {
		// An empty prefix matches every string; the guard keeps `~` off an unrelated path.
		expect(shortenPath("/etc/hosts", "")).toBe("/etc/hosts");
	});

	it("is the same binding render-utils re-exports", () => {
		// One owner. A second copy behind the barrel would drift from the boundary rule above.
		expect(reExported).toBe(shortenPath);
	});
});
