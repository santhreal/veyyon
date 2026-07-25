import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { StdioTransport } from "@veyyon/coding-agent/mcp/transports/stdio";
import { removeWithRetries } from "@veyyon/utils";

/**
 * When an MCP server dies, the caller must learn WHY, not just THAT.
 *
 * WHY THIS SUITE EXISTS (MCP-2). A stdio MCP server is a subprocess veyyon
 * spawns, and it dies for ordinary reasons: a missing API key, a bad path, an
 * unhandled exception on a malformed request. When it does, the server almost
 * always explains itself on stderr first, because that is what a well-behaved
 * program does before exiting.
 *
 * Veyyon read that stderr and sent it to `logger.debug`, which is off by
 * default, and then rejected every in-flight request with the bare string
 * "Transport closed". So the one message that reached the operator and the
 * agent contained no server name, no exit status, and none of the server's own
 * account of what went wrong. A clean shutdown and a crash on a missing
 * credential produced identical text, and the difference between them is the
 * whole of the fix.
 *
 * The debug-level logging was not itself wrong: servers use stderr for routine
 * chatter, and promoting all of it would fill the log with false alarms. What
 * was missing is that on DEATH those same lines stop being chatter and become
 * the only diagnosis available. So a bounded tail is retained and spent exactly
 * once, in the error the crash produces.
 *
 * These tests spawn REAL subprocesses that really die, because the behaviour
 * under test is the interaction between process exit, the stderr stream, and
 * the pending-request map. A mocked transport would prove only that the string
 * concatenation works.
 */

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-stdio-crash-"));
});

afterEach(async () => {
	await removeWithRetries(tmpDir);
});

/**
 * Write a script that acts as a doomed MCP server: it emits `stderrLines` on
 * stderr, then exits with `exitCode` without ever answering a request.
 */
async function writeDoomedServer(options: {
	stderrLines: string[];
	exitCode: number;
	delayMs?: number;
}): Promise<string> {
	const file = path.join(tmpDir, "doomed-server.ts");
	await Bun.write(
		file,
		`
${options.stderrLines.map(line => `process.stderr.write(${JSON.stringify(`${line}\n`)});`).join("\n")}
await new Promise(resolve => setTimeout(resolve, ${options.delayMs ?? 50}));
process.exit(${options.exitCode});
`,
	);
	return file;
}

function transportFor(scriptPath: string): StdioTransport {
	return new StdioTransport({ args: [scriptPath], command: "bun" });
}

