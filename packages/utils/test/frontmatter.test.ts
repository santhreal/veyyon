import { afterEach, describe, expect, it, vi } from "bun:test";
import { parseFrontmatter } from "@veyyon/utils";
import * as logger from "@veyyon/utils/logger";

describe("parseFrontmatter", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("accepts unquoted skill descriptions containing colon-space without warning", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const content = `---
name: tool-prompt-optimization
description: Optimize tool prompts. Two halves: measure schema overlap; keep scar tissue.
enabled: true
---
Skill body`;

		const result = parseFrontmatter(content, { source: "bad-skill/SKILL.md" });

		expect(result.frontmatter).toEqual({
			name: "tool-prompt-optimization",
			description: "Optimize tool prompts. Two halves: measure schema overlap; keep scar tissue.",
			enabled: true,
		});
		expect(result.body).toBe("Skill body");
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("still warns and falls back for unrecoverable malformed frontmatter", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const content = `---
invalid: [unclosed array
---
Body content`;

		const result = parseFrontmatter(content, { source: "broken.md" });

		expect(result.frontmatter).toEqual({ invalid: "[unclosed array" });
		expect(result.body).toBe("Body content");
		expect(warnSpy).toHaveBeenCalledWith(
			"Failed to parse YAML frontmatter",
			expect.objectContaining({ err: expect.stringContaining("broken.md") }),
		);
	});
});

/**
 * Skill and prompt files are authored in kebab-case (`thinking-level`) but the
 * runtime reads camelCase (`thinkingLevel`). parseFrontmatter rewrites every key
 * on the way in; if that stopped recursing into nested maps or list items the
 * inner options would silently read as undefined, so these lock the recursion.
 */
describe("parseFrontmatter key normalization", () => {
	it("rewrites kebab-case keys to camelCase at the top level", () => {
		const result = parseFrontmatter("---\nthinking-level: 3\n---\nbody");
		expect(result.frontmatter).toEqual({ thinkingLevel: 3 });
	});

	it("recurses into nested maps and arrays of maps", () => {
		const content = `---
thinking-level: 3
nested-map:
  inner-key: v
list-items:
  - item-key: a
---
body`;
		expect(parseFrontmatter(content).frontmatter).toEqual({
			thinkingLevel: 3,
			nestedMap: { innerKey: "v" },
			listItems: [{ itemKey: "a" }],
		});
	});
});

/**
 * The body is normalized before the fence is located: CRLF line endings collapse
 * to LF and HTML comments are stripped. A skill shipped from Windows or carrying
 * an `<!-- note -->` must parse identically to a clean Unix file, and `normalize:
 * false` must turn both behaviors off for callers that need the raw bytes.
 */
describe("parseFrontmatter content normalization", () => {
	it("parses CRLF frontmatter identically to LF", () => {
		const result = parseFrontmatter("---\r\nkey: val\r\n---\r\nbody");
		expect(result.frontmatter).toEqual({ key: "val" });
		expect(result.body).toBe("body");
	});

	it("strips HTML comments from the body by default", () => {
		expect(parseFrontmatter("---\nk: v\n---\ntext <!--c--> end").body).toBe("text  end");
	});

	it("leaves HTML comments intact when normalization is disabled", () => {
		expect(parseFrontmatter("---\nk: v\n---\ntext <!--c--> end", { normalize: false }).body).toBe(
			"text <!--c--> end",
		);
	});
});

/**
 * A file only has frontmatter when it opens with a `---` fence and closes with a
 * matching `\n---`. Missing either fence must return the whole input as the body
 * with no frontmatter, never throw or eat content; an empty fence pair yields an
 * empty record. These guard the boundary arithmetic in the slice offsets.
 */
describe("parseFrontmatter fence detection", () => {
	it("returns the input verbatim as body when there is no opening fence", () => {
		const result = parseFrontmatter("no fm here", { fallback: { a: 1 } });
		expect(result.frontmatter).toEqual({ a: 1 });
		expect(result.body).toBe("no fm here");
	});

	it("returns the input verbatim as body when the closing fence is missing", () => {
		const result = parseFrontmatter("---\nkey: val\nno close");
		expect(result.frontmatter).toEqual({});
		expect(result.body).toBe("---\nkey: val\nno close");
	});

	it("yields an empty record for an empty fence pair", () => {
		const result = parseFrontmatter("---\n---\nbody");
		expect(result.frontmatter).toEqual({});
		expect(result.body).toBe("body");
	});
});

/**
 * Callers pass a `fallback` record of defaults; parsed keys must win over it while
 * unrelated defaults survive. This proves the merge order so a present default is
 * never allowed to shadow an explicitly authored value.
 */
describe("parseFrontmatter fallback merge", () => {
	it("lets parsed values override fallback defaults and keeps unrelated defaults", () => {
		const result = parseFrontmatter("---\nkey: parsed\n---\nbody", {
			fallback: { key: "default", extra: 9 },
		});
		expect(result.frontmatter).toEqual({ key: "parsed", extra: 9 });
	});
});

/**
 * The recovery pass only re-quotes ambiguous *plain* scalars. A value the author
 * already quoted must pass through unchanged, not get wrapped a second time, or a
 * description reading `"a: b"` would come back mangled.
 */
describe("parseFrontmatter ambiguous scalar recovery", () => {
	it("does not re-quote a value the author already quoted", () => {
		expect(parseFrontmatter(`---\nnote: "a: b"\n---\nx`).frontmatter).toEqual({ note: "a: b" });
	});
});

/**
 * The `level` option controls how a parse failure surfaces: `off` swallows it
 * silently, `warn` (the default) logs once, and `fatal` throws a FrontmatterError
 * carrying the source. A control that quietly downgraded `fatal` to a warning
 * would let callers that require valid frontmatter proceed on garbage.
 */
describe("parseFrontmatter error level handling", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("stays silent and uses the simple fallback when level is off", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const result = parseFrontmatter("---\ninvalid: [unclosed\n---\nb", { level: "off" });
		expect(result.frontmatter).toEqual({ invalid: "[unclosed" });
		expect(result.body).toBe("b");
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("throws a FrontmatterError naming the source when level is fatal", () => {
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		expect(() => parseFrontmatter("---\ninvalid: [unclosed\n---\nb", { level: "fatal", source: "x.md" })).toThrow(
			/x\.md/,
		);
	});
});
