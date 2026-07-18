/**
 * `veyyon plugin` offline e2e: empty listing, doctor health check, and the
 * not-installed error paths. Pins the fail-closed uninstall — a never-installed
 * package must NOT report "Uninstalled" (bun uninstall exits 0 for it).
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const cliPath = path.resolve(import.meta.dir, "../../src/cli.ts");

function makeEnv(): Record<string, string | undefined> {
	const home = mkdtempSync(path.join(tmpdir(), "veyyon-plugin-home-"));
	const env: Record<string, string | undefined> = { ...process.env, HOME: home, NO_COLOR: "1" };
	for (const key of ["VEYYON_CODING_AGENT_DIR", "VEYYON_CONFIG_DIR", "VEYYON_PROFILE"]) {
		delete env[key];
	}
	return env;
}

async function runPlugin(
	env: Record<string, string | undefined>,
	args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["bun", cliPath, "plugin", ...args], {
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
	return { stdout, stderr, exitCode };
}

describe("veyyon plugin offline surfaces", () => {
	it("list reports no plugins (human and JSON)", async () => {
		const env = makeEnv();
		const human = await runPlugin(env, ["list"]);
		expect(human.exitCode).toBe(0);
		expect(human.stdout).toContain("No plugins installed");
		const json = await runPlugin(env, ["list", "--json"]);
		expect(json.exitCode).toBe(0);
		expect(JSON.parse(json.stdout)).toEqual({ npm: [], marketplace: [] });
	}, 30_000);

	it("uninstall of a never-installed package fails closed with exit 1", async () => {
		const { stdout, stderr, exitCode } = await runPlugin(makeEnv(), ["uninstall", "ghost-package"]);
		expect(exitCode).toBe(1);
		expect(stdout).not.toContain("Uninstalled ghost-package");
		expect(stderr).toContain("Plugin ghost-package is not installed");
		expect(stderr).toContain("veyyon plugin list");
	}, 30_000);

	it("enable/disable of an unknown plugin exit 1", async () => {
		const env = makeEnv();
		const enable = await runPlugin(env, ["enable", "ghost-package"]);
		expect(enable.exitCode).toBe(1);
		expect(enable.stderr).toContain("not found");
		const disable = await runPlugin(env, ["disable", "ghost-package"]);
		expect(disable.exitCode).toBe(1);
	}, 30_000);

	it("doctor sets up and passes on a fresh home", async () => {
		const { stdout, exitCode } = await runPlugin(makeEnv(), ["doctor"]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("Plugin Health Check");
		expect(stdout).toContain("0 errors");
	}, 30_000);

	it("rejects an unknown action with the canonical action list", async () => {
		const { stderr, exitCode } = await runPlugin(makeEnv(), ["frobnicate"]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("Expected action to be one of");
	}, 30_000);
});
