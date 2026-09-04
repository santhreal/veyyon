/**
 * HEADTAIL_DRIFT_WARNING exact content.
 */
import { describe, expect, it } from "bun:test";
import { HEADTAIL_DRIFT_WARNING } from "../src/messages";

describe("HEADTAIL_DRIFT_WARNING exact", () => {
	it("mentions HEAD and TAIL", () => {
		expect(HEADTAIL_DRIFT_WARNING).toContain("INS.HEAD");
		expect(HEADTAIL_DRIFT_WARNING).toContain("INS.TAIL");
		expect(HEADTAIL_DRIFT_WARNING).toContain("stale snapshot");
	});
});
