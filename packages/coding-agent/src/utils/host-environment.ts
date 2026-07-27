/**
 * What machine is this? — the host facts the prompt's environment block reports.
 *
 * WHY THIS IS ITS OWN MODULE. All of it lived in `system-prompt.ts`, which is about
 * ASSEMBLING A PROMPT, and none of this is: it spawns `lspci` and `wmic`, races them
 * against a deadline, drains a pipe an exited child left behind, caches the answer on
 * disk, and reads `/proc/cpuinfo`. That is a subsystem with its own failure modes,
 * and burying it in a 1200-line file about something else is what let two of those
 * failures be handled at different volumes without anyone noticing: an unreadable GPU
 * cache warned while an unreadable `/proc/cpuinfo` went to `logger.debug`, the same
 * fact reported two ways, forty lines apart.
 *
 * The prompt's only interest is the finished rows, which is exactly the surface here:
 * {@link getCpuModel} and {@link getCachedGpu} for the two slow lookups the builder
 * races, and {@link getEnvironmentInfo} to turn them into labelled rows.
 * {@link selectGpuFromLspci} is exported for its own tests, which is what it was
 * already doing from inside the prompt builder.
 */
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

/**
 * How far inside the caller's budget the probe must finish.
 *
 * The invariant is that a probe which times out still has time to write its null
 * cache, so the next launch does not probe again. That used to be expressed as
 * `SYSTEM_PROMPT_PREP_TIMEOUT_MS - 500` with both halves in the prompt builder;
 * the margin belongs to the probe and the budget belongs to the caller, so the
 * budget is now a parameter and only the margin lives here. Neither value can
 * drift out from under the other by being edited in the wrong file.
 */
const GPU_PROBE_MARGIN_MS = 500;
/** Drop stdout from a probe descendant that inherited the pipe after the probe exited. */
const GPU_PROBE_STDOUT_DRAIN_MS = 250;

