/**
 * Regression: an MCP response that never reached the server must be reported.
 *
 * Both the streamable-HTTP and the SSE transport answer server-to-client
 * requests (sampling, elicitation) by POSTing a JSON-RPC response back. Both
 * swallowed a failed POST, one of them under the comment "best-effort response
 * delivery".
 *
 * It is not best-effort from the server's side. The server asked a question, we
 * did the work to answer it, and then dropped the answer. The server waits on a
 * reply that never comes, so the operator sees an MCP tool that hangs, with
 * nothing anywhere connecting the hang to the send that failed (Law 10). Two
 * transports had the identical swallow, so the report has one owner and cannot
 * drift into describing the same failure two ways.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { reportUndeliveredServerResponse } from "@veyyon/coding-agent/mcp/transports/server-response-delivery";
import { logger } from "@veyyon/utils";

describe("reportUndeliveredServerResponse", () => {
	let warnings: Array<{ message: string; fields: Record<string, unknown> }>;

	beforeEach(() => {
		warnings = [];
		vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
			warnings.push({ message, fields: fields ?? {} });
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const report = (over: Partial<Parameters<typeof reportUndeliveredServerResponse>[0]> = {}): void =>
		reportUndeliveredServerResponse({
			url: "https://mcp.example.test/rpc",
			requestId: 42,
			kind: "result",
			cause: new Error("fetch failed: ECONNRESET"),
			...over,
		});

	it("says the server is still waiting, which is the consequence the operator needs", () => {
		// "Failed to POST response" describes our side. What matters to the reader
		// is that something downstream is now stuck.
		report();

		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.message).toBe(
			"Could not deliver a response to an MCP server request; the server is still waiting for it",
		);
	});

	it("names the server by URL, so a config with several is unambiguous", () => {
		report({ url: "https://other.example.test/rpc" });

		expect(warnings[0]?.fields.server).toBe("https://other.example.test/rpc");
	});

	it("names the JSON-RPC id, which is what ties the report to the stuck request", () => {
		report({ requestId: 99 });

		expect(warnings[0]?.fields.requestId).toBe(99);
	});

	it("carries a string id unchanged, since JSON-RPC allows either", () => {
		// Coercing it to a number would silently mangle ids from servers that use
		// strings, and the report would then point at a request that does not exist.
		report({ requestId: "req-7a" });

		expect(warnings[0]?.fields.requestId).toBe("req-7a");
	});

	it("distinguishes an undelivered error response from an undelivered result", () => {
		// They fail the same way and mean different things: a lost error response
		// means the server never learned its request was rejected.
		report({ kind: "error" });

		expect(warnings[0]?.fields.responseKind).toBe("error");
	});

	it("reports the underlying cause, not just that delivery failed", () => {
		// A connection reset and a timeout need different responses from the
		// operator, so the distinction has to survive into the log.
		report({ cause: new Error("The operation timed out") });

		expect(String(warnings[0]?.fields.error)).toContain("The operation timed out");
	});

	it("survives a thrown value that is not an Error", () => {
		// `fetch` and its abort paths can reject with a plain string or a
		// DOMException. Reporting must not itself throw on the way to reporting.
		report({ cause: "aborted" });

		expect(warnings).toHaveLength(1);
		expect(String(warnings[0]?.fields.error)).toContain("aborted");
	});

	it("tells the operator what to do, since the symptom they see is only a hang", () => {
		report();

		expect(String(warnings[0]?.fields.fix)).toContain("/mcp");
	});

	it("reports at warn, not debug, because a capability is actually lost", () => {
		// The original swallow is one demotion away from returning. Pinning the
		// level means that demotion fails here rather than silently shipping.
		const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});

		report();

		expect(warnings).toHaveLength(1);
		expect(debug).not.toHaveBeenCalled();
	});
});

/**
 * The owner being correct is not enough: both call sites have to use it.
 *
 * The original defect was two bare catches, and nothing about a well-tested
 * reporter stops one of them being reintroduced. These read the transport
 * sources, because the defect is a source pattern and no runtime observation
 * can see a `catch` that does nothing.
 */
describe("both transports route a failed server-response POST through the owner", () => {
	const TRANSPORTS = [
		{ name: "http", path: path.resolve(import.meta.dir, "../../src/mcp/transports/http.ts") },
		{ name: "sse", path: path.resolve(import.meta.dir, "../../src/mcp/transports/sse.ts") },
	];

	for (const transport of TRANSPORTS) {
		it(`${transport.name} calls reportUndeliveredServerResponse`, () => {
			const source = fs.readFileSync(transport.path, "utf8");

			expect(source).toContain("reportUndeliveredServerResponse({");
			expect(source).toContain('from "./server-response-delivery"');
		});

		it(`${transport.name} does not reintroduce its own copy of the report`, () => {
			// A second `logger.warn` with this text would mean the two transports had
			// drifted apart again, which is the state the owner exists to end.
			const source = fs.readFileSync(transport.path, "utf8");

			expect(source).not.toContain("the server is still waiting for it");
		});

		it(`${transport.name} has no bare catch left in its server-response path`, () => {
			// The exact shape of the original defect: `} catch {` with a comment or
			// nothing, discarding the send failure.
			const source = fs.readFileSync(transport.path, "utf8");
			const inSendServerResponse = source.slice(
				source.indexOf("async #sendServerResponse"),
				source.indexOf("async #sendServerResponse") + 3_000,
			);

			expect(inSendServerResponse).not.toContain("} catch {");
			expect(inSendServerResponse).not.toContain("Best-effort response delivery");
		});
	}

	it("reads real transport sources, so a passing scan means something", () => {
		// Anti-vacuity. A moved or renamed file would otherwise make every scan
		// above pass against an empty string.
		for (const transport of TRANSPORTS) {
			const source = fs.readFileSync(transport.path, "utf8");
			expect(source.length).toBeGreaterThan(5_000);
			expect(source).toContain("async #sendServerResponse");
		}
	});
});
