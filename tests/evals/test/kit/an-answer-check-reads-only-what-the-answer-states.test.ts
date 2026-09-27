/**
 * WHY: `answerHasNumber` read every run of digits in an answer as a number the answer states,
 * digits inside an identifier included. On `shop-warranty-answer` an answer that named the right SKU
 * and no warranty (`The longest warranty is on SK-A5HNU.`) passed "states its warranty in years"
 * whenever the SKU held the years digit after a letter, so the trial earned a reward it had not. The
 * same reading took the hyphen of `ORD-1042` for a sign. `answerHasText` matched inside a longer
 * word or number ("East" in "West leads, at least on this data"; `Tent 1` in `Tent 12`), and held an
 * empty `expected` in every answer, the empty answer of a trial that did nothing included. An answer
 * that hedged ("East, or maybe West") passed every check that looked for the right value alone. A
 * minus written before a currency sign (`-$312.40`) or as a typographic minus (`−312.40`) was
 * dropped, so a figure with the wrong sign passed a check that meant the sign.
 *
 * The class closed: every identifier shape the kit's generator produces (`Seeded.code` behind the
 * prefixes the applications use) contributes no number and is not named by a longer one, while the
 * ways an answer writes a number (signs, dates, ranges, currency, units) still read; a check built
 * on `answerNamesOnly` or `answerStatesOnly` fails an answer that also names a candidate it was given.
 *
 * Not caught: an identifier that starts with a digit and stands alone (`5HANU`) still yields its
 * leading digits; a hedge over a candidate the check was not given passes; accounting parentheses
 * (`($12.30)`) read as a positive figure, since prose uses them for positive amounts too.
 */
import { describe, expect, it } from "bun:test";
import { TempDir } from "@veyyon/utils";
import {
	answerHasNumber,
	answerHasText,
	answerNamesOnly,
	answerStatesOnly,
	gradeChecks,
	numbersIn,
} from "../../engine/kit/checks";
import { Seeded } from "../../engine/kit/seeded";
import { trialSeed } from "../../engine/kit/suite";
import { BROWSER_TASKS } from "../../suites/browser/main";

/** The ways the applications prefix a generated code: `SK-…`, `PR-…`, `S…`, `F…`, `ch_…`. */
const ID_PREFIXES = ["SK-", "PR-", "S", "F", "ch_"];

describe("a number in an answer", () => {
	it("is never read from inside an identifier", () => {
		const read: Record<string, number[]> = {};
		for (let seed = 1; seed <= 400; seed++) {
			const code = new Seeded(seed).code(6);
			for (const prefix of ID_PREFIXES) {
				const numbers = numbersIn(`The item is ${prefix}${code}.`);
				if (numbers.length > 0) read[`${prefix}${code}`] = numbers;
			}
		}
		expect(read).toEqual({});
		expect(numbersIn("Order ORD-1042 was placed in 2024-W07.")).toEqual([2024]);
		expect(answerHasNumber("The longest warranty is on SK-A5HNU.", 5)).toBe(false);
	});

	it("is read with its sign, and a date or range as its positive parts", () => {
		expect(numbersIn("It fell by -40 units (-2.5%).")).toEqual([-40, -2.5]);
		expect(numbersIn("Due 2026-05-03, pages 10-15.")).toEqual([2026, 5, 3, 10, 15]);
		expect(numbersIn("A 5-year warranty, 3rd shelf, 12kg, $1,234.50.")).toEqual([5, 3, 12, 1234.5]);
	});
});

describe("the warranty task", () => {
	it("does not reward an answer that names the SKU and no warranty", async () => {
		const task = BROWSER_TASKS.find(entry => entry.id === "shop-warranty-answer");
		if (!task) throw new Error("the browser suite has no shop-warranty-answer task");
		// The first seeds whose winning SKU holds the years digit after a letter.
		const graded: Record<string, [number, boolean | undefined]> = {};
		for (let repeat = 1; repeat <= 200 && Object.keys(graded).length < 3; repeat++) {
			await using dir = await TempDir.create("@evals-kit-warranty-");
			const trial = await task.start({
				seed: trialSeed({ task: task.id, repeat }),
				workspace: dir.path(),
				trialDir: dir.path(),
			});
			const state = JSON.parse(JSON.stringify(await trial.finish())) as { expected: { sku: string; years: number } };
			const { sku, years } = state.expected;
			if (!new RegExp(`[A-Z]${years}(?![0-9])`).test(sku.slice(3))) continue;
			const grade = task.grade(state, `The longest warranty is on ${sku}.`);
			graded[sku] = [grade.reward, grade.outcomes.find(outcome => outcome.id === "answer-years")?.passed];
		}
		expect(Object.values(graded)).toEqual([
			[0, false],
			[0, false],
			[0, false],
		]);
	});
});

