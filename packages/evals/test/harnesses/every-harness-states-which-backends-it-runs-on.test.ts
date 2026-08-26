/**
 * WHY THIS SUITE EXISTS.
 *
 * Each evaluation suite targets an execution backend (e.g. DeepSWE -> Pier,
 * TerminalBench -> Harbor, TypeScriptEdit -> in-process). Harness adapters
 * implement agent execution interfaces, but not all harnesses run on all
 * backends.
 *
 * Previously, VeyyonAdapter declared only the `pier` backend, leaving `harbor`
 * and `in-process` silently unbound or failing with unhelpful runtime errors.
 *
 * This regression suite enforces:
 * 1. Every harness explicitly declares which backends it runs on in its `backends` map.
 * 2. Sweeping builtinHarnesses × builtinSuites dynamically from the registries proves that
 *    every (harness, suite) pair either plans successfully or fails loudly with an
 *    UnboundHarnessBackendError naming the harness, suite, and backend.
 * 3. The refused set is pinned with exact equality so any new harness or suite turns
 *    this suite RED until an explicit backend decision is recorded.
 * 4. Multi-harness planning produces a deterministic task-major matrix where 2 harnesses
 *    × N tasks yields 2N cells in deterministic order.
 *
 * WHAT THIS SUITE DOES NOT CATCH:
 * It does not run end-to-end containerized Docker or Pier execution (that requires live
 * container infrastructure). It tests run planning, backend binding contracts, and preflight
 * refusal semantics.
 */

import { describe, expect, it } from "bun:test";
import {
	defaultHarnessRegistry,
	defaultSuiteRegistry,
	type EvalSuite,
	type HarnessAdapter,
	HarnessRegistry,
	type TaskDescriptor,
} from "../../src/core";
import { registerBuiltinHarnesses } from "../../src/harnesses";
import { buildRunPlan, UnboundHarnessBackendError } from "../../src/run";
import { registerAllSuites } from "../../src/suites";

registerAllSuites();
registerBuiltinHarnesses();

