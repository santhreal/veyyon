import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Process, ProcessStatus } from "@veyyon/natives";
import { type SettledStartupFrame, StartupFrameObserver, type StartupInputProbe } from "./startup-frame-observer";

export interface ProcessMemorySample {
	pid: number;
	ppid: number | null;
	name?: string;
	exe?: string;
	args?: string[];
	rssBytes: number;
	vmHwmBytes?: number;
	rssAnonBytes?: number;
	rssFileBytes?: number;
	rssShmemBytes?: number;
	vmSizeBytes?: number;
	vmPeakBytes?: number;
}

export interface MemorySample {
	timestampMs: number;
	mainProcess: ProcessMemorySample;
	descendants: ProcessMemorySample[];
	mainRssBytes: number;
	treeRssBytes: number;
}

export interface MemoryObservation {
	sampleIntervalMs: number;
	targetExecutable: string;
	targetExeSha256?: string;
	targetPid: number;
	samplesCount: number;
	mainPeakRssBytes: number;
	treePeakRssBytes: number;
	mainSteadyRssBytes: number;
	treeSteadyRssBytes: number;
	mainVmHwmBytes?: number;
	samples: MemorySample[];
}

export interface SettledStartupMemoryOptions {
	enabled?: boolean;
	intervalMs?: number;
	targetExecutable?: string;
	targetArgs?: string[];
}

export interface SettledStartupOptions {
	command: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
	columns: number;
	rows: number;
	expectedModel: string;
	observationMs: number;
	stableMs: number;
	trace: string;
	input?: { intervalMs: number; count: number };
	memory?: SettledStartupMemoryOptions;
}

export interface RecordedStartup extends SettledStartupFrame {
	inputProbes?: readonly StartupInputProbe[];
	memory?: MemoryObservation;
}

interface ProcStatus {
	name?: string;
	vmRssBytes?: number;
	vmHwmBytes?: number;
	rssAnonBytes?: number;
	rssFileBytes?: number;
	rssShmemBytes?: number;
	vmSizeBytes?: number;
	vmPeakBytes?: number;
}

const STAT_FIELDS: Record<string, keyof ProcStatus> = {
	VmRSS: "vmRssBytes",
	VmHWM: "vmHwmBytes",
	RssAnon: "rssAnonBytes",
	RssFile: "rssFileBytes",
	RssShmem: "rssShmemBytes",
	VmSize: "vmSizeBytes",
	VmPeak: "vmPeakBytes",
};

async function readProcStatus(pid: number): Promise<ProcStatus | null> {
	try {
		const content = await fs.readFile(`/proc/${pid}/status`, "utf8");
		const res: ProcStatus = {};
		for (const line of content.split("\n")) {
			if (line.startsWith("Name:")) {
				res.name = line.slice(5).trim();
				continue;
			}
			const colon = line.indexOf(":");
			if (colon === -1) continue;
			const key = STAT_FIELDS[line.slice(0, colon)];
			if (key) {
				const match = /\s+(\d+)\s+kB/.exec(line.slice(colon + 1));
				if (match) (res[key] as number) = Number(match[1]) * 1024;
			}
		}
		return res;
	} catch {
		return null;
	}
}

function matchesOrderedArgs(actualArgs: string[], expectedArgs: string[]): boolean {
	if (expectedArgs.length === 0) return true;
	if (actualArgs.length < expectedArgs.length) return false;
	for (let i = 0; i <= actualArgs.length - expectedArgs.length; i++) {
		if (expectedArgs.every((exp, j) => actualArgs[i + j] === exp || actualArgs[i + j] === path.resolve(exp))) {
			return true;
		}
	}
	return false;
}

const WRAPPER_SUFFIXES = ["/script", "/sh", "/bash", "/dash", "/stty"];

