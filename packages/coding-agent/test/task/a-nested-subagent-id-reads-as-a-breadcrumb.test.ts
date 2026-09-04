/**
 * WHY THIS EXISTS.
 *
 * A subagent id carries its nesting as a `.` separator (`Anna.Bob`), which reads as a filename
 * rather than as a parent and a child. Three surfaces show the same id -- the subagent HUD, the
 * transcript card and the task result rows -- so the conversion is one function and a second
 * spelling of it would show one agent two ways.
 *
 * The class this closes is a display id that reaches a reader carrying whatever the model wrote:
 * a raw separator, an ANSI sequence a subagent name picked up from a provider, or a control byte
 * that would move the cursor out of the card. All three are the same defect, and all three are
 * decided in `formatTaskId`.
 *
 * WHAT IT DOES NOT CATCH. Where the id is placed, how it is truncated, and what colour it is
 * drawn in are the card's, not this function's.
 */

import { describe, expect, it } from "bun:test";
import { formatTaskId } from "@veyyon/coding-agent/task/task-id";

describe("a nested subagent id reads as a breadcrumb", () => {
	it("leaves a top-level id exactly as it is", () => {
		expect(formatTaskId("Anna")).toBe("Anna");
		expect(formatTaskId("Anna-2")).toBe("Anna-2");
	});

	it("shows each nesting level as a step of one breadcrumb", () => {
		expect(formatTaskId("Anna.Bob")).toBe("Anna>Bob");
		expect(formatTaskId("Anna.Bob.Cara")).toBe("Anna>Bob>Cara");
	});

	it("strips an escape sequence before the id reaches a card", () => {
		expect(formatTaskId("\x1b[31mAnna\x1b[0m.Bob")).toBe("Anna>Bob");
	});

	it("drops a control byte that would move the cursor out of the card", () => {
		expect(formatTaskId("An\x07na.B\x08ob")).toBe("Anna>Bob");
	});

	it("answers an empty id with an empty string rather than a separator", () => {
		expect(formatTaskId("")).toBe("");
	});
});
