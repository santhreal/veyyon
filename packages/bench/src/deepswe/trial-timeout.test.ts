/**
 * Tests for the per-task trial timeout.
 *
 * These exist because the bench used to kill every trial at a flat 900s while
 * the DeepSWE tasks grant the agent 1800s or 5400s, i.e. the harness was cutting
 * the agent off at one sixth of its budgeted time on the pilot set. That is a
 * validity threat rather than a scheduling nuisance: an arm that is slower per
 * turn eats more truncations than a fast one, so a flat ceiling silently
 * converts "slower per turn" into "solves fewer tasks". An encode arm carrying a
 * 16000-token dictionary in every system prompt is exactly that shape, so the
 * flat timeout would have made it look worse on reward for a reason with nothing
 * to do with reward.
 *
 * What is locked here: the default comes from the task, the timer covers every
 * phase it spans, an explicit override still wins, a truncating override is
 * announced, and nothing anywhere silently substitutes a number.
 */

import { describe, expect, test } from "bun:test";
import { moduleSpecifiersIn } from "@veyyon/utils/module-reach";
import {
	budgetedTrialTimeoutSec,
	parseTaskTimeBudget,
	parseTrialTimeoutFlag,
	type ResolvedTrialTimeout,
	resolveTrialTimeout,
	type TaskTimeBudgetSec,
	taskTimeBudget,
	truncationWarning,
} from "./trial-timeout";

/**
 * A real DeepSWE `task.toml`, trimmed to the tables this module reads but
 * keeping the shape (and the two distinct `timeout_sec` keys in two different
 * tables) that made a naive top-level regex the wrong tool.
 */
const REAL_TASK_TOML = `schema_version = "1.1"
artifacts = ["/logs/artifacts/model.patch"]
[task]
name = "datacurve/abs-module-cache-flags"
[metadata]
task_id = "abs-module-cache-flags"
language = "go"
[verifier]
environment_mode = "separate"
timeout_sec = 1800.0

[verifier.env]
[verifier.environment]
build_timeout_sec = 1800.0
cpus = 2

[agent]
timeout_sec = 5400.0
[environment]
build_timeout_sec = 1800.0
docker_image = "public.ecr.aws/example:v1.1"
cpus = 2
`;

function budget(overrides: Partial<TaskTimeBudgetSec> = {}): TaskTimeBudgetSec {
	return { build: 1800, agent: 5400, verifier: 1800, missing: [], ...overrides };
}

