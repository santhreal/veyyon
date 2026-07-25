import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";

/**
 * Machine output goes to stdout. Everything else goes to stderr.
 *
 * WHY THIS SUITE EXISTS (OUT-3, OUT-4). The whole value of a CLI in a pipeline
 * rests on one promise: whatever comes out of stdout is the thing you asked for
 * and nothing else. Break it and `veyyon ssh list --json | jq` fails on a line
 * of red text that was meant for a human, and the failure looks like malformed
 * JSON rather than like the error it actually is.
 *
 * `ssh-cli.ts` broke it in seven places. Every usage error, every validation
 * failure, and every caught exception was written with
 * `process.stdout.write(chalk.red(...))`, sharing the stream with the `--json`
 * listing three functions away. A caller piping that command got the diagnostic
 * spliced into its data.
 *
 * OUT-4 is the same promise under a different condition. When stdout is a pipe
 * rather than a terminal, cursor control and colour are not just useless, they
 * are corruption: the consumer is a program, and an escape sequence is bytes it
 * did not ask for. So the spawned processes here read their output through a
 * pipe, which is exactly the non-TTY case, and the bytes are asserted directly.
 *
 * These spawn a real CLI. Stream separation is a property of the process, not of
 * a function, and a unit test that stubs `process.stdout` proves only that the
 * stub was called.
 */

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const cliEntry = path.join(repoRoot, "src", "cli.ts");

/** Any ANSI escape sequence: colour, cursor movement, erase, mode set. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching escape bytes is the point
const ANSI = /\[[0-9;?]*[A-Za-z]/u;

interface SpawnResult {
	code: number;
	stdout: string;
	stderr: string;
}

async function runCli(args: string[], extraEnv?: Record<string, string>): Promise<SpawnResult> {
	const { env, cleanup } = hermeticSpawnEnv(extraEnv);
	try {
		const proc = Bun.spawn([process.execPath, cliEntry, ...args], {
			env,
			stdin: "ignore",
			// Piped, not inherited: this is the non-TTY condition OUT-4 is about.
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { code, stdout, stderr };
	} finally {
		cleanup();
	}
}

describe("a diagnostic never lands on stdout", () => {
	/**
	 * THE REGRESSION. `veyyon ssh add` with no name wrote its error and its usage
	 * hint to stdout, on the same stream as `ssh list --json`.
	 */
	it("sends the ssh add usage error to stderr and leaves stdout empty", async () => {
		const result = await runCli(["ssh", "add"]);

		expect(result.stderr).toContain("Host name required");
		expect(result.stdout.trim()).toBe("");
	}, 60_000);

	/** The missing-flag error, which was the second of the seven. */
	it("sends the missing --host error to stderr", async () => {
		const result = await runCli(["ssh", "add", "myhost"]);

		expect(result.stderr).toContain("--host is required");
		expect(result.stdout.trim()).toBe("");
	}, 60_000);

	/** A validation failure on a supplied value takes the same path. */
	it("sends the port validation error to stderr", async () => {
		const result = await runCli(["ssh", "add", "myhost", "--host", "example.com", "--port", "999999"]);

		expect(result.stderr).toContain("Port must be");
		expect(result.stdout.trim()).toBe("");
	}, 60_000);

	/**
	 * An unknown subaction is a usage error, not data. The framework's own
	 * options-constraint check catches this one before the handler runs, which is
	 * why the assertion is on the offending token rather than on a message the
	 * handler would have written: either way it must be on stderr and stdout must
	 * stay empty.
	 */
	it("sends an unknown ssh action to stderr", async () => {
		const result = await runCli(["ssh", "frobnicate"]);

		expect(result.stderr).toContain("frobnicate");
		expect(result.stdout.trim()).toBe("");
	}, 60_000);

	/**
	 * The top-level case. An unrecognized flag must not put a word on stdout,
	 * because a wrapper reading stdout would treat the complaint as output.
	 */
	it("keeps an unrecognized top-level flag off stdout", async () => {
		const result = await runCli(["--definitely-not-a-real-flag"]);

		expect(result.stderr.trim().length).toBeGreaterThan(0);
		expect(result.stdout).not.toContain("definitely-not-a-real-flag");
	}, 60_000);
});

describe("machine output still goes to stdout", () => {
	/**
	 * THE NECESSARY TWIN. A fix that moved everything to stderr would satisfy
	 * every assertion above and destroy the CLI, so the data path is asserted just
	 * as hard: `--json` output must be on stdout and must parse.
	 */
	it("writes ssh list --json to stdout as parseable JSON", async () => {
		const result = await runCli(["ssh", "list", "--json"]);

		expect(result.code).toBe(0);
		expect(() => JSON.parse(result.stdout) as unknown).not.toThrow();
	}, 60_000);

	/**
	 * The JSON is the WHOLE of stdout, not JSON with a banner in front of it. This
	 * is the assertion a `| jq` pipeline actually depends on, and a leading status
	 * line would pass a looser "stdout contains JSON" check.
	 */
	it("puts nothing but the JSON document on stdout", async () => {
		const result = await runCli(["ssh", "list", "--json"]);
		const parsed = JSON.parse(result.stdout) as Record<string, unknown>;

		expect(Object.keys(parsed).sort()).toEqual(["project", "user"]);
	}, 60_000);

	/** `--version` answers a question, so its answer belongs on stdout. */
	it("writes the version to stdout", async () => {
		const result = await runCli(["--version"]);

		expect(result.stdout.trim().length).toBeGreaterThan(0);
	}, 60_000);
});

describe("piped output carries no terminal control bytes", () => {
	/**
	 * THE OUT-4 CONTRACT. stdout is a pipe here, so the consumer is a program.
	 * Colour codes and cursor movement in that stream are bytes the consumer did
	 * not ask for and cannot interpret.
	 */
	it("emits no ANSI sequences in piped --json output", async () => {
		const result = await runCli(["ssh", "list", "--json"]);

		expect(ANSI.test(result.stdout)).toBe(false);
	}, 60_000);

	/** The same holds for the simplest possible output. */
	it("emits no ANSI sequences in piped --version output", async () => {
		const result = await runCli(["--version"]);

		expect(ANSI.test(result.stdout)).toBe(false);
	}, 60_000);

	/**
	 * No cursor control specifically, which is the class that corrupts a captured
	 * log rather than merely decorating it: a spinner rewriting its own line turns
	 * a redirected file into unreadable overstrike.
	 */
	it("emits no cursor movement or line-erase sequences when piped", async () => {
		const result = await runCli(["--help"]);
		// Cursor up/down/forward/back, position, erase-in-line, erase-in-display.
		// biome-ignore lint/suspicious/noControlCharactersInRegex: matching escape bytes is the point
		const CURSOR = /\[[0-9;]*[ABCDHJKfsu]/u;

		expect(CURSOR.test(result.stdout)).toBe(false);
	}, 60_000);

	/**
	 * Help is plain text end to end when piped. A reader who redirects `--help`
	 * into a file should get something they can read, not escape soup.
	 */
	it("emits plain-text help when piped", async () => {
		const result = await runCli(["--help"]);

		expect(result.stdout).toContain("USAGE");
		expect(ANSI.test(result.stdout)).toBe(false);
	}, 60_000);
});
