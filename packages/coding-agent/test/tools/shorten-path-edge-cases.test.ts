/**
 * WHY: `shortenPath` and `shortenEmbeddedPaths` are the sanitization boundary
 * that prevents the operator's home directory from leaking into tool render
 * output, transcripts, and error cards. `shortenPath` has a boundary check
 * (path must start with home AND the remainder must start with a separator)
 * that a helper extraction can rewire to a plain `startsWith` — which would
 * shorten `/home/userXYZ` to `~XYZ` when home is `/home/user`. `shortenEmbeddedPaths`
 * splits on spaces and strips leading/trailing punctuation before shortening;
 * a regression that drops the punctuation handling corrupts the display.
 *
 * Existing tests cover the Windows path, the sibling-boundary case, and the
 * indirect path through `formatErrorMessage`. This suite covers the direct
 * edge cases that have no coverage:
 * - Non-string input returns ""
 * - Empty string returns ""
 * - Path exactly equal to home returns "~"
 * - Path that starts with home but is not a boundary prefix is NOT shortened
 * - `shortenEmbeddedPaths` with empty string
 * - `shortenEmbeddedPaths` with a single path (no spaces)
 * - `shortenEmbeddedPaths` preserves leading/trailing punctuation
 * - `shortenEmbeddedPaths` with multiple paths
 * - `shortenEmbeddedPaths` with punctuation-only segment
 * - `formatScopePaths` with multiple paths joins and truncates
 */
import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { formatScopePaths, shortenEmbeddedPaths, shortenPath } from "@veyyon/coding-agent/tools/render-utils";

const HOME = os.homedir();

describe("shortenPath — edge cases", () => {
	it("returns empty string for non-string input", () => {
		expect(shortenPath(undefined)).toBe("");
		expect(shortenPath(null)).toBe("");
		expect(shortenPath(42)).toBe("");
		expect(shortenPath({})).toBe("");
	});

	it("returns empty string for empty string input", () => {
		expect(shortenPath("")).toBe("");
	});

	it("returns ~ for path exactly equal to home", () => {
		expect(shortenPath(HOME)).toBe("~");
	});

	it("returns ~ + suffix for a path inside home", () => {
		const p = path.join(HOME, "projects", "app.ts");
		expect(shortenPath(p)).toBe(`~${p.slice(HOME.length)}`);
	});

	it("does not shorten a path that starts with home but is not a boundary prefix", () => {
		// e.g., home = /home/user, path = /home/userXYZ — must NOT become ~XYZ
		const sibling = `${HOME}XYZ`;
		expect(shortenPath(sibling)).toBe(sibling);
	});

	it("uses the provided homeDir override", () => {
		const customHome = "/custom/home";
		expect(shortenPath(`${customHome}/dir/file.ts`, customHome)).toBe("~/dir/file.ts");
	});

	it("does not shorten when homeDir is empty string", () => {
		expect(shortenPath("/some/path", "")).toBe("/some/path");
	});

	it("normalizes Windows backslashes to forward slashes after home", () => {
		const home = String.raw`C:\Users\dev`;
		expect(shortenPath(String.raw`C:\Users\dev\repo\file.ts`, home)).toBe("~/repo/file.ts");
	});
});

describe("shortenEmbeddedPaths — edge cases", () => {
	it("returns empty string for empty input", () => {
		expect(shortenEmbeddedPaths("")).toBe("");
	});

	it("shortens a single bare path with no spaces", () => {
		const p = path.join(HOME, "repo", "a.ts");
		const result = shortenEmbeddedPaths(p);
		expect(result).toContain("~");
		expect(result).not.toContain(HOME);
	});

	it("preserves leading and trailing punctuation around a path", () => {
		const p = path.join(HOME, "repo", "a.ts");
		const result = shortenEmbeddedPaths(`cannot read '${p}'`);
		expect(result).toContain("~");
		expect(result).not.toContain(HOME);
		expect(result).toContain("'");
		expect(result).toContain("cannot read");
	});

	it("shortens multiple paths in one string", () => {
		const p1 = path.join(HOME, "repo", "a.ts");
		const p2 = path.join(HOME, "repo", "b.ts");
		const result = shortenEmbeddedPaths(`diff ${p1} ${p2}`);
		expect(result).not.toContain(HOME);
		expect(result).toContain("~");
		expect(result).toContain("diff");
	});

	it("leaves a segment that is entirely punctuation unchanged", () => {
		expect(shortenEmbeddedPaths("error: [done]")).toBe("error: [done]");
	});

	it("handles paths with brackets at boundaries", () => {
		const p = path.join(HOME, "repo", "a.ts");
		const result = shortenEmbeddedPaths(`[${p}]`);
		expect(result).not.toContain(HOME);
		expect(result).toContain("[");
		expect(result).toContain("]");
	});

	it("handles paths with backticks", () => {
		const p = path.join(HOME, "repo", "a.ts");
		const result = shortenEmbeddedPaths(`file \`${p}\` not found`);
		expect(result).not.toContain(HOME);
		expect(result).toContain("`");
	});

	it("uses the provided homeDir override", () => {
		const customHome = "/custom/home";
		const result = shortenEmbeddedPaths(`${customHome}/dir/file.ts`, customHome);
		expect(result).toBe("~/dir/file.ts");
	});

	it("leaves non-path text unchanged", () => {
		expect(shortenEmbeddedPaths("connection reset by peer")).toBe("connection reset by peer");
	});
});

describe("formatScopePaths — edge cases", () => {
	it("formats a single path", () => {
		const p = path.join(HOME, "repo", "a.ts");
		const result = formatScopePaths(p);
		expect(result).toContain("~");
		expect(result).not.toContain(HOME);
	});

	it("formats multiple paths joined with comma", () => {
		const p1 = path.join(HOME, "repo", "a.ts");
		const p2 = path.join(HOME, "repo", "b.ts");
		const result = formatScopePaths([p1, p2]);
		expect(result).not.toContain(HOME);
		expect(result).toContain("~");
		expect(result).toContain(",");
	});

	it("handles a string input (not array)", () => {
		const result = formatScopePaths("/repo/a.ts");
		expect(result).toContain("/repo/a.ts");
	});
});
