/**
 * `veyyon token` error paths in a credential-less home: every failure exits 1
 * on stderr with actionable copy (what's missing and how to fix it), never a
 * bare empty line or exit 0 a script would misread as a token.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const cliPath = path.resolve(import.meta.dir, "../../src/cli.ts");

async function runToken(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const home = mkdtempSync(path.join(tmpdir(), "veyyon-token-home-"));
	const env: Record<string, string | undefined> = {
		...process.env,
		HOME: home,
		NO_COLOR: "1",
	};
	for (const key of ["VEYYON_CODING_AGENT_DIR", "VEYYON_CONFIG_DIR", "VEYYON_PROFILE"]) {
		delete env[key];
	}
	// A provider key inherited from the dev environment would turn the
	// no-credentials fixture into an authenticated one.
	for (const key of Object.keys(env)) {
		if (/API_KEY|_TOKEN$/i.test(key)) delete env[key];
	}
	const proc = Bun.spawn(["bun", cliPath, "token", ...args], {
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
}

describe("veyyon token without credentials", () => {
	it("exits 1 and tells the user how to configure a provider", async () => {
		const { exitCode, stdout, stderr } = await runToken(["anthropic"]);
		expect(exitCode).toBe(1);
		expect(stdout).toBe("");
		expect(stderr).toContain('No active credential found for provider "anthropic".');
		expect(stderr).toContain("No providers are configured. Sign in with /login in an interactive session");
	}, 30_000);

	it("--list exits 1 with a no-accounts explanation", async () => {
		const { exitCode, stderr } = await runToken(["anthropic", "--list"]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain('No OAuth accounts found for provider "anthropic".');
		expect(stderr).toContain("this provider has none stored");
	}, 30_000);

	it("--account exits 1 with the same no-accounts explanation", async () => {
		const { exitCode, stderr } = await runToken(["anthropic", "--account", "2"]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain('No OAuth accounts found for provider "anthropic".');
	}, 30_000);

	it("requires the provider argument", async () => {
		const { exitCode, stderr } = await runToken([]);
		expect(exitCode).toBe(1);
		expect(stderr.toLowerCase()).toContain("provider");
	}, 30_000);
});
