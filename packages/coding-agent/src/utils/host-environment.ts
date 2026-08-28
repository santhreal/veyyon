import * as os from "node:os";
import { errorMessage, firstNonEmpty, getGpuCachePath, isEnoent, logger } from "@veyyon/utils";

function parseWmicTable(output: string, header: string): string | null {
	const lines = output
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean);
	const filtered = lines.filter(line => line.toLowerCase() !== header.toLowerCase());
	return filtered[0] ?? null;
}

const GPU_PROBE_MARGIN_MS = 500;
const GPU_PROBE_STDOUT_DRAIN_MS = 250;

async function runGpuProbe(cmd: string[], budgetMs: number): Promise<string | null> {
	try {
		const proc = Bun.spawn({
			cmd,
			stdout: "pipe",
			stderr: "ignore",
			stdin: "ignore",
			timeout: Math.max(0, budgetMs - GPU_PROBE_MARGIN_MS),
			killSignal: "SIGKILL",
		});
		const stdoutReader = proc.stdout.getReader();
		let stdout = "";
		const decoder = new TextDecoder();
		const stdoutDone = (async () => {
			while (true) {
				const chunk = await stdoutReader.read();
				if (chunk.done) break;
				stdout += decoder.decode(chunk.value, { stream: true });
			}
			stdout += decoder.decode();
		})();
		const exitCode = await proc.exited;
		const drained = await Promise.race([
			stdoutDone.then(() => "ok" as const).catch(() => "err" as const),
			Bun.sleep(GPU_PROBE_STDOUT_DRAIN_MS).then(() => "timeout" as const),
		]);
		if (drained !== "ok") {
			await stdoutReader.cancel().catch(() => undefined);
			await stdoutDone.catch(() => undefined);
		}
		return exitCode === 0 ? stdout : null;
	} catch (error) {
		if (isEnoent(error)) {
			logger.debug("GPU probe binary is not installed; the prompt will omit the GPU", {
				cmd: cmd.join(" "),
			});
		} else {
			logger.warn("GPU probe could not run; the prompt will omit the GPU even if one is present", {
				cmd: cmd.join(" "),
				error: errorMessage(error),
			});
		}
		return null;
	}
}

export function selectGpuFromLspci(output: string): string | null {
	const gpus: Array<{ name: string; priority: number }> = [];
	for (const line of output.split("\n")) {
		if (!/(VGA|3D|Display)/i.test(line)) continue;
		const sep = line.indexOf(": ");
		const name = sep >= 0 ? line.slice(sep + 2).trim() : line.trim();
		const nameLower = name.toLowerCase();
		if (/aspeed|mga\s*g200/i.test(name)) continue;
		let priority = 0;
		if (
			nameLower.includes("nvidia") ||
			nameLower.includes("geforce") ||
			nameLower.includes("quadro") ||
			nameLower.includes("rtx")
		) {
			priority = 3;
		} else if (nameLower.includes("amd") || nameLower.includes("radeon") || nameLower.includes("rx ")) {
			priority = 3;
		} else if (nameLower.includes("intel")) {
			priority = 1;
		} else {
			priority = 2;
		}
		gpus.push({ name, priority });
	}
	if (gpus.length === 0) return null;
	gpus.sort((a, b) => b.priority - a.priority);
	return gpus[0].name;
}

async function getGpuModel(budgetMs: number): Promise<string | null> {
	switch (process.platform) {
		case "win32": {
			const output = await runGpuProbe(["wmic", "path", "win32_VideoController", "get", "name"], budgetMs);
			return output ? parseWmicTable(output, "Name") : null;
		}
		case "linux": {
			const output = await runGpuProbe(["lspci"], budgetMs);
			return output ? selectGpuFromLspci(output) : null;
		}
		default:
			return null;
	}
}

function getTerminalName(): string | undefined {
	const termProgram = Bun.env.TERM_PROGRAM;
	const termProgramVersion = Bun.env.TERM_PROGRAM_VERSION;
	if (termProgram) {
		return termProgramVersion ? `${termProgram} ${termProgramVersion}` : termProgram;
	}

	if (Bun.env.WT_SESSION) return "Windows Terminal";

	const term = firstNonEmpty(Bun.env.TERM, Bun.env.COLORTERM, Bun.env.TERMINAL_EMULATOR);
	return term ?? undefined;
}

