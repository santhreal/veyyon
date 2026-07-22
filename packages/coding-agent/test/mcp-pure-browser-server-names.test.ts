/**
 * isBrowserMCPServer by known names.
 */
import { describe, expect, it } from "bun:test";
import type { SourceMeta } from "../src/capability/types";
import { filterBrowserMCPServers, isBrowserMCPServer } from "../src/mcp/config";
import type { MCPServerConfig } from "../src/mcp/types";

describe("isBrowserMCPServer names", () => {
	const yes = ["puppeteer", "playwright", "browserbase", "browser-tools", "browser-use", "browser"];
	for (const name of yes) {
		it(`true ${name}`, () => {
			expect(isBrowserMCPServer(name, { command: "node" })).toBe(true);
		});
		it(`true ${name.toUpperCase()}`, () => {
			expect(isBrowserMCPServer(name.toUpperCase(), { command: "node" })).toBe(true);
		});
	}

	const no = ["github", "exa", "filesystem", "memory"];
	for (const name of no) {
		it(`false ${name}`, () => {
			expect(isBrowserMCPServer(name, { command: "node" })).toBe(false);
		});
	}
});

/**
 * filterBrowserMCPServers strips the built-in browser MCP servers (veyyon ships its own browser
 * tooling, so an external browser MCP would be a redundant/conflicting duplicate) while keeping every
 * other server. It had no direct test. The contract that matters beyond "drops browser servers": each
 * KEPT server must carry its source-provenance entry over UNCHANGED so downstream config reporting
 * still knows where a kept server came from, and a kept server with no source entry must not
 * fabricate one. A regression that dropped a non-browser server would silently disable a user's MCP;
 * one that lost the source mapping would misreport provenance.
 */
describe("filterBrowserMCPServers", () => {
	const source = (provider: string): SourceMeta => ({
		provider,
		providerName: provider,
		path: `/config/${provider}.json`,
		level: "user",
	});

	it("drops browser servers (and their sources) while keeping the rest with sources intact", () => {
		const configs: Record<string, MCPServerConfig> = {
			playwright: { command: "node" },
			myserver: { command: "node" },
		};
		const sources: Record<string, SourceMeta> = {
			playwright: source("playwright"),
			myserver: source("myserver"),
		};

		const result = filterBrowserMCPServers(configs, sources);

		expect(Object.keys(result.configs)).toEqual(["myserver"]);
		expect(result.configs.myserver).toEqual({ command: "node" });
		expect(result.sources).toEqual({ myserver: source("myserver") });
	});

	it("keeps a non-browser server that has no source entry without fabricating one", () => {
		const result = filterBrowserMCPServers({ other: { type: "http", url: "https://example.com/mcp" } }, {});
		expect(Object.keys(result.configs)).toEqual(["other"]);
		expect(result.sources).toEqual({});
	});

	it("returns empty records for empty input", () => {
		expect(filterBrowserMCPServers({}, {})).toEqual({ configs: {}, sources: {} });
	});
});
