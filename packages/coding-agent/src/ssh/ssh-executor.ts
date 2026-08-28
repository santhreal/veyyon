import { logger, ptree } from "@veyyon/utils";
import { Settings } from "../config/settings";
import { primarySessionCpuAdoption } from "../session/cpu-limit";
import { OutputSink } from "../session/streaming-output";
import { resolveOutputMaxColumns, resolveOutputSinkHeadBytes } from "../tools/output-meta";
import { buildRemoteCommand, ensureConnection, ensureHostInfo, type SSHConnectionTarget } from "./connection-manager";
import { hasSshfs, mountRemote } from "./sshfs-mount";
import { wrapInPosixShell } from "./utils";

export interface SSHExecutorOptions {
	timeout?: number;
	onChunk?: (chunk: string) => void;
	signal?: AbortSignal;
	remotePath?: string;
	compatEnabled?: boolean;
	artifactPath?: string;
	artifactId?: string;
	spillThreshold?: number;
}

export interface SSHResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	artifactId?: string;
}

type SSHExitEvent = { kind: "exit"; exitCode: number } | { kind: "error"; error: unknown };

function sshExitEvent(exitCode: number): SSHExitEvent {
	return { kind: "exit", exitCode };
}

function sshErrorEvent(error: unknown): SSHExitEvent {
	return { kind: "error", error };
}

function createAbortWaiter(
	signal: AbortSignal | undefined,
	streamAbort: AbortController,
): { promise: Promise<ptree.ProcessAbortError> | undefined; cleanup: () => void } {
	if (!signal) {
		return { promise: undefined, cleanup: () => {} };
	}

	const { promise, resolve } = Promise.withResolvers<ptree.ProcessAbortError>();
	const onAbort = () => {
		const error = new ptree.ProcessAbortError(signal.reason, "<cancelled>");
		if (!streamAbort.signal.aborted) {
			streamAbort.abort(error);
		}
		resolve(error);
	};

	if (signal.aborted) {
		onAbort();
		return { promise, cleanup: () => {} };
	}

	signal.addEventListener("abort", onAbort, { once: true });
	return { promise, cleanup: () => signal.removeEventListener("abort", onAbort) };
}

export async function executeSSH(
	host: SSHConnectionTarget,
	command: string,
	options?: SSHExecutorOptions,
): Promise<SSHResult> {
	await ensureConnection(host);
	if (hasSshfs()) {
		try {
			await mountRemote(host, options?.remotePath ?? "/");
		} catch (err) {
			logger.warn("SSHFS mount failed", { host: host.name, error: String(err) });
		}
	}

	let resolvedCommand = command;
	if (options?.compatEnabled) {
		const info = await ensureHostInfo(host);
		if (info.compatShell) {
			resolvedCommand = wrapInPosixShell(info.compatShell, command);
		} else {
			logger.warn("SSH compat enabled without detected compat shell", { host: host.name });
		}
	}

	using child = ptree.spawn(["ssh", ...(await buildRemoteCommand(host, resolvedCommand))], {
		signal: options?.signal,
		timeout: options?.timeout,
		stdin: "pipe",
		stderr: "full",
		onSpawnPid: primarySessionCpuAdoption(),
	});

	const settings = await Settings.init();
	const sink = new OutputSink({
		onChunk: options?.onChunk,
		artifactPath: options?.artifactPath,
		artifactId: options?.artifactId,
		...(options?.spillThreshold !== undefined ? { spillThreshold: options.spillThreshold } : {}),
		headBytes: resolveOutputSinkHeadBytes(settings),
		maxColumns: resolveOutputMaxColumns(settings),
	});

	const streamAbort = new AbortController();
	const abortWaiter = createAbortWaiter(options?.signal, streamAbort);
	const streamOptions = { signal: streamAbort.signal };
	const streams = [child.stdout.pipeTo(sink.createInput(), streamOptions)];
	if (child.stderr) {
		streams.push(child.stderr.pipeTo(sink.createInput(), streamOptions));
	}
	const streamsSettled = Promise.allSettled(streams).then(() => {});

	try {
		const exitEvent = child.exited.then(sshExitEvent, sshErrorEvent);
		const abortEvent = abortWaiter.promise?.then(sshErrorEvent);
		const event = await (abortEvent ? Promise.race([exitEvent, abortEvent]) : exitEvent);
		if (event.kind === "error") {
			throw event.error;
		}

		const streamEvent = await (abortEvent ? Promise.race([streamsSettled, abortEvent]) : streamsSettled);
		if (streamEvent?.kind === "error") {
			throw streamEvent.error;
		}
		return {
			exitCode: event.exitCode,
			cancelled: false,
			...(await sink.dump()),
		};
	} catch (err) {
		if (!streamAbort.signal.aborted) {
			streamAbort.abort(err);
		}
		void streamsSettled;
		if (err instanceof ptree.Exception) {
			if (err instanceof ptree.TimeoutError) {
				return {
					exitCode: undefined,
					cancelled: true,
					...(await sink.dump(`SSH: ${err.message}`)),
				};
			}
			if (err.aborted) {
				return {
					exitCode: undefined,
					cancelled: true,
					...(await sink.dump(`Command aborted: ${err.message}`)),
				};
			}
			return {
				exitCode: err.exitCode,
				cancelled: false,
				...(await sink.dump(`Unexpected error: ${err.message}`)),
			};
		}
		throw err;
	} finally {
		abortWaiter.cleanup();
	}
}
