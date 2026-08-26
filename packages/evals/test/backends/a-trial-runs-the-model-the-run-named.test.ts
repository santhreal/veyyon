/**
 * WHY: three backends each resolved the model themselves and each ended its chain in a
 * different hardcoded literal — the in-process backend in `anthropic/claude-sonnet-4-6`,
 * the harbor CLI in the same id, the veyyon harness in a Gemini id. A run that named no
 * model therefore ran *some* model, and reported its tokens, its spend and its pass rate
 * under the arm's name. A substituted model is not a default, it is a wrong result, and
 * nothing in the run record said which model produced it.
 *
 * The class this closes: any axis member a backend supplies for itself when the plan
 * supplied none. The sweeps enumerate the backend registry and the harness registry at
 * run time and drive every (backend, harness) pair that a plan can produce, so a new
 * backend that invents a model, or a new harness that reintroduces a silent default,
 * turns this suite red. The exempt agents are pinned by exact set equality against the
 * constant the backend routes on, so a fourth exemption is a red test and a recorded
 * decision rather than a quiet hole.
 *
 * What it does not catch: whether the id names a model the provider actually serves
 * (that is preflight and the provider's own answer), and anything downstream of the
 * spawn, since no container is started here.
 */

import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { HarborBackend, NO_MODEL_AGENTS } from "../../src/backends/harbor/backend";
import { parseArgs, resolveResumeConfig } from "../../src/backends/harbor/runner";
import { InProcessBackend } from "../../src/backends/in-process/backend";
import { builtinBackends } from "../../src/backends/index";
import { PierExecutionBackend } from "../../src/backends/pier/backend";
import * as pierRunner from "../../src/backends/pier/runner";
import { listHarnesses } from "../../src/core/harness-registry";
import { MalformedModelIdError, ModelNotNamedError, parseModelId, resolveTrialModel } from "../../src/core/trial-model";
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

const TASK = "name-the-model";
const SUITE = "model-axis-suite";
/** A provider-namespaced id: the split takes the FIRST slash, so `openai/gpt-oss-120b`
 * stays in the model half. Truncating at the last slash silently renamed the model. */
const NAMESPACED_MODEL = "openrouter/openai/gpt-oss-120b";
const PLAIN_MODEL = "vendor/model-x";
/** No slash at all, so no provider selects a credential or an endpoint. */
const BARE_MODEL = "model-x";

/** `model: ""` is how a variant that names no model is spelled: `Variant.model` is a
 * string, and the matrix refuses an empty models axis, so a plan that names none
 * carries the empty id rather than a null. */
function variantNamed(harness: string, model: string): Variant {
	return {
		name: `${harness}-arm`,
		harness,
		configPath: null,
		promptVariantPath: null,
		model,
		attachments: [],
	};
}

function stubSuite(backend: BackendId): EvalSuite {
	return {
		name: SUITE,
		version: "1.0.0",
		displayName: "Model Axis Suite",
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
				metadata: { prompt: "do the thing", files: [] },
			};
		},
		async provenance() {
			return { suite: SUITE, version: "1.0.0" };
		},
		async scoreTrial(): Promise<TrialScore> {
			return { reward: null, partial: null, error: null, usage: null, extra: {} };
		},
		async preflight() {
			return { ok: true };
		},
	};
}

async function makeContext(
	backend: BackendId,
	variants: readonly Variant[],
	options: Record<string, unknown> = {},
): Promise<RunContext> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "evals-model-axis-"));
	return {
		runId: "run-model-axis",
		suite: stubSuite(backend),
		workDir: root,
		runsDir: path.join(root, "runs"),
		options: { variants, ...options },
	};
}

function cell(variantName: string): TrialCell {
	return { variant: variantName, suite: SUITE, task: TASK, repeat: 0 };
}

