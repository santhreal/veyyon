/**
 * WHY: `bench-startup.ts --max <arm>=<ms>` is the assertion that holds the shipped
 * binary's launch card to a recorded baseline. Two defects would let a slow launch
 * pass: judging an arm with no samples (the shared `median` returns 0 for an empty
 * list, which is under every ceiling) and comparing the wrong statistic or the
 * wrong arm. A malformed ceiling must fail before any process launches rather than
 * run a bench that checks nothing. This does not measure startup itself.
 */
import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import { checkCeilings, type Sample } from "./bench-startup";

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");

const samples: Sample[] = [
	{ arm: "composer", ms: 40 },
	{ arm: "composer", ms: 200 },
	{ arm: "composer", ms: 44 },
	{ arm: "first-frame", ms: 900 },
	{ arm: "editable", ms: 50 },
	{ arm: "editable", ms: 60 },
];

test.each([
	{ ceiling: 44, passed: true, why: "a median equal to the ceiling holds it" },
	{ ceiling: 43.9, passed: false, why: "a median above the ceiling exceeds it" },
	{ ceiling: 100, passed: true, why: "one slow outlier does not move the median" },
])("composer median 44 against $ceiling: $why", ({ ceiling, passed }) => {
	expect(checkCeilings(samples, new Map([["composer", ceiling]]))).toEqual([
		{ arm: "composer", ceiling, median: 44, passed },
	]);
});

test("an even sample count takes the mean of the middle pair", () => {
	expect(checkCeilings(samples, new Map([["editable", 55]]))).toEqual([
		{ arm: "editable", ceiling: 55, median: 55, passed: true },
	]);
});

test("an arm the run never measured fails instead of reading as zero", () => {
	expect(checkCeilings(samples, new Map([["replay", 1000]]))).toEqual([
		{ arm: "replay", ceiling: 1000, passed: false },
	]);
});

test("each ceiling is judged against its own arm", () => {
	const verdicts = checkCeilings(
		samples,
		new Map([
			["composer", 130.5],
			["first-frame", 130.5],
		]),
	);
	expect(verdicts.map(verdict => [verdict.arm, verdict.median, verdict.passed])).toEqual([
		["composer", 44, true],
		["first-frame", 900, false],
	]);
});

test.each([
	["composer", "--max takes <arm>=<value>"],
	["nope=10", "--max takes <arm>=<value>"],
	["=10", "--max takes <arm>=<value>"],
	["composer=", "--max composer needs a positive number"],
	["composer=-5", "--max composer needs a positive number"],
	["composer=fast", "--max composer needs a positive number"],
])("a malformed ceiling %j fails before any launch", async (ceiling, message) => {
	const failure = await exec(process.execPath, [path.join(root, "scripts", "bench-startup.ts"), "--max", ceiling], {
		cwd: root,
	}).then(
		() => undefined,
		(error: { code: number; stderr: string }) => error,
	);
	expect(failure?.code).toBe(1);
	expect(failure?.stderr).toContain(message);
});
