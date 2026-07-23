/**
 * parseUnexpectedStopClassification: startsWith yes/no after trim+lower.
 * Adversarial: prefixes, whitespace, multiline, empty, partial words.
 */
import { describe, expect, it } from "bun:test";
import { parseUnexpectedStopClassification } from "@veyyon/coding-agent/session/unexpected-stop-classifier";

describe("parseUnexpectedStopClassification adversarial matrix", () => {
	const yes = ["yes", "YES", "Yes", "  yes", "yes\n", "yes please", "yes, continue", "YESNO", "yes\nmore text"];
	for (const t of yes) {
		it(`yes: ${JSON.stringify(t)}`, () => {
			expect(parseUnexpectedStopClassification(t)).toBe(true);
		});
	}

	const no = ["no", "NO", "No", "  no", "nope", "no way", "NO\n", "nobody"];
	for (const t of no) {
		it(`no: ${JSON.stringify(t)}`, () => {
			expect(parseUnexpectedStopClassification(t)).toBe(false);
		});
	}

	const undef = [
		"",
		"   ",
		"maybe",
		"y",
		"n",
		"yeah",
		"affirmative",
		"true",
		"false",
		"0",
		"1",
		"y e s",
		"x yes",
		"unsure",
		"possibly",
	];
	for (const t of undef) {
		it(`undefined: ${JSON.stringify(t)}`, () => {
			expect(parseUnexpectedStopClassification(t)).toBeUndefined();
		});
	}

	it("trim removes leading newline so \\nyes is yes", () => {
		expect(parseUnexpectedStopClassification("\nyes")).toBe(true);
	});

	it("not sure starts with no → false (not undefined)", () => {
		expect(parseUnexpectedStopClassification("not sure")).toBe(false);
	});
});
