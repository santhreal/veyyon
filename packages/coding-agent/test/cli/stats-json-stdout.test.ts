import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";

// `veyyon stats -j` is a machine-readable surface: stdout must be exactly one
// parseable JSON document. The "Syncing…"/"Synced…" progress lines belong on
// stderr — a progress line on stdout broke `veyyon stats -j | jq`.

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const cliEntry = path.join(repoRoot, "src", "cli.ts");

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-stats-json-test-"));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-stats-json-proj-"));

const hermetic = hermeticSpawnEnv({ VEYYON_NO_TITLE: "1", VEYYON_CODING_AGENT_DIR: agentDir });

afterAll(() => {
	hermetic.cleanup();
	fs.rmSync(agentDir, { recursive: true, force: true });
	fs.rmSync(projectDir, { recursive: true, force: true });
});

describe("veyyon stats -j (e2e)", () => {
	it("stdout is pure JSON; progress lines go to stderr", async () => {
		const proc = Bun.spawn([process.execPath, cliEntry, "stats", "-j"], {
			cwd: projectDir,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: hermetic.env,
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout as ReadableStream).text(),
			new Response(proc.stderr as ReadableStream).text(),
			proc.exited,
		]);

		expect(exitCode).toBe(0);
		// The whole stdout stream must parse — not just contain — a JSON object.
		const stats = JSON.parse(stdout) as { overall?: unknown };
		expect(stats.overall).toBeDefined();
		expect(stderr).toContain("Synced");
	}, 60_000);
});
