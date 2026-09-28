/**
 * WHY: each status-line segment states one fact about the session. A segment
 * with no desktop decision is a fact the terminal shows and the window drops,
 * with nothing to say so. This sweep enumerates `SEGMENTS` at run time and fails
 * on a segment with no row and on a row whose segment is gone. Opt-outs and
 * recorded gaps are pinned by exact equality.
 *
 * Not caught: whether the window draws the field of the section a segment is
 * mapped to.
 */
import { describe, expect, it } from "bun:test";
import { membersCarriedBy } from "../../../src/gui-host/desktop-parity/carrier";
import { STATUS_SEGMENT_CARRIERS } from "../../../src/gui-host/desktop-parity/status-line";
import { ALL_SEGMENT_IDS } from "../../../src/modes/terminal/components/status-line/segments";

const RECORDED_GAPS = ["account", "git", "hostname", "pr", "time_spent", "token_rate", "usage"];

describe("status-line segments on the desktop", () => {
	it("decides every segment the terminal draws, and only those", () => {
		const segments: string[] = ALL_SEGMENT_IDS;
		expect(segments.filter(id => !(id in STATUS_SEGMENT_CARRIERS))).toEqual([]);
		expect(Object.keys(STATUS_SEGMENT_CARRIERS).filter(id => !segments.includes(id))).toEqual([]);
	});

	it("pins the opt-outs and the recorded gaps", () => {
		expect(membersCarriedBy(STATUS_SEGMENT_CARRIERS, "optOut")).toEqual(["pi", "time"]);
		expect(membersCarriedBy(STATUS_SEGMENT_CARRIERS, "gap")).toEqual(RECORDED_GAPS);
	});
});