describe("every harness states which backends it runs on", () => {
	it("sweeps builtinHarnesses × builtinSuites and pins refused pairs by exact equality", async () => {
		const harnesses = defaultHarnessRegistry.list();
		const suites = defaultSuiteRegistry.list();

		expect(harnesses.length).toBeGreaterThanOrEqual(4);
		expect(suites.length).toBeGreaterThanOrEqual(3);

		const bound: Array<{ harness: string; suite: string; backend: string }> = [];
		const refused: Array<{ harness: string; suite: string; backend: string }> = [];

		for (const harness of harnesses) {
			for (const suite of suites) {
				const pair = { harness: harness.name, suite: suite.name, backend: suite.backend };
				const tasks = await suite.discoverTasks({});
				const sampleTasks = tasks.slice(0, 1);

				if (harness.backends[suite.backend]) {
					// Bound: planning must succeed
					const plan = await buildRunPlan({
						suite,
						selection: {
							harnesses: [harness.name],
							models: ["anthropic/claude-sonnet-4-5"],
						},
						tasks: sampleTasks,
					});

					expect(plan.variants.length).toBe(1);
					expect(plan.cells.length).toBe(sampleTasks.length);
					bound.push(pair);
				} else {
					// Unbound: planning must throw UnboundHarnessBackendError naming harness, suite, and backend
					let threwError: unknown = null;
					try {
						await buildRunPlan({
							suite,
							selection: {
								harnesses: [harness.name],
								models: ["anthropic/claude-sonnet-4-5"],
							},
							tasks: sampleTasks,
						});
					} catch (err) {
						threwError = err;
					}

					expect(threwError).toBeInstanceOf(UnboundHarnessBackendError);
					const err = threwError as UnboundHarnessBackendError;
					expect(err.harness).toBe(harness.name);
					expect(err.suite).toBe(suite.name);
					expect(err.backend).toBe(suite.backend);
					expect(err.message).toContain(harness.name);
					expect(err.message).toContain(suite.name);
					expect(err.message).toContain(suite.backend);

					refused.push(pair);
				}
			}
		}

		// veyyon is bound on all 3 backends
		const veyyonBound = bound.filter(b => b.harness === "veyyon");
		expect(veyyonBound.map(b => b.backend).sort()).toEqual(["harbor", "in-process", "pier"]);

		// Refused pairs are pinned with exact equality - adding any suite/harness turns this RED
		expect(refused).toEqual([
			{ harness: "omp", suite: "typescript-edit", backend: "in-process" },
			{ harness: "omp", suite: "terminal-bench", backend: "harbor" },
			{ harness: "factory", suite: "typescript-edit", backend: "in-process" },
			{ harness: "factory", suite: "terminal-bench", backend: "harbor" },
			{ harness: "hermes", suite: "typescript-edit", backend: "in-process" },
			{ harness: "hermes", suite: "terminal-bench", backend: "harbor" },
		]);
	});

	it("turns red if a new unrecorded harness is added to the registry", async () => {
		const customHarnessRegistry = new HarnessRegistry();
		registerBuiltinHarnesses(customHarnessRegistry);

		const unrecordedHarness: HarnessAdapter = {
			name: "unrecorded-agent",
			displayName: "Unrecorded Agent",
			description: "A newly added harness without recorded backends",
			defaultModel: "anthropic/claude-sonnet-4-5",
			capabilities: {},
			backends: {},
			async preflight() {
				return { ok: true };
			},
			async stageAssets() {},
		};
		customHarnessRegistry.register(unrecordedHarness);

		const suites = defaultSuiteRegistry.list();
		const refused: Array<{ harness: string; suite: string; backend: string }> = [];

		for (const harness of customHarnessRegistry.list()) {
			for (const suite of suites) {
				if (!harness.backends[suite.backend]) {
					refused.push({ harness: harness.name, suite: suite.name, backend: suite.backend });
				}
			}
		}

		const standardRefused = [
			{ harness: "omp", suite: "typescript-edit", backend: "in-process" },
			{ harness: "omp", suite: "terminal-bench", backend: "harbor" },
			{ harness: "factory", suite: "typescript-edit", backend: "in-process" },
			{ harness: "factory", suite: "terminal-bench", backend: "harbor" },
			{ harness: "hermes", suite: "typescript-edit", backend: "in-process" },
			{ harness: "hermes", suite: "terminal-bench", backend: "harbor" },
		];
		expect(refused).not.toEqual(standardRefused);
		expect(refused.length).toBeGreaterThan(standardRefused.length);
	});

	it("produces a deterministic multi-harness matrix: 2 harnesses × N tasks yields 2N cells in task-major order", async () => {
		const customHarnessRegistry = new HarnessRegistry();
		const harnessA: HarnessAdapter = {
			name: "harness-a",
			displayName: "Harness A",
			description: "Test harness A",
			defaultModel: "model-1",
			capabilities: {},
			backends: { "in-process": {} },
			async preflight() {
				return { ok: true };
			},
			async stageAssets() {},
		};
		const harnessB: HarnessAdapter = {
			name: "harness-b",
			displayName: "Harness B",
			description: "Test harness B",
			defaultModel: "model-1",
			capabilities: {},
			backends: { "in-process": {} },
			async preflight() {
				return { ok: true };
			},
			async stageAssets() {},
		};
		customHarnessRegistry.register(harnessA);
		customHarnessRegistry.register(harnessB);

		const taskIds = ["task-alpha", "task-beta", "task-gamma"];
		const mockSuite: EvalSuite = {
			name: "mock-suite",
			version: "1.0.0",
			displayName: "Mock Suite",
			description: "Multi-harness mock suite",
			backend: "in-process",
			async discoverTasks() {
				return taskIds;
			},
			async describeTask(id: string): Promise<TaskDescriptor> {
				return { id, path: `/tasks/${id}`, timeBudgetSec: 30, instructionPath: null, metadata: {} };
			},
			async provenance() {
				return { suite: "mock-suite", version: "1.0.0" };
			},
			async scoreTrial() {
				return { reward: 1, partial: null, error: null, usage: null, extra: {} };
			},
			async preflight() {
				return { ok: true };
			},
		};

		const plan = await buildRunPlan({
			suite: mockSuite,
			selection: {
				harnesses: ["harness-a", "harness-b"],
				models: ["vendor/model-x"],
			},
			tasks: taskIds,
			harnessRegistry: customHarnessRegistry,
		});

		// 2 harnesses × 3 tasks = 6 cells
		expect(plan.variants.map(v => v.harness)).toEqual(["harness-a", "harness-b"]);
		expect(plan.cells).toHaveLength(2 * taskIds.length);

		// Cell order must be deterministic and task-major (variants innermost)
		expect(plan.cells.map(cell => `${cell.task} -> ${cell.variant}`)).toEqual([
			"task-alpha -> harness-a",
			"task-alpha -> harness-b",
			"task-beta -> harness-a",
			"task-beta -> harness-b",
			"task-gamma -> harness-a",
			"task-gamma -> harness-b",
		]);
	});
});
