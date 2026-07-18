/**
 * `veyyon config` e2e: list/get/set/reset/path against a throwaway home.
 * Pins the JSON contracts (every entry carries an explicit `value`, null when
 * unset), the set→get roundtrip persistence, and the exit-1 error surfaces.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const cliPath = path.resolve(import.meta.dir, "../../src/cli.ts");

function makeEnv(home: string): Record<string, string | undefined> {
	// HOME alone isolates state; VEYYON_CONFIG_DIR is a dirname-under-HOME
	// override (not a full path), so setting it to a path would double-nest.
	const env: Record<string, string | undefined> = {
		...process.env,
		HOME: home,
		NO_COLOR: "1",
	};
	for (const key of ["VEYYON_CODING_AGENT_DIR", "VEYYON_CONFIG_DIR", "VEYYON_PROFILE"]) {
		delete env[key];
	}
	return env;
}

async function runConfig(
	env: Record<string, string | undefined>,
	args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["bun", cliPath, "config", ...args], {
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

describe("veyyon config", () => {
	it("list --json includes every setting with explicit value, type, description", async () => {
		const env = makeEnv(mkdtempSync(path.join(tmpdir(), "veyyon-config-home-")));
		const { stdout, exitCode } = await runConfig(env, ["list", "--json"]);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout) as Record<string, { value: unknown; type: string; description: string }>;
		expect(Object.keys(parsed).length).toBeGreaterThan(100);
		expect(parsed["git.enabled"]).toEqual({
			value: true,
			type: "boolean",
			description: parsed["git.enabled"].description,
		});
		// Unset string settings must still carry a value key (null), never be dropped.
		expect("shellPath" in parsed).toBe(true);
		expect(parsed.shellPath.value).toBeNull();
		for (const entry of Object.values(parsed)) {
			expect("value" in entry).toBe(true);
			expect(typeof entry.type).toBe("string");
			expect(typeof entry.description).toBe("string");
		}
	}, 30_000);

	it("set then get roundtrips a boolean and persists across processes", async () => {
		const env = makeEnv(mkdtempSync(path.join(tmpdir(), "veyyon-config-home-")));
		const set = await runConfig(env, ["set", "git.enabled", "false"]);
		expect(set.exitCode).toBe(0);
		expect(set.stdout).toContain("Set git.enabled = false");
		const get = await runConfig(env, ["get", "git.enabled", "--json"]);
		expect(get.exitCode).toBe(0);
		expect(JSON.parse(get.stdout)).toMatchObject({ key: "git.enabled", value: false, type: "boolean" });
	}, 30_000);

	it("reset restores the default value", async () => {
		const env = makeEnv(mkdtempSync(path.join(tmpdir(), "veyyon-config-home-")));
		await runConfig(env, ["set", "git.enabled", "false"]);
		const reset = await runConfig(env, ["reset", "git.enabled"]);
		expect(reset.exitCode).toBe(0);
		expect(reset.stdout).toContain("Reset git.enabled");
		const get = await runConfig(env, ["get", "git.enabled"]);
		expect(get.exitCode).toBe(0);
		expect(get.stdout.trim()).toBe("true");
	}, 30_000);

	it("get with an unset string setting reports null in JSON", async () => {
		const env = makeEnv(mkdtempSync(path.join(tmpdir(), "veyyon-config-home-")));
		const { stdout, exitCode } = await runConfig(env, ["get", "shellPath", "--json"]);
		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toMatchObject({ key: "shellPath", value: null, type: "string" });
	}, 30_000);

	it("rejects an unknown key with exit 1 and a list hint", async () => {
		const env = makeEnv(mkdtempSync(path.join(tmpdir(), "veyyon-config-home-")));
		for (const args of [
			["get", "no.such.key"],
			["set", "no.such.key", "1"],
			["reset", "no.such.key"],
		]) {
			const { stderr, exitCode } = await runConfig(env, args);
			expect(exitCode).toBe(1);
			expect(stderr).toContain("Unknown setting: no.such.key");
			expect(stderr).toContain("config list");
		}
	}, 30_000);

	it("rejects an invalid boolean value with exit 1 without changing the setting", async () => {
		const env = makeEnv(mkdtempSync(path.join(tmpdir(), "veyyon-config-home-")));
		const set = await runConfig(env, ["set", "git.enabled", "maybe"]);
		expect(set.exitCode).toBe(1);
		const get = await runConfig(env, ["get", "git.enabled"]);
		expect(get.stdout.trim()).toBe("true");
	}, 30_000);

	it("missing key argument exits 1 with usage", async () => {
		const env = makeEnv(mkdtempSync(path.join(tmpdir(), "veyyon-config-home-")));
		const { stderr, exitCode } = await runConfig(env, ["get"]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("config get <key>");
	}, 30_000);

	it("path prints the agent directory under the temp home", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "veyyon-config-home-"));
		const env = makeEnv(home);
		const { stdout, exitCode } = await runConfig(env, ["path"]);
		expect(exitCode).toBe(0);
		expect(stdout.trim()).toBe(path.join(home, ".veyyon", "profiles", "default", "agent"));
	}, 30_000);
});
