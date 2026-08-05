/**
 * An MCP HTTP failure reaches the MODEL, so it must be bounded and must say what
 * to do.
 *
 * WHAT WAS WRONG. Five sites across `mcp/transports/http.ts` and
 * `mcp/transports/sse.ts` threw `HTTP ${response.status}: ${await
 * response.text()}`. The body was echoed verbatim, so a proxy's HTML error page
 * or a verbose gateway response became the entire error, and that error is what
 * the tool result carries and the transcript keeps. The message also named
 * neither the server nor a remedy, so the two readers who need it, the operator
 * deciding which of several configured servers is broken and the model deciding
 * whether to retry, both got a bare status code.
 *
 * THE TEST DRIVES THE REAL TRANSPORT against a local `node:http` server rather
 * than asserting the formatter alone, because the formatter being correct and the
 * transport not calling it is exactly the half-wired shape that ships green.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as http from "node:http";
import { HttpTransport } from "@veyyon/coding-agent/mcp/transports/http";

let server: http.Server;
let url: string;
let respond: (res: http.ServerResponse) => void;

beforeEach(async () => {
	server = http.createServer((_req, res) => respond(res));
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("expected a TCP address");
	url = `http://127.0.0.1:${address.port}/mcp`;
});

afterEach(async () => {
	await new Promise<void>(resolve => server.close(() => resolve()));
});

async function failureMessage(): Promise<string> {
	const transport = new HttpTransport({ type: "http", url });
	// `connect()` on this transport is a flag flip, not a handshake, so the fixture
	// needs no `initialize` exchange to reach the request path under test.
	await transport.connect();
	try {
		await transport.request("tools/list", {});
	} catch (error) {
		return (error as Error).message;
	}
	throw new Error("expected the request to fail");
}

describe("an MCP HTTP failure", () => {
	/**
	 * The body cap, exercised with the payload that actually causes this: a proxy
	 * error page. 200,000 characters is not a hostile input, it is one badly
	 * configured gateway.
	 */
	it("does not paste a 200,000-character error page into the message", async () => {
		respond = res => {
			res.writeHead(502, { "Content-Type": "text/html" });
			res.end(`<html><body>${"x".repeat(200_000)}</body></html>`);
		};

		const message = await failureMessage();

		expect(message.length).toBeLessThanOrEqual(1200);
		expect(message).toStartWith(`MCP request to ${url} failed: HTTP 502: <html><body>xxx`);
		expect(message).toEndWith(
			"Fix: the server failed, not the request. Retry, and check the server's own logs if it persists.",
		);
	});

	/**
	 * Every status that carries a specific next step, in one pass, because a
	 * remedy added for the branch someone happened to open is the defect class
	 * this session keeps finding. The `/mcp` subcommands named are real: `/mcp`
	 * declares `textMode: true` and `list` / `reauth` are declared subcommands, so
	 * a text client can run them too.
	 */
	it("names the remedy each status implies, and names none when the status implies none", async () => {
		const expected: ReadonlyArray<[number, string]> = [
			[
				401,
				"Fix: run `/mcp list` to find this server's name, then `/mcp reauth <name>`, or check its token in your MCP configuration.",
			],
			[403, "Fix: run `/mcp list` to find this server's name, then `/mcp reauth <name>`"],
			[404, "Fix: check the server URL. A 404 here usually means the path is wrong rather than the host."],
			[429, "Fix: the server is rate limiting. Retry after a pause rather than immediately."],
			[500, "Fix: the server failed, not the request."],
			[503, "Fix: the server failed, not the request."],
		];

		for (const [status, remedy] of expected) {
			respond = res => {
				res.writeHead(status, { "Content-Type": "text/plain" });
				res.end("upstream said no");
			};
			const message = await failureMessage();
			expect(message).toStartWith(`MCP request to ${url} failed: HTTP ${status}: upstream said no. Fix: `);
			expect(message).toContain(remedy);
		}

		// A status with no specific next step says nothing rather than guessing one.
		respond = res => {
			res.writeHead(418, { "Content-Type": "text/plain" });
			res.end("teapot");
		};
		expect(await failureMessage()).toBe(`MCP request to ${url} failed: HTTP 418: teapot`);
	});

	/**
	 * The WHOLE-MESSAGE ceiling, which the body cap alone does not reach. The URL
	 * is echoed and comes from configuration, and an MCP endpoint carrying a signed
	 * token in its path is ordinary rather than hostile, so a long URL plus a
	 * capped body plus a remedy composes past the ceiling. This is the "per-field
	 * caps that never compose into a total" shape, on the one field that is not
	 * capped because truncating a URL would make it useless.
	 */
	it("bounds the whole message when the URL is the oversized part", async () => {
		respond = res => {
			res.writeHead(500, { "Content-Type": "text/plain" });
			res.end("z".repeat(2000));
		};
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("expected a TCP address");
		const longUrl = `http://127.0.0.1:${address.port}/${"a".repeat(2000)}`;
		const transport = new HttpTransport({ type: "http", url: longUrl });
		await transport.connect();

		let message = "";
		try {
			await transport.request("tools/list", {});
		} catch (error) {
			message = (error as Error).message;
		}

		expect(longUrl.length).toBeGreaterThan(2000);
		expect(message.length).toBe(1200);
		expect(message).toEndWith("\u2026");
	});

	/** The auth headers the transport already collected still travel, after the remedy exists. */
	it("keeps the auth hints alongside the remedy", async () => {
		respond = res => {
			res.writeHead(401, { "WWW-Authenticate": 'Bearer realm="mcp"', "Content-Type": "text/plain" });
			res.end("no token");
		};

		const message = await failureMessage();

		expect(message).toContain('[WWW-Authenticate: Bearer realm="mcp"]');
		expect(message).toContain("/mcp reauth <name>");
	});
});