interface GpuCache {
	gpu: string | null;
}

async function loadGpuCache(): Promise<GpuCache | null> {
	const cachePath = getGpuCachePath();
	let content: unknown;
	try {
		content = await Bun.file(cachePath).json();
	} catch (err) {
		if (!isEnoent(err)) {
			logger.warn("GPU cache could not be read; re-probing and rewriting it", {
				path: cachePath,
				error: errorMessage(err),
			});
		}
		return null;
	}
	if (content && typeof content === "object" && "gpu" in content) {
		const gpu = (content as { gpu: unknown }).gpu;
		if (typeof gpu === "string" || gpu === null) return { gpu };
		logger.warn("GPU cache has a non-string `gpu`; re-probing and rewriting it", {
			path: cachePath,
			type: typeof gpu,
		});
		return null;
	}
	logger.warn("GPU cache parsed but has no `gpu` field; re-probing and rewriting it", { path: cachePath });
	return null;
}

async function saveGpuCache(info: GpuCache): Promise<void> {
	const cachePath = getGpuCachePath();
	try {
		await Bun.write(cachePath, JSON.stringify(info, null, "\t"));
	} catch (err) {
		logger.warn("GPU cache could not be written; the GPU will be probed again on every launch", {
			path: cachePath,
			error: errorMessage(err),
		});
	}
}

let processGpu: { value: string | undefined } | undefined;
let gpuProbe: Promise<void> | undefined;
let processCpuModel: { value: string | undefined } | undefined;

export async function getCachedGpu(budgetMs: number): Promise<string | undefined> {
	if (processGpu) return processGpu.value;
	const cached = await logger.time("getCachedGpu:loadGpuCache", loadGpuCache);
	if (cached) {
		processGpu = { value: cached.gpu ?? undefined };
		return processGpu.value;
	}
	processGpu = { value: undefined };
	gpuProbe ??= probeGpuInBackground(budgetMs);
	return undefined;
}

async function probeGpuInBackground(budgetMs: number): Promise<void> {
	try {
		const gpu = await getGpuModel(budgetMs);
		await saveGpuCache({ gpu });
	} catch (err) {
		logger.warn("GPU probe failed; the GPU will be probed again on the next launch", {
			error: errorMessage(err),
		});
	}
}

export async function awaitGpuProbe(): Promise<void> {
	await gpuProbe;
}

export function __resetCpuStateForTests(): void {
	processCpuModel = undefined;
}

export async function getCpuModel(): Promise<string | undefined> {
	if (processCpuModel) return processCpuModel.value;
	if (process.platform !== "linux") {
		processCpuModel = { value: os.cpus()[0]?.model };
		return processCpuModel.value;
	}
	try {
		const cpuInfo = await Bun.file("/proc/cpuinfo").text();
		const match = /^model name\s*:\s*(.+)$/m.exec(cpuInfo);
		processCpuModel = { value: match?.[1]?.trim() || undefined };
	} catch (error) {
		if (!isEnoent(error)) {
			logger.warn("CPU model could not be read; the prompt's environment section will omit it", {
				path: "/proc/cpuinfo",
				error: errorMessage(error),
			});
		}
		processCpuModel = { value: undefined };
	}
	return processCpuModel.value;
}

function getKernelIdentity(): string {
	const version = os.version()?.trim();
	if (version && version.toLowerCase() !== "unknown") return version;
	return `${os.type()} ${os.release()}`.trim();
}

export function getEnvironmentInfo(
	cpuModel: string | undefined,
	gpu: string | undefined,
): Array<{ label: string; value: string }> {
	const entries: Array<{ label: string; value: string | undefined }> = [
		{ label: "OS", value: `${os.platform()} ${os.release()}` },
		{ label: "Distro", value: os.type() },
		{ label: "Kernel", value: getKernelIdentity() },
		{ label: "Arch", value: os.arch() },
		{ label: "CPU", value: cpuModel },
		{ label: "GPU", value: gpu },
		{ label: "Terminal", value: getTerminalName() },
	];
	return entries.filter((e): e is { label: string; value: string } => !!e.value);
}