describe("parseTaskTimeBudget", () => {
	/**
	 * The whole default hinges on reading `[agent].timeout_sec` correctly. A
	 * task.toml holds `timeout_sec` under BOTH `[verifier]` and `[agent]`, so a
	 * parser that matches the key without its table picks up 1800 where the agent
	 * was granted 5400 and truncates the trial by an hour.
	 */
	test("reads the agent budget from the [agent] table, not the [verifier] one", () => {
		const parsed = parseTaskTimeBudget(REAL_TASK_TOML, "abs-module-cache-flags");
		expect(parsed.agent).toBe(5400);
		expect(parsed.verifier).toBe(1800);
	});

	/** The environment build budget lives in `[environment]`, not `[verifier.environment]`. */
	test("reads the build budget from [environment], not [verifier.environment]", () => {
		expect(parseTaskTimeBudget(REAL_TASK_TOML, "t").build).toBe(1800);
	});

	/** Nothing is missing in a well-formed task, so the omission list stays empty. */
	test("reports no missing phases for a complete task.toml", () => {
		expect(parseTaskTimeBudget(REAL_TASK_TOML, "t").missing).toEqual([]);
	});

	/**
	 * The agent budget is the one number this mechanism exists to honour.
	 * Substituting anything for it would reintroduce the flat-default bug one
	 * layer down, so its absence is fatal and the message names the escape hatch.
	 */
	test("throws when [agent] timeout_sec is absent rather than inventing one", () => {
		expect(() => parseTaskTimeBudget(`[verifier]\ntimeout_sec = 1800.0\n`, "no-agent")).toThrow(
			/no-agent: task.toml has no positive \[agent\] timeout_sec/,
		);
	});

	/** A present-but-useless value is the same failure as an absent one. */
	test("throws when [agent] timeout_sec is zero or negative", () => {
		expect(() => parseTaskTimeBudget(`[agent]\ntimeout_sec = 0\n`, "zero")).toThrow(/no positive \[agent\]/);
		expect(() => parseTaskTimeBudget(`[agent]\ntimeout_sec = -5\n`, "neg")).toThrow(/no positive \[agent\]/);
	});

	/** A string where a number belongs is a typo, not a budget. */
	test("throws when [agent] timeout_sec is not a number", () => {
		expect(() => parseTaskTimeBudget(`[agent]\ntimeout_sec = "5400"\n`, "str")).toThrow(/no positive \[agent\]/);
	});

	/** A corrupt file must name itself; a bare parser error would not say which task. */
	test("names the task when the file is not valid TOML", () => {
		expect(() => parseTaskTimeBudget(`[agent\ntimeout_sec =`, "broken-task")).toThrow(
			/broken-task: task.toml is not valid TOML/,
		);
	});

	/**
	 * An undeclared phase contributes zero, which under-budgets the trial by
	 * exactly the amount nobody wrote down. That is acceptable only because the
	 * omission travels alongside the number instead of being absorbed into it.
	 */
	test("records an undeclared build phase instead of hiding it in the sum", () => {
		const parsed = parseTaskTimeBudget(`[agent]\ntimeout_sec = 600\n[verifier]\ntimeout_sec = 120\n`, "t");
		expect(parsed.build).toBe(0);
		expect(parsed.missing).toEqual(["build"]);
	});

	/** Same contract for the verifier phase. */
	test("records an undeclared verifier phase", () => {
		const parsed = parseTaskTimeBudget(`[agent]\ntimeout_sec = 600\n[environment]\nbuild_timeout_sec = 90\n`, "t");
		expect(parsed.verifier).toBe(0);
		expect(parsed.missing).toEqual(["verifier"]);
	});

	/** Both can be missing at once; the list is a list for a reason. */
	test("records both undeclared phases", () => {
		expect(parseTaskTimeBudget(`[agent]\ntimeout_sec = 600\n`, "t").missing).toEqual(["build", "verifier"]);
	});
});

describe("taskTimeBudget", () => {
	/** The parsed-object entry point is the same contract without the TOML step. */
	test("accepts an already-parsed table", () => {
		expect(taskTimeBudget({ agent: { timeout_sec: 42 } }, "t").agent).toBe(42);
	});

	/** A non-table under a table name must not be read as one. */
	test("treats a scalar where a table belongs as absent", () => {
		expect(() => taskTimeBudget({ agent: 5400 }, "scalar-agent")).toThrow(/no positive \[agent\]/);
	});

	/** `null` is an object in JavaScript; the table lookup must not be fooled by it. */
	test("treats a null table as absent", () => {
		expect(() => taskTimeBudget({ agent: null }, "null-agent")).toThrow(/no positive \[agent\]/);
	});
});

describe("budgetedTrialTimeoutSec", () => {
	/**
	 * The harness starts ONE timer around the whole `pier run`, which builds the
	 * image, runs the agent, then runs the verifier. Charging only the agent's
	 * budget would kill trials mid-grade and record them as agent failures, which
	 * is the same misattribution in a smaller costume.
	 */
	test("sums every phase the single timer spans", () => {
		expect(budgetedTrialTimeoutSec(budget())).toBe(9000);
	});

	/** The real corpus has two shapes; both must come out at their declared total. */
	test("matches the DeepSWE corpus totals", () => {
		expect(budgetedTrialTimeoutSec(budget({ agent: 1800 }))).toBe(5400);
		expect(budgetedTrialTimeoutSec(budget({ agent: 5400 }))).toBe(9000);
	});

	/** An undeclared phase is a zero addend, not a skipped sum. */
	test("adds zero for an undeclared phase", () => {
		expect(budgetedTrialTimeoutSec(budget({ build: 0, missing: ["build"] }))).toBe(7200);
	});
});

