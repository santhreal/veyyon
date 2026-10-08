/**
 * WHY: run code that called something without awaiting it, such as `page.click("#missing")` for an
 * element the page lacks, floated a rejection nothing handled. In the tab's worker thread that ended
 * the worker: the next run hung for its whole budget and the grace after it, and the tab was killed.
 *
 * The contract: a rejection run code floats never ends its tab. One that surfaces while its run is in
 * progress fails that run, naming what was not awaited. One that an ended run's code floats while a
 * later run is in progress is logged, and is not taken for the later run's failure. Either way the tab
 * takes the next run.
 *
 * Driven through the real tool against real headless Chromium, in a dedicated tab worker, in a `bun`
 * process of its own (`test/fixtures/browser-run-floats-a-rejection.ts`): under `bun test` a worker
 * thread ends on any unhandled rejection whatever listens for it, and the CLI runs its tab workers
 * under `bun`. Skipped where Chromium cannot run.
 *
 * What it does NOT catch: the inline fallback on the main thread, which claims only a rejection whose
 * stack names a run's code; and a rejection an ended run floats whose stack names no run (a library's
 * own error), which a run in progress then takes for its own.
 */

import { describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";
import { CHROMIUM_AVAILABLE } from "./browser/chromium";

const execFileAsync = promisify(execFile);
const fixture = path.resolve(import.meta.dirname, "../fixtures/browser-run-floats-a-rejection.ts");

describe.skipIf(!CHROMIUM_AVAILABLE)("a call a run does not await", () => {
	it("fails the run it rejects in, is logged when its run has ended, and never ends the tab", async () => {
		const { env, cleanup } = hermeticSpawnEnv();
		try {
			const { stdout } = await execFileAsync(process.execPath, [fixture], {
				env,
				timeout: 90_000,
				killSignal: "SIGKILL",
				maxBuffer: 1024 * 1024,
			});
			const outcome = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, string>;
			expect(outcome).toEqual({
				floatedInRun: expect.stringMatching(/^failed: Unhandled rejection \(missing await\?\): .*#missing/),
				afterFloatedInRun: "returned: 2",
				floatedAfterRun: "returned: returned",
				runWhileItLands: "returned: 2",
				afterItLanded: "returned: here",
			});
		} finally {
			cleanup();
		}
	}, 120_000);
});
