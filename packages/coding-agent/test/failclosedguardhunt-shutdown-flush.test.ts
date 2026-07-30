/**
 * WHICH BUG THIS LOCKS OUT: the headless `shutdown()` threw away the session
 * flush it had just started.
 *
 * `AgentSession`'s no-UI `ExtensionCommandContext.shutdown` was:
 *
 *     shutdown: () => {
 *         void this.dispose();
 *         process.exit(0);
 *     }
 *
 * `dispose()` is async. `void` starts it and returns the instant it reaches its
 * first `await`, and `process.exit(0)` on the very next line then tears the
 * process down mid-flush. Everything dispose had not already written was lost,
 * and because the process was gone a rejection from it could not even be
 * reported. This is the reason a plain `.catch` would have been theatre here:
 * the handler could never run.
 *
 * The fix awaits the flush and bounds the wait, so a wedged teardown still
 * exits instead of hanging the caller forever.
 *
 * WHAT BREAKS IF THIS REGRESSES: restore the `void` and an extension calling
 * `ctx.shutdown()` truncates the session record. The first test below fails
 * because the marker its dispose writes never appears.
 *
 * Runs in a child process on purpose: the code under test calls
 * `process.exit(0)`, which would take the test runner with it.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";

const CHILD = path.join(import.meta.dir, "support", "failclosedguardhunt-shutdown-flush-child.ts");

/** Run the child and report how it exited plus whatever marker it left. */
async function runChild(disposeDelayMs: number): Promise<{ exitCode: number; marker: string | null }> {
	const tempDir = TempDir.createSync("@pi-fcgh-shutdown-flush-");
	try {
		const markerPath = path.join(tempDir.path(), "marker.txt");
		const proc = Bun.spawn(["bun", CHILD, markerPath, String(disposeDelayMs)], {
			cwd: path.join(import.meta.dir, ".."),
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		const marker = Bun.file(markerPath);
		return { exitCode, marker: (await marker.exists()) ? await marker.text() : null };
	} finally {
		await tempDir.remove();
	}
}

describe("headless shutdown flushes before it exits", () => {
	it("lets an in-flight dispose finish instead of exiting out from under it", async () => {
		// 50ms is far longer than the synchronous window the old code gave
		// dispose, and far shorter than the bound the fix applies.
		const { exitCode, marker } = await runChild(50);

		expect(marker).toBe("disposed");
		expect(exitCode).toBe(0);
	}, 20_000);

	it("still exits cleanly when dispose completes immediately", async () => {
		// Boundary: a dispose that resolves on the first turn must not be
		// treated differently from a slow one.
		const { exitCode, marker } = await runChild(0);

		expect(marker).toBe("disposed");
		expect(exitCode).toBe(0);
	}, 20_000);
});