describe("resolveTrialTimeout", () => {
	/**
	 * The headline fix: with no flag, the trial gets what the task granted. The
	 * old code produced 900 here regardless of the task, which is the bug.
	 */
	test("defaults to the task's own budget, never a flat number", () => {
		const resolved = resolveTrialTimeout(budget());
		expect(resolved.timeoutSec).toBe(9000);
		expect(resolved.source).toBe("task");
		expect(resolved.timeoutSec).not.toBe(900);
	});

	/** Two tasks with different budgets must get different timeouts. */
	test("gives different timeouts to tasks with different budgets", () => {
		expect(resolveTrialTimeout(budget({ agent: 1800 })).timeoutSec).toBe(5400);
		expect(resolveTrialTimeout(budget({ agent: 5400 })).timeoutSec).toBe(9000);
	});

	/** The flag remains a real override, otherwise a short run is impossible. */
	test("an explicit override beats the task budget", () => {
		const resolved = resolveTrialTimeout(budget(), 600);
		expect(resolved.timeoutSec).toBe(600);
		expect(resolved.source).toBe("override");
	});

	/**
	 * An override below the budget is the truncation this row is about. It stays
	 * allowed, because an operator may want a fast smoke run, but it must be
	 * visible: `truncatesTask` is what the run reports before it starts.
	 */
	test("flags an override that cuts into the task's budget", () => {
		const resolved = resolveTrialTimeout(budget(), 600);
		expect(resolved.truncatesTask).toBe(true);
		expect(resolved.budgetedSec).toBe(9000);
	});

	/** An override ABOVE the budget truncates nothing and must not warn. */
	test("does not flag an override that is more generous than the budget", () => {
		expect(resolveTrialTimeout(budget(), 20_000).truncatesTask).toBe(false);
	});

	/** Exactly equal is not a truncation; a strict comparison keeps the warning honest. */
	test("does not flag an override equal to the budget", () => {
		expect(resolveTrialTimeout(budget(), 9000).truncatesTask).toBe(false);
	});

	/** The task-derived default can never truncate the task it came from. */
	test("never flags the derived default as truncating", () => {
		expect(resolveTrialTimeout(budget()).truncatesTask).toBe(false);
	});

	/** Undeclared phases survive resolution so the caller can report them. */
	test("carries undeclared phases through to the caller", () => {
		expect(resolveTrialTimeout(budget({ missing: ["verifier"] })).missingPhases).toEqual(["verifier"]);
	});

	/** The budget is reported even when an override wins, so the run can say what it gave up. */
	test("reports the task budget alongside an override", () => {
		expect(resolveTrialTimeout(budget({ agent: 1800 }), 300).budgetedSec).toBe(5400);
	});
});

describe("parseTrialTimeoutFlag", () => {
	/**
	 * `undefined` is what makes the per-task default reachable. If an unpassed
	 * flag resolved to a number, every task would be back on a flat ceiling.
	 */
	test("an unpassed flag is undefined, not a default", () => {
		expect(parseTrialTimeoutFlag(undefined)).toBeUndefined();
	});

	/** The ordinary case. */
	test("parses a positive number of seconds", () => {
		expect(parseTrialTimeoutFlag("1200")).toBe(1200);
		expect(parseTrialTimeoutFlag("900.5")).toBe(900.5);
	});

	/**
	 * The old code did `Number(raw) ... : 900`, so `--trial-timeout 90O` (letter
	 * O) silently became 900. A typo that quietly changes the measurement is
	 * exactly the failure this module exists to prevent, so it throws now.
	 */
	test("rejects a non-numeric value instead of falling back to a default", () => {
		expect(() => parseTrialTimeoutFlag("90O")).toThrow(/--trial-timeout must be a positive number/);
		expect(() => parseTrialTimeoutFlag("")).toThrow(/--trial-timeout must be a positive number/);
		expect(() => parseTrialTimeoutFlag("abc")).toThrow(/--trial-timeout must be a positive number/);
	});

	/** Zero and negatives disable the timer or fire immediately; neither is a request. */
	test("rejects zero and negative values", () => {
		expect(() => parseTrialTimeoutFlag("0")).toThrow(/positive number/);
		expect(() => parseTrialTimeoutFlag("-60")).toThrow(/positive number/);
	});

	/** The rejection quotes what was actually passed, so the typo is visible in the error. */
	test("echoes the offending value", () => {
		expect(() => parseTrialTimeoutFlag("90O")).toThrow(/"90O"/);
	});
});

