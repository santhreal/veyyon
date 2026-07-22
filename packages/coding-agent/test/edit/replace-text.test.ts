import { describe, expect, it } from "bun:test";
import { replaceText } from "@veyyon/coding-agent/edit/diff";

/**
 * replaceText is the core string-replacement primitive behind the edit tool: given file content, an
 * oldText to find, and a newText, it returns the rewritten content and how many replacements it made.
 * It had NO direct test, despite being the function every edit ultimately runs through. The contracts
 * pinned here are the ones a regression would most quietly break:
 *   - an empty oldText is rejected (a blank find would "match" everywhere);
 *   - single mode replaces exactly one occurrence and refuses (throws) when the target is ambiguous
 *     (more than one occurrence), rather than silently editing the first;
 *   - single mode reports count 0 and leaves content untouched when nothing matches;
 *   - `all` mode replaces every exact occurrence and returns the true count;
 *   - all inputs are normalized to LF, so CRLF content/oldText still match and CRLF newText is stored
 *     as LF (mixed line endings never leak into a file);
 *   - fuzzy matching is opt-in: a whitespace-only difference matches only when fuzzy is enabled.
 */

const options = (overrides: { fuzzy?: boolean; all?: boolean; threshold?: number } = {}) => ({
	fuzzy: false,
	all: false,
	...overrides,
});

describe("replaceText", () => {
	it("throws when oldText is empty", () => {
		expect(() => replaceText("content", "", "new", options())).toThrow("oldText must not be empty.");
	});

	describe("single replacement mode", () => {
		it("replaces exactly one exact occurrence and reports count 1", () => {
			expect(replaceText("hello world", "world", "there", options())).toEqual({
				content: "hello there",
				count: 1,
			});
		});

		it("leaves content untouched and reports count 0 when nothing matches", () => {
			expect(replaceText("abc", "xyz", "q", options())).toEqual({ content: "abc", count: 0 });
		});

		it("throws an ambiguity error naming the occurrence count when the target appears more than once", () => {
			expect(() => replaceText("a a a", "a", "b", options())).toThrow("Found 3 occurrences");
		});
	});

	describe("all mode", () => {
		it("replaces every exact occurrence and returns the true count", () => {
			expect(replaceText("a a a", "a", "b", options({ all: true }))).toEqual({ content: "b b b", count: 3 });
			expect(replaceText("foo foo bar", "foo", "baz", options({ all: true }))).toEqual({
				content: "baz baz bar",
				count: 2,
			});
		});
	});

	describe("line-ending normalization", () => {
		it("matches CRLF content against a CRLF oldText after normalizing both to LF", () => {
			expect(replaceText("line1\r\nline2", "line1\r\nline2", "new", options())).toEqual({
				content: "new",
				count: 1,
			});
		});

		it("stores a CRLF newText as LF so mixed line endings never leak in", () => {
			expect(replaceText("x", "x", "a\r\nb", options())).toEqual({ content: "a\nb", count: 1 });
		});
	});

	describe("fuzzy matching is opt-in", () => {
		const content = "function f() {\n    return 1;   \n}";
		const oldText = "function f() {\n    return 1;\n}";

		it("does not match a whitespace-only difference when fuzzy is disabled", () => {
			expect(replaceText(content, oldText, "REPLACED", options({ fuzzy: false }))).toEqual({
				content,
				count: 0,
			});
		});

		it("matches the same whitespace-only difference when fuzzy is enabled", () => {
			expect(replaceText(content, oldText, "REPLACED", options({ fuzzy: true }))).toEqual({
				content: "REPLACED",
				count: 1,
			});
		});
	});
});
