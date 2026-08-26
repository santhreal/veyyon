/**
 * WHY: a TrialCell carries the variant NAME only, and every container backend used to
 * re-derive the harness and the model from that string. Pier passed the name to
 * `getHarness()`, so a matrix variant named `veyyon+alpha@vendor/model-x` matched no
 * harness and fell back to `veyyon_agent:VeyyonAgent` with the binding's extra kwargs
 * dropped and the variant's model ignored; harbor guessed the harbor agent from the
 * name's punctuation and selected the agent `veyyon+alpha`. Both reported the result
 * under the requested arm's name while running a different arm, which corrupts every
 * comparison a run exists to make.
 *
 * The class this closes: any backend deriving an axis member from the variant name
 * instead of the plan. The sweeps below enumerate the backend registry and the harness
 * registry at run time, so a new backend that guesses, or a new harness whose binding
 * nothing drives, turns this suite red.
 *
 * What it does not catch: whether the resolved agent import path or harbor agent name
 * is the right one for that harness (that is the adapter's own contract), and anything
 * downstream of the spawn, since no container is started here.
 */

import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { HarborBackend } from "../../src/backends/harbor/backend";
import { builtinBackends } from "../../src/backends/index";
import { PierExecutionBackend } from "../../src/backends/pier/backend";
import * as pierRunner from "../../src/backends/pier/runner";
import { UnknownCellVariantError } from "../../src/core/cell-variant";
import { listHarnesses } from "../../src/core/harness-registry";
import type {
	BackendId,
	EvalSuite,
	HarnessAdapter,
	RunContext,
	TaskDescriptor,
	TrialCell,
	TrialScore,
	Variant,
} from "../../src/core/types";
import { registerBuiltinHarnesses } from "../../src/harnesses/index";

/** Backends this suite drives end to end without a container runtime. */
const DRIVEN_BACKENDS: ReadonlySet<BackendId> = new Set<BackendId>(["pier", "harbor"]);

const TASK = "resolve-the-plan";
const MODEL = "vendor/model-x";

/** An overlay-suffixed name: what the matrix produces, and what name inference mangles. */
function overlayVariantName(harnessName: string): string {
	return `${harnessName}+alpha@${MODEL}`;
}

function planVariant(harness: HarnessAdapter): Variant {
	return {
		name: overlayVariantName(harness.name),
		harness: harness.name,
		configPath: null,
		promptVariantPath: null,
		model: MODEL,
		attachments: [],
	};
}

function stubSuite(backend: BackendId): EvalSuite {
	return {
		name: "plan-fidelity-suite",
		version: "1.0.0",
		displayName: "Plan Fidelity Suite",
		description: "Fixture suite that describes one task and scores nothing.",
		backend,
		async discoverTasks(): Promise<readonly string[]> {
			return [TASK];
		},
		async describeTask(taskId: string): Promise<TaskDescriptor> {
			return {
				id: taskId,
				path: null,
				timeBudgetSec: 60,
				instructionPath: null,
				metadata: { prompt: "do the thing" },
			};
		},
		async provenance() {
			return { suite: "plan-fidelity-suite", version: "1.0.0" };
		},
		async scoreTrial(): Promise<TrialScore> {
			return { reward: null, partial: null, error: null, usage: null, extra: {} };
		},
		async preflight() {
			return { ok: true };
		},
	};
}

async function makeContext(backend: BackendId, variants: readonly Variant[]): Promise<RunContext> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "evals-plan-fidelity-"));
	return {
		runId: "run-plan-fidelity",
		suite: stubSuite(backend),
		workDir: root,
		runsDir: path.join(root, "runs"),
		options: { variants },
	};
}

function cell(variantName: string): TrialCell {
	return { variant: variantName, suite: "plan-fidelity-suite", task: TASK, repeat: 0 };
}

function harnessesBoundTo(backend: BackendId): readonly HarnessAdapter[] {
	return listHarnesses().filter(harness => harness.backends[backend] !== undefined);
}

interface CapturedSpawn {
	readonly argv: readonly string[];
}

function stubSubprocess(): Bun.Subprocess {
	const subprocess = {
		stdout: new Response("harbor finished\n").body,
		stderr: new Response("").body,
		exited: Promise.resolve(0),
		kill(): void {},
	};
	return subprocess as unknown as Bun.Subprocess;
}

