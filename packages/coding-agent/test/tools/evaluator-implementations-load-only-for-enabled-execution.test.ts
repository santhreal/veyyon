/**
 * WHY: importing EvalTool initialized every interpreter, including disabled ones.
 * Each declared language runs first in a fresh process. Construction, metadata,
 * and disabled requests must leave implementations unloaded; enabled execution
 * loads only the requested backend. JS executes a real cell. Other languages use
 * an explicitly missing interpreter to exercise their real availability failure
 * without assuming the host has Ruby, Julia, or Python installed. Their successful
 * execution remains covered by backend-specific tests and production smokes.
 */
import { expect, it } from "bun:test";
import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import { EVAL_LANGUAGE_ORDER } from "../../src/tools/shell/eval";
import { evalBackendLoaders } from "../../src/tools/shell/manifest";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";

const execFileAsync = promisify(execFile);
for (const language of EVAL_LANGUAGE_ORDER) {
	it(`loads only the enabled ${language} evaluator on execution`, async () => {
		const { env, cleanup } = hermeticSpawnEnv();
		for (const token of EVAL_LANGUAGE_ORDER) delete env[`VEYYON_${token.toUpperCase()}`];
		for (const runtime of Object.keys(evalBackendLoaders)) delete env[`VEYYON_${runtime.toUpperCase()}_SKIP_CHECK`];
		// Exercise actual interpreter probes rather than their test-runner shortcut.
		env.BUN_ENV = "production";
		env.NODE_ENV = "production";
		try {
			const { stdout, stderr } = await execFileAsync(
				process.execPath,
				[path.join(import.meta.dirname, "../fixtures/evaluator-activation.ts"), language],
				{ env, timeout: 20_000, killSignal: "SIGKILL" },
			);
			expect(stderr).toBe("");
			expect(JSON.parse(stdout)).toMatchObject({ language, loaded: [language] });
		} finally {
			cleanup();
		}
	}, 25_000);
}
