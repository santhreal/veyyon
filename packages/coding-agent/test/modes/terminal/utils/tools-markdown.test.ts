import { describe, expect, it } from "bun:test";
import { buildToolsMarkdown } from "../../../../src/modes/terminal/utils/tools-markdown";
import { BUILTIN_TOOL_NAMES, BUILTIN_TOOL_SUMMARIES } from "../../../../src/tools/core/builtin-names";

/**
 * buildToolsMarkdown renders the `/tools` listing as a GitHub-flavored markdown
 * table (one row per visible tool). It had no test. Because the output is real
 * markdown that a client parses, the cell escaping is load-bearing and pinned here:
 *   - an empty tool list returns the plain "No tools are currently visible" line,
 *     not an empty table;
 *   - each row is `| ` + backtick-wrapped name + ` | ` + escaped description + ` |`;
 *   - a literal pipe in a description is backslash-escaped so it cannot forge an
 *     extra column, and every run of newlines collapses to a single space so a
 *     multi-line description stays inside one table row;
 *   - a description that is empty or only whitespace becomes "No description
 *     provided." (the escape trims first, so whitespace-only is treated as empty);
 *   - a built-in tool shows its curated summary, never its prompt, and any other
 *     tool shows the first sentence of its description with prompt markup removed.
 * A regression would break table rendering (an unescaped pipe or a stray newline
 * splits the row), drop the empty-description fallback, or dump a tool prompt
 * into the table.
 */

describe("buildToolsMarkdown", () => {
	it("returns the empty-state line when no tools are visible", () => {
		expect(buildToolsMarkdown({ tools: [] })).toBe("No tools are currently visible to the agent.");
	});

	it("renders a single tool as a header plus one backtick-wrapped row", () => {
		expect(buildToolsMarkdown({ tools: [{ name: "custom", description: "Read a file" }] })).toBe(
			["| Tool | Description |", "|------|-------------|", "| `custom` | Read a file |"].join("\n"),
		);
	});

	it("renders one row per tool in input order", () => {
		expect(
			buildToolsMarkdown({
				tools: [
					{ name: "a", description: "A" },
					{ name: "b", description: "B" },
				],
			}),
		).toBe(["| Tool | Description |", "|------|-------------|", "| `a` | A |", "| `b` | B |"].join("\n"));
	});

	it("escapes a pipe in the description so it cannot forge an extra column", () => {
		expect(buildToolsMarkdown({ tools: [{ name: "t", description: "left|right" }] })).toContain(
			"| `t` | left\\|right |",
		);
	});

	it("collapses every run of newlines (LF and CRLF) to a single space", () => {
		expect(buildToolsMarkdown({ tools: [{ name: "t", description: "a\nb\n\nc\r\nd" }] })).toContain(
			"| `t` | a b c d |",
		);
	});

	it("falls back to 'No description provided.' for an empty or whitespace-only description", () => {
		expect(buildToolsMarkdown({ tools: [{ name: "t", description: "" }] })).toContain(
			"| `t` | No description provided. |",
		);
		expect(buildToolsMarkdown({ tools: [{ name: "t", description: "   " }] })).toContain(
			"| `t` | No description provided. |",
		);
	});

	it("shows every built-in tool's curated summary instead of its prompt", () => {
		const prompt = "<instruction>\n# Heading\nDo the thing. Then more.\n</instruction>";
		for (const name of BUILTIN_TOOL_NAMES) {
			expect(buildToolsMarkdown({ tools: [{ name, description: prompt }] })).toContain(
				`| \`${name}\` | ${BUILTIN_TOOL_SUMMARIES[name]} |`,
			);
		}
	});

	it("shows the first sentence of any other tool's description with markup and headings removed", () => {
		const description = "<instruction>\n# Usage\nFetch a page. Supports <b>many</b> options.\n</instruction>";
		expect(buildToolsMarkdown({ tools: [{ name: "custom", description }] })).toContain(
			"| `custom` | Fetch a page. |",
		);
	});

	it("treats a tool named after an Object prototype member as a plain tool", () => {
		expect(buildToolsMarkdown({ tools: [{ name: "toString", description: "Stringify." }] })).toContain(
			"| `toString` | Stringify. |",
		);
	});
});
