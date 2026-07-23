import { describe, expect, it } from "bun:test";
import { awaitStartupMarker } from "@veyyon/coding-agent/stt/recorder";

/**
 * awaitStartupMarker abandons an in-flight read on timeout WITHOUT leaking an
 * unhandled rejection.
 *
 * The bug this suite locks out (HUNT2-ASYNC-recorder-abandoned-read, 2026-07-22):
 * the PowerShell recorder's startup-confirm loop raced `reader.read()` against a
 * deadline sleep. When the process emitted no stdout before the deadline the sleep
 * won, the loop broke with the read STILL PENDING, and `reader.releaseLock()`
 * rejected that outstanding read. Nothing awaited or caught it, so a floating
 * unhandled rejection escaped on exactly the no-output failure path — drowning the
 * clean "failed to start" diagnostic the caller then throws. The fix attaches a
 * `.catch` to the read the moment it is created so an abandoned read can never
 * surface as unhandled, while still letting a genuine mid-loop read error
 * propagate through the awaited race.
 *
 * These drive the extracted helper directly (the recorder itself spawns a real
 * `powershell`, which does not exist here) with synthetic streams.
 */

/** A stream whose `pull` never resolves: `reader.read()` stays pending until the
 *  lock is released — the exact condition that produced the unhandled rejection. */
function neverYieldingStream(): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		pull() {
			return new Promise<void>(() => {});
		},
	});
}

/** A stream that yields the given text chunks in order, then closes. */
function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let index = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (index < chunks.length) {
				controller.enqueue(encoder.encode(chunks[index++]));
			} else {
				controller.close();
			}
		},
	});
}

/** Run `fn` while capturing any process-level unhandled rejection, then wait long
 *  enough for a late rejection to surface before returning what was captured. */
async function withUnhandledRejectionGuard<T>(fn: () => Promise<T>): Promise<{ result: T; rejections: unknown[] }> {
	const rejections: unknown[] = [];
	const listener = (reason: unknown) => rejections.push(reason);
	process.on("unhandledRejection", listener);
	try {
		const result = await fn();
		await new Promise<void>(resolve => setTimeout(resolve, 60));
		return { result, rejections };
	} finally {
		process.off("unhandledRejection", listener);
	}
}

describe("awaitStartupMarker no-stdout timeout path", () => {
	it("times out with started=false and emits NO unhandled rejection when the stream never yields", async () => {
		const { result, rejections } = await withUnhandledRejectionGuard(() =>
			awaitStartupMarker(neverYieldingStream(), "RECORDING", 30),
		);

		expect(result.started).toBe(false);
		expect(result.output).toBe("");
		// The load-bearing assertion: the abandoned pending read was defused, so no
		// rejection escaped to the process. Pre-fix this array held a TypeError from
		// releaseLock() rejecting the outstanding read.
		expect(rejections).toEqual([]);
	});

	it("returns started=true as soon as the marker arrives on stdout", async () => {
		const result = await awaitStartupMarker(streamFromChunks(["RECORDING\n"]), "RECORDING", 1000);
		expect(result.started).toBe(true);
		expect(result.output).toContain("RECORDING");
	});

	it("assembles the marker split across multiple reads", async () => {
		const result = await awaitStartupMarker(streamFromChunks(["REC", "ORD", "ING\n"]), "RECORDING", 1000);
		expect(result.started).toBe(true);
		expect(result.output).toBe("RECORDING\n");
	});

	it("reports started=false with the captured output when the stream closes without the marker", async () => {
		const result = await awaitStartupMarker(streamFromChunks(["nope\n", "still nope\n"]), "RECORDING", 1000);
		expect(result.started).toBe(false);
		expect(result.output).toBe("nope\nstill nope\n");
	});
});
