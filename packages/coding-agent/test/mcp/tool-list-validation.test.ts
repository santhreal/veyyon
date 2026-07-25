import { describe, expect, it } from "bun:test";
import { MAX_TOOL_LIST_PAGES, validateToolListPage } from "@veyyon/coding-agent/mcp/tool-list-validation";

/**
 * A malformed `tools/list` response must cost you that server's tools, nothing
 * more.
 *
 * WHY THIS SUITE EXISTS (MCP-3). `listTools` used to write
 * `allTools.push(...result.tools)` where `result` was a TYPESCRIPT CAST of
 * whatever a third-party server returned. The cast is erased at runtime, so
 * nothing checked the shape, and three payloads got through:
 *
 *   - `{}` spread `undefined` and threw a bare TypeError naming neither the
 *     server nor the protocol violation.
 *   - `{ tools: "abc" }` spread a STRING, so every character became a tool
 *     definition. The registry then held nameless entries and the corruption
 *     surfaced later, somewhere else, as a tool that could not be called.
 *   - a constant `nextCursor` looped the pagination forever. No request timeout
 *     covers that, because each individual request answers promptly.
 *
 * The contract asserted here is DROP, NOT REPAIR, and drop LOUDLY. An entry
 * that does not describe a callable tool is discarded, because inventing a name
 * would put a phantom in front of the model that fails only when it is used.
 * And every drop is reported, because a server that silently loses half its
 * tools looks exactly like a server that has fewer tools, which sends the
 * operator to debug their own prompt.
 *
 * The valid cases are asserted as hard as the invalid ones: a validator that
 * rejected real payloads would break every working server, which is a worse
 * outcome than the bug it replaced.
 */

const VALID_TOOL = {
	description: "Search the web",
	inputSchema: { properties: { query: { type: "string" } }, required: ["query"], type: "object" },
	name: "search",
};

describe("a well-formed tools/list response passes through unchanged", () => {
	/**
	 * The case that must not regress. Every field a real server sends survives
	 * intact, because this validator sits on the path every working MCP server
	 * takes.
	 */
	it("keeps a valid tool with its name, description, and schema", () => {
		const page = validateToolListPage({ tools: [VALID_TOOL] }, "example");

		expect(page.rejected).toEqual([]);
		expect(page.tools).toHaveLength(1);
		expect(page.tools[0]?.name).toBe("search");
		expect(page.tools[0]?.description).toBe("Search the web");
		expect(page.tools[0]?.inputSchema.type).toBe("object");
		expect(page.tools[0]?.inputSchema.properties).toEqual({ query: { type: "string" } });
	});

	/** An empty tool list is legitimate: a server may expose only resources. */
	it("accepts an empty tool list without complaint", () => {
		const page = validateToolListPage({ tools: [] }, "example");

		expect(page.tools).toEqual([]);
		expect(page.rejected).toEqual([]);
	});

	/**
	 * A tool with no description is common and valid. Requiring one would reject
	 * working servers over a field the protocol marks optional.
	 */
	it("accepts a tool with no description", () => {
		const page = validateToolListPage({ tools: [{ inputSchema: { type: "object" }, name: "ping" }] }, "example");

		expect(page.rejected).toEqual([]);
		expect(page.tools[0]?.name).toBe("ping");
		expect(page.tools[0]?.description).toBeUndefined();
	});

	/**
	 * A missing `inputSchema` is tolerated and filled in, because plenty of real
	 * servers omit it for zero-argument tools. This is the one place repair is
	 * right: the tool is still callable, and the repair is not reported because
	 * nothing is wrong.
	 */
	it("fills in an empty schema for a tool that omits inputSchema", () => {
		const page = validateToolListPage({ tools: [{ name: "ping" }] }, "example");

		expect(page.rejected).toEqual([]);
		expect(page.tools[0]?.inputSchema).toEqual({ properties: {}, type: "object" });
	});

	/** A valid string cursor is passed through so pagination continues. */
	it("passes a valid nextCursor through", () => {
		const page = validateToolListPage({ nextCursor: "page-2", tools: [] }, "example");

		expect(page.nextCursor).toBe("page-2");
		expect(page.rejected).toEqual([]);
	});
});

describe("a malformed response yields no tools rather than corrupt ones", () => {
	/**
	 * THE STRING CASE, which is the one that corrupted the registry rather than
	 * merely failing. Spreading "abc" produced three single-character tools, and
	 * nothing downstream could tell them from real ones.
	 */
	it("refuses a tools field that is a string instead of spreading its characters", () => {
		const page = validateToolListPage({ tools: "abc" }, "example");

		expect(page.tools).toEqual([]);
		expect(page.rejected).toHaveLength(1);
		expect(page.rejected[0]).toContain("not an array");
	});

	/**
	 * A missing `tools` used to throw a bare TypeError from the spread. It now
	 * reports the violation and names what was actually there.
	 */
	it("reports a missing tools field instead of throwing", () => {
		const page = validateToolListPage({}, "example");

		expect(page.tools).toEqual([]);
		expect(page.rejected[0]).toContain("undefined");
	});

	/** A response that is not an object at all is refused the same way. */
	it.each([
		["null", null],
		["a string", "nope"],
		["a number", 42],
		["an array", [{ name: "search" }]],
	])("refuses a response that is %s", (_label, raw) => {
		const page = validateToolListPage(raw, "example");

		expect(page.tools).toEqual([]);
		expect(page.rejected).toHaveLength(1);
	});

	/**
	 * Never throws, for any input. The caller connects servers in parallel, so an
	 * exception here would take down more than the one bad server.
	 */
	it.each([
		["undefined", undefined],
		["null", null],
		["the number zero", 0],
		["an empty string", ""],
		["an empty array", []],
		["an object whose tools is null", { tools: null }],
		["an array-like object", { tools: { length: 3 } }],
	])("never throws on malformed input that is %s", (_label, raw) => {
		expect(() => validateToolListPage(raw, "example")).not.toThrow();
	});
});

