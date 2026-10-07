/**
 * Bash command execution with streaming support and cancellation.
 *
 * Uses brush-core via native bindings for shell execution.
 */
import { ExponentialYield } from "@veyyon/agent-core/utils/yield";
import {
	type MinimizerOptions,
	type MinimizerResult,
	Shell,
	type ShellOptions,
	type ShellRunResult,
} from "@veyyon/natives";
import { isExecutable, type ShellConfig } from "@veyyon/utils/procmgr";
import { Settings, type ShellMinimizerSettings } from "../config/settings";
import { sessionCpuLimit } from "../session/cpu-limit";
import { OutputSink } from "../session/streaming-output";
import { resolveOutputMaxColumns, resolveOutputSinkHeadBytes } from "../tools/core/output-meta";
import { TOOL_TIMEOUTS } from "../tools/core/tool-timeouts";
import { getOrCreateSnapshot } from "../utils/shell-snapshot";
import { buildNonInteractiveEnv } from "./non-interactive-env";

// The executor's fallback deadline for a caller that passes no timeout (e.g. the
// RPC `executeBash(command)` path) is the same concept as the bash tool default,
// so it reads from the single owner (TOOL_TIMEOUTS, in seconds) rather than
// hardcoding a second copy of 300s that could silently diverge.
const DEFAULT_BASH_TIMEOUT_MS = TOOL_TIMEOUTS.bash.default * 1000;

export interface BashExecutorOptions {
	cwd?: string;
	/** Milliseconds before aborting the command; 0 disables the executor deadline. */
	timeout?: number;
	onChunk?: (chunk: string) => void;
	chunkThrottleMs?: number;
	signal?: AbortSignal;
	/** Session key suffix to isolate shell sessions per agent */
	sessionKey?: string;
	/**
	 * The veyyon session id whose CPU budget this command joins. `sessionKey` is
	 * a shell-isolation key and is NOT always a session id (autoresearch uses
	 * `autoresearch:<cwd>`), so a caller whose two identities differ passes this.
	 */
	cpuSessionId?: string;
	/** Session CPU budget name; the command's processes join that budget group. */
	cpuBudgetId?: string;
	/** Additional environment variables to inject */
	env?: Record<string, string>;
	/** Run through the configured user shell instead of brush parsing directly. */
	useUserShell?: boolean;
	/** Artifact path/id for full output storage */
	artifactPath?: string;
	artifactId?: string;
	/**
	 * How many bytes of output may stay inline, from the caller's session.
	 *
	 * The executor has no session, so it cannot price this itself, and the flat
	 * default it used instead is how a large result ended up re-read on every
	 * turn for the rest of the session. Callers that own a `ToolSession` pass
	 * `inlineBudgetFor(session)`; a caller with no session omits it and gets the
	 * flat budget, which is the previous behaviour.
	 */
	spillThreshold?: number;
	/**
	 * Invoked when the native minimizer rewrote the command's output, giving
	 * the caller a chance to persist the lossless original capture (typically
	 * via the session's `ArtifactManager`). The returned id is spliced into
	 * the sink output as `artifact://<id>` so the agent can retrieve the raw
	 * bytes. Return `undefined` to skip the footer.
	 */
	onMinimizedSave?: (
		originalText: string,
		info: { filter: string; inputBytes: number; outputBytes: number },
	) => Promise<string | undefined>;
}

export interface BashResult {
	output: string;
	exitCode: number | undefined;
	/**
	 * The signal that killed the command, when it died from one.
	 *
	 * `exitCode` carries bash's `128 + signal`, which a program that calls
	 * `exit(137)` produces just as readily as one the kernel killed with
	 * SIGKILL. Only a real signalled death sets this, so the two can be told
	 * apart. `undefined` for every command that exited on its own.
	 */
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
/** Session keys with a command currently in flight on the persistent Shell. */
const shellSessionsInUse = new Set<string>();

/**
 * Shells retained past their turn because a background (`nohup`/`&`) job is
 * still running. A per-call `:async:` Shell is normally dropped at teardown,
 * which SIGKILLs its children via kill-on-drop. Keeping the reference alive lets
 * the process survive across turns; the Shell is dropped once its last
 * background job exits (reaped by the poll loop below). Children stay
 * kill-on-drop, so they still die when the harness tears the Shell down on exit.
 */
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
	// `cleanup` is `allSettled`, so it cannot reject on the quarantined run's own failure -- that failure was
	// already delivered to whoever ran the command, and this only waits for the wedged shell to finish before
	// letting the session be used again. The guard covers a rejection from `finally` itself.
	void cleanup
		.finally(() => {
			if (shellSessionQuarantines.get(sessionKey) === cleanup) {
				shellSessionQuarantines.delete(sessionKey);
				brokenShellSessions.delete(sessionKey);
			}
		})
		.catch(() => undefined);
}

