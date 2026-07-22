import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { HttpTransport, resolveSSEConnectTimeoutMs } from "@veyyon/coding-agent/mcp/transports/http";

const encoder = new TextEncoder();
const REQUEST_TIMEOUT_MS = 50;
const GUARD_TIMEOUT_MS = 500;

let server: Bun.Server<undefined> | null = null;

type ToolList = {
	tools: { name: string; inputSchema: { type: string } }[];
};

afterEach(() => {
	server?.stop(true);
	server = null;
});

async function connectedTransport(): Promise<HttpTransport> {
	if (!server) throw new Error("Test server was not started");
	const transport = new HttpTransport({
		type: "http",
		url: `http://127.0.0.1:${server.port}/mcp`,
		timeout: REQUEST_TIMEOUT_MS,
	});
	await transport.connect();
	return transport;
}

function stalledBodyResponse(bodyPrefix: string, init?: ResponseInit): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(bodyPrefix));
			},
		}),
		init,
	);
}

// Real time is intentional: this exercises Bun fetch aborting a live HTTP body stream,
// which fake timers do not drive through the socket/readable-stream stack.
async function withPendingGuard<T>(promise: Promise<T>, label: string): Promise<T> {
	return await Promise.race([
		promise,
		Bun.sleep(GUARD_TIMEOUT_MS).then(() => {
			throw new Error(`${label} stayed pending past ${GUARD_TIMEOUT_MS}ms`);
		}),
	]);
}

describe("MCP Streamable HTTP transport timeouts", () => {
	it("keeps the request timeout active until a JSON response body is fully read", async () => {
		server = Bun.serve({
			port: 0,
			fetch() {
				return stalledBodyResponse('{"jsonrpc":"2.0","id":"', {
					headers: { "Content-Type": "application/json" },
				});
			},
		});
		const transport = await connectedTransport();

		await expect(withPendingGuard(transport.request("tools/list"), "request")).rejects.toThrow(
			`Request timeout after ${REQUEST_TIMEOUT_MS}ms`,
		);
	});

	it("keeps the notify timeout active while reading HTTP error bodies", async () => {
		server = Bun.serve({
			port: 0,
			fetch() {
				return stalledBodyResponse("partial failure body", {
					status: 500,
					headers: { "Content-Type": "text/plain" },
				});
			},
		});
		const transport = await connectedTransport();

		await expect(withPendingGuard(transport.notify("notifications/initialized"), "notify")).rejects.toThrow(
			`Notify timeout after ${REQUEST_TIMEOUT_MS}ms`,
		);
	});

	it("still resolves normal JSON response bodies", async () => {
		server = Bun.serve({
			port: 0,
			fetch() {
				return Response.json({
					jsonrpc: "2.0",
					id: 1,
					result: { tools: [{ name: "fast", inputSchema: { type: "object" } }] },
				});
			},
		});
		const transport = await connectedTransport();

		await expect(withPendingGuard(transport.request<ToolList>("tools/list"), "request")).resolves.toEqual({
			tools: [{ name: "fast", inputSchema: { type: "object" } }],
		});
	});
});

/**
 * resolveSSEConnectTimeoutMs derives how long to wait for the initial SSE connect from the server's
 * request timeout. It had no direct test. The contract: a disabled request timeout (<= 0) disables
 * the connect timeout too (returns 0, meaning "wait indefinitely"); otherwise it is a quarter of the
 * request timeout, HARD-CAPPED at HTTP_SSE_CONNECT_TIMEOUT_MS (1000ms) so a huge request timeout does
 * not leave a hung connect for minutes, and floored to at least 1ms so a tiny positive timeout never
 * collapses to the "disabled" sentinel of 0. A regression here either hangs a dead SSE connect or
 * aborts a healthy one too eagerly.
 */
describe("resolveSSEConnectTimeoutMs", () => {
	// The resolver consults VEYYON_MCP_TIMEOUT_MS; isolate the test from the host env.
	let savedEnv: string | undefined;
	beforeEach(() => {
		savedEnv = process.env.VEYYON_MCP_TIMEOUT_MS;
		delete process.env.VEYYON_MCP_TIMEOUT_MS;
	});
	afterEach(() => {
		if (savedEnv === undefined) delete process.env.VEYYON_MCP_TIMEOUT_MS;
		else process.env.VEYYON_MCP_TIMEOUT_MS = savedEnv;
	});

	it("caps the connect timeout at 1000ms for the default (30s) request timeout", () => {
		// 30_000 / 4 = 7_500, capped to 1_000.
		expect(resolveSSEConnectTimeoutMs(undefined)).toBe(1_000);
		expect(resolveSSEConnectTimeoutMs(100_000)).toBe(1_000);
	});

	it("uses a quarter of the request timeout when that is below the cap", () => {
		expect(resolveSSEConnectTimeoutMs(2_000)).toBe(500);
		expect(resolveSSEConnectTimeoutMs(40)).toBe(10);
	});

	it("returns 0 (disabled) when the request timeout is disabled", () => {
		expect(resolveSSEConnectTimeoutMs(0)).toBe(0);
	});

	it("floors a tiny positive timeout to at least 1ms so it never collapses to the disabled sentinel", () => {
		// 1 / 4 = 0.25 -> floor 0 -> clamped up to 1.
		expect(resolveSSEConnectTimeoutMs(1)).toBe(1);
		expect(resolveSSEConnectTimeoutMs(4)).toBe(1);
	});
});
