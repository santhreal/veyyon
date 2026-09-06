/**
 * WHY: startup imported the AI barrel for streaming helpers, evaluating provider
 * implementations that already have lazy execution dispatch. Fresh processes
 * load the session, SDK, and all warmup stages, rejecting barrel imports at any depth.
 * Usage and credential-ranking contributions must still be registered, with
 * expected membership derived from their declarations. This covers bootstrap
 * registration, not network quota responses or provider execution correctness.
 */
import { expect, it } from "bun:test";
import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import { DEFAULT_RANKING_STRATEGIES, DEFAULT_USAGE_PROVIDERS } from "@veyyon/ai/usage/defaults";
import { hermeticSpawnEnv } from "../../helpers/hermetic-spawn-env";

const run = promisify(execFile);
it.each(["session", "sdk", "warmup"])(
	"%s preserves usage without the AI package barrel",
	async entry => {
		const { env, cleanup } = hermeticSpawnEnv();
		const rankingProviders = DEFAULT_RANKING_STRATEGIES.map(([provider]) => provider).sort();
		try {
			const { stdout, stderr } = await run(
				process.execPath,
				[
					path.join(import.meta.dirname, `../../fixtures/startup-ai-leaves-${entry}.ts`),
					JSON.stringify(rankingProviders),
				],
				{ env, timeout: 20_000, killSignal: "SIGKILL" },
			);
			expect(stderr).toBe("");
			expect(JSON.parse(stdout)).toEqual({
				usageProviders: DEFAULT_USAGE_PROVIDERS.map(provider => provider.id).sort(),
				rankingProviders,
			});
		} finally {
			cleanup();
		}
	},
	25_000,
);