async function runGpuProbe(cmd: string[], budgetMs: number): Promise<string | null> {
	try {
		const proc = Bun.spawn({
			cmd,
			stdout: "pipe",
			stderr: "ignore",
			stdin: "ignore",
			timeout: Math.max(0, budgetMs - GPU_PROBE_MARGIN_MS),
			// SIGKILL so a probe ignoring SIGTERM (PATH wrapper, wedged WMI) still
			// dies at the deadline and lets getCachedGpu reach the null-cache write.
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
		// Even on exit 0, a probe wrapper can leave a descendant holding stdout open.
		// Bound the EOF wait so getCachedGpu cannot outlive the probe in either path;
		// keep whatever bytes the reader already captured before cancelling.
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
		// `null` means "no GPU information", and the prompt's environment section then simply omits the
		// GPU -- which on a machine that HAS one is a configuration bug, not a fact (Law 8). Two failures
		// reach here and they deserve different volumes: a missing probe binary is ordinary (no `lspci` in
		// a slim container, no `wmic` on a trimmed Windows install), while anything else means the probe
		// could not run for a reason the operator can fix, and staying quiet about it is how a workstation
		// with an RTX 5090 ends up describing itself as having no GPU.
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

/**
 * Pick the best GPU device name from `lspci` default-format output, or null if
 * none is present. Exported for unit testing.
 *
 * lspci lines are `<slot> <class>: <device>`, e.g.
 * `01:00.0 VGA compatible controller: NVIDIA Corporation Device 2b85 (rev a1)`.
 * The slot (`01:00.0`) contains colons but never a colon-SPACE, so the first
 * `": "` is always the class/device separator; the device name is everything
 * after it. Splitting on a bare `":"` (as an earlier version did) kept the slot
 * tail and class text, so the prompt showed
 * `00.0 VGA compatible controller: NVIDIA ...` instead of the device name.
 *
 * Among candidates, discrete GPUs (NVIDIA/AMD) outrank an unknown adapter,
 * which outranks Intel integrated; BMC/server display adapters are skipped. The
 * sort is stable, so ties keep lspci enumeration order.
 */
export function selectGpuFromLspci(output: string): string | null {
	const gpus: Array<{ name: string; priority: number }> = [];
	for (const line of output.split("\n")) {
		if (!/(VGA|3D|Display)/i.test(line)) continue;
		const sep = line.indexOf(": ");
		const name = sep >= 0 ? line.slice(sep + 2).trim() : line.trim();
		const nameLower = name.toLowerCase();
		// Skip BMC/server management adapters. Real lspci names read
		// `Matrox Electronics Systems Ltd. MGA G200e`, so the model token is
		// `MGA G200` with a space: match `mga\s*g200` (the earlier `matrox g200` /
		// `mgag200` patterns never matched real output and let the BMC adapter
		// through as the reported GPU).
		if (/aspeed|mga\s*g200/i.test(name)) continue;
		// Prioritize discrete GPUs
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

/** Cached GPU probe result. */
interface GpuCache {
	gpu: string | null;
}

/**
 * Read the GPU probe result cached on disk, or `null` to probe again.
 *
 * A damaged file (truncated by a crash mid-write, hand-edited, replaced with a
 * JSON value that is not an object) must never take the prompt down and must
 * never be trusted: the caller re-probes and overwrites it, so the cache repairs
 * itself on the next launch. But it is reported, because a file that fails to
 * parse on every launch means the probe runs on every launch, and the only
 * symptom of that is a slower start that nobody attributes to a cache.
 *
 * The one silence kept on purpose is a missing file. That is every first run, and
 * a warning that fires for everyone once is a warning people learn to skip.
 */
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
		// `null` is a real cached answer ("probed, found nothing"), so it is a hit.
		// Anything else that is not a string is damage: normalizing it to `null` and
		// returning it would leave the bad file on disk forever, because the caller
		// only rewrites the cache when it re-probes.
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

/**
 * Persist the probe result. A failed write costs only speed (the probe reruns
 * next launch), so it must not throw, but it is reported for the same reason the
 * read failure is: an unwritable cache directory is otherwise invisible.
 */
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

/**
 * The GPU name, from the on-disk cache when it has one and from a probe when it does not.
 *
 * `budgetMs` is the CALLER'S deadline for the whole lookup, not the probe's timeout:
 * the probe is given less by {@link GPU_PROBE_MARGIN_MS} so that a probe which times
 * out still reaches the null-cache write and the next launch does not probe again.
 */
export async function getCachedGpu(budgetMs: number): Promise<string | undefined> {
	const cached = await logger.time("getCachedGpu:loadGpuCache", loadGpuCache);
	if (cached) return cached.gpu ?? undefined;
	const gpu = await logger.time("getCachedGpu:getGpuModel", () => getGpuModel(budgetMs));
	await logger.time("getCachedGpu:saveGpuCache", saveGpuCache, { gpu });
	return gpu ?? undefined;
}

/**
 * The CPU line of the environment section, or nothing when it cannot be had.
 *
 * A missing `/proc/cpuinfo` is not a failure: the file is Linux-only and absent in
 * some containers, and the prompt simply omits the CPU line. Anything else means the
 * file IS there and could not be read, which is the same fact `loadGpuCache` reports
 * with `logger.warn` a few functions above — this one used `logger.debug`, a level
 * nobody runs with, so the identical situation was loud for the GPU and effectively
 * silent for the CPU. One volume for one class of failure.
 */
export async function getCpuModel(): Promise<string | undefined> {
	if (process.platform !== "linux") return os.cpus()[0]?.model;
	try {
		const cpuInfo = await Bun.file("/proc/cpuinfo").text();
		const match = /^model name\s*:\s*(.+)$/m.exec(cpuInfo);
		return match?.[1]?.trim() || undefined;
	} catch (error) {
		if (!isEnoent(error)) {
			logger.warn("CPU model could not be read; the prompt's environment section will omit it", {
				path: "/proc/cpuinfo",
				error: errorMessage(error),
			});
		}
		return undefined;
	}
}

/**
 * Kernel identity for the workstation block. Prefers the uname build string
 * from `os.version()`, but Bun on macOS 15+ (Darwin 24/25) returns the literal
 * `"unknown"` when `uv_os_uname()`'s `version` field is empty — which surfaces
 * `Kernel: unknown` in the system prompt and makes the model misidentify the
 * host as Windows (#4141). Fall back to `<type> <release>` (uname -s + -r) so
 * macOS is always tagged as `Darwin <release>` and Linux keeps its build info.
 */
function getKernelIdentity(): string {
	const version = os.version()?.trim();
	if (version && version.toLowerCase() !== "unknown") return version;
	return `${os.type()} ${os.release()}`.trim();
}

/** The labelled host rows the prompt's environment block renders, empty values dropped. */
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
