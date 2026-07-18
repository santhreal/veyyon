/**
 * `veyyon setup --check` e2e: dependency status reporting without installing
 * anything. Pins the python JSON shape, the speech human report, and the
 * unknown-component rejection.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";

const cliPath = path.resolve(import.meta.dir, "../../src/cli.ts");

async function runSetup(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const { env, cleanup } = hermeticSpawnEnv();
	try {
		const proc = Bun.spawn(["bun", cliPath, "setup", ...args], {
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
	} finally {
		cleanup();
	}
}

describe("veyyon setup --check", () => {
	it("python --check --json reports availability with paths", async () => {
		const { stdout, exitCode } = await runSetup(["python", "--check", "--json"]);
		expect(exitCode).toBe(0);
		const status = JSON.parse(stdout) as {
			available: boolean;
			managedEnvPath: string;
			usingManagedEnv: boolean;
		};
		expect(typeof status.available).toBe("boolean");
		expect(status.managedEnvPath).toContain(path.join(".veyyon", "profiles", "default", "python-env"));
		expect(typeof status.usingManagedEnv).toBe("boolean");
	}, 30_000);

	it("speech --check lists each dependency and exits 1 iff something is missing", async () => {
		const { stdout, exitCode } = await runSetup(["speech", "--check"]);
		expect(exitCode).toBe(stdout.includes("[missing]") ? 1 : 0);
		expect(stdout).toContain("Speech dependencies:");
		expect(stdout).toContain("Recorder:");
		expect(stdout).toContain("Speech-to-Text model:");
		expect(stdout).toContain("Text-to-Speech model:");
		expect(stdout).toMatch(/\[(ok|missing)\]/);
	}, 30_000);

	it("rejects an unknown component with exit 1", async () => {
		const { exitCode } = await runSetup(["bogus", "--check"]);
		expect(exitCode).toBe(1);
	}, 30_000);
});
