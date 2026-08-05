import { describe, expect, it } from "bun:test";
import type { CustomEntry } from "@veyyon/coding-agent/session/session-entries";
import { getLatestTodoPhasesSnapshotFromEntries, USER_TODO_EDIT_CUSTOM_TYPE } from "@veyyon/coding-agent/tools/todo";

function todoEdit(id: string, phases: unknown[]): CustomEntry<{ phases: unknown[] }> {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: "2026-08-03T00:00:00.000Z",
		customType: USER_TODO_EDIT_CUSTOM_TYPE,
		data: { phases },
	};
}

describe("todo journal snapshot fidelity", () => {
	/** A deliberate clear is a persisted snapshot, not absence, so older tasks cannot return after compaction. */
	it("distinguishes an explicit empty snapshot from no todo history", () => {
		const older = todoEdit("older", [
			{ name: "Old plan", tasks: [{ content: "Must stay cleared", status: "in_progress" }] },
		]);
		const cleared = todoEdit("cleared", []);

		expect(getLatestTodoPhasesSnapshotFromEntries([older, cleared])).toEqual({ found: true, phases: [] });
		expect(getLatestTodoPhasesSnapshotFromEntries([])).toEqual({ found: false, phases: [] });
	});

	/** Large multi-phase snapshots must retain every task and status in insertion order. */
	it("recovers all fifty tasks without collapsing them", () => {
		const phases = [
			{
				name: "Full plan",
				tasks: Array.from({ length: 50 }, (_, index) => ({
					content: `Task ${index + 1}`,
					status: index === 0 ? "in_progress" : "pending",
				})),
			},
		];

		const snapshot = getLatestTodoPhasesSnapshotFromEntries([todoEdit("fifty", phases)]);

		expect(snapshot.found).toBeTrue();
		expect(snapshot.phases[0]!.tasks).toHaveLength(50);
		expect(snapshot.phases[0]!.tasks[0]).toEqual({ content: "Task 1", status: "in_progress" });
		expect(snapshot.phases[0]!.tasks[49]).toEqual({ content: "Task 50", status: "pending" });
	});
});
