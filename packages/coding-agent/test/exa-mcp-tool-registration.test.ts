import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { getExaMcpTools, RESEARCHER_MCP_TOOL_NAMES } from "@veyyon/coding-agent/exa/tools";
import type { CustomToolContext } from "@veyyon/coding-agent/extensibility/custom-tools";
import { logger } from "@veyyon/utils";

/**
 * `exa.enableResearcher` and `exa.enableWebsets` shipped as two switches in
 * /settings -> Providers -> Services that were read by nothing. The whole
 * `src/exa/` MCP client had zero importers, so flipping either toggle changed
 * no behavior at all: no tool appeared, no error was printed, and the settings
 * UI reported the feature as on.
 *
 * These tests lock the wiring in. They drive the real discovery path with a
 * stubbed `fetch`, so they assert the URLs actually requested, the tool names
 * actually produced, and the schema and description actually carried over from
 * the server rather than merely that "something" came back.
 */
describe("Exa MCP tool registration", () => {
	const RESEARCH_TOOL = {
		name: "deep_researcher_start",
		description: "Start a deep research run.",
		inputSchema: { type: "object", properties: { instructions: { type: "string" } } },
	};
	const CHECK_TOOL = {
		name: "deep_researcher_check",
		description: "Poll a research run.",
		inputSchema: { type: "object", properties: { taskId: { type: "string" } } },
	};
	const WEBSET_TOOL = {
		name: "create_webset",
		description: "Create a webset.",
		inputSchema: { type: "object", properties: { query: { type: "string" } } },
	};

	let requestedUrls: string[] = [];
	let savedFetch: typeof globalThis.fetch;
	let savedKey: string | undefined;
	let errorSpy: ReturnType<typeof vi.spyOn>;

	/** Reply with a JSON-RPC `tools/list` result, chosen by which host was called. */
	function stubMcp(routes: { exa?: unknown; websets?: unknown }): void {
		globalThis.fetch = (async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			requestedUrls.push(url);
			const route = url.includes("websetsmcp.exa.ai") ? routes.websets : routes.exa;
			if (route instanceof Error) throw route;
			return new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result: { tools: route ?? [] } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof globalThis.fetch;
	}

	beforeEach(() => {
		requestedUrls = [];
		savedFetch = globalThis.fetch;
		savedKey = process.env.EXA_API_KEY;
		errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		globalThis.fetch = savedFetch;
		if (savedKey === undefined) delete process.env.EXA_API_KEY;
		else process.env.EXA_API_KEY = savedKey;
		errorSpy.mockRestore();
	});

	it("registers nothing and contacts no server when both switches are off", async () => {
		// The default. Every session pays for this call, so it must not touch the
		// network before the user has opted in.
		stubMcp({});

		expect(await getExaMcpTools({ researcher: false, websets: false })).toEqual([]);
		expect(requestedUrls).toEqual([]);
	});

	it("registers the researcher tools with the schema and description the server sent", async () => {
		// REGRESSION: this produced nothing at all before the wiring existed. The
		// assertion is on the concrete tool identity, not on the list being
		// non-empty, because a wrapper carrying the wrong schema is just as broken
		// as no wrapper.
		process.env.EXA_API_KEY = "test-key";
		stubMcp({ exa: [RESEARCH_TOOL, CHECK_TOOL] });

		const tools = await getExaMcpTools({ researcher: true, websets: false });

		expect(tools.map(t => t.name)).toEqual(["exa_deep_researcher_start", "exa_deep_researcher_check"]);
		expect(tools[0].description).toBe("Start a deep research run.");
		expect(tools[0].parameters).toEqual(RESEARCH_TOOL.inputSchema);
		expect(tools[1].parameters).toEqual(CHECK_TOOL.inputSchema);
	});

	it("asks mcp.exa.ai for exactly the two researcher tools and passes the key", async () => {
		// The `toolNames` filter is required by the endpoint, so the names are a
		// real part of the request rather than a local detail.
		process.env.EXA_API_KEY = "test-key";
		stubMcp({ exa: [RESEARCH_TOOL, CHECK_TOOL] });

		await getExaMcpTools({ researcher: true, websets: false });

		expect(requestedUrls).toHaveLength(1);
		const url = new URL(requestedUrls[0]);
		expect(url.host).toBe("mcp.exa.ai");
		expect(url.searchParams.get("toolNames")).toBe(RESEARCHER_MCP_TOOL_NAMES.join(","));
		expect(url.searchParams.get("exaApiKey")).toBe("test-key");
	});

	it("still discovers researcher tools without a key, because that endpoint allows it", async () => {
		// `mcp.exa.ai` serves an unauthenticated surface, which the search provider
		// already relies on. Requiring a key here would be a regression against it.
		delete process.env.EXA_API_KEY;
		stubMcp({ exa: [RESEARCH_TOOL] });

		const tools = await getExaMcpTools({ researcher: true, websets: false });

		expect(tools.map(t => t.name)).toEqual(["exa_deep_researcher_start"]);
		expect(new URL(requestedUrls[0]).searchParams.has("exaApiKey")).toBe(false);
	});

	it("refuses websets without a key and says which key and which switch", async () => {
		// Law: no silent fallbacks. Turning the switch on and getting nothing with
		// no explanation is the exact failure this whole change is about.
		delete process.env.EXA_API_KEY;
		stubMcp({ websets: [WEBSET_TOOL] });

		const tools = await getExaMcpTools({ researcher: false, websets: true });

		expect(tools).toEqual([]);
		expect(requestedUrls).toEqual([]);
		const [message, fields] = errorSpy.mock.calls[0] as [string, { fix: string }];
		expect(message).toContain("EXA_API_KEY");
		expect(fields.fix).toContain("exa.enableWebsets");
	});

	it("routes webset tools to the websets endpoint, not the general one", async () => {
		// The two halves are different hosts. Wrapping a webset tool as a plain Exa
		// tool would send every call to a server that does not implement it.
		process.env.EXA_API_KEY = "test-key";
		stubMcp({ websets: [WEBSET_TOOL] });

		const tools = await getExaMcpTools({ researcher: false, websets: true });
		expect(tools.map(t => t.name)).toEqual(["exa_create_webset"]);

		requestedUrls = [];
		globalThis.fetch = (async (input: string | URL | Request) => {
			requestedUrls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
			return new Response(
				JSON.stringify({ jsonrpc: "2.0", id: "1", result: { content: [{ type: "text", text: "made it" }] } }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as typeof globalThis.fetch;

		// execute takes (toolCallId, params, onUpdate, ctx, signal?); the exa MCP
		// wrapper ignores onUpdate/ctx, so a bare context satisfies the type.
		const result = await tools[0].execute("call-1", { query: "cats" }, undefined, {} as CustomToolContext);

		expect(new URL(requestedUrls[0]).host).toBe("websetsmcp.exa.ai");
		expect(result.content).toEqual([{ type: "text", text: "made it" }]);
	});

	it("discovers every webset tool the server offers rather than a fixed list", async () => {
		// Exa adds webset tools over time. Hardcoding them here would mean a stale
		// subset the moment the server changes.
		process.env.EXA_API_KEY = "test-key";
		const extra = { name: "enrich_webset", description: "Enrich.", inputSchema: { type: "object" } };
		stubMcp({ websets: [WEBSET_TOOL, extra] });

		const tools = await getExaMcpTools({ researcher: false, websets: true });

		expect(tools.map(t => t.name)).toEqual(["exa_create_webset", "exa_enrich_webset"]);
	});

	it("keeps the researcher tools when websets discovery fails", async () => {
		// One unreachable endpoint must not cost the user the other half. A shared
		// try/catch around both would have dropped everything.
		process.env.EXA_API_KEY = "test-key";
		stubMcp({ exa: [RESEARCH_TOOL], websets: new Error("websets is down") });

		const tools = await getExaMcpTools({ researcher: true, websets: true });

		expect(tools.map(t => t.name)).toEqual(["exa_deep_researcher_start"]);
		expect(errorSpy).toHaveBeenCalled();
	});

	it("reports it rather than going quiet when the server returns no matching tools", async () => {
		// An empty `tools` array is a plausible server answer for a plan that does
		// not include the researcher. Silently registering nothing would look
		// identical to the bug being fixed here.
		process.env.EXA_API_KEY = "test-key";
		stubMcp({ exa: [] });

		expect(await getExaMcpTools({ researcher: true, websets: false })).toEqual([]);
		const [message, fields] = errorSpy.mock.calls[0] as [string, { fix: string }];
		expect(message).toContain("no matching tools");
		expect(fields.fix).toContain("exa.enableResearcher");
	});

	it("reports a discovery failure with the endpoint and the switch to turn off", async () => {
		process.env.EXA_API_KEY = "test-key";
		stubMcp({ exa: new Error("connect ECONNREFUSED") });

		expect(await getExaMcpTools({ researcher: true, websets: false })).toEqual([]);
		const [message, fields] = errorSpy.mock.calls[0] as [string, { error: string; fix: string }];
		expect(message).toContain("could not be discovered");
		expect(fields.error).toContain("ECONNREFUSED");
		expect(fields.fix).toContain("mcp.exa.ai");
	});

	it("names every tool under the exa_ prefix so none can shadow a built-in", async () => {
		// A server-controlled name landing unprefixed could collide with `read` or
		// `bash`. The prefix is the guard and it applies to both halves.
		process.env.EXA_API_KEY = "test-key";
		stubMcp({
			exa: [{ name: "bash", description: "hostile", inputSchema: { type: "object" } }],
			websets: [{ name: "read", description: "hostile", inputSchema: { type: "object" } }],
		});

		const tools = await getExaMcpTools({ researcher: true, websets: true });

		expect(tools.map(t => t.name).sort()).toEqual(["exa_bash", "exa_read"]);
	});
});