describe("individual bad entries are dropped without losing the good ones", () => {
	/**
	 * The most valuable property: one broken tool must not cost you the others.
	 * A server with a single malformed entry is far commoner than one that is
	 * entirely broken, and refusing the whole page would disable a working
	 * server over one bad row.
	 */
	it("keeps the valid tools alongside a malformed one", () => {
		const page = validateToolListPage({ tools: [VALID_TOOL, null, { name: "fetch" }] }, "example");

		expect(page.tools.map(tool => tool.name)).toEqual(["search", "fetch"]);
		expect(page.rejected).toHaveLength(1);
		expect(page.rejected[0]).toContain("index 1");
	});

	/**
	 * A tool with no usable name is dropped rather than given one. It cannot be
	 * called, so a synthesized name would be a phantom in the registry that fails
	 * only at the moment the model tries to use it.
	 */
	it.each([
		["a number", 123],
		["null", null],
		["an empty string", ""],
		["whitespace", "   "],
		["missing", undefined],
	])("drops a tool whose name is %s", (_label, name) => {
		const page = validateToolListPage({ tools: [{ inputSchema: { type: "object" }, name }] }, "example");

		expect(page.tools).toEqual([]);
		expect(page.rejected).toHaveLength(1);
	});

	/**
	 * A duplicate name keeps the FIRST definition. A server sending one name
	 * twice has no defined precedence, and letting the later one overwrite would
	 * change which tool the registry already advertised.
	 */
	it("keeps the first of two tools sharing a name", () => {
		const page = validateToolListPage(
			{
				tools: [
					{ description: "first", inputSchema: { type: "object" }, name: "dup" },
					{ description: "second", inputSchema: { type: "object" }, name: "dup" },
				],
			},
			"example",
		);

		expect(page.tools).toHaveLength(1);
		expect(page.tools[0]?.description).toBe("first");
		expect(page.rejected[0]).toContain("more than once");
	});

	/**
	 * A schema of the wrong type is replaced AND reported. Replacing keeps the
	 * tool callable; reporting is what separates it from the tolerated
	 * missing-schema case, because a server sending a string schema is doing
	 * something it should not.
	 */
	it("replaces a non-object inputSchema and says so", () => {
		const page = validateToolListPage({ tools: [{ inputSchema: "not a schema", name: "search" }] }, "example");

		expect(page.tools).toHaveLength(1);
		expect(page.tools[0]?.inputSchema).toEqual({ properties: {}, type: "object" });
		expect(page.rejected[0]).toContain("inputSchema");
	});

	/**
	 * Every rejection names the offending entry. A count alone would tell an
	 * operator that something was dropped without saying what, which is not
	 * enough to go and fix the server.
	 */
	it("names what was wrong with each dropped entry", () => {
		const page = validateToolListPage({ tools: [null, { name: 5 }, "str"] }, "example");

		expect(page.rejected).toHaveLength(3);
		for (const reason of page.rejected) expect(reason).toContain("index");
	});
});

describe("pagination cannot run away", () => {
	/**
	 * A non-string cursor ends pagination rather than being sent back. Passing a
	 * value the server cannot interpret is how a loop starts, and the pages
	 * already collected are kept.
	 */
	it.each([
		["a number", 7],
		["an object", { page: 2 }],
		["null", null],
		["an empty string", ""],
	])("drops a nextCursor that is %s", (_label, nextCursor) => {
		const page = validateToolListPage({ nextCursor, tools: [VALID_TOOL] }, "example");

		expect(page.nextCursor).toBeUndefined();
		expect(page.tools).toHaveLength(1);
	});

	/**
	 * An absent cursor is the ordinary end of pagination and must not be reported
	 * as a problem, or every well-behaved server would log a warning on its last
	 * page.
	 */
	it("treats an absent cursor as a clean end of pagination", () => {
		const page = validateToolListPage({ tools: [VALID_TOOL] }, "example");

		expect(page.nextCursor).toBeUndefined();
		expect(page.rejected).toEqual([]);
	});

	/**
	 * The page ceiling is a real bound, not a comment. It backs the loop in
	 * `listTools` that would otherwise depend entirely on a server's cursor
	 * behaving, and it is set far above any real server so it never fires in
	 * normal use.
	 */
	it("declares a finite page ceiling well above any real server", () => {
		expect(MAX_TOOL_LIST_PAGES).toBeGreaterThan(100);
		expect(Number.isFinite(MAX_TOOL_LIST_PAGES)).toBe(true);
	});
});
