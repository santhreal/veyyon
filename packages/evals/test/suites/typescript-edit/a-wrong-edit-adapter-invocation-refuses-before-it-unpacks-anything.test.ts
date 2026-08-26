/**
 * WHY: the edit adapter is one of the three entry points the manager spawns, and it carried its own
 * `node:util` argument parser beside the package's grammar. Every count came out of it as a string
 * and reached the scheduler through `Number(...)`: `--runs abc` became NaN runs per task,
 * `--task-concurrency 0` asked for a run with no workers, and `--max-tasks -1` silently measured
 * every task because the limit was only applied when it was positive. A `--tasks` list naming an
 * id the corpus does not hold refused with "one or more edit task ids were not found", which names
 * neither the ids it knows nor the one it rejected.
 *
 * The class this closes is a wrong invocation of a manager-spawned adapter that costs a run:
 *  - every count refuses a non-integer, a zero and a negative, through the one grammar owner;
 *  - a missing `--model` or `--output` refuses by name;
 *  - a `--tasks` list that names nothing, or names an unknown id, refuses and states which;
 *  - every refusal happens before the fixture archive is unpacked, which `--fixtures-archive`
 *    makes observable: an archive that does not exist fails naming the archive, so a refusal that
 *    names the flag instead proves the order;
 *  - `--help`, which the suite documentation points callers at, answers rather than refusing as an
 *    undeclared flag, and every declared flag appears in the text it prints;
 *  - the process exits 2 for a wrong command line and 1 for a run that failed.
 *
 * It does not run trials (that needs a provider), and it does not cover the report shape the
 * adapter writes (that is the edit suite's own tests).
 */
import { describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import { TempDir } from "@veyyon/utils";
import { FlagValueError, UnknownFlagError } from "../../../src/core/flags";
import {
	DEFAULT_MAX_TASKS,
	DEFAULT_TASK_CONCURRENCY,
	EDIT_ADAPTER_FLAGS,
	EDIT_ADAPTER_USAGE,
	main,
} from "../../../src/suites/typescript-edit/adapter/cli";

const spawn = promisify(execFile);

const REFUSED_COUNTS: readonly string[] = ["abc", "0", "-1", "2.5", "NaN"];
const COUNT_FLAGS: readonly string[] = ["max-tasks", "task-concurrency", "runs"];

const withOutput = async (body: (output: string) => Promise<void>): Promise<void> => {
	const temp = await TempDir.create("edit-adapter-usage");
	try {
		await body(temp.join("report.json"));
	} finally {
		await temp.remove();
	}
};

describe("the flags the edit adapter declares", () => {
	it("declares every flag the manager passes it, and the list flag as valueless", () => {
		// src/server/runner.ts spawns it with exactly these.
		for (const flag of ["model", "output", "max-tasks", "tasks", "task-concurrency", "runs", "fixtures-archive"]) {
			expect(EDIT_ADAPTER_FLAGS.valued).toHaveProperty(flag);
		}
		expect(EDIT_ADAPTER_FLAGS.valueless).toEqual({ list: true, help: true });
	});

	it("states every flag it declares in the usage text the docs point at", () => {
		for (const flag of [...Object.keys(EDIT_ADAPTER_FLAGS.valued), ...Object.keys(EDIT_ADAPTER_FLAGS.valueless)]) {
			expect(EDIT_ADAPTER_USAGE).toContain(`--${flag}`);
		}
	});

	it("answers --help without a model, an output or an archive", async () => {
		await expect(main(["--help"])).resolves.toBeUndefined();
		await expect(main(["--fixtures-archive", "/nonexistent/x.tar.gz", "--help"])).resolves.toBeUndefined();
	});

	it("states the defaults it applies when a run names no limit", () => {
		expect(DEFAULT_MAX_TASKS).toBeGreaterThan(0);
		expect(DEFAULT_TASK_CONCURRENCY).toBeGreaterThan(0);
	});
});

describe("a count the edit adapter cannot act on", () => {
	it("refuses every count flag, for every value the scheduler could not run", async () => {
		await withOutput(async output => {
			for (const flag of COUNT_FLAGS) {
				for (const value of REFUSED_COUNTS) {
					const attempt = main(["--model", "anthropic/claude-opus-4-8", "--output", output, `--${flag}`, value]);
					await expect(attempt).rejects.toThrow(FlagValueError);
					await expect(
						main(["--model", "anthropic/claude-opus-4-8", "--output", output, `--${flag}`, value]),
					).rejects.toThrow(new RegExp(`--${flag} expects`));
				}
			}
		});
	});
});

describe("a required input the edit adapter has no default for", () => {
	it("refuses a run that names no model", async () => {
		await withOutput(async output => {
			await expect(main(["--output", output])).rejects.toThrow(/--model is required/);
		});
	});

	it("refuses a run that names no output path", async () => {
		await expect(main(["--model", "anthropic/claude-opus-4-8"])).rejects.toThrow(/--output is required/);
	});

	it("refuses a flag it does not declare instead of ignoring it", async () => {
		await withOutput(async output => {
			await expect(
				main(["--model", "anthropic/claude-opus-4-8", "--output", output, "--task-concurency", "4"]),
			).rejects.toThrow(UnknownFlagError);
		});
	});
});

describe("a --tasks list the corpus cannot satisfy", () => {
	it("refuses a list that names nothing", async () => {
		await withOutput(async output => {
			await expect(
				main(["--model", "anthropic/claude-opus-4-8", "--output", output, "--tasks", " , ,"]),
			).rejects.toThrow(/--tasks names nothing/);
		});
	});

	it("names each unknown id rather than reporting a count of them", async () => {
		await withOutput(async output => {
			await expect(
				main(["--model", "anthropic/claude-opus-4-8", "--output", output, "--tasks", "not-a-task-id,also-not-one"]),
			).rejects.toThrow(/--tasks names 2 unknown edit task id\(s\): not-a-task-id, also-not-one/);
		});
	});
});

describe("the order a wrong invocation is refused in", () => {
	// `--fixtures-archive` names an archive that does not exist, so an extraction attempt is
	// observable: it fails naming the archive. A refusal that reaches the flags first names the flag.
	const missingArchive = "/nonexistent/typescript-edit/fixtures.tar.gz";

	it("refuses a bad count before it opens the fixtures archive", async () => {
		await expect(
			main(["--fixtures-archive", missingArchive, "--model", "a/b", "--output", "r.json", "--runs", "abc"]),
		).rejects.toThrow(/--runs expects a number/);
	});

	it("refuses a missing model before it opens the fixtures archive", async () => {
		await expect(main(["--fixtures-archive", missingArchive, "--output", "r.json"])).rejects.toThrow(
			/--model is required/,
		);
	});

	it("refuses an unknown flag before it opens the fixtures archive", async () => {
		await expect(main(["--fixtures-archive", missingArchive, "--nope"])).rejects.toThrow(UnknownFlagError);
	});

	it("reaches the archive once the command line is right, and names it when it is missing", async () => {
		await expect(
			main(["--fixtures-archive", missingArchive, "--model", "a/b", "--output", "r.json"]),
		).rejects.toThrow(new RegExp(`fixtures archive not found or unreadable at "${missingArchive}"`));
	});

	it("names the archive for a --list run too, rather than listing the bundled corpus", async () => {
		await expect(main(["--fixtures-archive", missingArchive, "--list"])).rejects.toThrow(
			/fixtures archive not found or unreadable/,
		);
	});
});

describe("when the edit adapter refuses", () => {
	const cliPath = path.join(import.meta.dirname, "../../../src/suites/typescript-edit/adapter/cli.ts");

	const invoke = async (args: readonly string[]): Promise<{ code: number; stderr: string }> => {
		try {
			const { stderr } = await spawn(process.execPath, [cliPath, ...args], { maxBuffer: 8 << 20 });
			return { code: 0, stderr };
		} catch (error) {
			const failure = error as { code?: number; stderr?: string };
			return { code: failure.code ?? -1, stderr: failure.stderr ?? "" };
		}
	};

	it("exits 2 on a wrong command line, and unpacks nothing to find out", async () => {
		const cases: readonly { args: readonly string[]; message: RegExp }[] = [
			{ args: ["--runs", "abc"], message: /--runs expects a number/ },
			{ args: ["--task-concurrency", "0"], message: /--task-concurrency expects an integer >= 1/ },
			{ args: ["--nope"], message: /Unknown flag "--nope"/ },
			{ args: ["--output", "report.json"], message: /--model is required/ },
		];

		for (const { args, message } of cases) {
			const result = await invoke(args);
			expect({ args, code: result.code }).toEqual({ args, code: 2 });
			expect(result.stderr).toMatch(message);
			expect(result.stderr).not.toMatch(/archive not found or unreadable/);
			// The refusal carries the usage text, so the caller can fix the line from it.
			expect(result.stderr).toContain("--task-concurrency <n>");
		}
	}, 120_000);

	it("exits 0 on --help, which the suite documentation points callers at", async () => {
		const result = await invoke(["--help"]);

		expect(result.code).toBe(0);
	}, 60_000);
});
