/**
 * Regression: an MCP stdio server's diagnostics must not be thrown away.
 *
 * `StdioTransport` discarded two different things, both of which the operator
 * needs precisely when something is wrong:
 *
 *  1. `#startReadLoop` wrapped `#handleMessage` in `catch { // Skip malformed
 *     lines }`. A dropped line is not always harmless. If it was the RESPONSE
 *     to a pending request, that request waits until its timeout with no
 *     explanation, so the operator sees an MCP tool that hangs and there is
 *     nothing anywhere linking the hang to the line that was skipped.
 *  2. `#startStderrLoop` decoded the server's stderr and then did nothing with
 *     it, under a comment reading "For now, silent - MCP spec says clients MAY
 *     capture/ignore". A server's stderr is where it explains why it is
 *     failing. Discarding it left anyone debugging a misbehaving MCP server
 *     with no information at all. The spec permitting it is permission, not a
 *     reason (Law 10).
 *
 * The two get different levels on purpose, and that difference is part of the
 * contract these tests pin. A skipped message is something going wrong, so it
 * warns. Stderr is ordinary server logging, so it goes to debug; warning on it
 * would make a chatty server fill the log with false alarms, which is how a
 * loud channel stops being read.
 *
 * These drive a REAL subprocess rather than stubbing the streams, because the
 * defect lives in how the transport consumes a real server's output.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { StdioTransport } from "@veyyon/coding-agent/mcp/transports/stdio";
import { logger } from "@veyyon/utils";

/** A server script run under the current runtime, so no fixture files are needed. */
function serverRunning(script: string): StdioTransport {
	return new StdioTransport({ type: "stdio", command: process.execPath, args: ["-e", script] });
}

/** Give the transport's read loops a moment to consume what the child wrote. */
const settle = (): Promise<void> => Bun.sleep(300);

describe("StdioTransport surfaces what an MCP server tells it", () => {
	let warnings: Array<{ message: string; fields: Record<string, unknown> }>;
	let debugs: Array<{ message: string; fields: Record<string, unknown> }>;
	let open: StdioTransport[];

	beforeEach(() => {
		warnings = [];
		debugs = [];
		open = [];
		vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
			warnings.push({ message, fields: fields ?? {} });
		});
		vi.spyOn(logger, "debug").mockImplementation((message: string, fields?: Record<string, unknown>) => {
			debugs.push({ message, fields: fields ?? {} });
		});
	});

	afterEach(async () => {
		for (const transport of open) await transport.close().catch(() => {});
		vi.restoreAllMocks();
	});

	async function connected(script: string): Promise<StdioTransport> {
		const transport = serverRunning(script);
		open.push(transport);
		await transport.connect();
		return transport;
	}

	it("reports a server's stderr instead of decoding it and discarding it", async () => {
		// THE second regression. The text was already being decoded, so the only
		// thing missing was letting anyone see it.
		await connected('process.stderr.write("db connection refused\\n"); await Bun.sleep(2000);');
		await settle();

		const stderr = debugs.filter(d => d.message === "MCP server stderr");
		expect(stderr.length).toBeGreaterThan(0);
		expect(String(stderr[0]?.fields.text)).toContain("db connection refused");
	});

	it("names which server the stderr came from, since a config can have several", async () => {
		await connected('process.stderr.write("hello\\n"); await Bun.sleep(2000);');
		await settle();

		const stderr = debugs.find(d => d.message === "MCP server stderr");
		expect(stderr?.fields.server).toBe(process.execPath);
	});

	it("reports server stderr at debug, not warn, because servers log there normally", async () => {
		// A chatty server must not produce a stream of warnings. That is what turns
		// a loud channel into one people filter out.
		await connected('process.stderr.write("routine startup log\\n"); await Bun.sleep(2000);');
		await settle();

		expect(warnings.filter(w => w.message.includes("stderr"))).toEqual([]);
	});

	it("does not report empty stderr writes", async () => {
		// Whitespace-only flushes are common and mean nothing.
		await connected('process.stderr.write("   \\n"); await Bun.sleep(2000);');
		await settle();

		expect(debugs.filter(d => d.message === "MCP server stderr")).toEqual([]);
	});

	it("reports a message it could not handle instead of silently skipping it", async () => {
		// THE first regression. A JSON line that parses but whose handling throws is
		// what `catch {}` swallowed; the transport must keep running AND say so.
		// A bare JSON string is valid JSON and parses fine, then `"method" in
		// message` throws because `in` rejects a primitive. That is the realistic
		// shape of the "malformed line" the old catch swallowed.
		await connected('process.stdout.write(JSON.stringify("not an object")+"\\n"); await Bun.sleep(2000);');
		await settle();

		const skipped = warnings.filter(w => w.message === "Ignored an unreadable message from an MCP server");
		expect(skipped).toHaveLength(1);
		expect(skipped[0]?.fields.server).toBe(process.execPath);
		expect(String(skipped[0]?.fields.line)).toContain("not an object");
		// The report has to connect the skipped line to the symptom the operator
		// actually sees, which is a tool call that never returns.
		expect(String(skipped[0]?.fields.fix)).toContain("hangs");
		expect(String(skipped[0]?.fields.error)).not.toBe("");
	});

	it("keeps reading after a line it could not handle, rather than killing the connection", async () => {
		// One bad line must not take down a working server. The loop continues, and
		// the proof is that stderr written afterwards still arrives.
		await connected(
			'process.stdout.write(JSON.stringify("not an object")+"\\n");' +
				'await Bun.sleep(50); process.stderr.write("still alive\\n"); await Bun.sleep(2000);',
		);
		await settle();

		const stderr = debugs.filter(d => d.message === "MCP server stderr");
		expect(stderr.some(d => String(d.fields.text).includes("still alive"))).toBe(true);
	});

	it("stays quiet for a server that behaves, so the reports above mean something", async () => {
		// Anti-vacuity: if the transport reported on the healthy path too, every
		// assertion above would pass for the wrong reason.
		await connected("await Bun.sleep(2000);");
		await settle();

		expect(warnings.filter(w => w.message.includes("MCP server"))).toEqual([]);
		expect(debugs.filter(d => d.message === "MCP server stderr")).toEqual([]);
	});

	it("truncates a huge line in the report rather than logging the whole thing", async () => {
		// The report exists to identify WHICH message was lost, not to reproduce
		// it. A server can emit an arbitrarily large line, and a log entry that
		// large is its own problem.
		const huge = "x".repeat(20_000);
		await connected(`process.stdout.write(JSON.stringify("${huge}")+"\\n"); await Bun.sleep(2000);`);
		await settle();

		const skipped = warnings.filter(w => w.message === "Ignored an unreadable message from an MCP server");
		expect(skipped).toHaveLength(1);
		expect(String(skipped[0]?.fields.line).length).toBeLessThanOrEqual(501);
	});
});
