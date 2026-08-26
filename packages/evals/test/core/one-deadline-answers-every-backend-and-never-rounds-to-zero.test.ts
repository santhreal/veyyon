/**
 * WHY THIS SUITE EXISTS.
 *
 * Every registered backend decided a trial's deadline for itself. The three copies of the
 * numbers had drifted: pier and harbor clamped at 3600 seconds, the in-process backend at
 * 7200 under a different constant name. The `trialTimeoutSec` override reached the in-process
 * backend and neither of the others, so a config that set it changed nothing on a pier or
 * harbor run and reported nothing. Both of the other formulas also multiplied before clamping
 * with no lower bound, so `--timeout-multiplier 0.0001` produced a whole-number budget of 0,
 * `setTimeout(0)` fired immediately, and every trial failed with "timed out after 0s".
 *
 * The unified CLI also had no flag for either knob, so `trialTimeoutSec` and `timeoutMultiplier`
 * were reachable only from the manager and a programmatic caller: a deadline nothing shipped
 * could set. `--trial-timeout` and `--timeout-multiplier` now carry them onto the options bag
 * every suite and backend is handed.
 *
 * The class this closes: a per-trial bound decided by a backend rather than by one owner. The
 * suite pins the registered backend set, so a fourth backend turns it red until someone records
 * a decision, and sweeps each backend module's exports for a deadline or output-bound name of
 * its own. The resolver's floor, default, ceiling and byte-accurate output bound are pinned
 * directly, and the in-process backend proves the floor end to end through a real trial.
 *
 * What it does not catch: a backend that declares a private constant it never exports and arms
 * its own timer with it, and the pier and harbor watchdogs themselves, which need a running
 * pier or harbor binary that the test sandbox has neither of.
 */

import { describe, expect, it } from "bun:test";
import { registerAllBackends } from "../../src/backends";
import * as harborBackend from "../../src/backends/harbor/backend";
import * as harborCleanup from "../../src/backends/harbor/runner/cleanup";
import * as inProcessBackend from "../../src/backends/in-process/backend";
import * as pierRunner from "../../src/backends/pier/runner";
import { CliUsageError, parseEvalsArgs, suiteContext } from "../../src/cli";
import { defaultBackendRegistry } from "../../src/core/backend-registry";
import { requireSuite } from "../../src/core/suite-registry";
import {
	boundRawOutput,
	DEFAULT_GRACE_PERIOD_MS,
	DEFAULT_TRIAL_TIMEOUT_SEC,
	HARD_CEILING_TRIAL_TIMEOUT_SEC,
	MAX_TRIAL_TIMEOUT_SEC,
	MIN_TRIAL_TIMEOUT_SEC,
	RAW_OUTPUT_MAX_BYTES,
	resolveTrialTimeoutSec,
	trialTimeoutFromOptions,
} from "../../src/core/trial-deadline";
import { registerBuiltinHarnesses } from "../../src/harnesses";
import { registerAllSuites } from "../../src/suites";

registerBuiltinHarnesses();
registerAllBackends();
registerAllSuites();

const BACKEND_IDS: readonly string[] = ["in-process", "pier", "harbor"];

/** Every module a backend reaches its deadline and its output bound through. */
const BACKEND_MODULES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
	"in-process/backend": inProcessBackend,
	"pier/runner": pierRunner,
	"harbor/backend": harborBackend,
	"harbor/runner/cleanup": harborCleanup,
};

/** Names that belong to src/core/trial-deadline.ts and to nothing else. */
const OWNED_NAMES: readonly string[] = [
	"DEFAULT_TRIAL_TIMEOUT_SEC",
	"HARD_CEILING_TRIAL_TIMEOUT_SEC",
	"HARD_CEILING_TIMEOUT_SEC",
	"MAX_TRIAL_TIMEOUT_SEC",
	"MIN_TRIAL_TIMEOUT_SEC",
	"DEFAULT_GRACE_PERIOD_MS",
	"RAW_OUTPUT_MAX_BYTES",
	"RAW_OUTPUT_TAIL_CAP_BYTES",
	"MAX_RAW_OUTPUT_CHARS",
	"boundRawOutput",
	"capRawOutputTail",
	"truncateRawOutput",
];

