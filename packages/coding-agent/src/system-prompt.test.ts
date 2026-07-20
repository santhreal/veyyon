import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { APP_NAME, DIR_OVERRIDE_ENV_KEYS } from "@veyyon/utils";
import { buildSystemPrompt } from "./system-prompt";

interface ProbeRunResult {
	elapsedMs: number;
	childElapsedMs: number;
	cached: unknown;
	count: number;
}

async function runProbeScenario(options: {
	runs: number;
	sleepSeconds?: number;
	holdStdoutOpen?: boolean;
	descendantHoldsStdout?: boolean;
	validOutput?: string;
}): Promise<ProbeRunResult> {
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-gpu-probe-"));
	try {
		const binDir = path.join(tempRoot, "bin");
		const cacheRoot = path.join(tempRoot, "cache");
		const homeRoot = path.join(tempRoot, "home");
		const probeCountPath = path.join(tempRoot, "probe-count");
		await fs.mkdir(binDir, { recursive: true });
		await fs.mkdir(path.join(cacheRoot, APP_NAME), { recursive: true });
		await fs.mkdir(homeRoot, { recursive: true });
		const lspciPath = path.join(binDir, "lspci");
		await Bun.write(
			lspciPath,
			'#!/usr/bin/env sh\nprintf x >> "$VEYYON_GPU_PROBE_COUNT"\nif [ -n "$VEYYON_GPU_PROBE_VALID_OUTPUT" ]; then printf "%s\\n" "$VEYYON_GPU_PROBE_VALID_OUTPUT"; fi\nif [ "$VEYYON_GPU_PROBE_DESCENDANT_HOLDS_STDOUT" = "true" ]; then sleep "$VEYYON_GPU_PROBE_SLEEP" & exit 0; fi\nif [ "$VEYYON_GPU_PROBE_HOLD_STDOUT_OPEN" = "true" ]; then sleep "$VEYYON_GPU_PROBE_SLEEP" & wait "$!"; fi\nif [ -n "$VEYYON_GPU_PROBE_SLEEP" ]; then exec sleep "$VEYYON_GPU_PROBE_SLEEP"; fi\nexit 0\n',
		);
		await fs.chmod(lspciPath, 0o755);

		const scenarioPath = path.join(tempRoot, "scenario.ts");
		await Bun.write(
			scenarioPath,
			`import { getGpuCachePath, refreshDirsFromEnv } from ${JSON.stringify(path.resolve(import.meta.dir, "../../utils/src/index.ts"))};
import { buildSystemPrompt } from ${JSON.stringify(path.join(import.meta.dir, "system-prompt.ts"))};

refreshDirsFromEnv();
const buildOptions = {
	contextFiles: [],
	skills: [],
	toolNames: [],
	workspaceTree: {
		rootPath: process.cwd(),
		rendered: "",
		truncated: false,
		totalLines: 0,
		agentsMdFiles: [],
	},
	activeRepoContext: null,
};
const startedAt = performance.now();
for (let index = 0; index < Number(process.env.VEYYON_GPU_PROBE_RUNS ?? "1"); index += 1) {
	await buildSystemPrompt(buildOptions);
}
const cacheFile = Bun.file(getGpuCachePath());
const cached = await cacheFile.exists() ? await cacheFile.json() : null;
const countFile = Bun.file(process.env.VEYYON_GPU_PROBE_COUNT ?? "");
const count = await countFile.exists() ? (await countFile.text()).length : 0;
console.log(JSON.stringify({ elapsedMs: Math.round(performance.now() - startedAt), cached, count }));
`,
		);

		const env: Record<string, string | undefined> = {
			...process.env,
			PATH: `${binDir}:${process.env.PATH ?? ""}`,
			// Point HOME (and its Windows twin) at a fresh dir so the dirs resolver
			// finds no ~/.veyyon/config.yml, and therefore no default profile whose
			// own dir would win over XDG_CACHE_HOME below. Without this, a developer
			// with a selected profile reads that profile's real gpu_cache.json — the
			// probe then hits a stale cache and never runs (count 0). CI's fresh HOME
			// hid the leak; a dev machine did not.
			HOME: homeRoot,
			USERPROFILE: homeRoot,
			XDG_CACHE_HOME: cacheRoot,
			VEYYON_GPU_PROBE_COUNT: probeCountPath,
			VEYYON_GPU_PROBE_RUNS: String(options.runs),
		};
		// Strip inherited dirs-resolver overrides so XDG_CACHE_HOME above wins and
		// the test cannot touch the developer/CI profile's real gpu_cache.json.
		for (const key of DIR_OVERRIDE_ENV_KEYS) {
			delete env[key];
		}
		// A selected profile is carried by VEYYON_PROFILE too, not just the dir
		// overrides above; drop it so the resolver stays on the isolated base.
		delete env.VEYYON_PROFILE;
		if (options.sleepSeconds === undefined) {
			delete env.VEYYON_GPU_PROBE_SLEEP;
		} else {
			env.VEYYON_GPU_PROBE_SLEEP = String(options.sleepSeconds);
		}
		if (options.holdStdoutOpen) {
			env.VEYYON_GPU_PROBE_HOLD_STDOUT_OPEN = "true";
		} else {
			delete env.VEYYON_GPU_PROBE_HOLD_STDOUT_OPEN;
		}
		if (options.descendantHoldsStdout) {
			env.VEYYON_GPU_PROBE_DESCENDANT_HOLDS_STDOUT = "true";
		} else {
			delete env.VEYYON_GPU_PROBE_DESCENDANT_HOLDS_STDOUT;
		}
		if (options.validOutput !== undefined) {
			env.VEYYON_GPU_PROBE_VALID_OUTPUT = options.validOutput;
		} else {
			delete env.VEYYON_GPU_PROBE_VALID_OUTPUT;
		}

		const childStartedAt = performance.now();
		const child = Bun.spawn([process.execPath, scenarioPath], { stdout: "pipe", stderr: "pipe", env });
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		const childElapsedMs = Math.round(performance.now() - childStartedAt);
		if (exitCode !== 0) {
			throw new Error(`GPU probe scenario failed with exit ${exitCode}: ${stderr}`);
		}
		return { ...JSON.parse(stdout.trim()), childElapsedMs };
	} finally {
		await fs.rm(tempRoot, { recursive: true, force: true });
	}
}

