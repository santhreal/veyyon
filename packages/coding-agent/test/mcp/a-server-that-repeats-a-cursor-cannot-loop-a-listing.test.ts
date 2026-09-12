/**
 * A cursor-paginated MCP listing ends, whatever the server's cursors do.
 *
 * WHY THIS SUITE EXISTS. `tools/list` grew a repeated-cursor guard and a page limit after a server
 * answered every page with the same cursor (see `mcp/tool-list-validation.ts`): no request timeout
 * catches that, because each request answers promptly, so the loop grew its list until the process
 * died. `resources/list`, `resources/templates/list` and `prompts/list` paginate the same way and had
 * no guard at all; the same server would have hung a `/mcp` resource listing. `listAllPages` in
 * `mcp/client.ts` now states the guard once, and this sweep holds every list method to it.
 *
 * CLASS CLOSED. Every exported `list*` of the MCP client that paginates: a repeated cursor ends the
 * listing with the pages collected so far, the page limit ends a listing whose cursors never repeat,
 * and an honest multi-page listing is collected in full. A new list method must be added to
 * `LISTINGS` below or the exact-equality pin on the client's `list*` exports fails.
 *
 * NOT CAUGHT. The bound is asserted as a request count, not a wall-clock: a server that answers one
 * page slowly is the request timeout's problem, not this suite's.
 */
import { describe, expect, it, spyOn } from "bun:test";
import * as client from "@veyyon/coding-agent/mcp/client";
import { MAX_TOOL_LIST_PAGES } from "@veyyon/coding-agent/mcp/tool-list-validation";
import type { MCPServerCapabilities, MCPServerConnection, MCPTransport } from "@veyyon/coding-agent/mcp/types";
import * as utils from "@veyyon/utils";
import { createMockConnection } from "../helpers/mcp-mocks";

interface Listing {
	method: string;
	capabilities: MCPServerCapabilities;
	/** The item field whose value carries the page index. */
	key: string;
	list(connection: MCPServerConnection): Promise<unknown[]>;
	page(index: number, nextCursor: string | undefined): Record<string, unknown>;
}

const LISTINGS: Record<string, Listing> = {
	listTools: {
		method: "tools/list",
		capabilities: { tools: {} },
		key: "name",
		list: connection => client.listTools(connection),
		page: (index, nextCursor) => ({
			tools: [{ name: `tool-${index}`, inputSchema: { type: "object" } }],
			nextCursor,
		}),
	},
	listResources: {
		method: "resources/list",
		capabilities: { resources: {} },
		key: "uri",
		list: connection => client.listResources(connection),
		page: (index, nextCursor) => ({ resources: [{ uri: `file:///${index}`, name: `${index}` }], nextCursor }),
	},
	listResourceTemplates: {
		method: "resources/templates/list",
		capabilities: { resources: {} },
		key: "uriTemplate",
		list: connection => client.listResourceTemplates(connection),
		page: (index, nextCursor) => ({
			resourceTemplates: [{ uriTemplate: `file:///{${index}}`, name: `${index}` }],
			nextCursor,
		}),
	},
	listPrompts: {
		method: "prompts/list",
		capabilities: { prompts: {} },
		key: "name",
		list: connection => client.listPrompts(connection),
		page: (index, nextCursor) => ({ prompts: [{ name: `prompt-${index}` }], nextCursor }),
	},
};

/** A transport that answers `method` from `cursorAt` forever, counting requests. */
function endlessTransport(
	method: string,
	listing: Listing,
	cursorAt: (index: number) => string | undefined,
): MCPTransport & { requests: number } {
	const transport = {
		connected: true,
		requests: 0,
		async request<T>(requested: string): Promise<T> {
			if (requested !== method) throw new Error(`unexpected ${requested}`);
			const index = transport.requests++;
			return listing.page(index, cursorAt(index)) as T;
		},
		async notify() {},
		async close() {},
	};
	return transport;
}

describe("a server that repeats a cursor cannot loop a listing", () => {
	it("covers every paginated list method the client exports", () => {
		const exported = Object.keys(client)
			.filter(name => name.startsWith("list"))
			.sort();
		expect(exported).toEqual(Object.keys(LISTINGS).sort());
	});

	for (const [name, listing] of Object.entries(LISTINGS)) {
		it(`${name}: a repeated cursor ends the listing with the pages collected so far`, async () => {
			const warn = spyOn(utils.logger, "warn").mockImplementation(() => {});
			try {
				const transport = endlessTransport(listing.method, listing, () => "same");
				const items = await listing.list(createMockConnection(listing.capabilities, transport));
				// Page 0 returns "same", page 1 returns "same" again: the second sighting stops it.
				expect(transport.requests).toBe(2);
				expect(items).toHaveLength(2);
				const messages = warn.mock.calls.map(([message]) => String(message));
				expect(messages).toHaveLength(1);
				expect(messages[0]).toContain("repeated a pagination cursor");
			} finally {
				warn.mockRestore();
			}
		});

		it(`${name}: the page limit ends a listing whose cursors never repeat`, async () => {
			const warn = spyOn(utils.logger, "warn").mockImplementation(() => {});
			try {
				const transport = endlessTransport(listing.method, listing, index => `cursor-${index}`);
				const items = await listing.list(createMockConnection(listing.capabilities, transport));
				expect(transport.requests).toBe(MAX_TOOL_LIST_PAGES);
				expect(items).toHaveLength(MAX_TOOL_LIST_PAGES);
				const messages = warn.mock.calls.map(([message]) => String(message));
				expect(messages).toHaveLength(1);
				expect(messages[0]).toContain("page limit");
			} finally {
				warn.mockRestore();
			}
		});

		it(`${name}: an honest three-page listing is collected in full and in order`, async () => {
			const transport = endlessTransport(listing.method, listing, index =>
				index < 2 ? `cursor-${index}` : undefined,
			);
			const items = await listing.list(createMockConnection(listing.capabilities, transport));
			expect(transport.requests).toBe(3);
			// Each page's item carries its page index in `key`, so order is visible.
			expect(items.map(item => (item as Record<string, unknown>)[listing.key])).toEqual([
				expect.stringContaining("0"),
				expect.stringContaining("1"),
				expect.stringContaining("2"),
			]);
		});
	}
});
