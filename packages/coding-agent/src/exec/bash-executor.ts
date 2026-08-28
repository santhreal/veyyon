import { ExponentialYield } from "@veyyon/agent-core/utils/yield";
import { type MinimizerOptions, Shell, type ShellRunResult } from "@veyyon/natives";
import { isExecutable, type ShellConfig } from "@veyyon/utils/procmgr";
import { Settings, type ShellMinimizerSettings } from "../config/settings";
import { sessionCpuLimit } from "../session/cpu-limit";
import { OutputSink } from "../session/streaming-output";
import { resolveOutputMaxColumns, resolveOutputSinkHeadBytes } from "../tools/output-meta";
import { TOOL_TIMEOUTS } from "../tools/tool-timeouts";
import { getOrCreateSnapshot } from "../utils/shell-snapshot";
import { buildNonInteractiveEnv } from "./non-interactive-env";

const DEFAULT_BASH_TIMEOUT_MS = TOOL_TIMEOUTS.bash.default * 1000;

export interface BashExecutorOptions {
	cwd?: string;
	timeout?: number;
	onChunk?: (chunk: string) => void;
	chunkThrottleMs?: number;
	signal?: AbortSignal;
	sessionKey?: string;
	cpuSessionId?: string;
	cpuBudgetId?: string;
	env?: Record<string, string>;
	useUserShell?: boolean;
	artifactPath?: string;
	artifactId?: string;
	spillThreshold?: number;
	onMinimizedSave?: (
		originalText: string,
		info: { filter: string; inputBytes: number; outputBytes: number },
	) => Promise<string | undefined>;
}

export interface BashResult {
	output: string;
	exitCode: number | undefined;
	signal?: number;
	cancelled: boolean;
	truncated: boolean;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	artifactId?: string;
	workingDir?: string;
}

const shellSessions = new Map<string, Shell>();
const brokenShellSessions = new Set<string>();
const shellSessionQuarantines = new Map<string, Promise<unknown>>();
const shellSessionsInUse = new Set<string>();

const retainedShells = new Set<Shell>();
const RETAIN_REAP_INTERVAL_MS = 5_000;

async function retainShellWithLiveBackgroundJobs(shell: Shell): Promise<void> {
	let live: number;
	try {
		live = await shell.liveBackgroundJobCount();
	} catch {
		return;
	}
	if (live <= 0) return;
	retainedShells.add(shell);
	const interval = setInterval(() => {
		void shell
			.liveBackgroundJobCount()
			.then(remaining => {
				if (remaining > 0) return;
				clearInterval(interval);
				retainedShells.delete(shell);
			})
			.catch(() => {
				clearInterval(interval);
				retainedShells.delete(shell);
			});
	}, RETAIN_REAP_INTERVAL_MS);
	interval.unref?.();
}

function quarantineShellSession(
	sessionKey: string,
	runPromise: Promise<ShellRunResult>,
	abortCleanupPromise: Promise<void> | undefined,
): void {
	brokenShellSessions.add(sessionKey);
	const cleanup = abortCleanupPromise
		? Promise.allSettled([runPromise, abortCleanupPromise])
		: Promise.allSettled([runPromise]);
	shellSessionQuarantines.set(sessionKey, cleanup);
	void cleanup
		.finally(() => {
			if (shellSessionQuarantines.get(sessionKey) === cleanup) {
				shellSessionQuarantines.delete(sessionKey);
				brokenShellSessions.delete(sessionKey);
			}
		})
		.catch(() => undefined);
}

function resolveShellCwd(cwd: string | undefined): string | undefined {
	return cwd;
}

export function buildMinimizerOptions(group: ShellMinimizerSettings): MinimizerOptions | undefined {
	if (!group.enabled) return undefined;
	return {
		enabled: true,
		settingsPath: group.settingsPath || undefined,
		only: group.only.length > 0 ? group.only : undefined,
		except: group.except.length > 0 ? group.except : undefined,
		maxCaptureBytes: group.maxCaptureBytes,
		sourceOutlineLevel: group.sourceOutlineLevel === "default" ? undefined : group.sourceOutlineLevel,
		legacyFilters: group.legacyFilters,
	};
}

function shellBasename(shell: string): string {
	return shell.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
}

function isBashShell(shell: string): boolean {
	const basename = shellBasename(shell);
	return basename.includes("bash");
}

function needsInteractiveShellArg(shell: string): boolean {
	const basename = shellBasename(shell);
	return basename.includes("zsh");
}

function supportsAutoUserShell(shell: string): boolean {
	const basename = shellBasename(shell);
	return basename.includes("bash") || basename.includes("zsh") || basename.includes("fish");
}

function hasInteractiveShellArg(args: string[]): boolean {
	return args.some(arg => arg === "--interactive" || /^-[^-]*i/.test(arg));
}

