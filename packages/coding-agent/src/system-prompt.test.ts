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
	/** Everything the child logged, so a warning can be asserted by its bytes. */
	log: string;
}

async function runProbeScenario(options: {
	runs: number;
	sleepSeconds?: number;
	holdStdoutOpen?: boolean;
	descendantHoldsStdout?: boolean;
	validOutput?: string;
	/** Exact bytes to plant at the cache path before the run (CACHE-1). */
	seedCache?: string;
	/** Make the cache directory read-only before the run, so the save must fail. */
	readOnlyCacheDir?: boolean;
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
			`import { getGpuCachePath, logger, refreshDirsFromEnv } from ${JSON.stringify(path.resolve(import.meta.dir, "../../utils/src/index.ts"))};
import { mkdirSync, chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildSystemPrompt } from ${JSON.stringify(path.join(import.meta.dir, "system-prompt.ts"))};

refreshDirsFromEnv();
// Warnings go to the rotating log file, not the console, so point that file at a
// path the parent can read: the test asserts the warning's bytes, not its absence.
logger.setTransports({ file: process.env.VEYYON_GPU_LOG_DIR, console: false });
// Plant the damaged/absent cache and its directory permissions BEFORE the build,
// because both are read on the first probe.
const seededPath = getGpuCachePath();
mkdirSync(dirname(seededPath), { recursive: true });
if (process.env.VEYYON_GPU_SEED_CACHE !== undefined) {
	writeFileSync(seededPath, process.env.VEYYON_GPU_SEED_CACHE);
}
if (process.env.VEYYON_GPU_READONLY_CACHE_DIR === "true") {
	chmodSync(dirname(seededPath), 0o500);
}
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
// A damaged entry may still be damaged if repair failed, so read it as TEXT and
// let the parent decide: parsing here would turn "not repaired" into a crash.
const cachedText = await cacheFile.exists() ? await cacheFile.text() : null;
let cached: unknown = null;
try { cached = cachedText === null ? null : JSON.parse(cachedText); } catch { cached = { unparseable: cachedText }; }
const countFile = Bun.file(process.env.VEYYON_GPU_PROBE_COUNT ?? "");
const count = await countFile.exists() ? (await countFile.text()).length : 0;
const elapsedMs = Math.round(performance.now() - startedAt);
// Restore permissions so the parent's rm() can clean up a read-only dir.
if (process.env.VEYYON_GPU_READONLY_CACHE_DIR === "true") chmodSync(dirname(seededPath), 0o700);
// The file transport is a daily-rotate DIRECTORY, and its writes are buffered,
// so give it a moment and then read whatever it produced. Reading one guessed
// filename would silently return "" and turn every log assertion into a pass.
await Bun.sleep(250);
const logDir = process.env.VEYYON_GPU_LOG_DIR ?? "";
let log = "";
// The transport creates the directory lazily, so a run that logged nothing
// leaves no directory at all; that is an empty log, not a failure.
if (existsSync(logDir)) for (const name of readdirSync(logDir)) log += readFileSync(join(logDir, name), "utf8");
console.log(JSON.stringify({ elapsedMs, cached, count, log }));
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
			VEYYON_GPU_LOG_DIR: path.join(tempRoot, "logs"),
		};
		if (options.seedCache === undefined) delete env.VEYYON_GPU_SEED_CACHE;
		else env.VEYYON_GPU_SEED_CACHE = options.seedCache;
		if (options.readOnlyCacheDir) env.VEYYON_GPU_READONLY_CACHE_DIR = "true";
		else delete env.VEYYON_GPU_READONLY_CACHE_DIR;
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
		// selectGpuFromLspci strips the "<slot> <class>: " prefix (GPU-1), so the
		// cached value is the clean device name, not the raw lspci line.
		expect(result.cached).toEqual({ gpu: "NVIDIA TestGPU" });
		expect(result.elapsedMs).toBeLessThan(2000);
		// Budgets bun spawn/startup overhead; blocking on the descendant would
		// take at least the 8s sleep.
		expect(result.childElapsedMs).toBeLessThan(5000);
	}, 20_000);
});

/**
 * CACHE-1: a damaged GPU cache entry must be ignored, regenerated, and REPORTED.
 *
 * `gpu_cache.json` is written on the way out of a launch, so a machine that
 * loses power or is force-quit mid-write leaves a truncated file behind. Two
 * outcomes are unacceptable and one is required:
 *
 *  - crashing on it would make an unrelated disposable file able to stop the
 *    system prompt from being built at all;
 *  - trusting it would put whatever survived the truncation into the prompt;
 *  - so it must be discarded, re-probed, and the file rewritten — and the
 *    discard must be recorded, because a file that fails to parse every launch
 *    means the probe runs every launch, and that presents only as a slower
 *    start that nobody attributes to a cache (Law 10).
 *
 * The one silence kept on purpose is a MISSING file, which is every first run.
 * These run the real child process against an isolated cache root, so what is
 * asserted is the shipped read-probe-write path, not a re-implementation of it.
 */
describe.skipIf(process.platform !== "linux")("system prompt GPU cache damage", () => {
	/** The probe is stubbed to report nothing, so a repaired entry is exactly this. */
	const REPAIRED = { gpu: null };

	it("re-probes and repairs a truncated entry rather than trusting it", async () => {
		// The canonical crash artifact: a write cut off mid-object. The old code
		// caught this and returned null, which was right; what it did not do was say
		// so, and this test pins both halves at once.
		const result = await runProbeScenario({ runs: 1, seedCache: '{"gpu": "NVIDIA Half-Writt' });

		expect(result.cached).toEqual(REPAIRED);
		expect(result.count).toBe(1);
	}, 15_000);

	it("records the unreadable entry with its path", async () => {
		// The Law 10 half. Without this assertion the whole suite passes with a bare
		// `catch { return null }`, which is the code this row exists to remove.
		const result = await runProbeScenario({ runs: 1, seedCache: "not json at all" });

		expect(result.log).toContain("GPU cache could not be read");
		expect(result.log).toContain("gpu_cache.json");
	}, 15_000);

	it("treats a well-formed file with no `gpu` field as damaged, and says which kind", async () => {
		// Parses cleanly, carries nothing usable. It has to be distinguishable in the
		// log from a parse failure, because the two have different causes: this one
		// is a schema change or a hand edit, not a torn write.
		const result = await runProbeScenario({ runs: 1, seedCache: '{"model": "NVIDIA Something"}' });

		expect(result.cached).toEqual(REPAIRED);
		expect(result.count).toBe(1);
		expect(result.log).toContain("has no `gpu` field");
	}, 15_000);

	it("treats a JSON array as damaged instead of reading fields off it", async () => {
		// `typeof [] === "object"`, so a bare `typeof content === "object"` check
		// would accept this. The guard must be the `gpu` field, not the type.
		const result = await runProbeScenario({ runs: 1, seedCache: "[1, 2, 3]" });

		expect(result.cached).toEqual(REPAIRED);
		expect(result.count).toBe(1);
	}, 15_000);

	it("treats a non-string `gpu` as damage and rewrites the file", async () => {
		// The serve-corrupt-data case, and the one that exposed a half-fix: the old
		// code normalized this to `{ gpu: null }` and RETURNED it, which kept the
		// number out of the prompt but also counted as a hit, so the bad file was
		// never re-probed and never rewritten. It survived every launch.
		const result = await runProbeScenario({ runs: 1, seedCache: '{"gpu": 42}' });

		expect(result.cached).toEqual(REPAIRED);
		expect(result.count).toBe(1);
		expect(result.log).toContain("non-string `gpu`");
	}, 15_000);

	it("a cached `null` is a real answer, not damage", async () => {
		// The boundary on the rule above. "Probed, found no GPU" is exactly what the
		// cache stores on a machine without one; treating it as damage would re-probe
		// on every launch for every such machine, which is the cost this cache exists
		// to avoid.
		const result = await runProbeScenario({ runs: 1, seedCache: '{"gpu": null}' });

		expect(result.cached).toEqual(REPAIRED);
		expect(result.count).toBe(0);
		expect(result.log).not.toContain("GPU cache");
	}, 15_000);

	it("an empty file is damaged, not an empty cache", async () => {
		// The zero-byte outcome of a crash between create and write. It is the case
		// most easily mistaken for "no GPU found", which would suppress the probe.
		const result = await runProbeScenario({ runs: 1, seedCache: "" });

		expect(result.cached).toEqual(REPAIRED);
		expect(result.count).toBe(1);
	}, 15_000);

	it("stays quiet when the file is simply absent", async () => {
		// The deliberate silence. Every first run takes this path, and a warning
		// everyone sees once is a warning nobody reads the second time.
		const result = await runProbeScenario({ runs: 1 });

		expect(result.cached).toEqual(REPAIRED);
		expect(result.log).not.toContain("GPU cache could not be read");
		expect(result.log).not.toContain("has no `gpu` field");
	}, 15_000);

	it("reports a cache it cannot write, and still builds the prompt", async () => {
		// The write side of the same rule. A read-only cache directory costs a probe
		// per launch forever; unreported, that is invisible. The run must still
		// succeed, because a cache failure may not take the prompt down.
		const result = await runProbeScenario({ runs: 1, readOnlyCacheDir: true });

		expect(result.count).toBe(1);
		expect(result.log).toContain("GPU cache could not be written");
	}, 15_000);

	it("does not warn when the cache is healthy", async () => {
		// The control. Every assertion above is satisfied by code that warns
		// unconditionally, which would be its own defect.
		const result = await runProbeScenario({ runs: 2, seedCache: '{"gpu": "NVIDIA TestGPU"}' });

		expect(result.cached).toEqual({ gpu: "NVIDIA TestGPU" });
		// A valid entry is a hit: the probe must not run at all.
		expect(result.count).toBe(0);
		expect(result.log).not.toContain("GPU cache could not be");
	}, 15_000);
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