describe.skipIf(process.platform !== "linux")("system prompt GPU probe", () => {
	it("caches empty GPU probe results", async () => {
		const result = await runProbeScenario({ runs: 2 });

		expect(result.cached).toEqual({ gpu: null });
		expect(result.count).toBe(1);
	}, 15_000);

	it("kills the GPU probe at the prep deadline", async () => {
		const result = await runProbeScenario({ runs: 1, sleepSeconds: 12, holdStdoutOpen: true });

		expect(result.cached).toEqual({ gpu: null });
		// Probe is SIGKILLed at ~4.5s and the drain wait is bounded, so in-child
		// time sits near the deadline; waiting on the descendant would push it
		// past the 12s sleep.
		expect(result.elapsedMs).toBeLessThan(6500);
		// Codex#3838: the child process MUST exit shortly after the deadline, not
		// linger until a descendant holding stdout (sleep 12) exits on its own.
		// The bound over in-child time budgets bun spawn/startup on loaded runners
		// while staying far below the descendant's 12s exit.
		expect(result.childElapsedMs).toBeLessThan(9000);
	}, 20_000);

	it("does not wait on stdout held by a descendant after a successful probe", async () => {
		const result = await runProbeScenario({ runs: 1, sleepSeconds: 8, descendantHoldsStdout: true });

		expect(result.cached).toEqual({ gpu: null });
		// Probe exits 0 immediately but leaves a backgrounded sleep holding the stdout
		// pipe. The success path MUST bound the drain wait, not block until sleep exits.
		expect(result.elapsedMs).toBeLessThan(2000);
		// Budgets bun spawn/startup overhead; blocking on the descendant would
		// take at least the 8s sleep.
		expect(result.childElapsedMs).toBeLessThan(5000);
	}, 20_000);

	it("keeps probe output captured before a descendant delays EOF", async () => {
		const result = await runProbeScenario({
			runs: 1,
			sleepSeconds: 8,
			descendantHoldsStdout: true,
			validOutput: "00:02.0 VGA compatible controller: NVIDIA TestGPU",
		});

		// Probe exited 0 with valid output before bg sleep held stdout open.
		// Captured stdout MUST be cached, not discarded as if the probe failed.
		expect(result.cached).toEqual({ gpu: "02.0 VGA compatible controller: NVIDIA TestGPU" });
		expect(result.elapsedMs).toBeLessThan(2000);
		// Budgets bun spawn/startup overhead; blocking on the descendant would
		// take at least the 8s sleep.
		expect(result.childElapsedMs).toBeLessThan(5000);
	}, 20_000);
});

