/**
 * WHY: Gridwork's COUNTIF, SUMIF and AVERAGEIF read `*` and `?` in a text criterion as wildcards.
 * The criterion compiled to a backtracking regular expression, so a pattern with many stars against
 * a long text took time exponential in its stars: `*a*a*a*a*a*a*a*b` over twenty cells of forty
 * `a`s held the server for seconds, and a longer one would stall it for the rest of the trial.
 *
 * The first case pins what a pattern matches (stars, question marks, case, characters a regular
 * expression treats as special, and `<>` negation), so a matcher that drops the regular expression
 * keeps its meaning. The second requires the many-star pattern to evaluate within a bound far under
 * what backtracking takes.
 *
 * Not caught: the time of a criterion over a whole sheet of long texts, which grows with the
 * sheet's cells whatever the matcher.
 */
import { describe, expect, it } from "bun:test";
import { Evaluator } from "../../../suites/browser/apps/sheet/formula";

const VALUES = [
	"North",
	"north east",
	"Nrth",
	"N.rth",
	"Northgate",
	"abc",
	"aXbYc",
	"acb",
	"aab",
	"ab",
	"x",
	"xy",
	"(x)",
];

/** A criterion and how many of `VALUES` it counts. */
const CRITERIA: readonly (readonly [string, number])[] = [
	["north", 1],
	["N*", 5],
	["*th", 3],
	["N?rth", 2],
	["N.rth", 1],
	["a*b*c", 2],
	["*a*a*b", 1],
	["a?b", 2],
	["a*", 5],
	["*b", 3],
	["?", 1],
	["(x)", 1],
	["*", VALUES.length],
	["<>N*", 8],
];

function countIf(values: readonly string[], criterion: string): unknown {
	const cells: Record<string, string> = { B1: `=COUNTIF(A1:A${values.length},"${criterion}")` };
	values.forEach((value, index) => {
		cells[`A${index + 1}`] = value;
	});
	return new Evaluator([{ name: "Sheet", cells }]).value("Sheet", "B1");
}

describe("a wildcard criterion", () => {
	it("counts the texts its stars and question marks match, ignoring case", () => {
		const counted = CRITERIA.map(([criterion]) => [criterion, countIf(VALUES, criterion)]);
		expect(counted).toEqual(CRITERIA.map(([criterion, count]) => [criterion, count]));
	});

	it("matches a pattern of many stars against long texts within a bound", () => {
		const started = performance.now();
		const count = countIf(
			Array.from({ length: 20 }, () => "a".repeat(40)),
			`${"*a".repeat(7)}*b`,
		);
		const elapsed = performance.now() - started;
		expect(count).toBe(0);
		// Backtracking took over two seconds on this input; a matcher that never retries takes microseconds.
		expect(elapsed).toBeLessThan(250);
	});
});