describe("a stdio MCP server that dies mid-request", () => {
	/**
	 * The core contract. An in-flight request must reject with the server's own
	 * last words, because those are the actual diagnosis: "missing OPENAI_API_KEY"
	 * tells an operator what to do, "Transport closed" does not.
	 */
	it("rejects the in-flight request with the server's own stderr", async () => {
		const script = await writeDoomedServer({
			exitCode: 1,
			stderrLines: ["Error: missing OPENAI_API_KEY", "  at start (server.ts:12)"],
		});
		const transport = transportFor(script);
		await transport.connect();

		const rejection = await transport.request("tools/list").catch((error: unknown) => error);

		expect(rejection).toBeInstanceOf(Error);
		expect(String(rejection)).toContain("missing OPENAI_API_KEY");
	});

	/**
	 * The exit status appears once it is known, which is NOT during the in-flight
	 * rejection. Stdout reaching EOF and Bun populating `exitCode` are separate
	 * events and EOF comes first, so at the moment the pending requests are
	 * rejected the status is still null.
	 *
	 * Waiting for it was tried and is wrong twice over: `exited` does not settle
	 * until the pipes drain and this transport is what drains them, so awaiting
	 * it from the close path deadlocks; and delaying a rejection on a process
	 * that may never exit is the exact wedge this reporting exists to expose.
	 *
	 * So the in-flight rejection carries the stderr, which is the part that
	 * explains the failure, and the status joins the account for every message
	 * after it. This test pins the second half; the in-flight half is covered
	 * above. A server killed by a signal and one that exited 3 on its own are
	 * different problems, and the code is what separates them when stderr is
	 * uninformative.
	 */
	it("names the exit code once the process has been reaped", async () => {
		const script = await writeDoomedServer({ exitCode: 3, stderrLines: ["fatal: bad config"] });
		const transport = transportFor(script);
		await transport.connect();
		await transport.request("tools/list").catch(() => undefined);

		// Polled rather than slept on, because the status is an eventually-available
		// fact and the exact tick it lands on is a runtime detail. The bound is what
		// makes this a real assertion: if the status never arrives, this fails.
		let message = "";
		for (let attempt = 0; attempt < 50; attempt++) {
			message = String(await transport.request("tools/list").catch((error: unknown) => error));
			if (message.includes("exit code")) break;
			await Bun.sleep(20);
		}

		expect(message).toContain("exit code 3");
		// The stderr is still there alongside it: gaining the status must not cost
		// the diagnosis, which is the more useful half.
		expect(message).toContain("fatal: bad config");
	});

	/**
	 * And the server's name. A session runs several MCP servers at once, so a
	 * message that does not say which one died sends the operator to check all of
	 * them.
	 */
	it("names the server in the rejection", async () => {
		const script = await writeDoomedServer({ exitCode: 1, stderrLines: ["boom"] });
		const transport = transportFor(script);
		await transport.connect();

		const rejection = await transport.request("tools/list").catch((error: unknown) => error);

		expect(String(rejection)).toContain("bun");
	});

	/**
	 * A server that says NOTHING before dying must still produce a usable
	 * message, and must say plainly that there was no explanation rather than
	 * leaving an empty section. "The server produced no output" is itself a
	 * finding: it points at a hard crash or a kill rather than a handled error.
	 */
	it("says so explicitly when the server died without a word", async () => {
		const script = await writeDoomedServer({ exitCode: 1, stderrLines: [] });
		const transport = transportFor(script);
		await transport.connect();

		const rejection = await transport.request("tools/list").catch((error: unknown) => error);

		expect(String(rejection)).toContain("no output");
	});

	/**
	 * EVERY in-flight request must reject, not just the first. A pending map that
	 * cleared partially would leave the agent loop awaiting a promise that can
	 * never settle, which is the wedge this row is about.
	 */
	it("rejects every concurrent in-flight request, not just one", async () => {
		const script = await writeDoomedServer({
			delayMs: 150,
			exitCode: 1,
			stderrLines: ["going down"],
		});
		const transport = transportFor(script);
		await transport.connect();

		const settled = await Promise.allSettled([
			transport.request("tools/list"),
			transport.request("resources/list"),
			transport.request("prompts/list"),
		]);

		expect(settled.map(entry => entry.status)).toEqual(["rejected", "rejected", "rejected"]);
		for (const entry of settled) {
			expect(String((entry as PromiseRejectedResult).reason)).toContain("going down");
		}
	});

	/**
	 * A request made AFTER the server is already gone gets the same detail. This
	 * is the commoner ordering in practice (the server dies, then the agent calls
	 * one of its tools), and it used to produce "Transport not connected", which
	 * is even less actionable than the in-flight message.
	 */
	it("reports the same detail for a call made after the server is gone", async () => {
		const script = await writeDoomedServer({ exitCode: 1, stderrLines: ["died during startup"] });
		const transport = transportFor(script);
		await transport.connect();
		await transport.request("tools/list").catch(() => undefined);

		const rejection = await transport.request("tools/list").catch((error: unknown) => error);

		expect(String(rejection)).toContain("died during startup");
	});

	/**
	 * The transport must report itself disconnected once the process is gone, so
	 * the manager's reconnect and circuit-breaker logic sees a consistent state
	 * rather than a transport that claims to be connected to a dead process.
	 */
	it("reports itself disconnected after the process exits", async () => {
		const script = await writeDoomedServer({ exitCode: 1, stderrLines: ["bye"] });
		const transport = transportFor(script);
		await transport.connect();
		await transport.request("tools/list").catch(() => undefined);

		expect(transport.connected).toBe(false);
	});

	/**
	 * `onClose` must still fire. It is what drives reconnection, and a crash that
	 * reported its cause but skipped the callback would trade one bug for a worse
	 * one: a server that never comes back.
	 */
	it("still fires onClose so the manager can reconnect", async () => {
		const script = await writeDoomedServer({ exitCode: 1, stderrLines: ["restarting soon"] });
		const transport = transportFor(script);
		let closed = false;
		transport.onClose = () => {
			closed = true;
		};
		await transport.connect();
		await transport.request("tools/list").catch(() => undefined);

		expect(closed).toBe(true);
	});
});

describe("the retained stderr tail is bounded", () => {
	/**
	 * A chatty server must not be able to grow the transport's memory without
	 * limit. The tail is capped, and it keeps the LAST lines rather than the
	 * first, because a program explains its death in its last words.
	 *
	 * Asserted through the observable message: the final line must be present and
	 * the very first of a long run must not be.
	 */
	it("keeps the last lines and drops the oldest", async () => {
		const noisy = Array.from({ length: 200 }, (_, index) => `chatter-line-${index}`);
		const script = await writeDoomedServer({ exitCode: 1, stderrLines: noisy });
		const transport = transportFor(script);
		await transport.connect();

		const rejection = await transport.request("tools/list").catch((error: unknown) => error);
		const text = String(rejection);

		expect(text).toContain("chatter-line-199");
		expect(text).not.toContain("chatter-line-0\n");
	});

	/**
	 * And a single enormous line is truncated rather than embedded whole. A
	 * server can emit a megabyte on one line, and pasting that into an error
	 * message would push everything else out of the operator's view.
	 */
	it("truncates a single enormous line", async () => {
		const script = await writeDoomedServer({ exitCode: 1, stderrLines: ["x".repeat(50_000)] });
		const transport = transportFor(script);
		await transport.connect();

		const rejection = await transport.request("tools/list").catch((error: unknown) => error);

		expect(String(rejection).length).toBeLessThan(10_000);
	});
});
