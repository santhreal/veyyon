import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { Process } from "@veyyon/natives";
import { AnsiStripper } from "@veyyon/utils";
import { parseDocument } from "yaml";
import { AUTONOMY_LABEL } from "../packages/coding-agent/src/tools/core/approval-modes";
import { computeDigest, median, recordSettledStartup } from "./record-settled-startup";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CLI_SOURCE = path.join(REPO_ROOT, "packages", "coding-agent", "src", "cli.ts");
const ONBOARDED_CONFIG = "onboardingVersion: 1\nstartup:\n  checkUpdate: false\n  autoUpdate: false\n";

const ARM_GROUPS = ["version", "help", "ready", "frame", "replay"] as const;
const OPTIONAL_ARM_GROUPS = ["settled", "responsive"] as const;
type ArmGroup = (typeof ARM_GROUPS)[number] | (typeof OPTIONAL_ARM_GROUPS)[number];

interface Options {
	runs: number;
	cold: boolean;
	bin?: string;
	json?: string;
	timeoutMs: number;
	only?: Set<ArmGroup>;
	scratch?: string;
	source?: string;
	cwd?: string;
	seed?: string;
	expectedModel?: string;
	observationMs: number;
	stableMs: number;
	columns: number;
	rows: number;
	probeIntervalMs: number;
	probeCount: number;
	memory: boolean;
	memoryIntervalMs: number;
}

interface Sample {
	arm: string;
	ms: number;
}

