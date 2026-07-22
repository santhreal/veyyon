import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BENCHMARK_DEFINITIONS, readBenchmarkSnapshot } from "./benchmarks";

const cleanups: string[] = [];

function jobDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-benchmark-"));
	cleanups.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("benchmark adapters", () => {
	it("normalizes edit attempts, traces, tokens, and declared metrics", () => {
		const dir = jobDir();
		fs.writeFileSync(
			path.join(dir, "result.json"),
			JSON.stringify({
				tasks: [
					{
						id: "rename-symbol",
						name: "Rename symbol",
						runs: [
							{
								runIndex: 0,
								success: true,
								duration: 1200,
								tokens: { input: 100, output: 20, reasoning: 5 },
							},
						],
					},
				],
				summary: {
					totalRuns: 1,
					successfulRuns: 1,
					taskSuccessRate: 1,
					editSuccessRate: 0.75,
					totalTokens: { input: 100, output: 20 },
				},
			}),
		);

		const snapshot = readBenchmarkSnapshot("edit", dir);
		expect(snapshot.metrics).toEqual({ task_success_rate: 1, edit_success_rate: 0.75 });
		expect(snapshot.traces[0]).toMatchObject({
			name: "rename-symbol__1",
			status: "pass",
			tracePath: path.join("result.dump", "rename-symbol", "run-1.md"),
		});
		expect([snapshot.tokIn, snapshot.tokOut]).toEqual([100, 20]);
	});

	it("publishes metric definitions for every managed benchmark", () => {
		expect(BENCHMARK_DEFINITIONS.map(definition => definition.kind)).toEqual(["harbor", "edit"]);
		expect(BENCHMARK_DEFINITIONS.every(definition => definition.metrics.length > 0)).toBe(true);
	});
});