function harnessesBoundTo(backend: BackendId): readonly HarnessAdapter[] {
	return listHarnesses().filter(harness => harness.backends[backend] !== undefined);
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

/** An in-process backend whose client answers every call without reaching a provider,
 * recording the model the backend asked it to run. */
function inProcessBackend(launches: Launch[]): InProcessBackend {
	return new InProcessBackend({
		clientFactory: clientOptions => {
			launches.push({ backend: "in-process", model: clientOptions.model ?? null });
			return {
				async start() {},
				async prompt() {},
				async getSessionStats() {
					return {
						tokens: { input: 1, output: 1, total: 2 },
						assistantMessages: 1,
						cost: 0,
					};
				},
				async getLastAssistantText() {
					return "done";
				},
				async dispose() {},
			};
		},
	});
}

/**
 * Drive one backend for one variant, capturing every launch the trial attempts and the
 * model each launch carried. `null` model means the backend refused before launching.
 */
interface Launch {
	readonly backend: BackendId;
	readonly model: string | null;
}

async function driveTrial(
	backendId: BackendId,
	variant: Variant,
	options: Record<string, unknown> = {},
): Promise<{ launches: readonly Launch[]; error: Error | null }> {
	const context = await makeContext(backendId, [variant], options);
	const launches: Launch[] = [];
	const restore: Array<() => void> = [];
	let error: Error | null = null;

	if (backendId === "pier") {
		const writeSpy = spyOn(pierRunner, "writePierJobConfig").mockImplementation(opts => {
			launches.push({ backend: "pier", model: opts.modelName ?? null });
			return path.join(opts.configDir, `${opts.jobName}.yaml`);
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
		restore.push(() => {
			writeSpy.mockRestore();
			runSpy.mockRestore();
			artifactSpy.mockRestore();
		});
	} else if (backendId === "harbor") {
		const spawnSpy = spyOn(Bun, "spawn").mockImplementation(command => {
			const argv = [...(command as readonly string[])];
			const index = argv.indexOf("-m");
			launches.push({ backend: "harbor", model: index > -1 ? (argv[index + 1] ?? null) : null });
			return stubSubprocess();
		});
		restore.push(() => spawnSpy.mockRestore());
	}

	try {
		if (backendId === "in-process") {
			// The in-process backend launches no process: the model it resolved is the
			// model in the options it constructs its client with, so the factory is the
			// observation point.
			await inProcessBackend(launches).runTrial(cell(variant.name), context);
		} else if (backendId === "pier") {
			await new PierExecutionBackend().runTrial(cell(variant.name), context);
		} else {
			await new HarborBackend().runTrial(cell(variant.name), context);
		}
	} catch (err) {
		error = err instanceof Error ? err : new Error(String(err));
	} finally {
		for (const undo of restore) undo();
	}

	return { launches, error };
}

describe("a trial runs the model the run named", () => {
	// The harness registry is process-wide and self-registers on import; re-registering
	// is idempotent. Clearing it here would poison every later file in the same worker.
	beforeAll(() => {
		registerBuiltinHarnesses();
	});

	it("splits a provider-namespaced id at its first slash and keeps the rest of the name", () => {
		const parsed = parseModelId(NAMESPACED_MODEL);

		expect(parsed.provider).toBe("openrouter");
		expect(parsed.model).toBe("openai/gpt-oss-120b");
		expect(parsed.id).toBe(NAMESPACED_MODEL);
	});

	it.each([
		["no slash", "model-x"],
		["empty provider", "/model-x"],
		["empty model", "vendor/"],
		["whitespace in the provider", "ven dor/model-x"],
		["whitespace in the model", "vendor/model x"],
		["nothing at all", ""],
	])("refuses an id that no backend can route: %s", (_label, id) => {
		expect(() => parseModelId(id)).toThrow(MalformedModelIdError);
	});

	it("prefers the variant's model, then the run option, then the harness's own default", () => {
		const context = { options: { model: "option/model" } };
		const withDefault = { name: "third-party", defaultModel: "harness/model" };

		expect(resolveTrialModel(variantNamed("h", PLAIN_MODEL), withDefault, context).id).toBe(PLAIN_MODEL);
		expect(resolveTrialModel(variantNamed("h", ""), withDefault, context).id).toBe("option/model");
		expect(resolveTrialModel(variantNamed("h", ""), withDefault, { options: {} }).id).toBe("harness/model");
		expect(() =>
			resolveTrialModel(variantNamed("h", ""), { name: "h", defaultModel: null }, { options: {} }),
		).toThrow(ModelNotNamedError);
	});

	it("carries the plan's model into every backend a plan can name, unchanged", async () => {
		const driven: string[] = [];
		for (const backend of builtinBackends) {
			for (const harness of harnessesBoundTo(backend.id)) {
				const variant = variantNamed(harness.name, NAMESPACED_MODEL);
				const { launches, error } = await driveTrial(backend.id, variant);

				expect(error).toBeNull();
				expect(launches.map(launch => launch.model)).toEqual([NAMESPACED_MODEL]);
				driven.push(`${harness.name}:${backend.id}`);
			}
		}
		// Pinned by equality so a new backend, a new harness, or a binding that stops
		// being reachable turns this red instead of shrinking the sweep in silence.
		expect(driven.sort()).toEqual([
			"factory:pier",
			"hermes:pier",
			"omp:pier",
			"veyyon:harbor",
			"veyyon:in-process",
			"veyyon:pier",
		]);
	});

	it("takes the run's --model when the plan's variant names none", async () => {
		for (const backend of builtinBackends) {
			for (const harness of harnessesBoundTo(backend.id)) {
				const variant = variantNamed(harness.name, "");
				const { launches, error } = await driveTrial(backend.id, variant, { model: PLAIN_MODEL });

				expect(error).toBeNull();
				// The run option beats a third-party harness's declared default: an
				// operator who passed --model asked for that model on every arm.
				expect(launches.map(launch => launch.model)).toEqual([PLAIN_MODEL]);
			}
		}
	});

	it("refuses, launching nothing, when no axis names a model and the harness declares none", async () => {
		let refusals = 0;
		for (const backend of builtinBackends) {
			for (const harness of harnessesBoundTo(backend.id)) {
				if (harness.defaultModel !== null) continue;
				const variant = variantNamed(harness.name, "");
				const { launches, error } = await driveTrial(backend.id, variant);

				expect(error).toBeInstanceOf(ModelNotNamedError);
				expect(error?.message).toContain("--model <provider/model-id>");
				expect(launches).toEqual([]);
				refusals += 1;
			}
		}
		// Every backend must be represented, or a backend silently stopped being driven.
		expect(refusals).toBeGreaterThanOrEqual(builtinBackends.length);
	});

	it("refuses, launching nothing, an id that is not provider-qualified", async () => {
		for (const backend of builtinBackends) {
			for (const harness of harnessesBoundTo(backend.id)) {
				const variant = variantNamed(harness.name, BARE_MODEL);
				const { launches, error } = await driveTrial(backend.id, variant);

				expect(error).toBeInstanceOf(MalformedModelIdError);
				expect(launches).toEqual([]);
			}
		}
	});

	it("exempts exactly harbor's own no-model agents, and no others", async () => {
		// Pinned by equality against the set the backend routes on: a fourth exemption
		// has to be a decision recorded here, not a container running an unnamed model.
		expect([...NO_MODEL_AGENTS].sort()).toEqual(["nop", "oracle"]);

		for (const agent of NO_MODEL_AGENTS) {
			const variant = variantNamed("veyyon", "");
			const { launches, error } = await driveTrial("harbor", variant, { agent });

			expect(error).toBeNull();
			expect(launches).toHaveLength(1);
			expect(launches[0]?.model).toBeNull();
		}

		// An explicitly selected agent that is not one of them runs a model like any
		// other arm, so it refuses instead of inheriting harbor's container default.
		const { launches, error } = await driveTrial("harbor", variantNamed("veyyon", ""), { agent: "veyyon" });
		expect(error).toBeInstanceOf(ModelNotNamedError);
		expect(launches).toEqual([]);
	});

	it("leaves no registered harness able to supply a model nobody named", () => {
		// A third-party harness may declare its own default, because its CLI drives one
		// model and the arm's name is then unambiguous. Every such default must be a
		// provider-qualified id, or the backend it reaches cannot route it.
		const declared: string[] = [];
		for (const harness of listHarnesses()) {
			if (harness.defaultModel === null) continue;
			declared.push(harness.name);
			expect(() => parseModelId(harness.defaultModel ?? "")).not.toThrow();
		}
		expect(declared.sort()).toEqual(["factory", "hermes", "omp"]);
	});

	it("refuses a harbor launch that names no model, and a resume whose record names none", async () => {
		expect(() => parseArgs(["-d", "terminal-bench@2.0", "--job-name", "j", "--jobs-dir", "/tmp/x"])).toThrow(
			/--model <provider\/model-id> is required/,
		);

		// `--resume` names no model on the command line because the recorded launch
		// config carries it. A record that carries none is unresumable rather than a
		// licence to run the container's default under the original run's name.
		const jobsDir = await fs.mkdtemp(path.join(os.tmpdir(), "evals-model-resume-"));
		const jobName = "job-without-a-model";
		const jobDir = path.join(jobsDir, jobName);
		await fs.mkdir(jobDir, { recursive: true });
		await fs.writeFile(path.join(jobDir, "config.json"), JSON.stringify({ environment: { type: "docker" } }));
		const benchDir = path.join(jobsDir, "_bench", jobName);
		await fs.mkdir(benchDir, { recursive: true });
		await fs.writeFile(path.join(benchDir, "runner-config.json"), JSON.stringify({ models: [] }));

		expect(() => resolveResumeConfig(parseArgs(["--resume", jobName, "--jobs-dir", jobsDir]))).toThrow(
			/names no model/,
		);

		await fs.rm(jobsDir, { recursive: true, force: true });
	});
});
