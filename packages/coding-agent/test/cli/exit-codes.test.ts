import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	CLI_EXIT_CODES,
	EXIT_FAILURE,
	EXIT_INTERRUPTED,
	EXIT_OK,
	EXIT_USAGE,
} from "@veyyon/coding-agent/cli/exit-codes";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";

/**
 * The exit code is the only thing a script can branch on, so it has to be right.
 *
 * WHY THIS SUITE EXISTS (OUT-1). Nothing else veyyon emits is machine-readable
 * from a shell. A CI step, a wrapper script, and an agent driving veyyon as a
 * subprocess all decide what to do next from the status alone, and the decision
 * they most need to make is whether retrying could possibly help.
 *
 * That decision rests on the difference between 1 and 2. A `1` says the
 * invocation was valid and the attempt failed, so a retry may succeed. A `2`
 * says the command line was wrong and nothing ran, so an identical retry is
 * guaranteed to fail again. Collapse them and a wrapper loops forever on a
 * typo'd flag.
 *
 * Before this row the codes were twenty bare `process.exit(0|1|2)` calls across
 * `main.ts` and `cli.ts`, with the meaning of `2` written in a comment beside
 * exactly one of them. Nothing stopped the next exit from picking a different
 * number for the same class, and nothing checked that what shipped matched
 * `docs/handbook/src/reference/exit-codes.md`, which had been documenting this
 * contract to users the whole time.
 *
 * The behavioural cases SPAWN A REAL CLI. An in-process assertion on a constant
 * proves the constant, not the exit, and the exit is the contract. They run
 * against a hermetic HOME so a child process can never read or migrate the
 * developer's real `~/.veyyon`.
 */

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const cliEntry = path.join(repoRoot, "src", "cli.ts");

interface SpawnResult {
	code: number;
	stdout: string;
	stderr: string;
}

async function runCli(args: string[], input = ""): Promise<SpawnResult> {
	const { env, cleanup } = hermeticSpawnEnv();
	try {
		const proc = Bun.spawn([process.execPath, cliEntry, ...args], {
			env,
			stdin: input.length > 0 ? new TextEncoder().encode(input) : "ignore",
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

describe("a successful command exits 0", () => {
	/**
	 * `--version` is the cheapest complete success path: it takes the same startup
	 * and teardown as anything else and needs no network, so a non-zero here means
	 * the process cannot exit cleanly at all.
	 */
	it("exits 0 for --version", async () => {
		const result = await runCli(["--version"]);

		expect(result.code).toBe(EXIT_OK);
		expect(result.stdout.trim().length).toBeGreaterThan(0);
	}, 60_000);

	/** Help is a request that was satisfied, not an error, so it is a success. */
	it("exits 0 for --help", async () => {
		const result = await runCli(["--help"]);

		expect(result.code).toBe(EXIT_OK);
		expect(result.stdout).toContain("USAGE");
	}, 60_000);

	/** Subcommand help is the same contract one level down. */
	it("exits 0 for a subcommand's --help", async () => {
		const result = await runCli(["config", "--help"]);

		expect(result.code).toBe(EXIT_OK);
	}, 60_000);
});

describe("a usage error exits 2, distinct from a runtime failure", () => {
	/**
	 * THE CASE THE WHOLE DISTINCTION EXISTS FOR. An unrecognized flag can never
	 * succeed on a retry, and reporting it as `1` is what makes a wrapper loop.
	 * It must also fail BEFORE any session starts: the original defect behind this
	 * code path let the unrecognized token be consumed and the next positional
	 * leak through as a prompt, which started a real model session.
	 */
	it("exits 2 for an unrecognized flag", async () => {
		const result = await runCli(["--definitely-not-a-real-flag", "hello"]);

		expect(result.code).toBe(EXIT_USAGE);
		expect(result.stderr.length).toBeGreaterThan(0);
	}, 60_000);

	/**
	 * A single-shot run with nothing to send is a usage error, not a failure: the
	 * command line is incomplete, so no attempt was made.
	 */
	it("exits 2 for --print with no prompt and no stdin", async () => {
		const result = await runCli(["--print"]);

		expect(result.code).toBe(EXIT_USAGE);
	}, 60_000);

	/**
	 * The diagnostic goes to stderr. A usage error on stdout would corrupt the
	 * output of any caller piping veyyon into another program, and stdout is
	 * reserved for the thing that was asked for.
	 */
	it("writes the usage diagnostic to stderr, not stdout", async () => {
		const result = await runCli(["--definitely-not-a-real-flag"]);

		expect(result.stderr.trim().length).toBeGreaterThan(0);
		expect(result.stdout).not.toContain("definitely-not-a-real-flag");
	}, 60_000);

	/**
	 * A bad VALUE for a good flag is the same class as a bad flag. Both are
	 * "the command line is wrong", and splitting them would give a caller two
	 * codes to handle for one decision.
	 */
	it("exits non-zero for a flag value outside its declared set", async () => {
		const result = await runCli(["--mode", "not-a-mode", "--print", "hi"]);

		expect(result.code).not.toBe(EXIT_OK);
	}, 60_000);
});

describe("the code table is the one the docs promise", () => {
	/**
	 * The constants are pinned to their literal values because those values ARE
	 * the published contract. Renaming a constant is free; changing what `2` means
	 * breaks every script that ever branched on it, so the number is asserted
	 * rather than merely referenced.
	 */
	it("pins each code to the value documented in the handbook", () => {
		expect(EXIT_OK).toBe(0);
		expect(EXIT_FAILURE).toBe(1);
		expect(EXIT_USAGE).toBe(2);
		expect(EXIT_INTERRUPTED).toBe(130);
	});

	/**
	 * The enumeration covers every constant. A code added without an entry here is
	 * invisible to anything that iterates the table, including the doc check
	 * below.
	 */
	it("enumerates every declared code exactly once", () => {
		const values = Object.values(CLI_EXIT_CODES);

		expect(new Set(values).size).toBe(values.length);
		expect(values.sort((a, b) => a - b)).toEqual([0, 1, 2, 130]);
	});

	/**
	 * Interruption is NOT a failure. A CI step that folds a user cancellation into
	 * the failure code reports a cancelled job as a broken one, which sends
	 * someone to debug a build that was never broken.
	 */
	it("keeps interruption distinct from failure", () => {
		expect(EXIT_INTERRUPTED).not.toBe(EXIT_FAILURE);
		expect(EXIT_INTERRUPTED).toBeGreaterThan(128);
	});

	/**
	 * The published table and the code agree. This is the check that would have
	 * caught the drift the row is about, because the doc was already correct while
	 * nothing verified the code matched it.
	 */
	it("matches every row of the handbook's exit-code table", async () => {
		const docPath = path.join(repoRoot, "..", "..", "docs", "handbook", "src", "reference", "exit-codes.md");
		const doc = await Bun.file(docPath).text();

		for (const code of Object.values(CLI_EXIT_CODES)) {
			expect(doc).toContain(`| \`${code}\` |`);
		}
	});
});
