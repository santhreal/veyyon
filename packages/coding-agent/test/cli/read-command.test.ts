/**
 * `veyyon read` CLI probe: prints the read tool's content blocks exactly as
 * the model receives them (hashline header + numbered lines), exits 1 on a
 * missing path, and exits 1 on a binary-file refusal. The tool keeps the
 * refusal a non-error result so the agent gets the `:raw` hint without a retry
 * storm; the CLI has no retry loop, so it reports the refusal honestly via a
 * `details.contentUnavailable` marker and a non-zero exit (BACKLOG
 * READ-CLI-BINARY-EXIT0). The bracketed notice and `:raw` hint still print.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const cliPath = path.resolve(import.meta.dir, "../../src/cli.ts");

async function runRead(args: string[], cwd?: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const home = mkdtempSync(path.join(tmpdir(), "veyyon-read-home-"));
	const env: Record<string, string | undefined> = { ...process.env, HOME: home, NO_COLOR: "1" };
	for (const key of ["VEYYON_CODING_AGENT_DIR", "VEYYON_CONFIG_DIR", "VEYYON_PROFILE"]) {
		delete env[key];
	}

	const proc = Bun.spawn(["bun", cliPath, "read", ...args], {
		cwd: cwd ?? home,
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

describe("veyyon read", () => {
	it("prints hashline header and numbered lines for a text file", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "veyyon-read-fixture-"));
		writeFileSync(path.join(dir, "sample.txt"), "alpha\nbeta\n");
		const { exitCode, stdout } = await runRead(["sample.txt"], dir);
		expect(exitCode).toBe(0);
		expect(stdout).toMatch(/\[sample\.txt#[0-9A-F]{4}\]/);
		expect(stdout).toContain("1:alpha");
		expect(stdout).toContain("2:beta");
	}, 30_000);

	it("exits 1 with a not-found error for a missing path", async () => {
		const { exitCode, stderr } = await runRead(["/nonexistent-veyyon-read.txt"]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("not found");
	}, 30_000);

	it("exits 1 on a binary file while still printing the :raw hint", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "veyyon-read-fixture-"));
		writeFileSync(path.join(dir, "blob.bin"), Buffer.from([0x00, 0xff, 0xfe, 0x00, 0x01, 0x02]));
		const { exitCode, stdout } = await runRead(["blob.bin"], dir);
		expect(exitCode).toBe(1);
		expect(stdout).toContain("Cannot read binary file");
		expect(stdout).toContain(":raw");
	}, 30_000);

	it(":raw reads binary bytes verbatim as a hex/raw view", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "veyyon-read-fixture-"));
		writeFileSync(path.join(dir, "blob.bin"), Buffer.from([0x00, 0xff, 0xfe, 0x00, 0x01, 0x02]));
		const { exitCode, stdout } = await runRead(["blob.bin:raw"], dir);
		expect(exitCode).toBe(0);
		expect(stdout).not.toContain("Cannot read binary file");
		expect(stdout.length).toBeGreaterThan(0);
	}, 30_000);
});
