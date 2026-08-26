/**
 * WHY: the harbor runner CLI is one of the three entry points the manager spawns, so a flag it
 * accepts and cannot act on becomes a container run that measures the wrong thing. Every count it
 * read went through `Number(...)` with nothing checking the result: `--n-tasks abc` reached the
 * launch request as NaN, which JSON serializes as null, so harbor ran its own default and the
 * report stated a total of NaN; `--n-concurrent 0` asked for a run with no workers; and
 * `--timeout-multiplier abc` was silently read as 1 by the deadline owner, which treats a
 * non-finite multiplier as absent — a knob set and never applied.
 *
 * The class this closes is a flag whose wrong value costs a whole run rather than the invocation:
 *  - every count flag and every alias of it refuses a non-integer, a zero and a negative;
 *  - `--timeout-multiplier` refuses anything the deadline owner would ignore;
 *  - `--job-name` is one path segment, since it becomes a directory under the jobs dir;
 *  - `--env NAME` refuses when the host sets no NAME, rather than dropping the credential and
 *    failing inside the container;
 *  - a wrong command line exits 2, which a caller reads apart from a harbor run that failed.
 *
 * It does not check that harbor honors a value it was given, and it does not cover the resume
 * path's recorded config (that is the-harbor-cli-validates-flags-probes-cost-and-resumes.test.ts).
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
	GatewayHealthError,
	HarborConfigError,
	HarborExecutionError,
	HarborPrerequisiteError,
	HelpRequestedError,
	mapErrorToExitCode,
	parseArgs,
} from "../../../src/backends/harbor/runner/cli";
import { UnsafePathSegmentError } from "../../../src/paths";

const MODEL = ["--model", "anthropic/claude-opus-4-8"];

/** Every spelling of a flag that counts something, read from the CLI's own alias set. */
const COUNT_FLAGS: readonly { flags: readonly string[]; read: (argv: string[]) => number }[] = [
	{ flags: ["-l", "--tasks", "--n-tasks"], read: argv => parseArgs(argv).tasks },
	{ flags: ["-n", "--concurrency", "--n-concurrent"], read: argv => parseArgs(argv).concurrency },
	{ flags: ["-k", "--attempts", "--n-attempts"], read: argv => parseArgs(argv).attempts },
];

const REFUSED_COUNTS: readonly string[] = ["abc", "0", "-1", "2.5", "", "NaN", "1e400"];

describe("a harbor count flag", () => {
	it("reads a positive integer through every spelling it accepts", () => {
		for (const { flags, read } of COUNT_FLAGS) {
			for (const flag of flags) {
				expect(read([...MODEL, flag, "7"])).toBe(7);
				// The parser splits `=` for long flags only, so a short alias takes its value next.
				if (flag.startsWith("--")) expect(read([...MODEL, `${flag}=3`])).toBe(3);
			}
		}
	});

	it("refuses a value harbor could not act on, naming the flag and the value", () => {
		for (const { flags } of COUNT_FLAGS) {
			for (const flag of flags) {
				for (const value of REFUSED_COUNTS) {
					const attempt = () => parseArgs([...MODEL, flag, value]);
					expect(attempt).toThrow(HarborConfigError);
					expect(attempt).toThrow(new RegExp(`\\${flag} expects an integer >= 1`));
				}
			}
		}
	});

	it("refuses rather than reading NaN into the launch request", () => {
		for (const { flags, read } of COUNT_FLAGS) {
			expect(() => read([...MODEL, flags[0], "abc"])).toThrow(HarborConfigError);
		}
	});
});

describe("the harbor timeout multiplier", () => {
	it("keeps a positive number", () => {
		expect(parseArgs([...MODEL, "--timeout-multiplier", "2.5"]).timeoutMultiplier).toBe(2.5);
		expect(parseArgs([...MODEL, "--timeout-multiplier=0.5"]).timeoutMultiplier).toBe(0.5);
	});

	it("defaults to absent so the deadline owner applies the task budget unscaled", () => {
		expect(parseArgs(MODEL).timeoutMultiplier).toBeNull();
	});

	it("refuses every value the deadline owner would silently ignore", () => {
		for (const value of ["abc", "0", "-2", "", "NaN", "Infinity"]) {
			const attempt = () => parseArgs([...MODEL, "--timeout-multiplier", value]);
			expect(attempt).toThrow(HarborConfigError);
			expect(attempt).toThrow(/--timeout-multiplier expects a number > 0/);
		}
	});
});

describe("a harbor job name", () => {
	it("keeps a name that is one directory", () => {
		expect(parseArgs([...MODEL, "--job-name", "tb3_opus_2026-01-01"]).jobName).toBe("tb3_opus_2026-01-01");
	});

	it("refuses a name that would leave the jobs directory", () => {
		for (const name of ["..", "../escape", "a/b", ".", "", "with space/x"]) {
			expect(() => parseArgs([...MODEL, "--job-name", name])).toThrow(UnsafePathSegmentError);
		}
	});
});

describe("forwarding a host variable with --env", () => {
	const key = "VEYYON_TEST_HARBOR_ENV_PROBE";

	afterEach(() => {
		delete process.env[key];
	});

	it("forwards the host value when the host sets one", () => {
		process.env[key] = "from-host";

		expect(parseArgs([...MODEL, "--env", key]).env[key]).toBe("from-host");
	});

	it("refuses a bare key the host does not set, instead of dropping it", () => {
		const attempt = () => parseArgs([...MODEL, "--env", key]);

		expect(attempt).toThrow(HarborConfigError);
		expect(attempt).toThrow(new RegExp(`--env ${key}: this host sets no ${key}`));
	});

	it("takes the stated value even when the host holds a different one", () => {
		process.env[key] = "from-host";

		expect(parseArgs([...MODEL, "--env", `${key}=stated`]).env[key]).toBe("stated");
	});

	it("takes a stated empty value rather than falling back to the host", () => {
		process.env[key] = "from-host";

		expect(parseArgs([...MODEL, "--env", `${key}=`]).env[key]).toBe("");
	});
});

describe("the exit code a harbor failure maps to", () => {
	it("separates a wrong invocation from a run that failed", () => {
		expect(mapErrorToExitCode(new HelpRequestedError())).toBe(0);
		expect(mapErrorToExitCode(new HarborConfigError("--n-tasks expects an integer >= 1"))).toBe(2);
		expect(mapErrorToExitCode(new HarborPrerequisiteError("docker not found"))).toBe(2);
		expect(mapErrorToExitCode(new GatewayHealthError("gateway down"))).toBe(3);
		expect(mapErrorToExitCode(new HarborExecutionError(137, "OOM killed"))).toBe(137);
		expect(mapErrorToExitCode(new Error("generic failure"))).toBe(1);
	});

	it("maps every flag refusal the parser can raise to the usage code", () => {
		const wrong: readonly string[][] = [
			[...MODEL, "--n-tasks", "abc"],
			[...MODEL, "--n-concurrent", "0"],
			[...MODEL, "--n-attempts", "-1"],
			[...MODEL, "--timeout-multiplier", "0"],
			[...MODEL, "--environment", "podman"],
			[...MODEL, "--install", "sideload"],
			[...MODEL, "--not-a-real-flag"],
			["--n-tasks", "4"],
			[...MODEL, "--model"],
		];

		for (const argv of wrong) {
			let raised: unknown;
			try {
				parseArgs(argv);
			} catch (error) {
				raised = error;
			}
			expect({ argv, code: mapErrorToExitCode(raised) }).toEqual({ argv, code: 2 });
		}
	});
});
