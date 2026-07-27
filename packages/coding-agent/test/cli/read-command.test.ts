/**
 * `veyyon read` CLI probe: prints the read tool's content blocks exactly as
 * the model receives them (hashline header + numbered lines), exits 1 on a
 * missing path, and exits 1 on a binary-file refusal. The tool keeps the
 * refusal a non-error result so the agent gets the `:raw` hint without a retry
 * storm; the CLI has no retry loop, so it reports the refusal honestly via a
 * `details.contentUnavailable` marker and a non-zero exit (BACKLOG
 * READ-CLI-BINARY-EXIT0). The bracketed notice and `:raw` hint still print.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { removeSyncWithRetries } from "@veyyon/utils";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";

const cliPath = path.resolve(import.meta.dir, "../../src/cli.ts");

/**
 * Fixture trees this file made, deleted together at the end.
 *
 * They were never deleted at all. Each `runRead` call spawned the real CLI with a
 * fresh temp HOME and left it behind, and the CLI populates a whole config root
 * under the home it is given, so one abandoned directory was ~289MB. Three CLI
 * suites had the same hole; between them they had left 3,265 directories and 34GB
 * in `/tmp` on the machine where this was found, growing by roughly that much a
 * week. A leak that only shows up on a developer's disk is invisible to every gate
 * in this repository, which is why the cleanup has to be registered here rather
 * than remembered.
 */
const fixtures: string[] = [];

function makeFixtureDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "veyyon-read-fixture-"));
	fixtures.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of fixtures) removeSyncWithRetries(dir);
	fixtures.length = 0;
});

async function runRead(args: string[], cwd?: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	// `hermeticSpawnEnv` rather than a hand-built env, and not only for the cleanup it
	// carries. The list this file used to clear named three veyyon variables and none of
	// the four XDG bases, which is the partial-list trap that helper exists to close: a
	// developer with `XDG_STATE_HOME` set handed every spawned CLI a state root inside
	// their REAL tree, so `logs/`, `sessions/` and `reports/` resolved there no matter
	// what HOME said.
	const { home, env, cleanup } = hermeticSpawnEnv();
	try {
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
	} finally {
		// `finally`, so a failing assertion or a spawn that throws still cleans up.
		// The leak this replaces was unconditional; a cleanup that only runs on the
		// happy path would just make it intermittent, which is harder to notice.
		cleanup();
	}
}

describe("veyyon read", () => {
	it("prints hashline header and numbered lines for a text file", async () => {
		const dir = makeFixtureDir();
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
		const dir = makeFixtureDir();
		writeFileSync(path.join(dir, "blob.bin"), Buffer.from([0x00, 0xff, 0xfe, 0x00, 0x01, 0x02]));
		const { exitCode, stdout } = await runRead(["blob.bin"], dir);
		expect(exitCode).toBe(1);
		expect(stdout).toContain("Cannot read binary file");
		expect(stdout).toContain(":raw");
	}, 30_000);

	it(":raw reads binary bytes verbatim as a hex/raw view", async () => {
		const dir = makeFixtureDir();
		writeFileSync(path.join(dir, "blob.bin"), Buffer.from([0x00, 0xff, 0xfe, 0x00, 0x01, 0x02]));
		const { exitCode, stdout } = await runRead(["blob.bin:raw"], dir);
		expect(exitCode).toBe(0);
		expect(stdout).not.toContain("Cannot read binary file");
		expect(stdout.length).toBeGreaterThan(0);
	}, 30_000);
});