describe.skipIf(process.platform !== "linux")("system prompt CPU model", () => {
	it("does not call os.cpus while building the workstation block", async () => {
		const cpus = spyOn(os, "cpus").mockImplementation(() => [
			{
				model: "Synthetic Slow CPU",
				speed: 0,
				times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
			},
		]);
		try {
			await buildSystemPrompt({
				resolvedCustomPrompt: "Base prompt",
				contextFiles: [],
				skills: [],
				rules: [],
				workspaceTree: {
					rootPath: import.meta.dir,
					rendered: "",
					truncated: false,
					totalLines: 0,
					agentsMdFiles: [],
				},
				activeRepoContext: null,
			});

			expect(cpus).not.toHaveBeenCalled();
		} finally {
			cpus.mockRestore();
		}
	});
});

describe("non-Linux system prompt CPU model", () => {
	it("includes the model returned by os.cpus", async () => {
		const originalPlatform = process.platform;
		Object.defineProperty(process, "platform", { value: "darwin" });
		const cpus = spyOn(os, "cpus").mockImplementation(() => [
			{
				model: "Synthetic Non-Linux CPU",
				speed: 0,
				times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
			},
		]);
		try {
			const systemPrompt = await buildSystemPrompt({
				resolvedCustomPrompt: "Base prompt",
				contextFiles: [],
				skills: [],
				rules: [],
				workspaceTree: {
					rootPath: import.meta.dir,
					rendered: "",
					truncated: false,
					totalLines: 0,
					agentsMdFiles: [],
				},
				activeRepoContext: null,
			});

			expect(cpus).toHaveBeenCalledTimes(1);
			expect(systemPrompt.systemPrompt.join("\n")).toContain("- CPU: Synthetic Non-Linux CPU");
		} finally {
			cpus.mockRestore();
			Object.defineProperty(process, "platform", { value: originalPlatform });
		}
	});
});

describe("system prompt section order", () => {
	const baseOptions = {
		contextFiles: [],
		skills: [],
		rules: [],
		workspaceTree: {
			rootPath: import.meta.dir,
			rendered: "",
			truncated: false,
			totalLines: 0,
			agentsMdFiles: [],
		},
		activeRepoContext: null,
	};

	it("reorders the default template's banner sections via sectionOrder", async () => {
		const result = await buildSystemPrompt({
			...baseOptions,
			sectionOrder: ["delivery-contract", "tool-policy"],
		});
		const prompt = result.systemPrompt[0];
		expect(prompt.indexOf("DELIVERY CONTRACT")).toBeGreaterThan(-1);
		expect(prompt.indexOf("DELIVERY CONTRACT")).toBeLessThan(prompt.indexOf("TOOL POLICY"));
		expect(prompt.indexOf("TOOL POLICY")).toBeLessThan(prompt.indexOf("ROLE"));
		expect(prompt.startsWith("<system-conventions>")).toBe(true);
	});

	it("ignores sectionOrder for custom prompt templates", async () => {
		const result = await buildSystemPrompt({
			...baseOptions,
			resolvedCustomPrompt: "Custom base prompt",
			sectionOrder: ["delivery-contract"],
		});
		expect(result.systemPrompt[0]).toContain("Custom base prompt");
		expect(result.systemPrompt[0]).not.toContain("DELIVERY CONTRACT");
	});
});