describe("an expected text", () => {
	it("that is empty fails its check instead of matching every answer", () => {
		for (const expected of ["", "  \n"]) {
			const grade = gradeChecks(
				[
					{
						id: "named",
						description: "names the record",
						pass: (state: string, answer) => answerHasText(answer, state),
					},
				],
				expected,
				"",
			);
			expect([grade.reward, grade.outcomes[0]?.passed]).toEqual([0, false]);
			expect(grade.outcomes[0]?.error).toContain("empty");
		}
	});
});

describe("a name in an answer", () => {
	it("is named only as a whole term, never inside a longer word or code", () => {
		expect(answerHasText("West leads, at least on this data.", "East")).toBe(false);
		expect(answerHasText("The Trail Tent 12 is lighter.", "Trail Tent 1")).toBe(false);
		expect(answerHasText("East's lead held (East).", "east")).toBe(true);
		const misread: string[] = [];
		for (let seed = 1; seed <= 200; seed++) {
			const code = `SK-${new Seeded(seed).code(5)}`;
			const longer = `${code}${new Seeded(seed + 1000).code(1)}`;
			if (answerHasText(`It is ${longer}.`, code) || !answerHasText(`It is ${code}.`, code)) misread.push(code);
		}
		expect(misread).toEqual([]);
	});

	it("picks the right candidate only when the answer names no other", () => {
		const regions = ["North", "South", "East", "West", "Central"];
		expect(answerNamesOnly("East had the highest average sale.", "East", regions)).toBe(true);
		expect(answerNamesOnly("East, or maybe West.", "East", regions)).toBe(false);
		expect(answerNamesOnly("West leads, at least on this data.", "East", regions)).toBe(false);
		// A value with spellings of its own brings its own matcher.
		const flight = (answer: string, name: string) => answerHasText(answer.replaceAll("-", " "), name);
		expect(answerNamesOnly("Book AU-123.", "AU 123", ["AU 124"], flight)).toBe(true);
		expect(answerNamesOnly("Book AU-123 or AU-124.", "AU 123", ["AU 124"], flight)).toBe(false);
	});

	it("fails a check whose candidates hold one another, since no answer names one alone", () => {
		const grade = gradeChecks(
			[
				{
					id: "channel",
					description: "names the channel",
					pass: (state: string, answer) => answerNamesOnly(answer, state, ["Search"]),
				},
			],
			"Paid search",
			"Paid search grew fastest.",
		);
		expect([grade.reward, grade.outcomes[0]?.error]).toEqual([
			0,
			'"Paid search" and "Search" hold one another, so no answer names one alone',
		]);
	});
});

describe("a figure in an answer", () => {
	it("is taken only when the answer states none of the figures shown beside it", () => {
		const decoys = [298.1, 355, 312.4];
		expect(answerStatesOnly("You spent $312.40 in May.", 312.4, decoys)).toBe(true);
		expect(answerStatesOnly("$312.40, or $355.00 counting pending charges.", 312.4, decoys)).toBe(false);
		expect(answerStatesOnly("You spent $298.10.", 312.4, decoys)).toBe(false);
	});

	it("keeps a minus before a currency sign or written as a minus sign, and compares magnitudes only when told", () => {
		expect(numbersIn("A balance of -$1,234.50, then −40 and –12.30.")).toEqual([-1234.5, -40, -12.3]);
		expect(numbersIn("Pages 10–15; Groceries - $312.40; $-2.")).toEqual([10, 15, 312.4, -2]);
		expect(answerHasNumber("The ledger shows -$312.40.", 312.4)).toBe(false);
		expect(answerHasNumber("The ledger shows -$312.40.", 312.4, undefined, "either")).toBe(true);
		const decoys = [355, 298.1];
		expect(answerStatesOnly("You spent -$312.40.", 312.4, decoys, undefined, "either")).toBe(true);
		expect(answerStatesOnly("-$312.40, or -$355.00 with pending.", 312.4, decoys, undefined, "either")).toBe(false);
	});
});
