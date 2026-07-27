/**
 * `veyyon config` e2e: list/get/set/reset/path against a throwaway home.
 * Pins the JSON contracts (every entry carries an explicit `value`, null when
 * unset), the set→get roundtrip persistence, and the exit-1 error surfaces.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import * as path from "node:path";
import { useTrackedTempDirs } from "../helpers/tracked-temp-dir";

const makeTempDir = useTrackedTempDirs("veyyon-config-home-");

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
		const env = makeEnv(makeTempDir());
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
		const env = makeEnv(makeTempDir());
		const set = await runConfig(env, ["set", "git.enabled", "false"]);
		expect(set.exitCode).toBe(0);
		expect(set.stdout).toContain("Set git.enabled = false");
		const get = await runConfig(env, ["get", "git.enabled", "--json"]);
		expect(get.exitCode).toBe(0);
		expect(JSON.parse(get.stdout)).toMatchObject({ key: "git.enabled", value: false, type: "boolean" });
	}, 30_000);

	it("reset restores the default value", async () => {
		const env = makeEnv(makeTempDir());
		await runConfig(env, ["set", "git.enabled", "false"]);
		const reset = await runConfig(env, ["reset", "git.enabled"]);
		expect(reset.exitCode).toBe(0);
		expect(reset.stdout).toContain("Reset git.enabled");
		const get = await runConfig(env, ["get", "git.enabled"]);
		expect(get.exitCode).toBe(0);
		expect(get.stdout.trim()).toBe("true");
	}, 30_000);

	it("get with an unset string setting reports null in JSON", async () => {
		const env = makeEnv(makeTempDir());
		const { stdout, exitCode } = await runConfig(env, ["get", "shellPath", "--json"]);
		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toMatchObject({ key: "shellPath", value: null, type: "string" });
	}, 30_000);

	it("rejects an unknown key with exit 1 and a list hint", async () => {
		const env = makeEnv(makeTempDir());
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
		const env = makeEnv(makeTempDir());
		const set = await runConfig(env, ["set", "git.enabled", "maybe"]);
		expect(set.exitCode).toBe(1);
		const get = await runConfig(env, ["get", "git.enabled"]);
		expect(get.stdout.trim()).toBe("true");
	}, 30_000);

	it("missing key argument exits 1 with usage", async () => {
		const env = makeEnv(makeTempDir());
		const { stderr, exitCode } = await runConfig(env, ["get"]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("config get <key>");
	}, 30_000);

	/**
	 * A one-shot command must not report a write it did not achieve.
	 *
	 * `set` and `reset` printed their green tick and exited 0 without ever waiting for the
	 * debounced save, so a config path that cannot be written produced a
	 * successful-looking command and a setting that was never persisted. A script checking
	 * the exit status was told the change landed.
	 */
	describe("a config file that cannot be written", () => {
		/** A home whose profile config path is a DIRECTORY, so every write to it fails. */
		function homeWithBlockedConfig(): Record<string, string | undefined> {
			const home = makeTempDir();
			const agentDir = path.join(home, ".veyyon", "profiles", "default", "agent");
			mkdirSync(path.join(agentDir, "config.yml"), { recursive: true });
			return makeEnv(home);
		}

		it("set exits 1 and names the path and the reason instead of printing success", async () => {
			const env = homeWithBlockedConfig();
			const { stdout, stderr, exitCode } = await runConfig(env, ["set", "git.enabled", "false"]);
			expect(exitCode).toBe(1);
			expect(stderr).toContain("Could not save");
			expect(stderr).toContain("config.yml");
			expect(stderr).toContain("writable");
			// The success line must not appear: that is the whole defect.
			expect(stdout).not.toContain("Set git.enabled");
		}, 30_000);

		it("reset exits 1 for the same reason", async () => {
			const env = homeWithBlockedConfig();
			const { stdout, exitCode } = await runConfig(env, ["reset", "git.enabled"]);
			expect(exitCode).toBe(1);
			expect(stdout).not.toContain("Reset git.enabled");
		}, 30_000);

		it("set --json exits 1 rather than emitting a JSON success a script would trust", async () => {
			// The JSON contract is what automation reads. Printing `{"key":...}` here
			// would be a machine-readable lie.
			const env = homeWithBlockedConfig();
			const { stdout, exitCode } = await runConfig(env, ["set", "git.enabled", "false", "--json"]);
			expect(exitCode).toBe(1);
			expect(stdout.trim()).toBe("");
		}, 30_000);

		it("still exits 0 and persists when the path IS writable", async () => {
			// The negative twin: a suite that only checked the failure would pass with a
			// `set` that always exits 1.
			const env = makeEnv(makeTempDir());
			const set = await runConfig(env, ["set", "git.enabled", "false"]);
			expect(set.exitCode).toBe(0);
			const get = await runConfig(env, ["get", "git.enabled"]);
			expect(get.stdout.trim()).toBe("false");
		}, 30_000);
	});

	it("path prints the agent directory under the temp home", async () => {
		const home = makeTempDir();
		const env = makeEnv(home);
		const { stdout, exitCode } = await runConfig(env, ["path"]);
		expect(exitCode).toBe(0);
		expect(stdout.trim()).toBe(path.join(home, ".veyyon", "profiles", "default", "agent"));
	}, 30_000);
});
