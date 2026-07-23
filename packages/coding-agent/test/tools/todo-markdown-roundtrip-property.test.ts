import { describe, expect, it } from "bun:test";
import { applyOpsToPhases, markdownToPhases, phasesToMarkdown, type TodoPhase } from "@veyyon/coding-agent/tools/todo";

/**
 * phasesToMarkdown ↔ markdownToPhases round-trip over generated lists.
 */

function makePhases(nPhases: number, tasksPer: number): TodoPhase[] {
	const statuses = ["pending", "in_progress", "completed", "abandoned"] as const;
	return Array.from({ length: nPhases }, (_, p) => ({
		name: `Phase-${p}`,
		tasks: Array.from({ length: tasksPer }, (_, t) => ({
			content: `task-p${p}-t${t}`,
			status: statuses[(p + t) % statuses.length]!,
		})),
	}));
}

describe("todo markdown round-trip property", () => {
	it("round-trips many phase/task sizes with exact contents and statuses", () => {
		for (const nPhases of [1, 2, 5]) {
			for (const tasksPer of [1, 3, 8]) {
				const original = makePhases(nPhases, tasksPer);
				const md = phasesToMarkdown(original);
				const { phases, errors } = markdownToPhases(md);
				expect(errors).toEqual([]);
				expect(phases).toHaveLength(nPhases);
				for (let p = 0; p < nPhases; p++) {
					expect(phases[p]!.name).toBe(original[p]!.name);
					expect(phases[p]!.tasks.map(t => t.content)).toEqual(original[p]!.tasks.map(t => t.content));
				}
				// markdownToPhases runs normalizeInProgressTask: if nothing is
				// in_progress, the first pending becomes in_progress. Assert that
				// completed/abandoned are stable and that at most one is in_progress.
				const all = phases.flatMap(p => p.tasks);
				expect(all.filter(t => t.status === "in_progress").length).toBeLessThanOrEqual(1);
				for (const t of all) {
					if (t.status === "completed" || t.status === "abandoned") {
						const orig = original.flatMap(p => p.tasks).find(o => o.content === t.content);
						expect(orig?.status).toBe(t.status);
					}
				}
			}
		}
	});

	it("marker round-trip preserves completed and abandoned exactly when an in_progress exists", () => {
		const original: TodoPhase[] = [
			{
				name: "Mixed",
				tasks: [
					{ content: "done-one", status: "completed" },
					{ content: "doing-now", status: "in_progress" },
					{ content: "later", status: "pending" },
					{ content: "dropped", status: "abandoned" },
				],
			},
		];
		const { phases, errors } = markdownToPhases(phasesToMarkdown(original));
		expect(errors).toEqual([]);
		expect(phases[0]!.tasks.map(t => t.status)).toEqual(["completed", "in_progress", "pending", "abandoned"]);
	});

	it("init then markdown round-trip preserves task texts", () => {
		const { phases } = applyOpsToPhases(
			[],
			[
				{
					op: "init",
					list: [
						{ phase: "Build", items: ["scaffold app", "wire tests"] },
						{ phase: "Ship", items: ["tag release"] },
					],
				},
			],
		);
		const md = phasesToMarkdown(phases);
		const back = markdownToPhases(md);
		expect(back.errors).toEqual([]);
		expect(back.phases.map(p => p.name)).toEqual(["Build", "Ship"]);
		expect(back.phases[0]!.tasks.map(t => t.content)).toEqual(["scaffold app", "wire tests"]);
		expect(back.phases[1]!.tasks.map(t => t.content)).toEqual(["tag release"]);
	});
});