async function findCliProcess(
	root: Process,
	expectedExe?: string,
	expectedArgs?: string[],
): Promise<{ process: Process; exePath: string } | null> {
	const queue = [root];
	const visited = new Set<number>();
	const expectedResolved = expectedExe ? await fs.realpath(expectedExe).catch(() => expectedExe) : undefined;

	while (queue.length > 0) {
		const current = queue.shift()!;
		if (visited.has(current.pid)) continue;
		visited.add(current.pid);

		let exePath = "";
		let resolvedExe = "";
		try {
			exePath = await fs.realpath(`/proc/${current.pid}/exe`);
			resolvedExe = exePath;
		} catch {
			try {
				exePath = await fs.readlink(`/proc/${current.pid}/exe`);
				resolvedExe = await fs.realpath(exePath).catch(() => exePath);
			} catch {}
		}

		if (exePath) {
			const isWrapper = WRAPPER_SUFFIXES.some(s => exePath.endsWith(s) || resolvedExe.endsWith(s));
			const argsMatch = expectedArgs ? matchesOrderedArgs(current.args(), expectedArgs) : true;
			const pathMatched =
				resolvedExe === expectedResolved ||
				exePath === expectedResolved ||
				exePath === expectedExe ||
				resolvedExe === expectedExe;

			if (expectedExe) {
				if (pathMatched && argsMatch) return { process: current, exePath: resolvedExe || exePath };
			} else if (expectedArgs && expectedArgs.length > 0) {
				if (argsMatch && !isWrapper) return { process: current, exePath: resolvedExe || exePath };
			} else if (!isWrapper) {
				return { process: current, exePath: resolvedExe || exePath };
			}
		}

		try {
			for (const childProc of current.children()) queue.push(childProc);
		} catch {}
	}
	return null;
}

function collectDescendants(parent: Process): Process[] {
	const descendants: Process[] = [];
	const queue = [parent];
	const visited = new Set<number>([parent.pid]);
	while (queue.length > 0) {
		const curr = queue.shift()!;
		try {
			for (const child of curr.children()) {
				if (!visited.has(child.pid)) {
					visited.add(child.pid);
					descendants.push(child);
					queue.push(child);
				}
			}
		} catch {}
	}
	return descendants;
}

export async function computeDigest(filePath: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(filePath)) hash.update(chunk);
	return hash.digest("hex");
}

