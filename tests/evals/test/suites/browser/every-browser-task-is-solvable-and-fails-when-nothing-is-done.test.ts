/**
 * WHY: a benchmark task that no run can pass measures nothing, and neither does one whose checks
 * pass when the agent does nothing. Both happen silently: a seeded scenario whose planner picks an
 * item the site then refuses, a check that compares against a field the site never records, a
 * decoy that accidentally satisfies the rule. This suite sweeps every task of the browser suite, as
 * the suite itself lists them, over several seeds: the task's scripted solution, driven through the
 * running site's own HTTP endpoints, must pass every check, and a trial in which nothing happens
 * must fail.
 *
 * Every task must carry a solution (`KitTrial.solve` is required), so a new task joins the sweep
 * without an edit here.
 *
 * Not caught: whether the pages let a browser do what the solution does over HTTP (a button that
 * never submits, an overlay that cannot be dismissed). A calibration run of the suite is the check
 * for that.
 */
import { describe, expect, it } from "bun:test";
import { catalogProblems } from "../../../engine/kit/catalog";
import { BROWSER_CAPABILITIES, BROWSER_TASKS } from "../../../suites/browser/main";
import { sweepTasks } from "./task-sweep";

describe("the browser suite", () => {
	it("has a sound catalog", () => {
		expect(catalogProblems(BROWSER_TASKS, BROWSER_CAPABILITIES)).toEqual([]);
	});

	sweepTasks(BROWSER_TASKS);
});
