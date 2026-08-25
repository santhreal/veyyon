/**
 * DapClient.#writeMessage frames with two sink.write calls (header, then JSON
 * body) and then looks only at flush(). DapWriteSink.write is allowed to
 * return a Promise — Bun.FileSink and Bun.Socket both do under backpressure.
 *
 * If those promises are dropped, sendResponse can resolve while the header
 * is still in a pending write, and a later body write can land first or never.
 * The timeout/exit guard is wired only around flush, so a wedged *write*
 * (the original hang the comment describes) is exactly the path that is not
 * bounded.
 *
 * Constructor accepts an injected writeSink, so this is a real client, not a
 * reimplementation. The fake process only has to supply exited (the
 * constructor subscribes) and kill (dispose).
 */
import { describe, expect, it } from "bun:test";
import { DapClient } from "@veyyon/coding-agent/dap/client";
import type { DapResolvedAdapter } from "@veyyon/coding-agent/dap/types";

const ADAPTER: DapResolvedAdapter = {
	name: "test-adapter",
	command: "true",
	args: [],
	resolvedCommand: "/bin/true",
	languages: [],
	fileTypes: [],
	rootMarkers: [],
	launchDefaults: {},
	attachDefaults: {},
	connectMode: "stdio",
	acceptsDirectoryProgram: false,
};

function hangingProc() {
	const { promise: exited } = Promise.withResolvers<number>();
	return {
		stdout: new ReadableStream<Uint8Array>(),
		stdin: { write() { return 0; }, flush() {} },
		kill() {},
		exitCode: null as number | null,
		exited,
	};
}

describe("#writeMessage waits for write() promises, not only flush()", () => {
	it("does not resolve sendResponse while a write() promise is still pending", async () => {
		const writes: Array<{ data: string; resolve: () => void }> = [];
		const writeSink = {
			write(data: string | Uint8Array) {
				const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
				const { promise, resolve } = Promise.withResolvers<number>();
				writes.push({ data: text, resolve: () => resolve(text.length) });
				return promise;
			},
			flush() {
				return undefined;
			},
		};
		const client = new DapClient(ADAPTER, process.cwd(), hangingProc() as never, {
			readable: new ReadableStream<Uint8Array>(),
			writeSink,
		});
		const request = { seq: 1, type: "request" as const, command: "initialize" };
		const pending = client.sendResponse(request, true, { ok: true });
		const raced = await Promise.race([
			pending.then(() => "resolved" as const),
			Bun.sleep(50).then(() => "still-pending" as const),
		]);
		expect(writes.length).toBeGreaterThan(0);
		expect(raced).toBe("still-pending");
		for (const w of writes) w.resolve();
		await pending;
		const framed = writes.map(w => w.data).join("");
		expect(framed.startsWith("Content-Length: ")).toBe(true);
		expect(framed).toContain("\r\n\r\n");
		const body = framed.split("\r\n\r\n")[1] ?? "";
		expect(JSON.parse(body).type).toBe("response");
	});
});
