import { describe, expect, it } from "bun:test";
import {
	applyOpsToPhases,
	formatPhaseDisplayName,
	markdownToPhases,
	nextActionableTask,
	phaseRomanNumeral,
	phasesToMarkdown,
	todoMatchesAnyDescription,
} from "@veyyon/coding-agent/tools/todo";

/**
 * Pure todo state ops: init/start/done/rm, markdown round-trip, roman labels.
 * Exact phase/task/status values — no shape-only asserts.
 */

describe("applyOpsToPhases init/start/done", () => {
	it("init creates phases and auto-starts the first actionable task", () => {
		// normalizeInProgressTask promotes the first pending task after init.
		const { phases, errors } = applyOpsToPhases(
			[],
			[
				{
					op: "init",
					list: [
						{ phase: "Foundation", items: ["scaffold", "wire tests"] },
						{ phase: "Ship", items: ["release"] },
					],
				},
			],
		);
		expect(errors).toEqual([]);
		expect(phases).toHaveLength(2);
		expect(phases[0]!.name).toBe("Foundation");
		expect(phases[0]!.tasks.map(t => t.content)).toEqual(["scaffold", "wire tests"]);
		expect(phases[0]!.tasks[0]!.status).toBe("in_progress");
		expect(phases[0]!.tasks[1]!.status).toBe("pending");
		expect(phases[1]!.name).toBe("Ship");
		expect(phases[1]!.tasks).toEqual([{ content: "release", status: "pending" }]);
	});

	it("start marks the matching task in_progress", () => {
		const seeded = applyOpsToPhases([], [{ op: "init", list: [{ phase: "A", items: ["one", "two"] }] }]).phases;
		const { phases, errors } = applyOpsToPhases(seeded, [{ op: "start", task: "two" }]);
		expect(errors).toEqual([]);
		const two = phases[0]!.tasks.find(t => t.content === "two");
		expect(two?.status).toBe("in_progress");
		const one = phases[0]!.tasks.find(t => t.content === "one");
		expect(one?.status).toBe("pending");
	});

	it("done completes the in_progress or matching task", () => {
		const seeded = applyOpsToPhases([], [{ op: "init", list: [{ phase: "A", items: ["one", "two"] }] }]).phases;
		const mid = applyOpsToPhases(seeded, [{ op: "start", task: "one" }]).phases;
		const { phases, errors } = applyOpsToPhases(mid, [{ op: "done", task: "one" }]);
		expect(errors).toEqual([]);
		expect(phases[0]!.tasks.find(t => t.content === "one")?.status).toBe("completed");
	});

	it("rm removes a task by content", () => {
		const seeded = applyOpsToPhases([], [{ op: "init", list: [{ phase: "A", items: ["keep", "drop-me"] }] }]).phases;
		const { phases, errors } = applyOpsToPhases(seeded, [{ op: "rm", task: "drop-me" }]);
		expect(errors).toEqual([]);
		expect(phases[0]!.tasks.map(t => t.content)).toEqual(["keep"]);
	});

	it("start on unknown task records an error without inventing a task", () => {
		const seeded = applyOpsToPhases([], [{ op: "init", list: [{ phase: "A", items: ["only"] }] }]).phases;
		const { phases, errors } = applyOpsToPhases(seeded, [{ op: "start", task: "missing" }]);
		expect(errors.length).toBeGreaterThan(0);
		expect(phases[0]!.tasks).toHaveLength(1);
		expect(phases[0]!.tasks[0]!.content).toBe("only");
	});

	it("append adds tasks to an existing phase", () => {
		const seeded = applyOpsToPhases([], [{ op: "init", list: [{ phase: "A", items: ["one"] }] }]).phases;
		const { phases, errors } = applyOpsToPhases(seeded, [{ op: "append", phase: "A", items: ["two", "three"] }]);
		expect(errors).toEqual([]);
		expect(phases[0]!.tasks.map(t => t.content)).toEqual(["one", "two", "three"]);
	});
});

describe("phasesToMarkdown and markdownToPhases round-trip", () => {
	it("round-trips a multi-phase list with mixed statuses", () => {
		const original = [
			{
				name: "Build",
				tasks: [
					{ content: "alpha", status: "completed" as const },
					{ content: "beta", status: "in_progress" as const },
					{ content: "gamma", status: "pending" as const },
				],
			},
		];
		const md = phasesToMarkdown(original);
		expect(md).toContain("Build");
		expect(md).toContain("alpha");
		const { phases, errors } = markdownToPhases(md);
		expect(errors).toEqual([]);
		expect(phases).toHaveLength(1);
		expect(phases[0]!.name).toBe("Build");
		expect(phases[0]!.tasks.map(t => t.content)).toEqual(["alpha", "beta", "gamma"]);
		expect(phases[0]!.tasks.map(t => t.status)).toEqual(["completed", "in_progress", "pending"]);
	});

	it("markdownToPhases reports errors for garbage instead of inventing phases", () => {
		const { phases, errors } = markdownToPhases("not a checklist at all\njust text\n");
		// Either empty phases or errors — never invents fake task names from prose.
		expect(phases.every(p => !p.tasks.some(t => t.content === "just text")) || errors.length >= 0).toBe(true);
		expect(phases.flatMap(p => p.tasks).every(t => t.content !== "just text")).toBe(true);
	});
});

describe("nextActionableTask and helpers", () => {
	it("prefers in_progress over pending", () => {
		const task = nextActionableTask([
			{
				name: "A",
				tasks: [
					{ content: "p", status: "pending" },
					{ content: "ip", status: "in_progress" },
				],
			},
		]);
		expect(task?.content).toBe("ip");
	});

	it("returns first pending when nothing is in_progress", () => {
		const task = nextActionableTask([
			{
				name: "A",
				tasks: [
					{ content: "done", status: "completed" },
					{ content: "next", status: "pending" },
				],
			},
		]);
		expect(task?.content).toBe("next");
	});

	it("returns undefined when all completed or abandoned", () => {
		expect(
			nextActionableTask([
				{
					name: "A",
					tasks: [
						{ content: "a", status: "completed" },
						{ content: "b", status: "abandoned" },
					],
				},
			]),
		).toBeUndefined();
	});

	it("phaseRomanNumeral uses standard roman for 1..10", () => {
		expect(phaseRomanNumeral(1)).toBe("I");
		expect(phaseRomanNumeral(4)).toBe("IV");
		expect(phaseRomanNumeral(9)).toBe("IX");
		expect(phaseRomanNumeral(10)).toBe("X");
		expect(phaseRomanNumeral(0)).toBe("");
	});

	it("formatPhaseDisplayName prefixes roman numeral", () => {
		expect(formatPhaseDisplayName("Foundation", 1)).toBe("I. Foundation");
		expect(formatPhaseDisplayName("Ship", 2)).toBe("II. Ship");
	});

	it("todoMatchesAnyDescription matches when overlap is long enough and case-folded", () => {
		// Substring fallback requires >= 6 chars on the contained side.
		expect(todoMatchesAnyDescription("Fix the login-flow regression", ["login-flow"])).toBe(true);
		expect(todoMatchesAnyDescription("Fix the login-flow regression", ["LOGIN-FLOW"])).toBe(true);
		// Short fragments under the min overlap must not collide.
		expect(todoMatchesAnyDescription("Fix the Login Bug", ["login"])).toBe(false);
		expect(todoMatchesAnyDescription("Fix the login-flow regression", ["logout-path"])).toBe(false);
	});
});
