import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { commands } from "@veyyon/coding-agent/cli-commands";
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

/**
 * A two-word prompt whose first word is not a subcommand, so argv falls through
 * to `launch` and the non-TTY guard is what answers.
 */
const PROSE_POSITIONALS = ["rename", "everything"] as const;

/** Every name argv can resolve to a subcommand by, aliases included. */
const registeredNames = (): string[] => commands.flatMap(c => [c.name, ...(c.aliases ?? [])]);

describe("non-TTY stdin contract (e2e)", () => {
	it("the prose positional this suite relies on is not a registered subcommand", () => {
		// Guards the suite's own premise. Without this, a future `veyyon rename`
		// would turn the test below into an assertion about that command's usage
		// error while still claiming to test the non-TTY guard, which is exactly
		// how it broke with `sessions`.
		expect(registeredNames()).not.toContain(PROSE_POSITIONALS[0]);
	});

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
		// The first word has to be one that falls through to `launch` as prose. This
		// test used to hardcode `sessions list`, which was prose when it was written
		// and then became a registered alias of `veyyon session`; the CLI correctly
		// answered with that command's usage error and the test read it as a
		// regression in the non-TTY guard. Deriving the word from the registry and
		// asserting it is unclaimed means the next command added cannot quietly
		// change what this test is exercising: it fails loudly and says why.
		const [first, second] = PROSE_POSITIONALS;
		expect(registeredNames()).not.toContain(first);

		const { done } = spawnCli([first, second], "ignore");
		const { stderr, exitCode } = await done;

		expect(exitCode).toBe(1);
		expect(stderr).toContain("Interactive mode needs a terminal");
		// The exact rerun command, with the positional prompt quoted into it.
		expect(stderr).toContain(`veyyon -p "${first} ${second}"`);
		// The typo'd-subcommand escape hatch.
		expect(stderr).toContain(`If "${first}" was meant as a subcommand`);
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

	it("`-p` with a piped prompt consumes it (reaches the runner) instead of silently exiting 0", async () => {
		const { done } = spawnCli(["-p"], new Blob(["Reply with exactly: ok\n"]));
		const { stdout, stderr, exitCode } = await done;

		// The old bug: readPipedInput gated on `isTTY !== false`, so the pipe was
		// silently discarded and the run exited 0 with zero output. Proof the pipe
		// was consumed is environment-independent — it does NOT depend on the host
		// having credentials, so this e2e stays hermetic whether or not the CI/dev
		// environment exports a provider key: the "No prompt provided" gate fires
		// ONLY when nothing reached the runner (checked before any model/session
		// work), so a consumed prompt never trips it, and the run fails loudly
		// rather than succeeding silently.
		expect(exitCode).not.toBe(0);
		expect(stderr).not.toContain("No prompt provided");
		expect(stdout + stderr).not.toBe("");

		// Whether a model resolved on this host decides WHICH loud failure follows.
		// With no model available, the run stops at the no-models gate before print
		// mode; with a model, it reaches print mode and "Working..." is written to
		// stderr before the first prompt send. When it did reach print mode, assert
		// that indicator so the print-mode path keeps its coverage.
		if (!stderr.includes("No models available")) {
			expect(stderr).toContain("Working...");
		}
	}, 120_000);

	it("`-p` with no prompt anywhere errors with usage guidance instead of a silent 0-exit no-op", async () => {
		const { done } = spawnCli(["-p"], "ignore");
		const { stderr, exitCode } = await done;

		expect(exitCode).toBe(2);
		expect(stderr).toContain("No prompt provided");
	}, 60_000);
});
