import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createRequestDebugSession } from "../src/utils/request-debug";

/**
 * `VEYYON_REQ_DEBUG` records every request and response to disk. It is an
 * observability flag, so a failure to write that record must never become a
 * failure of the request being recorded.
 *
 * The response log used to sit directly in the stream's error path: `write`
 * chained onto a pending promise with no catch, `close` awaited that promise,
 * and `wrapResponse`'s `pull` awaited `close` inside a try whose catch calls
 * `controller.error(...)`. A full disk or a revoked permission therefore killed
 * the model response the user was reading, reported as an error about a debug
 * file they had not asked to see.
 */
describe("request debug log failures do not reach the caller", () => {
	let tempDir: string;
	let previousCwd: string;

	beforeEach(async () => {
		previousCwd = process.cwd();
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-req-debug-fail-"));
		process.chdir(tempDir);
	});

	afterEach(async () => {
		process.chdir(previousCwd);
		await fs.chmod(tempDir, 0o700).catch(() => {});
		await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
	});

	async function openLog() {
		const session = await createRequestDebugSession({ method: "POST", url: "https://example.test/v1/messages" });
		return { session, log: await session.openResponseLog("HTTP 200 OK") };
	}

	/**
	 * Hand back a real file handle whose `write` rejects the way a full disk does,
	 * so the failure happens on an OPEN log mid-stream. Writing after `close` is a
	 * different path that was always a silent no-op, so it cannot prove this.
	 */
	async function openLogWithFailingWrites(code: string) {
		const realOpen = fs.open;
		const spy = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
			const handle = await realOpen(...args);
			let headerWritten = false;
			const write = handle.write.bind(handle);
			Object.defineProperty(handle, "write", {
				configurable: true,
				value: async (...writeArgs: unknown[]) => {
					// Let the status line through, then fail everything after it.
					if (!headerWritten) {
						headerWritten = true;
						return (write as (...a: unknown[]) => unknown)(...writeArgs);
					}
					const error = new Error(`${code}: simulated`) as NodeJS.ErrnoException;
					error.code = code;
					throw error;
				},
			});
			return handle;
		});
		try {
			const session = await createRequestDebugSession({ method: "POST", url: "https://example.test/v1/messages" });
			return { session, log: await session.openResponseLog("HTTP 200 OK") };
		} finally {
			spy.mockRestore();
		}
	}

	test("a write that rejects on an open log does not reject close", async () => {
		// REGRESSION: the write chained onto #pending with no catch, so the rejection
		// sat there until close awaited it and rethrew.
		const { log } = await openLogWithFailingWrites("ENOSPC");

		log.write("a chunk the disk has no room for");

		await expect(log.close()).resolves.toBeUndefined();
	});

	test("close resolves after many failed writes, not just the first", async () => {
		// pull calls write once per chunk, so a long response produces one rejection
		// per chunk. Every one of them has to be absorbed.
		const { log } = await openLogWithFailingWrites("EACCES");

		for (let i = 0; i < 25; i++) log.write(`chunk ${i}`);

		await expect(log.close()).resolves.toBeUndefined();
	});

	test("a failing log leaves the response stream intact and byte-exact", async () => {
		// The whole point: the user still gets every byte the model sent, even though
		// the recording of it failed. wrapResponse opens the log itself, so the spy
		// has to still be installed when it runs.
		const realOpen = fs.open;
		const spy = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
			const handle = await realOpen(...args);
			Object.defineProperty(handle, "write", {
				configurable: true,
				value: async () => {
					const error = new Error("ENOSPC: simulated") as NodeJS.ErrnoException;
					error.code = "ENOSPC";
					throw error;
				},
			});
			return handle;
		});
		const session = await createRequestDebugSession({ method: "POST", url: "https://example.test/v1/messages" });
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("hello "));
				controller.enqueue(new TextEncoder().encode("world"));
				controller.close();
			},
		});

		try {
			const wrapped = await session.wrapResponse(new Response(body, { status: 200 }));

			expect(await wrapped.text()).toBe("hello world");
		} finally {
			spy.mockRestore();
		}
	});

	test("bytes written before the failure are still on disk", async () => {
		// Giving up on the rest of the log must not discard the part that succeeded:
		// the point of the flag is to have the request when something goes wrong.
		const { session, log } = await openLog();

		log.write("recorded before the log was closed");
		await log.close();
		log.write("dropped");
		await log.close();

		const contents = await fs.readFile(session.responsePath, "utf-8");
		expect(contents).toContain("HTTP 200 OK");
		expect(contents).toContain("recorded before the log was closed");
		expect(contents).not.toContain("dropped");
	});

	test("close is idempotent and returns the same settled result", async () => {
		const { log } = await openLog();

		const first = log.close();
		const second = log.close();

		expect(second).toBe(first);
		await expect(first).resolves.toBeUndefined();
	});

	test("a log that cannot even be opened still returns the response untouched", async () => {
		// Distinct from a failing write: fs.open throws before there is a log object
		// at all, on a read-only directory or with no descriptors left. That used to
		// propagate straight out of wrapResponse to whoever asked for the response.
		const session = await createRequestDebugSession({ method: "POST", url: "https://example.test/v1/messages" });
		const spy = spyOn(fs, "open").mockImplementation(() => {
			const error = new Error("EACCES: simulated") as NodeJS.ErrnoException;
			error.code = "EACCES";
			return Promise.reject(error);
		});
		try {
			const wrapped = await session.wrapResponse(new Response("the model's answer", { status: 200 }));

			expect(await wrapped.text()).toBe("the model's answer");
			expect(wrapped.status).toBe(200);
		} finally {
			spy.mockRestore();
		}
	});

	test("the response header block reaches the log ahead of the body", async () => {
		// The header goes through the same chained write as the body now, so the
		// ordering is worth pinning: a log whose status line landed after the first
		// chunk would not parse as an HTTP response.
		const session = await createRequestDebugSession({ method: "POST", url: "https://example.test/v1/messages" });

		const wrapped = await session.wrapResponse(new Response("body-bytes", { status: 201, statusText: "Created" }));
		await wrapped.text();

		const contents = await fs.readFile(session.responsePath, "utf-8");
		expect(contents.indexOf("HTTP 201 Created")).toBe(0);
		expect(contents.indexOf("body-bytes")).toBeGreaterThan(contents.indexOf("HTTP 201 Created"));
	});

	test("the request dump is written before any response bytes arrive", async () => {
		// A crash mid-response should still leave the request on disk, which is the
		// half that says what was asked for.
		const session = await createRequestDebugSession({
			method: "POST",
			url: "https://example.test/v1/messages",
			bodyText: "the exact request body",
		});

		const dump = JSON.parse(await fs.readFile(session.requestPath, "utf-8"));
		expect(dump.method).toBe("POST");
		expect(dump.url).toBe("https://example.test/v1/messages");
		expect(dump.bodyText).toBe("the exact request body");
	});
});
