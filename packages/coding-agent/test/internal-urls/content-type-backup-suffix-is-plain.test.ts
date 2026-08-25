/**
 * `getContentType` keys off `path.extname` — the FINAL suffix only.
 *
 * Existing content-type.test.ts already pins `.md`, `.json`, case folding,
 * and `a.md.json` vs `a.json.md`. It does not pin the operator files that
 * keep a real type in the middle and a backup/editor suffix on the end:
 *
 *   notes.md.bak
 *   config.json~
 *   README.md.orig
 *   file.md.swp
 *
 * Those must be `text/plain`. Serving `notes.md.bak` as markdown would
 * render a backup as a skill/doc body.
 */
import { describe, expect, it } from "bun:test";
import { getContentType } from "@veyyon/coding-agent/internal-urls/content-type";

describe("backup and editor suffixes win over an inner .md / .json", () => {
	it("treats .md.bak as plain, not markdown", () => {
		expect(getContentType("notes.md.bak")).toBe("text/plain");
		expect(getContentType("/vault/notes.md.bak")).toBe("text/plain");
	});

	it("treats .json.bak as plain, not json", () => {
		expect(getContentType("config.json.bak")).toBe("text/plain");
	});

	it("treats .md.orig / .md.old / .md.save as plain", () => {
		expect(getContentType("README.md.orig")).toBe("text/plain");
		expect(getContentType("README.md.old")).toBe("text/plain");
		expect(getContentType("README.md.save")).toBe("text/plain");
	});

	it("treats vim swap and backup suffixes as plain", () => {
		expect(getContentType("file.md.swp")).toBe("text/plain");
		expect(getContentType("file.md.swo")).toBe("text/plain");
		expect(getContentType("file.json~")).toBe("text/plain");
	});

	it("treats .md.copy and .json.backup as plain", () => {
		expect(getContentType("notes.md.copy")).toBe("text/plain");
		expect(getContentType("settings.json.backup")).toBe("text/plain");
	});
});

describe("a trailing dot or missing extension is plain", () => {
	it("treats 'notes.md.' as plain (extname is '.')", () => {
		expect(getContentType("notes.md.")).toBe("text/plain");
	});

	it("treats a dotfile with no second suffix as plain", () => {
		expect(getContentType(".md")).toBe("text/plain");
		expect(getContentType(".json")).toBe("text/plain");
		expect(getContentType(".gitignore")).toBe("text/plain");
	});

	it("treats .markdown / .mdown / .jsonc as plain (not in the two-type table)", () => {
		expect(getContentType("notes.markdown")).toBe("text/plain");
		expect(getContentType("notes.mdown")).toBe("text/plain");
		expect(getContentType("tsconfig.jsonc")).toBe("text/plain");
		expect(getContentType("data.json5")).toBe("text/plain");
	});

	it("treats .MD.bak with mixed case as plain (extname is .bak, lowercased)", () => {
		expect(getContentType("NOTES.MD.BAK")).toBe("text/plain");
	});
});

describe("compound archives and map files", () => {
	it("treats .tar.md as markdown because extname is .md — pin that trap", () => {
		expect(getContentType("archive.tar.md")).toBe("text/markdown");
	});

	it("treats .md.tar as plain", () => {
		expect(getContentType("notes.md.tar")).toBe("text/plain");
	});

	it("treats source-map .json.map as plain", () => {
		expect(getContentType("app.js.json.map")).toBe("text/plain");
		expect(getContentType("app.js.map")).toBe("text/plain");
	});
});
