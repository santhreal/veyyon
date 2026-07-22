import { describe, expect, it } from "bun:test";
import { harborRunnerArgs } from "./launch-args";

/**
 * Launch argv mapping: model/dataset/include flags must appear as real CLI
 * tokens the runner understands — empty model or malformed bodies fail closed.
 */

const baseOpts = { jobsDir: "/tmp/jobs", jobName: "job-1", dataset: "bench-set" };

describe("harborRunnerArgs", () => {
	it("includes model and required job/dataset flags", () => {
		const argv = harborRunnerArgs({ model: "claude-sonnet-4-5" }, baseOpts);
		expect(argv).toEqual(
			expect.arrayContaining([
				"--model",
				"claude-sonnet-4-5",
				"-d",
				"bench-set",
				"--job-name",
				"job-1",
				"--jobs-dir",
				"/tmp/jobs",
			]),
		);
	});

	it("passes repeated --include for each explicit task name", () => {
		const argv = harborRunnerArgs(
			{
				model: "m",
				include: ["task-a", "task-b"],
			},
			baseOpts,
		);
		const includes: string[] = [];
		for (let i = 0; i < argv.length; i++) {
			if (argv[i] === "--include" && argv[i + 1]) includes.push(argv[i + 1]!);
		}
		expect(includes).toEqual(["task-a", "task-b"]);
		// include list sets tasks to the include length when tasks omitted.
		const tasksIdx = argv.indexOf("--tasks");
		expect(tasksIdx).toBeGreaterThanOrEqual(0);
		expect(argv[tasksIdx + 1]).toBe("2");
	});

	it("emits --tasks when a numeric sample size is set without include", () => {
		const argv = harborRunnerArgs({ model: "m", tasks: 7 }, baseOpts);
		const idx = argv.indexOf("--tasks");
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(argv[idx + 1]).toBe("7");
	});

	it("maps concurrency to a positive --concurrency flag", () => {
		const argv = harborRunnerArgs({ model: "m", concurrency: 4 }, baseOpts);
		const idx = argv.indexOf("--concurrency");
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(argv[idx + 1]).toBe("4");
	});
});