/** Translate `ShellMinimizerSettings` into native `MinimizerOptions`, or `undefined` when disabled. */
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

/** The command line and persistent-shell options one `executeBash` call runs with. */
interface CommandPlan {
	command: string;
	shellOptions: ShellOptions;
	/** The persistent-session key: one Shell per shell, prefix, snapshot, env, caller key and minimizer. */
	sessionKey: string;
}

async function planCommand(
	settings: Settings,
	command: string,
	options: BashExecutorOptions | undefined,
): Promise<CommandPlan> {
	const useUserShell = options?.useUserShell === true;
	const baseShellConfig = settings.getShellConfig();
	const shellConfig = useUserShell ? resolveUserShellConfig(settings, baseShellConfig) : baseShellConfig;
	const { shell, args, env: shellEnv, prefix } = shellConfig;
	const bashShell = isBashShell(shell);
	const snapshotPath = bashShell ? await getOrCreateSnapshot(shell, shellEnv) : null;
	const minimizer = buildMinimizerOptions(settings.getGroup("shellMinimizer"));
	const prefixedCommand = prefix ? `${prefix} ${command}` : command;
	return {
		command: useUserShell && !bashShell ? buildUserShellCommand(shell, args, prefixedCommand) : prefixedCommand,
		shellOptions: { sessionEnv: shellEnv, snapshotPath: snapshotPath ?? undefined, minimizer },
		sessionKey: buildSessionKey(shell, prefix, snapshotPath, shellEnv, options?.sessionKey, minimizer),
	};
}

/**
 * Join the session CPU budget: refuse while the watcher reports sustained saturation, and return the
 * budget name the native shell hands every external command it spawns (see veyyon-shell's spawn observer).
 */
async function joinCpuBudget(options: BashExecutorOptions | undefined): Promise<string | undefined> {
	const cpuLimit = sessionCpuLimit(options?.cpuSessionId ?? options?.sessionKey);
	// gateSpawn creates the group first: assertMaySpawn is sync and used to skip memory/setup checks until
	// #group existed, so the first command raced unbounded.
	if (cpuLimit) await cpuLimit.gateSpawn("a bash command");
	return options?.cpuBudgetId ?? (cpuLimit && (await cpuLimit.ensureGroup()) ? cpuLimit.budgetName : undefined);
}

/** The shell a command runs in, and the key's persistent session when the command holds it. */
interface ShellLease {
	shell: Shell;
	persistent: Shell | undefined;
}

/**
 * A persistent Shell runs one command at a time (the native session is a mutex-guarded queue and `abort()`
 * kills every in-flight run on it). When parallel bash calls overlap on the same key, the first one holds the
 * persistent session; the rest run in isolated one-shot shells, the same path a quarantined session takes.
 */
function leaseShell(sessionKey: string, shellOptions: ShellOptions): ShellLease {
	if (brokenShellSessions.has(sessionKey)) {
		shellSessions.delete(sessionKey);
		return { shell: new Shell(shellOptions), persistent: undefined };
	}
	if (shellSessionsInUse.has(sessionKey)) return { shell: new Shell(shellOptions), persistent: undefined };
	let persistent = shellSessions.get(sessionKey);
	if (!persistent) {
		persistent = new Shell(shellOptions);
		shellSessions.set(sessionKey, persistent);
	}
	shellSessionsInUse.add(sessionKey);
	return { shell: persistent, persistent };
}