function parseArgs(argv: string[]): Options {
	const options: Options = {
		runs: 5,
		cold: false,
		timeoutMs: 60_000,
		observationMs: 5000,
		stableMs: 1000,
		columns: 140,
		rows: 45,
		probeIntervalMs: 50,
		probeCount: 40,
		memory: false,
		memoryIntervalMs: 25,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--runs") options.runs = Number(argv[++i]);
		else if (arg === "--cold") options.cold = true;
		else if (arg === "--bin") options.bin = argv[++i];
		else if (arg === "--json") options.json = argv[++i];
		else if (arg === "--timeout") options.timeoutMs = Number(argv[++i]) * 1000;
		else if (arg === "--scratch") options.scratch = argv[++i];
		else if (arg === "--only") options.only = parseArmGroups(argv[++i]);
		else if (arg === "--source") options.source = path.resolve(argv[++i]);
		else if (arg === "--cwd") options.cwd = path.resolve(argv[++i]);
		else if (arg === "--seed") options.seed = path.resolve(argv[++i]);
		else if (arg === "--expect-model") options.expectedModel = argv[++i];
		else if (arg === "--observe-ms") options.observationMs = Number(argv[++i]);
		else if (arg === "--stable-ms") options.stableMs = Number(argv[++i]);
		else if (arg === "--columns") options.columns = Number(argv[++i]);
		else if (arg === "--rows") options.rows = Number(argv[++i]);
		else if (arg === "--probe-interval-ms") options.probeIntervalMs = Number(argv[++i]);
		else if (arg === "--probe-count") options.probeCount = Number(argv[++i]);
		else if (arg === "--memory") options.memory = true;
		else if (arg === "--memory-interval-ms") options.memoryIntervalMs = Number(argv[++i]);
		else throw new Error(`unknown argument: ${arg}`);
	}
	const positiveInts: Record<string, number> = {
		runs: options.runs,
		"observe-ms": options.observationMs,
		"stable-ms": options.stableMs,
		columns: options.columns,
		rows: options.rows,
		"probe-interval-ms": options.probeIntervalMs,
		"probe-count": options.probeCount,
		"memory-interval-ms": options.memoryIntervalMs,
	};
	for (const [name, value] of Object.entries(positiveInts)) {
		if (!Number.isSafeInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`);
	}
	if (options.source && options.bin) throw new Error("--source and --bin are mutually exclusive");
	if (options.stableMs >= options.observationMs) throw new Error("--stable-ms must be smaller than --observe-ms");
	if (OPTIONAL_ARM_GROUPS.some(arm => options.only?.has(arm)) && !options.expectedModel?.trim()) {
		throw new Error("Observed startup arms require --expect-model with the resolved display name");
	}
	if (
		options.only?.has("responsive") &&
		options.probeCount * options.probeIntervalMs + options.stableMs >= options.observationMs
	) {
		throw new Error("Input probes and --stable-ms must fit within --observe-ms");
	}
	return options;
}

function parseArmGroups(raw: string | undefined): Set<ArmGroup> {
	const names = (raw ?? "").split(",").filter(Boolean);
	const known: readonly string[] = [...ARM_GROUPS, ...OPTIONAL_ARM_GROUPS];
	if (names.length === 0) throw new Error(`--only needs at least one of: ${known.join(", ")}`);
	for (const name of names) {
		if (!known.includes(name))
			throw new Error(`--only got unknown arm group ${JSON.stringify(name)}; known: ${known.join(", ")}`);
	}
	return new Set(names as ArmGroup[]);
}

export function ptyWrapper(
	command: string,
	args: string[],
	size?: { columns: number; rows: number },
): { command: string; args: string[] } {
	const quoted = [command, ...args].map(part => `'${part.replaceAll("'", "'\\''")}'`).join(" ");
	const withoutEcho = `stty -echo${size ? ` cols ${size.columns} rows ${size.rows}` : ""}; exec ${quoted}`;
	return os.platform() === "darwin"
		? { command: "script", args: ["-q", "/dev/null", "/bin/sh", "-c", withoutEcho] }
		: { command: "script", args: ["-qec", withoutEcho, "/dev/null"] };
}

export interface RunOutcome {
	ms: number;
	stdout: string;
}

const PROBE = "qjq";
const FRAME_HOLD_MS = 4000;

export const STATUS_ROW = new RegExp(
	`·\\s+(?:${Object.values(AUTONOMY_LABEL)
		.map(label => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join("|")})\\s+·`,
);

export interface FrameMarks {
	firstByte?: number;
	composer?: number;
	editable?: number;
	statusrow?: number;
}

async function killProcessTree(pid: number | undefined, target: Process | null): Promise<void> {
	const ref = target ?? (pid === undefined ? null : Process.fromPid(pid));
	if (ref) {
		if (!(await ref.terminate({ gracefulMs: 500, timeoutMs: 2000 }))) {
			throw new Error(`Startup process tree ${ref.pid} did not terminate`);
		}
	} else if (pid !== undefined) {
		process.kill(pid, "SIGKILL");
	}
}

export async function recordFrame(
	command: string,
	args: string[],
	env: Record<string, string>,
	holdMs: number,
	probe = true,
	cwd = REPO_ROOT,
): Promise<FrameMarks> {
	const marks: FrameMarks = {};
	const started = performance.now();
	const processState: { target: Process | null } = { target: null };
	const child = spawn(command, args, {
		cwd,
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, ...env },
	});
	child.once("spawn", () => {
		processState.target = child.pid === undefined ? null : Process.fromPid(child.pid);
	});

	const stdoutStripper = new AnsiStripper();
	const stderrStripper = new AnsiStripper();
	let stdoutSeen = "";
	let stderrSeen = "";
	const at = (): number => performance.now() - started;

	const handleChunk = (chunk: string, isStderr: boolean): void => {
		if (isStderr) stderrSeen += stderrStripper.push(chunk);
		else stdoutSeen += stdoutStripper.push(chunk);
		const visible = stdoutSeen + stdoutStripper.pending + stderrSeen + stderrStripper.pending;
		if (marks.firstByte === undefined) {
			marks.firstByte = at();
			if (probe) child.stdin.write(PROBE);
		}
		if (marks.composer === undefined && visible.includes("ask anything")) marks.composer = at();
		if (marks.editable === undefined && visible.includes(PROBE)) marks.editable = at();
		if (marks.statusrow === undefined && STATUS_ROW.test(visible)) marks.statusrow = at();
	};

	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => handleChunk(chunk, false));
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => handleChunk(chunk, true));

	const held = Promise.withResolvers<void>();
	const timer = setTimeout(held.resolve, holdMs);
	child.once("error", held.reject);

	let failure: { error: unknown } | undefined;
	try {
		await held.promise;
	} catch (error) {
		failure = { error };
	} finally {
		clearTimeout(timer);
	}
	try {
		await killProcessTree(child.pid, processState.target);
	} catch (error) {
		if (failure)
			throw new AggregateError([failure.error, error], "Startup recording and process cleanup both failed");
		throw error;
	}
	if (failure) throw failure.error;
	return marks;
}

export async function timeRun(
	command: string,
	args: string[],
	env: Record<string, string>,
	until: "first-byte" | "exit",
	timeoutMs: number,
	cwd = REPO_ROOT,
): Promise<RunOutcome> {
	const { promise, resolve, reject } = Promise.withResolvers<RunOutcome>();
	const started = performance.now();
	let ms: number | undefined;
	let stdout = "";
	let settled = false;
	const processState: { target: Process | null } = { target: null };

	const child = spawn(command, args, {
		cwd,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, ...env },
	});
	child.once("spawn", () => {
		processState.target = child.pid === undefined ? null : Process.fromPid(child.pid);
	});

	const cleanup = () => killProcessTree(child.pid, processState.target);

	const finish = async (): Promise<void> => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		try {
			if (ms === undefined) {
				await cleanup();
				reject(new Error(`no output before exit: ${stdout.slice(-300)}`));
			} else {
				if (until === "first-byte") await cleanup();
				resolve({ ms, stdout });
			}
		} catch (error) {
			reject(error);
		}
	};

	const timer = setTimeout(async () => {
		if (!settled) {
			settled = true;
			try {
				await cleanup();
				reject(new Error(`timed out after ${timeoutMs}ms`));
			} catch (error) {
				reject(error);
			}
		}
	}, timeoutMs);

	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdout += chunk;
		if (until !== "first-byte" || ms !== undefined) return;
		ms = performance.now() - started;
		void finish();
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.on("error", async err => {
		clearTimeout(timer);
		if (!settled) {
			settled = true;
			try {
				await cleanup();
			} catch {}
			reject(err);
		}
	});
	child.on("close", () => {
		if (until === "exit") ms = performance.now() - started;
		void finish();
	});

	return promise;
}

async function seedHome(root: string, installedNatives: string | undefined): Promise<string> {
	const home = path.join(root, "home");
	await fs.mkdir(path.join(home, ".veyyon"), { recursive: true });
	await fs.writeFile(path.join(home, ".veyyon", "config.yml"), ONBOARDED_CONFIG);
	if (installedNatives) await hardlinkTree(installedNatives, path.join(home, ".veyyon", "natives"));
	return home;
}

export async function disableBenchmarkUpdates(configPath: string): Promise<void> {
	let source = "";
	try {
		source = await fs.readFile(configPath, "utf8");
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
	}
	const config = parseDocument(source);
	if (config.errors.length) throw new Error(`Invalid benchmark config ${configPath}: ${config.errors[0].message}`);
	config.setIn(["startup", "checkUpdate"], false);
	config.setIn(["startup", "autoUpdate"], false);
	await fs.mkdir(path.dirname(configPath), { recursive: true });
	await fs.writeFile(configPath, config.toString());
}

async function hardlinkTree(from: string, to: string): Promise<void> {
	await fs.mkdir(to, { recursive: true });
	for (const entry of await fs.readdir(from, { withFileTypes: true })) {
		const src = path.join(from, entry.name);
		const dst = path.join(to, entry.name);
		if (entry.isDirectory()) {
			await hardlinkTree(src, dst);
			continue;
		}
		await fs.link(src, dst).catch((err: NodeJS.ErrnoException) => {
			if (err.code !== "EEXIST") throw err;
		});
	}
}

const execFileAsync = promisify(execFile);

export async function extractInstalledNatives(
	root: string,
	command: string,
	prefix: string[],
	cwd = REPO_ROOT,
): Promise<string | undefined> {
	const installed = path.join(root, "installed");
	const probe = path.join(installed, "probe");
	await fs.mkdir(probe, { recursive: true });
	await fs.writeFile(path.join(probe, "probe.txt"), "veyyon-native-self-test\n");
	try {
		await execFileAsync(command, [...prefix, "grep", "veyyon-native-self-test", probe], {
			cwd,
			env: { ...process.env, HOME: installed, VEYYON_PROFILE: "" },
		});
	} catch (err) {
		process.stderr.write(`seed: native addon probe failed, the launch arms will extract instead: ${String(err)}\n`);
	}
	const natives = path.join(installed, ".veyyon", "natives");
	return (await fs.stat(natives).catch(() => undefined))?.isDirectory() === true ? natives : undefined;
}

function report(arm: string, samples: number[]): string {
	if (samples.length === 0) return `${arm}: no samples`;
	const unit = arm.endsWith("-kb") ? "kB" : "ms";
	return (
		`${arm.padEnd(arm.endsWith("-kb") ? 32 : 12)} median ${median(samples).toFixed(0)}${unit} ` +
		`(min ${Math.min(...samples).toFixed(0)}, max ${Math.max(...samples).toFixed(0)}, n=${samples.length})`
	);
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	const launch = options.bin
		? { command: options.bin, prefix: [] }
		: { command: process.execPath, prefix: [options.source ?? CLI_SOURCE] };
	const { prefix } = launch;
	const scratch = path.resolve(options.scratch ?? path.join(REPO_ROOT, ".captures", "bench-startup"));
	await fs.rm(scratch, { recursive: true, force: true });
	await fs.mkdir(scratch, { recursive: true });
	const command = options.bin ? path.join(scratch, path.basename(options.bin)) : launch.command;
	if (options.bin) await fs.copyFile(path.resolve(options.bin), command);
	const binarySha256 = options.bin ? await computeDigest(command) : undefined;

	const samples: Sample[] = [];
	const push = (arm: string, ms: number): void => {
		samples.push({ arm, ms });
	};
	const recording = path.join(scratch, "first-frame.json");
	const cwd = options.cwd ?? REPO_ROOT;
	const installedNatives = await extractInstalledNatives(scratch, command, prefix, cwd);

	async function envFor(): Promise<Record<string, string>> {
		if (options.cold) await fs.rm(path.join(scratch, "home"), { recursive: true, force: true });
		if (options.seed) {
			const config = path.join(scratch, "config");
			const shouldSeed =
				options.cold ||
				!(await fs.stat(config).then(
					() => true,
					() => false,
				));
			if (shouldSeed) {
				if (options.cold) await fs.rm(config, { recursive: true, force: true });
				await fs.cp(options.seed, config, { recursive: true, force: false });
				await disableBenchmarkUpdates(path.join(config, "config.yml"));
				await disableBenchmarkUpdates(path.join(config, "profiles", "default", "agent", "config.yml"));
				if (installedNatives) await hardlinkTree(installedNatives, path.join(config, "natives"));
			}
		}
		const home = await seedHome(scratch, installedNatives);
		return {
			...(options.seed ? { VEYYON_CONFIG_DIR: path.join(scratch, "config") } : {}),
			HOME: home,
			TERM: "xterm-256color",
			VEYYON_PROFILE: "",
			VEYYON_FIRST_FRAME_CACHE: recording,
		};
	}

	const wants = (group: ArmGroup): boolean => options.only === undefined || options.only.has(group);

	for (let run = 0; run < options.runs; run++) {
		if (wants("version")) {
			const env = await envFor();
			push("version", (await timeRun(command, [...prefix, "--version"], env, "exit", options.timeoutMs, cwd)).ms);
		}
		if (wants("help")) {
			const env = await envFor();
			push("help", (await timeRun(command, [...prefix, "--help"], env, "exit", options.timeoutMs, cwd)).ms);
		}
		if (wants("ready")) {
			const env = await envFor();
			const readyPty = ptyWrapper(command, prefix);
			const ready = await timeRun(
				readyPty.command,
				readyPty.args,
				{ ...env, VEYYON_TIMING: "x" },
				"exit",
				options.timeoutMs,
				cwd,
			);
			push("ready", ready.ms);
			const totalMatch = /Total:\s+([0-9.]+)ms/.exec(ready.stdout);
			if (totalMatch) push("ready:boot", Number(totalMatch[1]));
			const beforeMatch = /\(before instrumentation\):\s+([0-9.]+)ms/.exec(ready.stdout);
			if (beforeMatch) push("ready:load", Number(beforeMatch[1]));
		}
		if (wants("frame")) {
			const env = await envFor();
			const framePty = ptyWrapper(command, prefix);
			await fs.rm(recording, { force: true });
			const marks = await recordFrame(framePty.command, framePty.args, env, FRAME_HOLD_MS, true, cwd);
			if (marks.firstByte !== undefined) push("first-frame", marks.firstByte);
			if (marks.composer !== undefined) push("composer", marks.composer);
			if (marks.editable !== undefined) push("editable", marks.editable);
			if (marks.statusrow !== undefined) push("statusrow", marks.statusrow);
		}
		if (wants("replay")) {
			const env = await envFor();
			const framePty = ptyWrapper(command, prefix);
			await fs.rm(recording, { force: true });
			await recordFrame(framePty.command, framePty.args, env, FRAME_HOLD_MS, false, cwd);
			const replayed = await recordFrame(framePty.command, framePty.args, env, FRAME_HOLD_MS, true, cwd);
			if (replayed.firstByte !== undefined) push("replay", replayed.firstByte);
			if (replayed.composer !== undefined) push("replay:composer", replayed.composer);
			if (replayed.editable !== undefined) push("replay:editable", replayed.editable);
			if (replayed.statusrow !== undefined) push("replay:statusrow", replayed.statusrow);
		}

		for (const observedArm of OPTIONAL_ARM_GROUPS) {
			if (!options.only?.has(observedArm)) continue;
			const seeded = await envFor();
			const environment: Record<string, string> = {
				PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
				LANG: "C.UTF-8",
				...seeded,
				XDG_CONFIG_HOME: path.join(seeded.HOME, ".config"),
				XDG_CACHE_HOME: path.join(seeded.HOME, ".cache"),
				COLORTERM: "truecolor",
			};
			const pty = ptyWrapper(command, [...prefix, "--no-session"], options);
			await fs.rm(recording, { force: true });
			const marks = await recordSettledStartup({
				...pty,
				cwd: options.cwd ?? REPO_ROOT,
				env: environment,
				columns: options.columns,
				rows: options.rows,
				expectedModel: options.expectedModel!,
				observationMs: options.observationMs,
				stableMs: options.stableMs,
				trace: path.join(scratch, `${observedArm}-${run + 1}.json`),
				input:
					observedArm === "responsive"
						? { intervalMs: options.probeIntervalMs, count: options.probeCount }
						: undefined,
				memory: options.memory
					? { enabled: true, intervalMs: options.memoryIntervalMs, targetExecutable: command, targetArgs: prefix }
					: undefined,
			});
			if (observedArm === "settled") {
				push("settled:first-byte", marks.firstByte);
				push("settled:editable", marks.editable);
				push("settled:editable-frame", marks.settledEditable);
				push("settled:stable-tail", marks.stableForMs);
			} else {
				if (!marks.inputProbes?.length) throw new Error("Responsive startup produced no input measurements");
				let worst = 0;
				for (const probe of marks.inputProbes) {
					if (probe.renderedAt === null) throw new Error("An input probe was not rendered");
					const latency = probe.renderedAt - probe.sentAt;
					push("responsive:input", latency);
					push(
						probe.metadataReady ? "responsive:input-after-metadata" : "responsive:input-before-metadata",
						latency,
					);
					worst = Math.max(worst, latency);
				}
				push("responsive:worst-input", worst);
			}
			if (marks.memory) {
				push(`${observedArm}:main-peak-rss-kb`, Math.round(marks.memory.mainPeakRssBytes / 1024));
				push(`${observedArm}:main-steady-rss-kb`, Math.round(marks.memory.mainSteadyRssBytes / 1024));
				push(`${observedArm}:tree-peak-rss-kb`, Math.round(marks.memory.treePeakRssBytes / 1024));
				push(`${observedArm}:tree-steady-rss-kb`, Math.round(marks.memory.treeSteadyRssBytes / 1024));
			}
		}
	}
	if (binarySha256 !== undefined && (await computeDigest(command)) !== binarySha256) {
		throw new Error("Benchmark executable changed during measurement; discard these samples and rebuild the target");
	}

	const memoryArms = options.memory
		? [
				"settled:main-peak-rss-kb",
				"settled:main-steady-rss-kb",
				"settled:tree-peak-rss-kb",
				"settled:tree-steady-rss-kb",
				"responsive:main-peak-rss-kb",
				"responsive:main-steady-rss-kb",
				"responsive:tree-peak-rss-kb",
				"responsive:tree-steady-rss-kb",
			]
		: [];
	const arms = [
		"version",
		"help",
		"ready:load",
		"ready:boot",
		"ready",
		"first-frame",
		"composer",
		"editable",
		"statusrow",
		"replay",
		"replay:composer",
		"replay:editable",
		"replay:statusrow",
		"settled:first-byte",
		"settled:editable",
		"settled:editable-frame",
		"settled:stable-tail",
		"responsive:input",
		"responsive:input-before-metadata",
		"responsive:input-after-metadata",
		"responsive:worst-input",
		...memoryArms,
	];
	const lines = [
		`veyyon startup — ${options.bin ? `binary ${options.bin}` : "bun source"}, ${options.cold ? "cold" : "warm"} home, ${options.runs} run(s)`,
		...arms.map(arm =>
			report(
				arm,
				samples.filter(sample => sample.arm === arm).map(sample => sample.ms),
			),
		),
	];
	process.stdout.write(`${lines.join("\n")}\n`);

	if (options.json) {
		await fs.writeFile(
			options.json,
			`${JSON.stringify(
				{
					target: options.bin ?? "bun source",
					binarySha256,
					home: options.cold ? "cold" : "warm",
					runs: options.runs,
					platform: `${os.platform()}-${os.arch()}`,
					source: options.bin ? undefined : (options.source ?? CLI_SOURCE),
					cwd: options.cwd ?? REPO_ROOT,
					seed: options.seed,
					settlement: OPTIONAL_ARM_GROUPS.some(arm => options.only?.has(arm))
						? {
								expectedModel: options.expectedModel,
								columns: options.columns,
								rows: options.rows,
								observationMs: options.observationMs,
								minimumStableMs: options.stableMs,
							}
						: undefined,
					input: options.only?.has("responsive")
						? { intervalMs: options.probeIntervalMs, count: options.probeCount }
						: undefined,
					memory: options.memory ? { sampleIntervalMs: options.memoryIntervalMs } : undefined,
					samples,
				},
				null,
				2,
			)}\n`,
		);
	}
}

if (import.meta.main) {
	await main();
}
