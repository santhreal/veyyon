/**
 * An MCP server cannot flood the client with one line.
 *
 * WHY THIS SUITE EXISTS. `StdioTransport` reads a server's stdout with `readJsonl`, which
 * frames on the line feed. A local subprocess is the most trusted peer in the product and
 * the least examined: an MCP server is whatever the operator's config points at, it may be
 * a script fetched from anywhere, and before the frame bound existed one that wrote to
 * stdout without ever writing a newline grew the client's buffer until the agent process
 * died. Nothing in the existing stdio coverage sees it — those suites prove what happens
 * to a malformed LINE, and this failure happens before a line exists.
 *
 * This drives the real transport against a real subprocess, because the defect is in how
 * the transport consumes a real server's output: the fault has to arrive through
 * `onError`, the transport has to close instead of sitting on a dead child, and the error
 * has to name what the server did.
 *
 * WHAT THIS DOES NOT CATCH. The bound is declared in bytes and driven here through
 * `VEYYON_STREAM_FRAME_MAX_BYTES` so the test costs kilobytes instead of the compiled
 * 64 MiB default; the default itself is asserted in the utils suite. Nothing here covers
 * the HTTP or SSE transports, which read their own streams.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { StdioTransport } from "@veyyon/coding-agent/mcp/transports/stdio";
import { isStreamFrameLimitError, STREAM_FRAME_MAX_BYTES_ENV } from "@veyyon/utils/stream";

const CEILING = 64 * 1024;

/** A server that writes to stdout forever and never writes a line feed. */
const FLOODING_SERVER =
	'const chunk = "a".repeat(16 * 1024); for (;;) { process.stdout.write(chunk); await Bun.sleep(0); }';

/** A server that answers each framed JSON-RPC request it is sent, and frames its replies. */
const POLITE_SERVER =
	'for await (const line of console) { const msg = JSON.parse(line); process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }) + "\\n"); }';

const open: StdioTransport[] = [];
let previousCeiling: string | undefined;

afterEach(async () => {
	while (open.length > 0)
		await open
			.pop()
			?.close()
			.catch(() => {});
	if (previousCeiling === undefined) delete process.env[STREAM_FRAME_MAX_BYTES_ENV];
	else process.env[STREAM_FRAME_MAX_BYTES_ENV] = previousCeiling;
	previousCeiling = undefined;
});

function declareCeiling(bytes: number): void {
	previousCeiling = process.env[STREAM_FRAME_MAX_BYTES_ENV];
	process.env[STREAM_FRAME_MAX_BYTES_ENV] = String(bytes);
}

function transportFor(script: string): StdioTransport {
	const transport = new StdioTransport({ type: "stdio", command: process.execPath, args: ["-e", script] });
	open.push(transport);
	return transport;
}

describe("a stdio MCP server that never sends a newline", () => {
	it("is refused at the frame bound, and the fault reaches the transport's owner", async () => {
		declareCeiling(CEILING);
		const transport = transportFor(FLOODING_SERVER);
		const failed = Promise.withResolvers<unknown>();
		const closed = Promise.withResolvers<void>();
		transport.onError = error => failed.resolve(error);
		transport.onClose = () => closed.resolve();

		await transport.connect();
		const error = await failed.promise;
		// Bounded, and it ENDS: without the frame bound this promise never settles, which is
		// a timeout in CI rather than a wrong value nobody can see.
		await closed.promise;

		expect(isStreamFrameLimitError(error)).toBe(true);
		expect(String((error as Error).message)).toContain("no line feed");
		expect(String((error as Error).message)).toContain(String(CEILING));
	});

	it("still reads a server that frames its messages", async () => {
		declareCeiling(CEILING);
		const transport = transportFor(POLITE_SERVER);
		const failed: unknown[] = [];
		transport.onError = error => failed.push(error);

		await transport.connect();
		// A real request over the real transport: the server frames its reply with a line
		// feed and the bound never sees it, which is the half a bound can quietly break.
		const result = await transport.request("initialize", {});

		expect(result).toEqual({ ok: true });
		expect(failed).toEqual([]);
	});
});
