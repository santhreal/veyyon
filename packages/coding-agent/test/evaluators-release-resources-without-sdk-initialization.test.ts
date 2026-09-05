/**
 * WHY: exit hooks registered by createAgentSession forced every evaluator onto the
 * startup import graph and left standalone evaluator resources without cleanup.
 * This subprocess drives the shared kernel pool and a real JS evaluator through
 * process cleanup without constructing an SDK session. Only the external language
 * interpreter is substituted; interpreter-specific execution remains covered by
 * each backend's suites. The subprocess bounds cleanup and isolates postmortem's
 * process-global, single-use lifecycle from the rest of the test runner.
 */
import { expect, it } from "bun:test";
import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import { hermeticSpawnEnv } from "./helpers/hermetic-spawn-env";

const execFileAsync = promisify(execFile);
it("releases kernel and JS resources without constructing an SDK session", async () => {
	const { env, cleanup } = hermeticSpawnEnv();
	try {
		const { stdout, stderr } = await execFileAsync(
			process.execPath,
			[path.join(import.meta.dirname, "fixtures/evaluator-exit-cleanup.ts")],
			{ env, timeout: 25_000, killSignal: "SIGKILL" },
		);
		expect(stderr).toBe("");
		expect(JSON.parse(stdout)).toEqual({ kernelReleased: true, jsContextReleased: true });
	} finally {
		cleanup();
	}
}, 30_000);
