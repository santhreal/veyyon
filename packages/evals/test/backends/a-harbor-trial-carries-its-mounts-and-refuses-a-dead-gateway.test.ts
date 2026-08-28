/**
 * WHY: the unified harbor backend built the source deps tree and then never told
 * harbor about it. `runTrial` passed neither `--extra-docker-compose` (docker) nor
 * `--mounts` (apple-container) and wrote no gateway providers file, so every trial in
 * source install mode died in agent setup with "veyyon source mode: bun mount
 * missing", and once the mounts arrived the containers still could not reach the host
 * auth gateway — each agent errored on its first request and the verifier recorded an
 * honest-looking reward of 0 for a trial that never ran.
 *
 * The class this closes: an input the container needs that the trial command does not
 * carry, and an infrastructure failure that reaches the scoreboard as a zero. The
 * mount assertions sweep both container environments from the backend's own argument
 * builder, the gateway refusal is asserted through `preflight`, and the transcript
 * reader is exercised on the exact shapes a veyyon run writes.
 *
 * What it does not catch: whether docker itself honors the overlay (no container is
 * started here), and a provider failure that still spends tokens before dying, which
 * is a real attempt and stays a scored trial.
 */

import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Config } from "../../backends/harbor/config";
import type { SourceMount } from "../../backends/harbor/deps";
import { agentSetupFailure, HarborBackend } from "../../backends/harbor/main";
import type { EvalSuite, RunContext, TaskDescriptor, TrialCell, TrialScore, Variant } from "../../engine/contracts";
import { harnesses } from "../../engine/loaded-members";

const TASK = "carry-the-mounts";
const MODEL = "vendor/model-x";

const VARIANT: Variant = {
	name: "veyyon",
	harness: "veyyon",
	configPath: null,
	promptVariantPath: null,
	model: MODEL,
	attachments: [],
};

function stubSuite(): EvalSuite {
	return {
		id: "mount-fidelity-suite",
		version: "1.0.0",
		displayName: "Mount Fidelity Suite",
		description: "Fixture suite that describes one task and scores nothing.",
		backend: "harbor",
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
			return { suite: "mount-fidelity-suite", version: "1.0.0" };
		},
		async scoreTrial(): Promise<TrialScore> {
			return { reward: null, partial: null, error: null, usage: null, extra: {} };
		},
		async preflight() {
			return { ok: true };
		},
	};
}

async function makeContext(options: Record<string, unknown> = {}): Promise<RunContext> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "evals-harbor-mounts-"));
	return {
		runId: "run-harbor-mounts",
		suite: stubSuite(),
		workDir: root,
		runsDir: path.join(root, "runs"),
		harnesses,
		options: { variants: [VARIANT], ...options },
	};
}

const CELL: TrialCell = { variant: VARIANT.name, suite: "mount-fidelity-suite", task: TASK, repeat: 0 };

/** A deps tree on disk, standing in for the one the real preparer builds in a container. */
async function fakeDepsTree(): Promise<SourceMount> {
	const depsDir = await fs.mkdtemp(path.join(os.tmpdir(), "evals-harbor-deps-"));
	await fs.mkdir(path.join(depsDir, "bin"), { recursive: true });
	await fs.mkdir(path.join(depsDir, "node_modules"), { recursive: true });
	return { arch: "x64", depsDir, nodeModules: ["node_modules"] };
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

async function argvForEnvType(envType: "docker" | "apple-container"): Promise<readonly string[]> {
	const source = await fakeDepsTree();
	const prepared: Config[] = [];
	const backend = new HarborBackend({
		prepareDeps: (cfg: Config) => {
			prepared.push(cfg);
			return source;
		},
		gatewayHealth: () => true,
	});
	const context = await makeContext({ envType });
	await backend.prepare(context);
	expect(prepared).toHaveLength(1);

	const spawns: string[][] = [];
	const spawnSpy = spyOn(Bun, "spawn").mockImplementation(command => {
		spawns.push([...(command as readonly string[])]);
		return stubSubprocess();
	});
	try {
		await backend.runTrial(CELL, context);
	} finally {
		spawnSpy.mockRestore();
	}
	expect(spawns).toHaveLength(1);
	return spawns[0] ?? [];
}

describe("a harbor trial carries its mounts", () => {
	it("passes docker the compose overlay that binds the repository, the deps tree and the host gateway", async () => {
		const argv = await argvForEnvType("docker");
		const overlayIndex = argv.indexOf("--extra-docker-compose");
		expect(overlayIndex).toBeGreaterThan(-1);
		const overlayPath = argv[overlayIndex + 1];
		expect(overlayPath).toBeDefined();
		const overlay = await fs.readFile(overlayPath as string, "utf-8");
		expect(overlay).toContain("/opt/veyyon/src:ro");
		expect(overlay).toContain("/opt/veyyon/src/node_modules:ro");
		expect(overlay).toContain("/opt/veyyon/bin:ro");
		// Plain Linux docker has no Docker Desktop DNS entry for the host.
		expect(overlay).toContain('host.docker.internal:host-gateway"');
		// A compose overlay is never handed to harbor as a --mounts payload.
		expect(argv).not.toContain("--mounts");
	});

	it("passes apple-container the same mounts as a --mounts payload instead", async () => {
		const argv = await argvForEnvType("apple-container");
		const mountsIndex = argv.indexOf("--mounts");
		expect(mountsIndex).toBeGreaterThan(-1);
		const payload: unknown = JSON.parse(argv[mountsIndex + 1] as string);
		expect(Array.isArray(payload)).toBe(true);
		const targets = (payload as Array<{ target: string }>).map(entry => entry.target);
		expect(targets).toContain("/opt/veyyon/src");
		expect(targets).toContain("/opt/veyyon/bin");
		expect(argv).not.toContain("--extra-docker-compose");
	});

	it("writes this trial's gateway providers file next to the trial, not once per run", async () => {
		const source = await fakeDepsTree();
		const backend = new HarborBackend({ prepareDeps: () => source, gatewayHealth: () => true });
		const context = await makeContext();
		await backend.prepare(context);
		const spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => stubSubprocess());
		try {
			await backend.runTrial(CELL, context);
		} finally {
			spawnSpy.mockRestore();
		}
		const runDir = path.join(context.runsDir, context.runId);
		const jobs = await fs.readdir(runDir);
		expect(jobs.length).toBeGreaterThan(0);
		const models = await fs.readFile(path.join(runDir, jobs[0] as string, "models.yml"), "utf-8");
		expect(models).toContain("baseUrl: http://host.docker.internal:4000");
	});
});