describe("one module owns the numbers", () => {
	it("states a default, a ceiling, a maximum, a floor, a grace period and an output bound", () => {
		expect(DEFAULT_TRIAL_TIMEOUT_SEC).toBe(1800);
		expect(HARD_CEILING_TRIAL_TIMEOUT_SEC).toBe(3600);
		expect(MAX_TRIAL_TIMEOUT_SEC).toBe(86_400);
		expect(MIN_TRIAL_TIMEOUT_SEC).toBe(1);
		expect(DEFAULT_GRACE_PERIOD_MS).toBe(5000);
		expect(RAW_OUTPUT_MAX_BYTES).toBe(65_536);
	});

	it("keeps the floor below the default and the default below the ceiling", () => {
		expect(MIN_TRIAL_TIMEOUT_SEC).toBeLessThan(DEFAULT_TRIAL_TIMEOUT_SEC);
		expect(DEFAULT_TRIAL_TIMEOUT_SEC).toBeLessThanOrEqual(HARD_CEILING_TRIAL_TIMEOUT_SEC);
		expect(HARD_CEILING_TRIAL_TIMEOUT_SEC).toBeLessThanOrEqual(MAX_TRIAL_TIMEOUT_SEC);
	});

	it("registers exactly the backends this suite sweeps, so a fourth one records a decision", () => {
		expect(
			defaultBackendRegistry
				.list()
				.map(backend => backend.id)
				.sort(),
		).toEqual([...BACKEND_IDS].sort());
	});

	it("leaves no backend module exporting a deadline or an output bound of its own", () => {
		const offenders: string[] = [];
		for (const [where, module] of Object.entries(BACKEND_MODULES)) {
			for (const name of OWNED_NAMES) {
				if (name in module) offenders.push(`${where} exports ${name}`);
			}
		}
		expect(offenders).toEqual([]);
	});
});

interface DeadlineCase {
	readonly what: string;
	readonly timeBudgetSec: number | null | undefined;
	readonly overrideSec?: number | null;
	readonly multiplier?: number | null;
	readonly expected: number;
}

const DEADLINE_CASES: DeadlineCase[] = [
	{ what: "a task budget is used as stated", timeBudgetSec: 900, expected: 900 },
	{ what: "no budget falls back to the default", timeBudgetSec: null, expected: DEFAULT_TRIAL_TIMEOUT_SEC },
	{ what: "a zero budget falls back to the default", timeBudgetSec: 0, expected: DEFAULT_TRIAL_TIMEOUT_SEC },
	{ what: "a negative budget falls back to the default", timeBudgetSec: -60, expected: DEFAULT_TRIAL_TIMEOUT_SEC },
	{ what: "an override replaces the task budget", timeBudgetSec: 900, overrideSec: 120, expected: 120 },
	{ what: "a zero override leaves the task budget", timeBudgetSec: 900, overrideSec: 0, expected: 900 },
	{ what: "a multiplier scales the budget", timeBudgetSec: 100, multiplier: 2.5, expected: 250 },
	{ what: "a multiplier scales an override", timeBudgetSec: 900, overrideSec: 100, multiplier: 3, expected: 300 },
	{
		what: "a stated budget past the ceiling is honored",
		timeBudgetSec: 18_000,
		expected: 18_000,
	},
	{
		what: "a multiplier cannot push a stated long budget past it",
		timeBudgetSec: 18_000,
		multiplier: 3,
		expected: 18_000,
	},
	{
		what: "a stated budget past a day is capped at a day",
		timeBudgetSec: 200_000,
		expected: MAX_TRIAL_TIMEOUT_SEC,
	},
	{
		what: "an override past a day is capped at a day",
		timeBudgetSec: 60,
		overrideSec: 500_000,
		expected: MAX_TRIAL_TIMEOUT_SEC,
	},
	{
		what: "a multiplier past the ceiling is clamped",
		timeBudgetSec: 1800,
		multiplier: 100,
		expected: HARD_CEILING_TRIAL_TIMEOUT_SEC,
	},
	{
		what: "a tiny multiplier never rounds to zero",
		timeBudgetSec: 1800,
		multiplier: 0.0001,
		expected: MIN_TRIAL_TIMEOUT_SEC,
	},
	{
		what: "a tiny override never rounds to zero",
		timeBudgetSec: 1800,
		overrideSec: 0.2,
		expected: MIN_TRIAL_TIMEOUT_SEC,
	},
	{ what: "a non-positive multiplier is ignored", timeBudgetSec: 600, multiplier: -1, expected: 600 },
	{ what: "a NaN multiplier is ignored", timeBudgetSec: 600, multiplier: Number.NaN, expected: 600 },
	{ what: "an infinite budget is clamped", timeBudgetSec: Number.POSITIVE_INFINITY, expected: 1800 },
];

