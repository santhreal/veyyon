/**
 * `veyyon ssh` e2e: add/list/remove lifecycle across project and user scopes,
 * run from a throwaway cwd so project config lands in the fixture, not a repo.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const cliPath = path.resolve(import.meta.dir, "../../src/cli.ts");

function makeDirs(): { home: string; cwd: string } {
	return {
		home: mkdtempSync(path.join(tmpdir(), "veyyon-ssh-home-")),
		cwd: mkdtempSync(path.join(tmpdir(), "veyyon-ssh-cwd-")),
	};
}

async function runSsh(
	dirs: { home: string; cwd: string },
	args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const env: Record<string, string | undefined> = { ...process.env, HOME: dirs.home, NO_COLOR: "1" };
	for (const key of ["VEYYON_CODING_AGENT_DIR", "VEYYON_CONFIG_DIR", "VEYYON_PROFILE"]) {
		delete env[key];
	}
	const proc = Bun.spawn(["bun", cliPath, "ssh", ...args], {
		env,
		cwd: dirs.cwd,
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

describe("veyyon ssh", () => {
	it("lists no hosts on a fresh setup with an add hint", async () => {
		const dirs = makeDirs();
		const { stdout, exitCode } = await runSsh(dirs, ["list"]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("No SSH hosts configured");
		expect(stdout).toContain("veyyon ssh add");
	}, 30_000);

	it("add writes project scope by default, --scope user writes the home config", async () => {
		const dirs = makeDirs();
		const added = await runSsh(dirs, ["add", "box", "--host", "10.0.0.5", "--user", "root", "--port", "2222"]);
		expect(added.exitCode).toBe(0);
		expect(added.stdout).toContain('Added SSH host "box" to project config');
		expect(existsSync(path.join(dirs.cwd, ".veyyon", "ssh.json"))).toBe(true);

		const userAdd = await runSsh(dirs, ["add", "homebox", "--host", "192.168.1.9", "--scope", "user"]);
		expect(userAdd.exitCode).toBe(0);
		expect(userAdd.stdout).toContain('Added SSH host "homebox" to user config');

		const listed = await runSsh(dirs, ["list", "--json"]);
		expect(listed.exitCode).toBe(0);
		const parsed = JSON.parse(listed.stdout) as {
			project: Record<string, { host: string; username?: string; port?: number }>;
			user: Record<string, { host: string }>;
		};
		expect(parsed.project.box).toEqual({ host: "10.0.0.5", username: "root", port: 2222 });
		expect(parsed.user.homebox).toEqual({ host: "192.168.1.9" });
	}, 30_000);

	it("remove deletes the host and refuses an unknown one", async () => {
		const dirs = makeDirs();
		await runSsh(dirs, ["add", "box", "--host", "10.0.0.5"]);
		const removed = await runSsh(dirs, ["remove", "box"]);
		expect(removed.exitCode).toBe(0);
		const listed = await runSsh(dirs, ["list"]);
		expect(listed.stdout).toContain("No SSH hosts configured");

		const missing = await runSsh(dirs, ["remove", "ghost"]);
		expect(missing.exitCode).toBe(1);
	}, 30_000);

	it("add without --host exits 1", async () => {
		const dirs = makeDirs();
		const { exitCode } = await runSsh(dirs, ["add", "nohost"]);
		expect(exitCode).toBe(1);
	}, 30_000);
});
