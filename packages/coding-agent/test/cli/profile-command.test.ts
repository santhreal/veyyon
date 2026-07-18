/**
 * `veyyon profile` e2e: list/new/rm lifecycle against a throwaway home. Pins
 * the safety rails — rm refuses without --yes, refuses the default profile,
 * refuses a nonexistent name — and the JSON listing shape.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const cliPath = path.resolve(import.meta.dir, "../../src/cli.ts");

function makeEnv(home: string): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...process.env, HOME: home, NO_COLOR: "1" };
	for (const key of ["VEYYON_CODING_AGENT_DIR", "VEYYON_CONFIG_DIR", "VEYYON_PROFILE"]) {
		delete env[key];
	}
	return env;
}

async function runProfile(
	env: Record<string, string | undefined>,
	args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["bun", cliPath, "profile", ...args], {
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

describe("veyyon profile", () => {
	it("new creates a profile, list shows it, rm --yes removes it", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "veyyon-profile-home-"));
		const env = makeEnv(home);

		const created = await runProfile(env, ["new", "work"]);
		expect(created.exitCode).toBe(0);
		expect(created.stdout).toContain('Created profile "work"');
		const agentDir = path.join(home, ".veyyon", "profiles", "work", "agent");
		expect(created.stdout).toContain(agentDir);
		expect(existsSync(agentDir)).toBe(true);

		const listed = await runProfile(env, ["list", "--json"]);
		expect(listed.exitCode).toBe(0);
		const rows = JSON.parse(listed.stdout) as {
			name: string;
			rootDir: string;
			active: boolean;
			bytes: number;
		}[];
		const names = rows.map(row => row.name);
		expect(names).toContain("default");
		expect(names).toContain("work");
		const work = rows.find(row => row.name === "work");
		expect(work?.active).toBe(false);
		expect(work?.rootDir).toBe(path.join(home, ".veyyon", "profiles", "work"));
		expect(rows.find(row => row.name === "default")?.active).toBe(true);

		const removed = await runProfile(env, ["rm", "work", "--yes"]);
		expect(removed.exitCode).toBe(0);
		expect(removed.stdout).toContain("Removed profile at");
		expect(existsSync(path.join(home, ".veyyon", "profiles", "work"))).toBe(false);
	}, 30_000);

	it("rm without --yes refuses and leaves the profile intact", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "veyyon-profile-home-"));
		const env = makeEnv(home);
		await runProfile(env, ["new", "keepme"]);
		const { stderr, exitCode } = await runProfile(env, ["rm", "keepme"]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("--yes");
		expect(existsSync(path.join(home, ".veyyon", "profiles", "keepme"))).toBe(true);
	}, 30_000);

	it("refuses to create a duplicate or remove default/nonexistent profiles", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "veyyon-profile-home-"));
		const env = makeEnv(home);
		await runProfile(env, ["new", "dup"]);
		const dup = await runProfile(env, ["new", "dup"]);
		expect(dup.exitCode).toBe(1);
		expect(dup.stderr).toContain('Profile "dup" already exists');

		const rmDefault = await runProfile(env, ["rm", "default", "--yes"]);
		expect(rmDefault.exitCode).toBe(1);

		const rmMissing = await runProfile(env, ["rm", "ghost", "--yes"]);
		expect(rmMissing.exitCode).toBe(1);
		expect(rmMissing.stderr).toContain('Profile "ghost" does not exist');
	}, 30_000);

	it("new --from blank seeds an empty agent tree", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "veyyon-profile-home-"));
		const env = makeEnv(home);
		const { stdout, exitCode } = await runProfile(env, ["new", "bounty", "--from", "blank", "--json"]);
		expect(exitCode).toBe(0);
		const created = JSON.parse(stdout) as { name: string; agentDir: string };
		expect(created.name).toBe("bounty");
		expect(existsSync(created.agentDir)).toBe(true);
	}, 30_000);
});
