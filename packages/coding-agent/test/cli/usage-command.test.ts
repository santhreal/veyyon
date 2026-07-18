/**
 * `veyyon usage` e2e in a credential-less home. Pins the human/machine split:
 * human output signals "nothing to show" with exit 1 and a /login hint, while
 * `--json` stays machine-friendly — a well-formed empty payload at exit 0.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const cliPath = path.resolve(import.meta.dir, "../../src/cli.ts");

function makeEnv(): Record<string, string | undefined> {
	const home = mkdtempSync(path.join(tmpdir(), "veyyon-usage-home-"));
	const env: Record<string, string | undefined> = {
		...process.env,
		HOME: home,
		NO_COLOR: "1",
	};
	for (const key of Object.keys(env)) {
		if (/API_KEY|_TOKEN$/i.test(key)) delete env[key];
	}
	for (const key of ["VEYYON_CODING_AGENT_DIR", "VEYYON_CONFIG_DIR", "VEYYON_PROFILE"]) {
		delete env[key];
	}
	return env;
}

async function runUsage(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["bun", cliPath, "usage", ...args], {
		env: makeEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

describe("veyyon usage without credentials", () => {
	it("human mode exits 1 with the /login hint", async () => {
		const { stderr, exitCode } = await runUsage([]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("No credentials found. Run `veyyon` and use /login to add accounts.");
	}, 30_000);

	it("--json emits a well-formed empty payload at exit 0", async () => {
		const { stdout, exitCode } = await runUsage(["--json"]);
		expect(exitCode).toBe(0);
		const payload = JSON.parse(stdout);
		expect(payload.reports).toEqual([]);
		expect(payload.accountsWithoutUsage).toEqual([]);
		expect(payload.capacity).toEqual({});
		expect(typeof payload.generatedAt).toBe("number");
	}, 30_000);

	it("--history with no snapshots exits 1 and explains how history accumulates", async () => {
		const { stderr, exitCode } = await runUsage(["--history"]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("No usage history recorded");
		expect(stderr).toContain("Snapshots accumulate");
	}, 30_000);

	it("--history --json emits an empty entries payload at exit 0", async () => {
		const { stdout, exitCode } = await runUsage(["--history", "--json"]);
		expect(exitCode).toBe(0);
		const payload = JSON.parse(stdout);
		expect(payload.entries).toEqual([]);
		expect(typeof payload.generatedAt).toBe("number");
		expect(typeof payload.sinceMs).toBe("number");
	}, 30_000);

	it("invalidate reports the cleared scope for all providers and one provider", async () => {
		const all = await runUsage(["invalidate"]);
		expect(all.exitCode).toBe(0);
		expect(all.stdout).toContain("Invalidated cached usage reports for all providers.");
		const one = await runUsage(["invalidate", "--provider", "anthropic"]);
		expect(one.exitCode).toBe(0);
		expect(one.stdout).toContain('Invalidated cached usage reports for provider "anthropic".');
	}, 30_000);
});
