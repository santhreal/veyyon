import { describe, expect, it } from "bun:test";
import { createMCPToolName, mcpToolNamePrefix, parseMCPToolName } from "@veyyon/coding-agent/mcp/tool-bridge";

/**
 * MCP-5: two different servers must never produce the same tool name.
 *
 * Every MCP tool is exposed to the model as `mcp__<server>_<tool>`, and that
 * string is the tool's identity in the registry. If two connected servers
 * generate the same one, the registry holds two entries under one name and a
 * call goes to whichever the lookup reaches first. Nothing warns, and the
 * symptom is a tool that "sometimes" talks to the wrong backend, which is close
 * to impossible to diagnose from a transcript.
 *
 * That was reachable, and not through anything exotic. The sanitizer replaced
 * every character outside `a-z_`, so DIGITS were destroyed: `github1` and
 * `github2` both became `github`, and every tool they shared a name for
 * collided outright. Numbered servers are completely ordinary (`mcp-server-1`,
 * `jira2`, `postgres-3`), and every provider allows digits in a tool name, so
 * the erasure bought nothing.
 *
 * The prefix had a second, quieter version of the same bug. `createMCPToolName`
 * built `mcp__<sanitized>_` while the manager's reconnect filter matched
 * `mcp__<raw>_`. For any server whose name needed sanitizing at all, the filter
 * matched none of that server's tools, so reconnecting kept the stale ones and
 * pushed a fresh copy of every one. `mcpToolNamePrefix` is now the single owner
 * both use, and the tests below hold them to it.
 */
describe("tool names distinguish servers that differ only by digits", () => {
	it("gives github1 and github2 different tool names", () => {
		// The exact collision: same tool, two numbered servers. Before the fix both
		// sides of this comparison were "mcp__github_search".
		expect(createMCPToolName("github1", "search")).toBe("mcp__github1_search");
		expect(createMCPToolName("github2", "search")).toBe("mcp__github2_search");
		expect(createMCPToolName("github1", "search")).not.toBe(createMCPToolName("github2", "search"));
	});

	it("keeps the digit in a hyphenated numbered server", () => {
		// `mcp-server-1` is the shape the MCP docs' own examples use, so this is
		// the naming a user copying from documentation ends up with.
		expect(createMCPToolName("mcp-server-1", "run")).toBe("mcp__mcp_server_1_run");
		expect(createMCPToolName("mcp-server-2", "run")).toBe("mcp__mcp_server_2_run");
	});

	it("keeps digits inside a tool name too", () => {
		// The tool half went through the same sanitizer, so a versioned tool name
		// collided with its own siblings in exactly the same way.
		expect(createMCPToolName("api", "v1_query")).toBe("mcp__api_v1_query");
		expect(createMCPToolName("api", "v2_query")).toBe("mcp__api_v2_query");
	});

	it("still replaces characters a tool name may not contain", () => {
		// Digits became legal; nothing else did. Spaces, dots and slashes are still
		// folded to a single underscore, and leading/trailing ones are dropped.
		expect(createMCPToolName("My Server.v2", "Get/Thing")).toBe("mcp__my_server_v2_get_thing");
		expect(createMCPToolName("--weird--", "  tool  ")).toBe("mcp__weird_tool");
	});

	it("falls back to a placeholder when a name sanitizes to nothing", () => {
		// A name of only illegal characters must still produce a usable, stable
		// tool name rather than `mcp___` or an empty segment.
		expect(createMCPToolName("!!!", "???")).toBe("mcp__server_tool");
	});

	it("leaves digit-free names byte-identical to before the fix", () => {
		// The compatibility half. Tool names travel in prompts and in user config,
		// so changing the ones that were already correct would bust prompt caches
		// and break allowlists for no reason. These are the pre-fix values.
		expect(createMCPToolName("puppeteer", "screenshot")).toBe("mcp__puppeteer_screenshot");
		expect(createMCPToolName("puppeteer", "puppeteer_screenshot")).toBe("mcp__puppeteer_screenshot");
		expect(createMCPToolName("weather", "get_forecast")).toBe("mcp__weather_get_forecast");
	});
});

describe("mcpToolNamePrefix is the one owner of the server prefix", () => {
	/** Server names that exercise every branch of the sanitizer. */
	const SERVERS = ["github1", "mcp-server-1", "puppeteer", "My Server.v2", "--weird--", "!!!", "a_b"];

	it("matches the prefix of every name createMCPToolName produces", () => {
		// The ONE-PLACE lock. The reconnect filter uses this function to decide
		// which tools belong to a server; if it can ever disagree with the names
		// actually generated, reconnects duplicate tools instead of replacing them.
		for (const server of SERVERS) {
			const toolName = createMCPToolName(server, "do_thing");

			expect(toolName.startsWith(mcpToolNamePrefix(server))).toBe(true);
		}
	});

	it("is exact, not merely a shared beginning", () => {
		// A prefix that was a strict substring would still pass a `startsWith`
		// check while matching a DIFFERENT server's tools on reconnect.
		expect(mcpToolNamePrefix("github1")).toBe("mcp__github1_");
		expect(mcpToolNamePrefix("My Server.v2")).toBe("mcp__my_server_v2_");
		expect(mcpToolNamePrefix("!!!")).toBe("mcp__server_");
	});

	it("does not match a sibling server whose name merely starts the same way", () => {
		// `github` and `github1` share a beginning, so a prefix without its
		// trailing underscore would let one server's reconnect delete the other's
		// tools.
		const tool = createMCPToolName("github1", "search");

		expect(tool.startsWith(mcpToolNamePrefix("github"))).toBe(false);
		expect(tool.startsWith(mcpToolNamePrefix("github1"))).toBe(true);
	});
});

describe("parsing a tool name back to its parts", () => {
	it("round-trips a server name with digits", () => {
		expect(parseMCPToolName("mcp__github1_search")).toEqual({ serverName: "github1", toolName: "search" });
	});

	it("returns null for anything that is not an MCP tool name", () => {
		expect(parseMCPToolName("read")).toBeNull();
		expect(parseMCPToolName("mcp__onlyserver")).toBeNull();
	});

	it("cannot separate a server name that contains underscores, which is a KNOWN limit", () => {
		// Pinned as a decision on record, not as desired behaviour. The name is a
		// flat string split at the first underscore, so server `a_b` + tool `c` and
		// server `a` + tool `b_c` both encode to `mcp__a_b_c` and both parse back
		// as the second reading.
		//
		// It is left alone because the parse result is used ONLY for display: a
		// label and the "server is still connecting" message in
		// `createPendingMCPTool`. Execution routes through `MCPTool.mcpServerName`,
		// which carries the real server, so a wrong parse cannot send a call to the
		// wrong backend. Changing the encoding to make it recoverable would rename
		// every MCP tool in every prompt and every user allowlist, which is a far
		// worse trade for a cosmetic gain.
		//
		// If this ever stops being display-only, this test is the place that says
		// why the encoding has to change first.
		expect(createMCPToolName("a_b", "c")).toBe(createMCPToolName("a", "b_c"));
		expect(parseMCPToolName("mcp__a_b_c")).toEqual({ serverName: "a", toolName: "b_c" });
	});
});