describe("a trial runs the arm the plan named", () => {
	// The harness registry is process-wide and self-registers on import; re-registering is
	// idempotent. Clearing it here would poison every later file in the same worker.
	beforeAll(() => {
		registerBuiltinHarnesses();
	});

	it("refuses a cell whose variant the plan does not define, on every registered backend", async () => {
		for (const backend of builtinBackends) {
			const context = await makeContext(backend.id, [
				{
					name: "planned-arm",
					harness: "veyyon",
					configPath: null,
					promptVariantPath: null,
					model: MODEL,
					attachments: [],
				},
			]);

			const attempt = backend.runTrial(cell("arm-nobody-planned"), context);
			await expect(attempt).rejects.toThrow(UnknownCellVariantError);
			await expect(attempt).rejects.toThrow(/planned-arm/);
		}
	});

	it("gives pier the harness binding and the plan's model for an overlay-suffixed arm", async () => {
		const bound = harnessesBoundTo("pier");
		expect(bound.length).toBeGreaterThan(0);

		for (const harness of bound) {
			const variant = planVariant(harness);
			const context = await makeContext("pier", [variant]);

			const configs: pierRunner.PierJobConfigOptions[] = [];
			const writeSpy = spyOn(pierRunner, "writePierJobConfig").mockImplementation(options => {
				configs.push(options);
				return path.join(options.configDir, `${options.jobName}.yaml`);
			});
			const runSpy = spyOn(pierRunner, "runPierTrial").mockImplementation(async () => ({
				exitCode: 0,
				stdout: "",
				stderr: "",
				trialDirPath: null,
				durationMs: 1,
				timedOut: false,
				error: null,
			}));
			const artifactSpy = spyOn(pierRunner, "trialArtifactsFromExecution").mockImplementation(() => ({}));

			try {
				await new PierExecutionBackend().runTrial(cell(variant.name), context);
			} finally {
				writeSpy.mockRestore();
				runSpy.mockRestore();
				artifactSpy.mockRestore();
			}

			expect(configs).toHaveLength(1);
			const config = configs[0];
			if (!config) throw new Error("pier job config was never written");
			const binding = harness.backends.pier;
			if (!binding) throw new Error(`harness ${harness.name} lost its pier binding mid-test`);
			const expectedImportPath = binding.agentImportPath;
			if (!expectedImportPath) throw new Error(`harness ${harness.name} declares no pier agent import path`);
			expect(config.agentImportPath).toBe(expectedImportPath);
			expect(config.modelName).toBe(MODEL);
			expect(config.kwargs.arm_name).toBe(variant.name);
			for (const [key, value] of Object.entries(binding.extra ?? {})) {
				expect(config.kwargs[key]).toEqual(value);
			}
		}
	});

	it("gives harbor the harness's agent name and the plan's model for an overlay-suffixed arm", async () => {
		const bound = harnessesBoundTo("harbor");
		expect(bound.length).toBeGreaterThan(0);

		for (const harness of bound) {
			const variant = planVariant(harness);
			const context = await makeContext("harbor", [variant]);
			const spawns: CapturedSpawn[] = [];
			const spawnSpy = spyOn(Bun, "spawn").mockImplementation(command => {
				spawns.push({ argv: [...(command as readonly string[])] });
				return stubSubprocess();
			});

			try {
				await new HarborBackend().runTrial(cell(variant.name), context);
			} finally {
				spawnSpy.mockRestore();
			}

			expect(spawns).toHaveLength(1);
			const argv = spawns[0]?.argv ?? [];
			const binding = harness.backends.harbor;
			if (!binding) throw new Error(`harness ${harness.name} lost its harbor binding mid-test`);
			// harbor selects an agent by import path when the binding names one, and by agent
			// name otherwise. Either way the value comes from the binding, never from the
			// variant name: `veyyon+alpha@vendor/model-x` is not an agent.
			if (binding.agentImportPath) {
				const importIndex = argv.indexOf("--agent-import-path");
				expect(importIndex).toBeGreaterThan(-1);
				expect(argv[importIndex + 1]).toBe(binding.agentImportPath);
			} else {
				const agentIndex = argv.indexOf("-a");
				expect(agentIndex).toBeGreaterThan(-1);
				expect(argv[agentIndex + 1]).toBe(binding.agentName ?? harness.name);
			}
			expect(argv).toContain(MODEL);
			expect(argv).not.toContain(variant.name);
		}
	});

	it("refuses harbor for a harness that declares no harbor binding", async () => {
		const unbound = listHarnesses().filter(harness => harness.backends.harbor === undefined);
		expect(unbound.length).toBeGreaterThan(0);

		for (const harness of unbound) {
			const variant = planVariant(harness);
			const context = await makeContext("harbor", [variant]);
			const spawns: CapturedSpawn[] = [];
			const spawnSpy = spyOn(Bun, "spawn").mockImplementation(command => {
				spawns.push({ argv: [...(command as readonly string[])] });
				return stubSubprocess();
			});
			try {
				await expect(new HarborBackend().runTrial(cell(variant.name), context)).rejects.toThrow(
					/declares no binding for backend "harbor"/,
				);
			} finally {
				spawnSpy.mockRestore();
			}
			// The refusal has to land before anything is launched: an unbound harness that
			// still reaches harbor would run some other harness's agent under this name.
			expect(spawns).toEqual([]);
		}
	});

	it("leaves no registered harness binding unexercised except the recorded opt-outs", () => {
		const undriven: string[] = [];
		for (const harness of listHarnesses()) {
			for (const backend of Object.keys(harness.backends)) {
				if (!DRIVEN_BACKENDS.has(backend)) {
					undriven.push(`${harness.name}:${backend}`);
				}
			}
		}
		// in-process carries no harness-specific binding fields today, so the sweeps above
		// have nothing to assert for it; the fail-closed sweep still drives that backend.
		expect(undriven.sort()).toEqual(["veyyon:in-process"]);
	});
});
