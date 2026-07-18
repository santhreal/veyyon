import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";

// E2E twins for the non-TTY stdin contract:
//
// 1. `veyyon` (interactive) with no terminal and nothing piped used to launch
//    the TUI against a dead stdin and hang forever with ZERO output
//    (`veyyon auth list </dev/null` blocked until killed). It must fail fast.
// 2. `echo prompt | veyyon -p` used to exit 0 with zero output: readPipedInput
//    gated on `isTTY !== false`, but Bun/Node leave `isTTY` as `undefined` on
//    a pipe, so piped prompts were silently discarded. The piped prompt must
//    actually be consumed (the "Working..." indicator proves it reached print
//    mode as the initial message).
// 3. `veyyon -p` with no prompt anywhere (and no session to resume) is a
//    silent no-op; it must error with usage guidance instead of exiting 0.

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const cliEntry = path.join(repoRoot, "src", "cli.ts");

// Isolated agent dir: no real credentials, no user settings.
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-nontty-test-"));
// Empty project dir so repo discovery/extensions don't slow startup.
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-nontty-proj-"));
const hermetic = hermeticSpawnEnv({ VEYYON_NO_TITLE: "1", VEYYON_CODING_AGENT_DIR: agentDir });

afterAll(() => {
	hermetic.cleanup();
	fs.rmSync(agentDir, { recursive: true, force: true });
	fs.rmSync(projectDir, { recursive: true, force: true });
});

const spawnCli = (
	args: string[],
	stdin: "ignore" | Blob,
): { proc: ReturnType<typeof Bun.spawn>; done: Promise<{ stdout: string; stderr: string; exitCode: number }> } => {
	const proc = Bun.spawn([process.execPath, cliEntry, ...args], {
		cwd: projectDir,
		stdin,
		stdout: "pipe",
		stderr: "pipe",
		env: hermetic.env,
	});
	const done = Promise.all([
		new Response(proc.stdout as ReadableStream).text(),
		new Response(proc.stderr as ReadableStream).text(),
		proc.exited,
	]).then(([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode }));
	return { proc, done };
};

describe("non-TTY stdin contract (e2e)", () => {
	it("interactive launch with non-TTY stdin and nothing piped fails fast instead of hanging", async () => {
		const { done } = spawnCli([], "ignore");
		const { stderr, exitCode } = await done;

		expect(exitCode).toBe(1);
		expect(stderr).toContain("Interactive mode needs a terminal");
		expect(stderr).toContain("-p");
	}, 60_000);

	it("`veyyon auth list` (unknown-subcommand fallthrough) with dead stdin fails fast, not a zero-output hang", async () => {
		const { done } = spawnCli(["auth", "list"], "ignore");
		const { stdout, stderr, exitCode } = await done;

		expect(exitCode).toBe(1);
		expect(stderr).toContain("Interactive mode needs a terminal");
		// The old failure mode: zero bytes on both streams, process never exits.
		expect(stdout + stderr).not.toBe("");
	}, 60_000);

	it("positional args with non-TTY stdin name both fixes: the -p rerun and the subcommand possibility", async () => {
		const { done } = spawnCli(["sessions", "list"], "ignore");
		const { stderr, exitCode } = await done;

		expect(exitCode).toBe(1);
		expect(stderr).toContain("Interactive mode needs a terminal");
		// The exact rerun command, with the positional prompt quoted into it.
		expect(stderr).toContain('veyyon -p "sessions list"');
		// The typo'd-subcommand escape hatch.
		expect(stderr).toContain('If "sessions" was meant as a subcommand');
		expect(stderr).toContain("veyyon --help");
		// The old message lied when positionals were present.
		expect(stderr).not.toContain("no prompt was piped in");
	}, 60_000);

	it("a typo'd subcommand with trailing args gets a did-you-mean, which the bare pre-launch guard cannot give", async () => {
		// `veyyon confg get foo` — argc 3, so the argc===1 pre-launch near-miss
		// guard never fires; the non-TTY error must carry the suggestion instead.
		const { done } = spawnCli(["confg", "get", "foo"], "ignore");
		const { stderr, exitCode } = await done;

		expect(exitCode).toBe(1);
		expect(stderr).toContain('veyyon -p "confg get foo"');
		expect(stderr).toContain("Did you mean");
		expect(stderr).toContain("`veyyon config`");
	}, 60_000);

	it("`-p` with a piped prompt consumes it (reaches print mode) instead of silently exiting 0", async () => {
		const { done } = spawnCli(["-p"], new Blob(["Reply with exactly: ok\n"]));
		const { stdout, stderr, exitCode } = await done;

		// No credentials in the isolated agent dir, so the prompt itself fails —
		// but the piped text must reach print mode: "Working..." is written
		// before the initial prompt is sent, and the run must NOT succeed
		// silently. Before the fix this exited 0 with zero output.
		expect(stderr).toContain("Working...");
		expect(exitCode).not.toBe(0);
		expect(stdout + stderr).not.toBe("");
	}, 120_000);

	it("`-p` with no prompt anywhere errors with usage guidance instead of a silent 0-exit no-op", async () => {
		const { done } = spawnCli(["-p"], "ignore");
		const { stderr, exitCode } = await done;

		expect(exitCode).toBe(2);
		expect(stderr).toContain("No prompt provided");
	}, 60_000);
});