describe("truncationWarning", () => {
	function resolvedMap(entries: Record<string, number | undefined>): Map<string, ResolvedTrialTimeout> {
		const map = new Map<string, ResolvedTrialTimeout>();
		for (const [task, override] of Object.entries(entries)) {
			map.set(task, resolveTrialTimeout(budget(), override));
		}
		return map;
	}

	/** Nothing truncated means nothing to say; the caller prints only when there is a warning. */
	test("returns undefined when no task is truncated", () => {
		expect(truncationWarning(resolvedMap({ a: undefined, b: undefined }))).toBeUndefined();
		expect(truncationWarning(new Map())).toBeUndefined();
	});

	/** The count is what tells the operator how much of the run is affected. */
	test("counts truncated tasks against the total", () => {
		const warning = truncationWarning(resolvedMap({ a: 600, b: 600, c: 600 }));
		expect(warning).toContain("truncates 3 of 3 task(s)");
	});

	/** A mixed run must not read as if every task were cut. */
	test("counts only the truncated tasks", () => {
		const map = resolvedMap({ short: 600 });
		map.set("long", resolveTrialTimeout(budget()));
		expect(truncationWarning(map)).toContain("truncates 1 of 2 task(s)");
	});

	/** The worst case is the informative one: it names the task giving up the most time. */
	test("names the task with the largest budget being cut", () => {
		const map = new Map<string, ResolvedTrialTimeout>([
			["small", resolveTrialTimeout(budget({ agent: 1800 }), 600)],
			["large", resolveTrialTimeout(budget({ agent: 5400 }), 600)],
		]);
		const warning = truncationWarning(map);
		expect(warning).toContain("largest: large budgets 9000s");
	});

	/**
	 * The warning has to state the consequence, not just the fact. An operator
	 * who reads "3 tasks truncated" and still compares the arms' reward has
	 * learned nothing, so the sentence about non-attributable deltas is part of
	 * the contract and is asserted rather than left to survive by luck.
	 */
	test("states that a delta across differing timeout counts is not attributable", () => {
		const warning = truncationWarning(resolvedMap({ a: 600 })) ?? "";
		expect(warning).toContain("counted separately from agent failures");
		expect(warning).toContain("not attributable");
	});
});

describe("run.ts wiring", () => {
	const runSourcePath = new URL("./run.ts", import.meta.url).pathname;

	/**
	 * The lock: the flat literal must not come back. It survived for months
	 * because it looked like a reasonable default, so the guard is on the source
	 * rather than on behaviour, which would only catch it on a real bench run.
	 */
	test("run.ts no longer contains a flat 900-second trial timeout default", async () => {
		const source = await Bun.file(runSourcePath).text();
		expect(source).not.toContain(`args["trial-timeout"] ?? "900"`);
		expect(source).not.toMatch(/trialTimeoutSec\s*=\s*[^;]*:\s*900/);
	});

	/** The resolver must actually be the thing run.ts uses, not a parallel copy. */
	test("run.ts resolves each trial's timeout through this module", async () => {
		const source = await Bun.file(runSourcePath).text();
		expect(moduleSpecifiersIn(source)).toContain("./trial-timeout");
		expect(source).toContain("resolveTrialTimeout(budget, trialTimeoutOverrideSec)");
	});

	/** A truncating run must announce itself before it burns hours of containers. */
	test("run.ts prints the truncation warning at preflight", async () => {
		const source = await Bun.file(runSourcePath).text();
		expect(source).toContain("truncationWarning(trialTimeouts)");
	});
});