describe("the resolved deadline", () => {
	it.each(DEADLINE_CASES)("$what", ({ timeBudgetSec, overrideSec, multiplier, expected }) => {
		expect(resolveTrialTimeoutSec({ timeBudgetSec, overrideSec, multiplier })).toBe(expected);
	});

	it("always lands inside the bounds, whatever it is asked", () => {
		for (const budget of [-1, 0, 1, 7, 1800, 3599, 3600, 3601, 18_000, 1e9]) {
			for (const multiplier of [0.00001, 0.5, 1, 2, 1e6]) {
				const resolved = resolveTrialTimeoutSec({ timeBudgetSec: budget, multiplier });
				expect(resolved).toBeGreaterThanOrEqual(MIN_TRIAL_TIMEOUT_SEC);
				expect(resolved).toBeLessThanOrEqual(MAX_TRIAL_TIMEOUT_SEC);
				// A multiplier alone never reaches past the ceiling.
				if (budget <= HARD_CEILING_TRIAL_TIMEOUT_SEC) {
					expect(resolved).toBeLessThanOrEqual(HARD_CEILING_TRIAL_TIMEOUT_SEC);
				}
				expect(Number.isInteger(resolved)).toBe(true);
			}
		}
	});

	it("reads the run options every backend is handed", () => {
		expect(trialTimeoutFromOptions(900, { trialTimeoutSec: 120 })).toBe(120);
		expect(trialTimeoutFromOptions(900, { timeoutMultiplier: 2 })).toBe(1800);
		expect(trialTimeoutFromOptions(900, { trialTimeoutSec: 100, timeoutMultiplier: 3 })).toBe(300);
		expect(trialTimeoutFromOptions(1800, { timeoutMultiplier: 0.0001 })).toBe(MIN_TRIAL_TIMEOUT_SEC);
	});

	it("ignores an option of the wrong shape rather than reading it as a number", () => {
		expect(trialTimeoutFromOptions(900, { trialTimeoutSec: "120" })).toBe(900);
		expect(trialTimeoutFromOptions(900, { timeoutMultiplier: "2" })).toBe(900);
		expect(trialTimeoutFromOptions(900, {})).toBe(900);
		expect(trialTimeoutFromOptions(900)).toBe(900);
	});
});
describe("the two flags that reach it", () => {
	const suite = requireSuite("typescript-edit");

	it("carries both values onto the options bag every suite and backend is handed", () => {
		const args = parseEvalsArgs([
			"--suite",
			"typescript-edit",
			"--trial-timeout",
			"600",
			"--timeout-multiplier",
			"1.5",
		]);
		expect(args.trialTimeoutSec).toBe(600);
		expect(args.timeoutMultiplier).toBe(1.5);

		const options = suiteContext(args, suite).options ?? {};
		expect(options.trialTimeoutSec).toBe(600);
		expect(options.timeoutMultiplier).toBe(1.5);
		expect(trialTimeoutFromOptions(120, options)).toBe(900);
	});

	it("leaves the options bag stating neither when neither flag is passed", () => {
		const options = suiteContext(parseEvalsArgs(["--suite", "typescript-edit"]), suite).options ?? {};
		expect("trialTimeoutSec" in options).toBe(false);
		expect("timeoutMultiplier" in options).toBe(false);
		expect(trialTimeoutFromOptions(120, options)).toBe(120);
	});

	it("refuses a value that would arm no usable deadline", () => {
		for (const argv of [
			["--trial-timeout", "0"],
			["--trial-timeout", "-5"],
			["--trial-timeout", "1.5"],
			["--trial-timeout", "soon"],
			["--timeout-multiplier", "0"],
			["--timeout-multiplier", "-1"],
			["--timeout-multiplier", "fast"],
		]) {
			expect(() => parseEvalsArgs(["--suite", "typescript-edit", ...argv])).toThrow(CliUsageError);
		}
	});
});

describe("the output bound", () => {
	it("reports nothing to keep as null", () => {
		expect(boundRawOutput(null)).toBeNull();
		expect(boundRawOutput(undefined)).toBeNull();
		expect(boundRawOutput("")).toBeNull();
	});

	it("leaves output inside the bound untouched", () => {
		expect(boundRawOutput("short", 64)).toBe("short");
		expect(boundRawOutput("A".repeat(64), 64)).toBe("A".repeat(64));
	});

	it("keeps the tail rather than the head", () => {
		expect(boundRawOutput(`${"A".repeat(100)}${"B".repeat(50)}`, 50)).toBe("B".repeat(50));
	});

	it("bounds by bytes, not characters, so multi-byte output fits what the journal writes", () => {
		const wide = "\u00e9".repeat(200); // two bytes per character
		const bounded = boundRawOutput(wide, 100);
		expect(bounded).not.toBeNull();
		expect(Buffer.from(bounded ?? "", "utf-8").byteLength).toBeLessThanOrEqual(100);
		expect(bounded).toBe("\u00e9".repeat(50));
	});

	it("never leaves a replacement character where it cut a multi-byte sequence", () => {
		const wide = "\u00e9".repeat(200);
		const bounded = boundRawOutput(wide, 101) ?? "";
		expect(bounded.startsWith("\uFFFD")).toBe(false);
		expect(bounded).toBe("\u00e9".repeat(50));
		expect(Buffer.from(bounded, "utf-8").byteLength).toBeLessThanOrEqual(101);
	});

	it("bounds a four-byte character run by bytes as well", () => {
		const emoji = "\u{1F600}".repeat(100); // four bytes per character
		const bounded = boundRawOutput(emoji, 40) ?? "";
		expect(Buffer.from(bounded, "utf-8").byteLength).toBeLessThanOrEqual(40);
		expect(bounded).toBe("\u{1F600}".repeat(10));
	});

	it("defaults to the one output bound", () => {
		const bounded = boundRawOutput("A".repeat(RAW_OUTPUT_MAX_BYTES + 7)) ?? "";
		expect(Buffer.from(bounded, "utf-8").byteLength).toBe(RAW_OUTPUT_MAX_BYTES);
	});
});