describe("a harbor run refuses a dead auth gateway", () => {
	it("fails preflight naming the gateway instead of running trials that cannot authenticate", async () => {
		const backend = new HarborBackend({
			which: (bin: string) => `/usr/bin/${bin}`,
			exec: async () => ({ stdout: "", stderr: "" }),
			gatewayHealth: () => false,
		});
		const verdict = await backend.preflight(await makeContext());
		expect(verdict.ok).toBe(false);
		expect(verdict.missingRequirements).toEqual(["auth-gateway"]);
		expect(verdict.reason).toContain("host.docker.internal:4000");
	});

	it("does not require a gateway when the run forwards host credentials instead", async () => {
		const backend = new HarborBackend({
			which: (bin: string) => `/usr/bin/${bin}`,
			exec: async () => ({ stdout: "", stderr: "" }),
			gatewayHealth: () => false,
		});
		const verdict = await backend.preflight(await makeContext({ gateway: false }));
		expect(verdict.ok).toBe(true);
	});

	it("requires the gateway for exactly the harnesses whose harbor binding routes through it", async () => {
		const backend = new HarborBackend({
			which: (bin: string) => `/usr/bin/${bin}`,
			exec: async () => ({ stdout: "", stderr: "" }),
			gatewayHealth: () => false,
		});

		// Swept from the registry rather than listed: a harness that gains or loses
		// `authGateway` moves between these two sets with no edit here.
		for (const harness of harnesses.list()) {
			const binding = harness.backends.harbor;
			if (!binding) continue;
			const variant: Variant = { ...VARIANT, name: harness.id, harness: harness.id };
			const verdict = await backend.preflight(await makeContext({ variants: [variant] }));
			expect({ harness: harness.id, ok: verdict.ok }).toEqual({
				harness: harness.id,
				ok: binding.authGateway !== true,
			});
		}
	});
});

describe("a trial whose agent never reached a provider is an error, not a zero", () => {
	async function transcript(lines: readonly unknown[]): Promise<string> {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "evals-agent-log-"));
		const file = path.join(dir, "veyyon.txt");
		await fs.writeFile(file, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
		return file;
	}

	const erroredTurn = (message: string) => ({
		type: "agent_end",
		messages: [
			{
				role: "assistant",
				stopReason: "error",
				errorMessage: message,
				usage: { input: 0, output: 0, totalTokens: 0 },
			},
		],
	});

	it("reports the provider error when no turn ever spent a token", async () => {
		const file = await transcript([
			{ type: "agent_start" },
			erroredTurn("getaddrinfo ENOTFOUND host.docker.internal"),
		]);
		expect(await agentSetupFailure(file)).toBe("getaddrinfo ENOTFOUND host.docker.internal");
	});

	it("stays silent when a turn did spend tokens before the run ended badly", async () => {
		const file = await transcript([
			{
				type: "agent_end",
				messages: [{ role: "assistant", stopReason: "stop", usage: { totalTokens: 4231 } }],
			},
			erroredTurn("usage limit reached"),
		]);
		expect(await agentSetupFailure(file)).toBeNull();
	});

	it("stays silent for a clean transcript and for a missing one", async () => {
		const file = await transcript([
			{ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop", usage: { totalTokens: 12 } }] },
		]);
		expect(await agentSetupFailure(file)).toBeNull();
		expect(await agentSetupFailure(path.join(path.dirname(file), "absent.txt"))).toBeNull();
	});
});
