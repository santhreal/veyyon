import { describe, expect, it } from "bun:test";
import { isWaitingPollDetails } from "@veyyon/coding-agent/tools/job";

/**
 * isWaitingPollDetails decides whether a job-tool result still represents an in-progress wait: it is
 * "waiting" only when there is at least one job and every job is still running with nothing cancelled.
 * The renderer/poll loop uses this to keep showing a live spinner versus settling to a final view, so
 * a regression that returned true for a completed or cancelled batch would hang the spinner forever,
 * and one that returned false for an all-running batch would drop the live indicator early. It also
 * takes `unknown`, so it must reject malformed details without throwing.
 */
describe("isWaitingPollDetails", () => {
	function job(status: "running" | "completed" | "failed" | "cancelled") {
		return { id: "x", type: "bash" as const, status, label: "l", durationMs: 1 };
	}

	it("is true only when every job is running and nothing is cancelled", () => {
		expect(isWaitingPollDetails({ jobs: [job("running"), job("running")] })).toBe(true);
	});

	it("is true when a cancelled field is present but empty", () => {
		expect(isWaitingPollDetails({ jobs: [job("running")], cancelled: [] })).toBe(true);
	});

	it("is false when any job has settled (completed/failed/cancelled)", () => {
		expect(isWaitingPollDetails({ jobs: [job("running"), job("completed")] })).toBe(false);
		expect(isWaitingPollDetails({ jobs: [job("failed")] })).toBe(false);
		expect(isWaitingPollDetails({ jobs: [job("cancelled")] })).toBe(false);
	});

	it("is false when there are any cancelled entries, even if the remaining jobs run", () => {
		expect(isWaitingPollDetails({ jobs: [job("running")], cancelled: [{ id: "a", status: "cancelled" }] })).toBe(
			false,
		);
	});

	it("is false for an empty or missing job list", () => {
		expect(isWaitingPollDetails({ jobs: [] })).toBe(false);
		expect(isWaitingPollDetails({})).toBe(false);
	});

	it("rejects malformed details without throwing", () => {
		expect(isWaitingPollDetails(undefined)).toBe(false);
		expect(isWaitingPollDetails(null)).toBe(false);
		expect(isWaitingPollDetails({ jobs: "not-an-array" })).toBe(false);
	});
});