export function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** The command must disable PTY line-discipline echo before launching the CLI. */
export async function recordSettledStartup(options: SettledStartupOptions): Promise<RecordedStartup> {
	const observer = new StartupFrameObserver(options.columns, options.rows, options.expectedModel, "qjq");
	const completed = Promise.withResolvers<SettledStartupFrame>();
	const processState: { target: Process | null; sampling?: Promise<void> } = { target: null };
	let observing = true;
	let probed = false;
	let inputTimer: NodeJS.Timeout | undefined;
	let memoryTimer: NodeJS.Timeout | undefined;
	let stderr = "";
	const memorySamples: MemorySample[] = [];
	let targetCliProcess: Process | null = null;
	let targetCliResolvedExe: string | null = null;
	let targetCliSha256: string | null = null;
	let digestPromise: Promise<string | null> | undefined;
	let memoryObservation: MemoryObservation | undefined;
	let samplingError: Error | null = null;
	const sampleIntervalMs = options.memory?.intervalMs ?? 25;
	const started = performance.now();
	const child = spawn(options.command, options.args, {
		cwd: options.cwd,
		env: options.env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	child.once("spawn", () => {
		processState.target = child.pid === undefined ? null : Process.fromPid(child.pid);
		if (!processState.target) completed.reject(new Error("Cannot retain a stable reference to the startup process"));
	});
	child.once("error", error => completed.reject(error));
	child.stdin.on("error", error => {
		if (observing) completed.reject(error);
	});
	child.once("exit", (code, signal) => {
		if (observing)
			completed.reject(new Error(`Startup exited before observation completed (${code ?? signal}): ${stderr}`));
	});
	observer.terminal.onData(data => {
		if (observing) child.stdin.write(data);
	});
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		if (!observing) return;
		void observer.write(chunk, performance.now() - started).catch(completed.reject);
		if (!probed) {
			probed = true;
			if (options.input) observer.noteInput("qjq", performance.now() - started);
			child.stdin.write("qjX\x7fq");
			if (options.input) {
				const { intervalMs, count } = options.input;
				let sent = 0;
				let draft = "qjq";
				inputTimer = setInterval(() => {
					if (!observing) return;
					draft += "x";
					observer.noteInput(draft, performance.now() - started);
					child.stdin.write("xY\x7f");
					if (++sent === count) clearInterval(inputTimer);
				}, intervalMs);
			}
		}
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stderr = (stderr + chunk).slice(-4096);
	});

	if (options.memory?.enabled) {
		let sampling = false;
		const sampleTick = async (): Promise<void> => {
			if (!observing || sampling) return;
			sampling = true;
			const task = (async (): Promise<void> => {
				try {
					if (!targetCliProcess || targetCliProcess.status() === ProcessStatus.Exited) {
						const root = processState.target ?? (child.pid !== undefined ? Process.fromPid(child.pid) : null);
						if (root) {
							const found = await findCliProcess(
								root,
								options.memory?.targetExecutable,
								options.memory?.targetArgs,
							);
							if (found) {
								targetCliProcess = found.process;
								targetCliResolvedExe = found.exePath;
								digestPromise ??= computeDigest(found.exePath).catch(() => null);
							}
						}
					}
					if (!targetCliProcess) return;

					const atMs = performance.now() - started;
					const mainStatus = await readProcStatus(targetCliProcess.pid);
					if (!mainStatus || mainStatus.vmRssBytes === undefined) return;

					const descendants = collectDescendants(targetCliProcess);
					const descendantSamples: ProcessMemorySample[] = [];
					let descendantsRssSum = 0;

					for (const descendant of descendants) {
						const dStatus = await readProcStatus(descendant.pid);
						if (!dStatus || dStatus.vmRssBytes === undefined) continue;
						descendantsRssSum += dStatus.vmRssBytes;
						let dExe: string | undefined;
						try {
							dExe = await fs.realpath(`/proc/${descendant.pid}/exe`);
						} catch {}
						descendantSamples.push({
							pid: descendant.pid,
							ppid: descendant.ppid,
							name: dStatus.name,
							exe: dExe,
							args: descendant.args(),
							rssBytes: dStatus.vmRssBytes,
							vmHwmBytes: dStatus.vmHwmBytes,
							rssAnonBytes: dStatus.rssAnonBytes,
							rssFileBytes: dStatus.rssFileBytes,
							rssShmemBytes: dStatus.rssShmemBytes,
							vmSizeBytes: dStatus.vmSizeBytes,
							vmPeakBytes: dStatus.vmPeakBytes,
						});
					}

					const mainRssBytes = mainStatus.vmRssBytes;
					memorySamples.push({
						timestampMs: atMs,
						mainProcess: {
							pid: targetCliProcess.pid,
							ppid: targetCliProcess.ppid,
							name: mainStatus.name,
							exe: targetCliResolvedExe ?? undefined,
							args: targetCliProcess.args(),
							rssBytes: mainRssBytes,
							vmHwmBytes: mainStatus.vmHwmBytes,
							rssAnonBytes: mainStatus.rssAnonBytes,
							rssFileBytes: mainStatus.rssFileBytes,
							rssShmemBytes: mainStatus.rssShmemBytes,
							vmSizeBytes: mainStatus.vmSizeBytes,
							vmPeakBytes: mainStatus.vmPeakBytes,
						},
						descendants: descendantSamples,
						mainRssBytes,
						treeRssBytes: mainRssBytes + descendantsRssSum,
					});
				} catch (err) {
					if (observing && !samplingError) {
						samplingError = err instanceof Error ? err : new Error(String(err));
					}
				} finally {
					sampling = false;
				}
			})();
			processState.sampling = task;
			await task;
			if (processState.sampling === task) processState.sampling = undefined;
		};

		void sampleTick();
		memoryTimer = setInterval(() => void sampleTick(), sampleIntervalMs);
	}

	const timer = setTimeout(() => {
		observing = false;
		if (options.input && observer.inputProbes.length !== options.input.count + 1) {
			completed.reject(new Error("Observation ended before every input probe was sent"));
			return;
		}
		if (options.memory?.enabled) {
			if (samplingError) {
				completed.reject(new Error(`Memory sampling error during observation: ${samplingError.message}`));
				return;
			}
			if (!targetCliProcess || memorySamples.length === 0) {
				completed.reject(
					new Error(
						`Incomplete memory sampling: target CLI process was not found or had no samples (target: ${options.memory.targetExecutable ?? "unknown"})`,
					),
				);
				return;
			}
			const stableStart = options.observationMs - options.stableMs;
			const stableSamples = memorySamples.filter(s => s.timestampMs >= stableStart);
			if (stableSamples.length === 0) {
				completed.reject(
					new Error(
						`Incomplete memory sampling: no samples recorded during stable window (${stableStart}ms to ${options.observationMs}ms)`,
					),
				);
				return;
			}
		}
		void observer.finish(performance.now() - started, options.stableMs).then(completed.resolve, completed.reject);
	}, options.observationMs);

	const errors: unknown[] = [];
	let result: SettledStartupFrame | undefined;
	try {
		result = await completed.promise;
	} catch (error) {
		errors.push(error);
	} finally {
		observing = false;
		clearTimeout(timer);
		clearInterval(inputTimer);
		clearInterval(memoryTimer);
		if (processState.sampling) await processState.sampling.catch(() => {});
		const target = processState.target;
		try {
			if (target && !(await target.terminate({ gracefulMs: 500, timeoutMs: 2000 }))) {
				errors.push(new Error(`Startup process tree ${target.pid} did not terminate`));
			}
			if (!target && child.pid !== undefined) child.kill("SIGKILL");
		} catch (error) {
			errors.push(error);
		} finally {
			await observer.flush().catch(() => {});
			if (options.memory?.enabled && memorySamples.length > 0 && targetCliProcess) {
				const stableStart = options.observationMs - options.stableMs;
				const stableSamples = memorySamples.filter(s => s.timestampMs >= stableStart);
				if (stableSamples.length === 0) {
					errors.push(
						new Error(
							`Incomplete memory sampling: no samples recorded during stable window (${stableStart}ms to ${options.observationMs}ms)`,
						),
					);
				} else {
					targetCliSha256 ??=
						(await digestPromise) ??
						(targetCliResolvedExe ? await computeDigest(targetCliResolvedExe).catch(() => null) : null);
					const mainPeakRssBytes = memorySamples.reduce(
						(max, s) => Math.max(max, s.mainRssBytes, s.mainProcess.vmHwmBytes ?? 0),
						0,
					);
					const treePeakRssBytes = memorySamples.reduce((max, s) => Math.max(max, s.treeRssBytes), 0);
					const lastSample = memorySamples[memorySamples.length - 1];

					memoryObservation = {
						sampleIntervalMs,
						targetExecutable: targetCliResolvedExe ?? options.memory.targetExecutable ?? "unknown",
						targetExeSha256: targetCliSha256 ?? undefined,
						targetPid: (targetCliProcess as Process).pid,
						samplesCount: memorySamples.length,
						mainPeakRssBytes,
						treePeakRssBytes,
						mainSteadyRssBytes: median(stableSamples.map(s => s.mainRssBytes)),
						treeSteadyRssBytes: median(stableSamples.map(s => s.treeRssBytes)),
						mainVmHwmBytes: lastSample?.mainProcess.vmHwmBytes,
						samples: memorySamples,
					};
				}
			}
			try {
				await fs.writeFile(
					options.trace,
					`${JSON.stringify(
						{
							columns: options.columns,
							rows: options.rows,
							expectedModel: options.expectedModel,
							observationMs: options.observationMs,
							stableMs: options.stableMs,
							stderr,
							samples: observer.samples,
							inputProbes: observer.inputProbes,
							memory: memoryObservation,
						},
						null,
						2,
					)}\n`,
				);
			} catch (error) {
				errors.push(error);
			} finally {
				observer.dispose();
				child.stdin.destroy();
				child.stdout.destroy();
				child.stderr.destroy();
			}
		}
	}
	if (errors.length > 0) throw new AggregateError(errors, "Settled startup measurement failed");
	if (!result) throw new Error("Settled startup measurement produced no result");
	return {
		...result,
		...(options.input ? { inputProbes: observer.inputProbes } : {}),
		...(memoryObservation ? { memory: memoryObservation } : {}),
	};
}
