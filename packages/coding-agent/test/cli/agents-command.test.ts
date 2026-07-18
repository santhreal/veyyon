/**
 * `veyyon agents unpack` e2e: bundled agent definitions land on disk as
 * frontmatter markdown, re-running skips existing files unless --force, and
 * --user/--project together is rejected.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

async function runAgents(
	env: Record<string, string | undefined>,
	args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["bun", cliPath, "agents", ...args], {
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

describe("veyyon agents unpack", () => {
	it("writes every bundled agent as frontmatter markdown, then skips on rerun and rewrites with --force", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "veyyon-agents-home-"));
		const env = makeEnv(home);

		const first = await runAgents(env, ["unpack", "--json"]);
		expect(first.exitCode).toBe(0);
		const result = JSON.parse(first.stdout) as {
			targetDir: string;
			total: number;
			written: string[];
			skipped: string[];
		};
		expect(result.targetDir).toBe(path.join(home, ".veyyon", "profiles", "default", "agent", "agents"));
		expect(result.total).toBeGreaterThan(0);
		expect(result.written.length).toBe(result.total);
		expect(result.skipped).toEqual([]);

		const files = readdirSync(result.targetDir).filter(name => name.endsWith(".md"));
		expect(files.length).toBe(result.total);
		const sample = readFileSync(result.written[0], "utf8");
		expect(sample.startsWith("---\n")).toBe(true);
		expect(sample).toContain("name:");
		expect(sample).toContain("description:");

		// A rerun must not clobber user edits without --force.
		writeFileSync(result.written[0], "user-edited\n");
		const second = await runAgents(env, ["unpack", "--json"]);
		expect(second.exitCode).toBe(0);
		const rerun = JSON.parse(second.stdout) as { written: string[]; skipped: string[] };
		expect(rerun.written).toEqual([]);
		expect(rerun.skipped.length).toBe(result.total);
		expect(readFileSync(result.written[0], "utf8")).toBe("user-edited\n");

		const forced = await runAgents(env, ["unpack", "--force", "--json"]);
		expect(forced.exitCode).toBe(0);
		const forcedResult = JSON.parse(forced.stdout) as { written: string[]; skipped: string[] };
		expect(forcedResult.written.length).toBe(result.total);
		expect(readFileSync(result.written[0], "utf8")).not.toBe("user-edited\n");
	}, 30_000);

	it("unpacks into an explicit --dir relative to the project", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "veyyon-agents-home-"));
		const target = mkdtempSync(path.join(tmpdir(), "veyyon-agents-dir-"));
		const { stdout, exitCode } = await runAgents(makeEnv(home), ["unpack", "--dir", target, "--json"]);
		expect(exitCode).toBe(0);
		const result = JSON.parse(stdout) as { targetDir: string; written: string[] };
		expect(result.targetDir).toBe(target);
		expect(result.written.every(file => file.startsWith(target))).toBe(true);
	}, 30_000);

	it("rejects --user together with --project", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "veyyon-agents-home-"));
		const { stderr, exitCode } = await runAgents(makeEnv(home), ["unpack", "--user", "--project"]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("either --user or --project");
	}, 30_000);
});