function ensureInteractiveShellArgs(shell: string, args: string[]): string[] {
	if (!needsInteractiveShellArg(shell) || hasInteractiveShellArg(args)) return args;

	const commandIndex = args.findIndex(arg => arg === "-c" || arg === "--command");
	if (commandIndex !== -1) {
		return args.slice(0, commandIndex).concat("-i", args.slice(commandIndex));
	}

	const compactCommandIndex = args.findIndex(arg => /^-[^-]*c[^-]*$/.test(arg));
	if (compactCommandIndex !== -1) {
		return args.map((arg, index) => (index === compactCommandIndex ? arg.replace("c", "ic") : arg));
	}

	return args.concat("-i");
}

function quoteShellArg(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildUserShellCommand(shell: string, args: string[], command: string): string {
	return [shell, ...ensureInteractiveShellArgs(shell, args), command].map(quoteShellArg).join(" ");
}

function resolveUserShellConfig(settings: Settings, baseConfig: ShellConfig): ShellConfig {
	const customShellPath = settings.get("shellPath");
	const envShell = Bun.env.SHELL;
	if (customShellPath || process.platform === "win32" || !envShell || envShell === baseConfig.shell) {
		return baseConfig;
	}
	if (!supportsAutoUserShell(envShell) || !isExecutable(envShell)) {
		return baseConfig;
	}

	return {
		...baseConfig,
		shell: envShell,
		env: {
			...baseConfig.env,
			SHELL: envShell,
		},
	};
}

export async function executeBash(command: string, options?: BashExecutorOptions): Promise<BashResult> {
	const settings = await Settings.init();
	const baseShellConfig = settings.getShellConfig();
	const shellConfig =
		options?.useUserShell === true ? resolveUserShellConfig(settings, baseShellConfig) : baseShellConfig;
	const { shell, args, env: shellEnv, prefix } = shellConfig;
	const bashShell = isBashShell(shell);
	const snapshotPath = bashShell ? await getOrCreateSnapshot(shell, shellEnv) : null;

	const minimizer = buildMinimizerOptions(settings.getGroup("shellMinimizer"));

	const commandCwd = resolveShellCwd(options?.cwd);
	const commandEnv = buildNonInteractiveEnv(options?.env);

	const prefixedCommand = prefix ? `${prefix} ${command}` : command;
	const finalCommand =
		options?.useUserShell === true && !bashShell
			? buildUserShellCommand(shell, args, prefixedCommand)
			: prefixedCommand;

	const sink = new OutputSink({
		onChunk: options?.onChunk,
		artifactPath: options?.artifactPath,
		artifactId: options?.artifactId,
		...(options?.spillThreshold !== undefined ? { spillThreshold: options.spillThreshold } : {}),
		headBytes: resolveOutputSinkHeadBytes(settings),
		maxColumns: resolveOutputMaxColumns(settings),
		chunkThrottleMs: options?.onChunk ? (options.chunkThrottleMs ?? 50) : 0,
	});

	let acceptingChunks = true;
	const enqueueChunk = (chunk: string) => {
		if (acceptingChunks) sink.push(chunk);
	};

	if (options?.signal?.aborted) {
		return {
			exitCode: undefined,
			cancelled: true,
			...(await sink.dump("Command cancelled")),
		};
	}

	const shellOptions = {
		sessionEnv: shellEnv,
		snapshotPath: snapshotPath ?? undefined,
		minimizer,
	};
	const cpuLimit = sessionCpuLimit(options?.cpuSessionId ?? options?.sessionKey);
	if (cpuLimit) {
		await cpuLimit.gateSpawn("a bash command");
	}
	const cpuBudgetId =
		options?.cpuBudgetId ?? (cpuLimit && (await cpuLimit.ensureGroup()) ? cpuLimit.budgetName : undefined);
	const sessionKey = buildSessionKey(shell, prefix, snapshotPath, shellEnv, options?.sessionKey, minimizer);
	const persistentSessionBroken = brokenShellSessions.has(sessionKey);
	if (persistentSessionBroken) {
		shellSessions.delete(sessionKey);
	}

	const sessionBusy = shellSessionsInUse.has(sessionKey);
	let shellSession = persistentSessionBroken || sessionBusy ? undefined : shellSessions.get(sessionKey);
	if (!shellSession && !persistentSessionBroken && !sessionBusy) {
		shellSession = new Shell(shellOptions);
		shellSessions.set(sessionKey, shellSession);
	}
	const executionShell = shellSession ?? new Shell(shellOptions);
	const ownsPersistentSession = shellSession !== undefined;
	if (ownsPersistentSession) {
		shellSessionsInUse.add(sessionKey);
	}
	const userSignal = options?.signal;
	const runAbortController = new AbortController();
	let abortCleanupPromise: Promise<void> | undefined;
	const abortShell = (): Promise<void> => {
		abortCleanupPromise ??= executionShell.abort().catch(() => undefined);
		return abortCleanupPromise;
	};
	const abortCurrentExecution = () => {
		if (!runAbortController.signal.aborted) {
			runAbortController.abort();
		}
		void abortShell();
	};
	const abortDeferred = Promise.withResolvers<"abort">();
	const abortHandler = () => {
		abortCurrentExecution();
		abortDeferred.resolve("abort");
	};
	if (userSignal) {
		userSignal.addEventListener("abort", abortHandler, { once: true });
	}

	let timeoutTimer: NodeJS.Timeout | undefined;
	const timeoutDeferred = Promise.withResolvers<"timeout">();
	const requestedTimeoutMs = options?.timeout;
	const deadlineTimeoutMs =
		requestedTimeoutMs === 0 ? undefined : Math.max(1_000, requestedTimeoutMs ?? DEFAULT_BASH_TIMEOUT_MS);
	const nativeTimeoutMs = requestedTimeoutMs !== undefined && requestedTimeoutMs > 0 ? requestedTimeoutMs : undefined;
	const nativeOwnsTimeout = nativeTimeoutMs !== undefined;
	if (deadlineTimeoutMs !== undefined) {
		timeoutTimer = setTimeout(() => {
			if (!nativeOwnsTimeout) {
				abortCurrentExecution();
			}
			timeoutDeferred.resolve("timeout");
		}, deadlineTimeoutMs);
	}

	let resetSession = false;

	try {
		const runPromise = executionShell.run(
			{
				command: finalCommand,
				cwd: commandCwd,
				env: commandEnv,
				timeoutMs: nativeTimeoutMs,
				signal: runAbortController.signal,
				...(cpuBudgetId ? { cpuBudgetId } : {}),
			},
			(err, chunk) => {
				if (!err) {
					enqueueChunk(chunk);
				}
			},
		);

		const ey = new ExponentialYield();
		const winner = await ey.race<
			{ kind: "result"; result: ShellRunResult } | { kind: "timeout" } | { kind: "abort" }
		>([
			runPromise.then(result => ({ kind: "result" as const, result })),
			timeoutDeferred.promise.then(kind => ({ kind })),
			abortDeferred.promise.then(kind => ({ kind })),
		]);

		if (winner.kind === "timeout" || winner.kind === "abort") {
			acceptingChunks = false;
			const cleanupPromise = abortShell();
			if (shellSession) {
				resetSession = true;
				quarantineShellSession(sessionKey, runPromise, cleanupPromise);
			} else {
				void Promise.allSettled([runPromise, cleanupPromise]);
			}
			return {
				exitCode: undefined,
				cancelled: true,
				...(await sink.dump(
					winner.kind === "timeout" && deadlineTimeoutMs !== undefined
						? `Command timed out after ${Math.round(deadlineTimeoutMs / 1000)} seconds`
						: "Command cancelled",
				)),
			};
		}
		if (timeoutTimer) {
			clearTimeout(timeoutTimer);
			timeoutTimer = undefined;
		}

		if (winner.result.timedOut) {
			const annotation = options?.timeout
				? `Command timed out after ${Math.round(options.timeout / 1000)} seconds`
				: "Command timed out";
			resetSession = true;
			if (shellSession) {
				quarantineShellSession(sessionKey, runPromise, abortCleanupPromise);
			}
			return {
				exitCode: undefined,
				cancelled: true,
				...(await sink.dump(annotation)),
			};
		}

		if (winner.result.cancelled) {
			resetSession = true;
			if (shellSession) {
				quarantineShellSession(sessionKey, runPromise, abortCleanupPromise);
			}
			return {
				exitCode: undefined,
				cancelled: true,
				...(await sink.dump("Command cancelled")),
			};
		}

		const minimized = winner.result.minimized;
		if (minimized && minimized.text !== minimized.originalText) {
			sink.replace(minimized.text);
			if (options?.onMinimizedSave) {
				const artifactId = await options.onMinimizedSave(minimized.originalText, {
					filter: minimized.filter,
					inputBytes: minimized.inputBytes,
					outputBytes: minimized.outputBytes,
				});
				if (artifactId) {
					const sep = minimized.text.endsWith("\n") ? "" : "\n";
					sink.push(`${sep}[raw output: artifact://${artifactId}]\n`);
				}
			}
		}

		return {
			exitCode: winner.result.exitCode,
			signal: winner.result.signal,
			cancelled: false,
			workingDir: winner.result.workingDir,
			...(await sink.dump()),
		};
	} catch (err) {
		resetSession = true;
		throw err;
	} finally {
		if (timeoutTimer) {
			clearTimeout(timeoutTimer);
		}
		if (userSignal) {
			userSignal.removeEventListener("abort", abortHandler);
		}
		if (ownsPersistentSession) {
			shellSessionsInUse.delete(sessionKey);
			if (resetSession || options?.sessionKey?.includes(":async:")) {
				shellSessions.delete(sessionKey);
				if (!resetSession && shellSession) {
					await retainShellWithLiveBackgroundJobs(shellSession);
				}
			}
		}
	}
}

function buildSessionKey(
	shell: string,
	prefix: string | undefined,
	snapshotPath: string | null,
	env: Record<string, string>,
	agentSessionKey?: string,
	minimizer?: MinimizerOptions,
): string {
	const entries = Object.entries(env);
	entries.sort(([a], [b]) => a.localeCompare(b));
	const envSerialized = entries.map(([key, value]) => `${key}=${value}`).join("\n");
	const minimizerSerialized = minimizer ? JSON.stringify(minimizer) : "";
	return [agentSessionKey ?? "", shell, prefix ?? "", snapshotPath ?? "", envSerialized, minimizerSerialized].join(
		"\n",
	);
}
