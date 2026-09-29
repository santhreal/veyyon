/**
 * WHY: `tab.fill` sets a date or time input by pressing each field of its editor and typing the digits a
 * person would. The digits depend on the field's part and, for an hour, on the clock its range shows:
 * a 12-hour field that starts at 1 takes 12 for midnight, one that starts at 0 takes 00, and a 24-hour
 * field that starts at 1 takes 24. The fields come in the order the locale writes them. The driven
 * suite (`a-date-time-or-range-fill-sends-trusted-events`) reaches the host locale's clock and order
 * alone; this one plans every clock, every input type and orders no one locale has, and reads the
 * editor's fields out of the shape `DOM.describeNode` returns.
 *
 * The contract: each field gets its part of the value, zero-padded to its width; an hour field gets
 * the hour on its own clock and an AM/PM field 1 or 2; an empty value clears every field; a value not
 * in the input's form, a field this does not know, or no fields at all yield no plan, so the script
 * sets the value instead.
 *
 * What it does not catch: whether Chromium takes the digits, which the driven suite proves.
 */
import { describe, expect, it } from "bun:test";
import {
	type CdpNode,
	collectDateFields,
	type DateField,
	planDateKeys,
} from "@veyyon/coding-agent/tools/web/browser/field-keys";

let nextId = 1;
const field = (part: string, min: number, max: number): DateField => ({ part, min, max, backendNodeId: nextId++ });

const YEAR = field("year", 1, 275760);
const MONTH = field("month", 1, 12);
const DAY = field("day", 1, 31);
const WEEK = field("week", 1, 53);
const MINUTE = field("minute", 0, 59);
const SECOND = field("second", 0, 59);
const MILLISECOND = field("millisecond", 0, 999);
const AMPM = field("ampm", 1, 2);

/** The four clocks an hour field's range can show. */
const CLOCKS = {
	"1-12": field("hour", 1, 12),
	"0-11": field("hour", 0, 11),
	"0-23": field("hour", 0, 23),
	"1-24": field("hour", 1, 24),
} as const;

/** The digits each clock takes for the hours at its edges. */
const HOUR_DIGITS: Record<keyof typeof CLOCKS, Record<number, string>> = {
	"1-12": { 0: "12", 1: "01", 11: "11", 12: "12", 13: "01", 23: "11" },
	"0-11": { 0: "00", 1: "01", 11: "11", 12: "00", 13: "01", 23: "11" },
	"0-23": { 0: "00", 1: "01", 11: "11", 12: "12", 13: "13", 23: "23" },
	"1-24": { 0: "24", 1: "01", 11: "11", 12: "12", 13: "13", 23: "23" },
};

describe("an hour field", () => {
	for (const [clock, hourField] of Object.entries(CLOCKS) as [keyof typeof CLOCKS, DateField][]) {
		it(`on a ${clock} clock takes the hour on that clock, and AM/PM by the hour`, () => {
			const planned: Record<number, string[] | undefined> = {};
			const expected: Record<number, string[]> = {};
			for (const [hour, digits] of Object.entries(HOUR_DIGITS[clock])) {
				const value = `${hour.padStart(2, "0")}:05`;
				planned[Number(hour)] = planDateKeys("time", value, [hourField, MINUTE, AMPM]);
				expected[Number(hour)] = [digits, "05", Number(hour) < 12 ? "1" : "2"];
			}
			expect(planned).toEqual(expected);
		});
	}

	it("with a range no clock has yields no plan", () => {
		expect(planDateKeys("time", "09:05", [field("hour", 0, 99), MINUTE])).toBeUndefined();
	});
});

describe("a date or time value", () => {
	it("gives each field its own part, in whatever order the fields come", () => {
		expect({
			dayFirst: planDateKeys("date", "2026-03-07", [DAY, MONTH, YEAR]),
			yearFirst: planDateKeys("date", "2026-03-07", [YEAR, MONTH, DAY]),
			month: planDateKeys("month", "2026-03", [MONTH, YEAR]),
			week: planDateKeys("week", "2026-W09", [WEEK, YEAR]),
			time: planDateKeys("time", "21:04", [CLOCKS["1-12"], MINUTE, SECOND, MILLISECOND, AMPM]),
			local: planDateKeys("datetime-local", "2026-03-07T21:04:05.5", [
				MONTH,
				DAY,
				YEAR,
				CLOCKS["1-12"],
				MINUTE,
				SECOND,
				MILLISECOND,
				AMPM,
			]),
		}).toEqual({
			dayFirst: ["07", "03", "2026"],
			yearFirst: ["2026", "03", "07"],
			month: ["03", "2026"],
			week: ["09", "2026"],
			time: ["09", "04", "00", "000", "2"],
			local: ["03", "07", "2026", "09", "04", "05", "500", "2"],
		});
	});

	it("that is empty clears every field", () => {
		expect(planDateKeys("date", "", [MONTH, DAY, YEAR])).toEqual(["", "", ""]);
	});

	it("not in the input's form, for a field it has no part for, or with no fields yields no plan", () => {
		expect({
			unpadded: planDateKeys("date", "2026-3-7", [MONTH, DAY, YEAR]),
			slashed: planDateKeys("date", "03/07/2026", [MONTH, DAY, YEAR]),
			trailing: planDateKeys("date", "2026-03-07T10:00", [MONTH, DAY, YEAR]),
			otherType: planDateKeys("text", "2026-03-07", [MONTH, DAY, YEAR]),
			noDay: planDateKeys("month", "2026-03", [MONTH, DAY, YEAR]),
			unknownPart: planDateKeys("date", "2026-03-07", [MONTH, field("era", 0, 1), YEAR]),
			noFields: planDateKeys("date", "2026-03-07", []),
		}).toEqual({
			unpadded: undefined,
			slashed: undefined,
			trailing: undefined,
			otherType: undefined,
			noDay: undefined,
			unknownPart: undefined,
			noFields: undefined,
		});
	});
});

describe("the editor's fields", () => {
	it("are read from the input's shadow tree in the order it shows them, with each field's range", () => {
		const node = (backendNodeId: number, attributes: string[], more: Partial<CdpNode> = {}): CdpNode => ({
			backendNodeId,
			attributes,
			...more,
		});
		const input: CdpNode = node(1, ["type", "date"], {
			shadowRoots: [
				node(2, [], {
					children: [
						node(3, ["pseudo", "-webkit-datetime-edit"], {
							children: [
								node(4, ["pseudo", "-webkit-datetime-edit-fields-wrapper"], {
									children: [
										node(5, [
											"pseudo",
											"-webkit-datetime-edit-day-field",
											"aria-valuemin",
											"1",
											"aria-valuemax",
											"31",
										]),
										node(6, ["pseudo", "-webkit-datetime-edit-text"]),
										node(7, [
											"pseudo",
											"-webkit-datetime-edit-month-field",
											"aria-valuemin",
											"1",
											"aria-valuemax",
											"12",
										]),
										node(8, ["pseudo", "-webkit-datetime-edit-text"]),
										node(9, [
											"pseudo",
											"-webkit-datetime-edit-year-field",
											"aria-valuemin",
											"1",
											"aria-valuemax",
											"275760",
										]),
									],
								}),
							],
						}),
						node(10, ["pseudo", "-webkit-calendar-picker-indicator"]),
					],
				}),
			],
		});
		expect(collectDateFields(input)).toEqual([
			{ part: "day", min: 1, max: 31, backendNodeId: 5 },
			{ part: "month", min: 1, max: 12, backendNodeId: 7 },
			{ part: "year", min: 1, max: 275760, backendNodeId: 9 },
		]);
	});
});
