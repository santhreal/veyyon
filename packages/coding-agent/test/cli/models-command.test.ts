/**
 * `veyyon models` in a credential-less home: the empty listing is guidance,
 * not an error — exit 0 with the unified no-auth copy (kept in lockstep with
 * `veyyon token`'s no-provider hint so the two surfaces never drift apart).
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";

const cliPath = path.resolve(import.meta.dir, "../../src/cli.ts");

describe("veyyon models without credentials", () => {
	it("exits 0 with the unified no-auth guidance", async () => {
		// `hermeticSpawnEnv` for the temp HOME and the variables a child must not inherit.
		// The env built here by hand cleared three veyyon keys and none of the four XDG
		// bases, and it never deleted the home it made: the CLI writes a whole config root
		// under the home it is given, so each run left ~289MB behind. This suite and the
		// `read`/`grep` ones had left 3,265 directories and 34GB in `/tmp`.
		const { env, cleanup } = hermeticSpawnEnv();
		// The credential scrub stays local: it is what this test is ABOUT (a home with no
		// way to reach a provider), not part of being hermetic, and folding it into the
		// shared helper would silently strip credentials from suites that need them.
		for (const key of Object.keys(env)) {
			if (/API_KEY|_TOKEN$/i.test(key)) delete env[key];
		}
		try {
			const proc = Bun.spawn(["bun", cliPath, "models"], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
			const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
			expect(exitCode).toBe(0);
			expect(stdout).toContain(
				"No models available. Set an API key environment variable, or sign in with /login in an interactive session.",
			);
		} finally {
			cleanup();
		}
	}, 30_000);
});