/**
 * Free the persistent session a command held. A reset session (cancel, timeout, error) is dropped. A
 * per-job `:async:` key is unique to its job, so its Shell is dropped too instead of staying in the
 * process-global map forever; dropping the only reference SIGKILLs any `nohup`/`&` children (kill-on-drop),
 * so a Shell with a live background job is retained until its last job exits and still dies with the harness.
 */
async function releaseShell(sessionKey: string, lease: ShellLease, reset: boolean, perJob: boolean): Promise<void> {
	if (!lease.persistent) return;
	shellSessionsInUse.delete(sessionKey);
	if (!reset && !perJob) return;
	shellSessions.delete(sessionKey);
	if (!reset) await retainShellWithLiveBackgroundJobs(lease.persistent);
}

/**
 * The two ways a run ends before its result: the caller's signal and the executor deadline. Either aborts
 * the run and settles `stopped` with the annotation of the first that fired.
 */
class RunStop {
	readonly controller = new AbortController();
	/** The explicit timeout veyyon-natives enforces itself through `timeoutMs`. */
	readonly nativeTimeoutMs: number | undefined;
	readonly #shell: Shell;
	readonly #userSignal: AbortSignal | undefined;
	readonly #stopped = Promise.withResolvers<string>();
	#timer: NodeJS.Timeout | undefined;
	#shellAbort: Promise<void> | undefined;

	constructor(shell: Shell, timeoutMs: number | undefined, userSignal: AbortSignal | undefined) {
		this.#shell = shell;
		this.#userSignal = userSignal;
		const deadlineMs = timeoutMs === 0 ? undefined : Math.max(1_000, timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS);
		this.nativeTimeoutMs = timeoutMs !== undefined && timeoutMs > 0 ? timeoutMs : undefined;
		userSignal?.addEventListener("abort", this.#onUserAbort, { once: true });
		if (deadlineMs !== undefined) this.#timer = setTimeout(() => this.#onDeadline(deadlineMs), deadlineMs);
	}

	get stopped(): Promise<string> {
		return this.#stopped.promise;
	}

	/** The shell abort in flight, if one started. */
	get shellAbort(): Promise<void> | undefined {
		return this.#shellAbort;
	}

	/**
	 * Abort the shell once. An abort that fails means the shell may still be running the command, which is
	 * the state `quarantineShellSession` exists for: this promise is handed to it, the session is marked
	 * broken, and it is not reused until the shell settles. Rethrowing here would replace the abort reason the
	 * caller is about to receive with a teardown error.
	 */
	abortShell(): Promise<void> {
		this.#shellAbort ??= this.#shell.abort().catch(() => undefined);
		return this.#shellAbort;
	}

	disarmDeadline(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	dispose(): void {
		clearTimeout(this.#timer);
		this.#userSignal?.removeEventListener("abort", this.#onUserAbort);
	}

	#abortRun(): void {
		if (!this.controller.signal.aborted) this.controller.abort();
		void this.abortShell();
	}

	#onUserAbort = (): void => {
		this.#abortRun();
		this.#stopped.resolve("Command cancelled");
	};

	#onDeadline(deadlineMs: number): void {
		// Explicit timeouts are already enforced inside veyyon-natives via `timeoutMs`. Do not also abort the
		// JS AbortSignal here: on Windows, aborting that signal while a piped command is still forwarding output
		// can terminate the Bun host before the native timeout result resolves.
		if (this.nativeTimeoutMs === undefined) this.#abortRun();
		this.#stopped.resolve(`Command timed out after ${Math.round(deadlineMs / 1000)} seconds`);
	}
}

async function cancelledResult(sink: OutputSink, annotation: string): Promise<BashResult> {
	return { exitCode: undefined, cancelled: true, ...(await sink.dump(annotation)) };
}

/**
 * When the native minimizer rewrote the output, swap the sink's accumulated raw stream for the minimized
 * text, persist the original as a session artifact, and splice an `artifact://<id>` footer into the visible
 * text so the agent can retrieve the raw bytes losslessly.
 */
