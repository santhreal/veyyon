/**
 * `veyyon models` in a credential-less home: the empty listing is guidance,
 * not an error — exit 0 with the unified no-auth copy (kept in lockstep with
 * `veyyon token`'s no-provider hint so the two surfaces never drift apart).
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const cliPath = path.resolve(import.meta.dir, "../../src/cli.ts");

describe("veyyon models without credentials", () => {
	it("exits 0 with the unified no-auth guidance", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "veyyon-models-home-"));
		const env: Record<string, string | undefined> = {
			...process.env,
			HOME: home,
			NO_COLOR: "1",
		};
		for (const key of ["VEYYON_CODING_AGENT_DIR", "VEYYON_CONFIG_DIR", "VEYYON_PROFILE"]) {
			delete env[key];
		}
		for (const key of Object.keys(env)) {
			if (/API_KEY|_TOKEN$/i.test(key)) delete env[key];
		}
		const proc = Bun.spawn(["bun", cliPath, "models"], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain(
			"No models available. Set an API key environment variable, or sign in with /login in an interactive session.",
		);
	}, 30_000);
});