async function spliceMinimizedOutput(
	sink: OutputSink,
	minimized: MinimizerResult | undefined,
	onMinimizedSave: BashExecutorOptions["onMinimizedSave"],
): Promise<void> {
	if (!minimized || minimized.text === minimized.originalText) return;
	sink.replace(minimized.text);
	if (!onMinimizedSave) return;
	const artifactId = await onMinimizedSave(minimized.originalText, {
		filter: minimized.filter,
		inputBytes: minimized.inputBytes,
		outputBytes: minimized.outputBytes,
	});
	if (!artifactId) return;
	const sep = minimized.text.endsWith("\n") ? "" : "\n";
	sink.push(`${sep}[raw output: artifact://${artifactId}]\n`);
}

type RunOutcome = { result: ShellRunResult } | { stopped: string };

export async function executeBash(command: string, options?: BashExecutorOptions): Promise<BashResult> {
	const settings = await Settings.init();
	const plan = await planCommand(settings, command, options);
	// Output sink for truncation and artifact handling. sink.push() is synchronous: buffer management,
	// counters and onChunk all run inline, and artifact file writes run asynchronously inside the sink.
	const sink = new OutputSink({
		onChunk: options?.onChunk,
		artifactPath: options?.artifactPath,
		artifactId: options?.artifactId,
		...(options?.spillThreshold !== undefined ? { spillThreshold: options.spillThreshold } : {}),
		headBytes: resolveOutputSinkHeadBytes(settings),
		maxColumns: resolveOutputMaxColumns(settings),
		chunkThrottleMs: options?.onChunk ? (options.chunkThrottleMs ?? 50) : 0,
	});
	if (options?.signal?.aborted) return cancelledResult(sink, "Command cancelled");

	const cpuBudgetId = await joinCpuBudget(options);
	// `RunStop` listens for the abort, and a signal that aborted during the budget join fires no event.
	// Nothing awaits between this check and that listener.
	if (options?.signal?.aborted) return cancelledResult(sink, "Command cancelled");
	const { sessionKey } = plan;
	const lease = leaseShell(sessionKey, plan.shellOptions);
	const stop = new RunStop(lease.shell, options?.timeout, options?.signal);
	let acceptingChunks = true;
	let resetSession = false;
	try {
		const runPromise = lease.shell.run(
			{
				command: plan.command,
				// The caller's logical cwd, unresolved: brush updates `PWD` and its working directory from this
				// string, so realpathing it would collapse symlinks before the shell sees them.
				cwd: options?.cwd,
				env: buildNonInteractiveEnv(options?.env),
				timeoutMs: stop.nativeTimeoutMs,
				signal: stop.controller.signal,
				...(cpuBudgetId ? { cpuBudgetId } : {}),
			},
			(err, chunk) => {
				if (!err && acceptingChunks) sink.push(chunk);
			},
		);
		const outcome = await new ExponentialYield().race<RunOutcome>([
			runPromise.then(result => ({ result })),
			stop.stopped.then(stopped => ({ stopped })),
		]);
		if ("stopped" in outcome) {
			acceptingChunks = false;
			const cleanup = stop.abortShell();
			if (lease.persistent) {
				resetSession = true;
				quarantineShellSession(sessionKey, runPromise, cleanup);
			} else {
				void Promise.allSettled([runPromise, cleanup]);
			}
			return await cancelledResult(sink, outcome.stopped);
		}
		stop.disarmDeadline();
		const { result } = outcome;
		if (result.timedOut || result.cancelled) {
			resetSession = true;
			if (lease.persistent) quarantineShellSession(sessionKey, runPromise, stop.shellAbort);
			let annotation = "Command cancelled";
			if (result.timedOut) {
				annotation = options?.timeout
					? `Command timed out after ${Math.round(options.timeout / 1000)} seconds`
					: "Command timed out";
			}
			return await cancelledResult(sink, annotation);
		}
		await spliceMinimizedOutput(sink, result.minimized, options?.onMinimizedSave);
		return {
			exitCode: result.exitCode,
			signal: result.signal,
			cancelled: false,
			workingDir: result.workingDir,
			...(await sink.dump()),
		};
	} catch (err) {
		resetSession = true;
		throw err;
	} finally {
		stop.dispose();
		await releaseShell(sessionKey, lease, resetSession, options?.sessionKey?.includes(":async:") === true);
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
