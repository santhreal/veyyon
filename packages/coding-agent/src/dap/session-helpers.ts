import * as path from "node:path";
import * as timers from "node:timers/promises";
import { errorMessage, logger } from "@veyyon/utils";
import type { DapClient } from "./client";
import type {
	DapBreakpointRecord,
	DapCapabilities,
	DapDataBreakpoint,
	DapFunctionBreakpointRecord,
	DapInstructionBreakpoint,
	DapResolvedAdapter,
	DapSessionStatus,
	DapSessionSummary,
	DapStackFrame,
	DapStopLocation,
	DapThread,
} from "./types";

export interface DapSession {
	id: string;
	adapter: DapResolvedAdapter;
	cwd: string;
	program?: string;
	client: DapClient;
	status: DapSessionStatus;
	launchedAt: number;
	lastUsedAt: number;
	breakpoints: Map<string, DapBreakpointRecord[]>;
	functionBreakpoints: DapFunctionBreakpointRecord[];
	instructionBreakpoints: DapInstructionBreakpoint[];
	dataBreakpoints: DapDataBreakpoint[];
	breakpointMutationQueue: Promise<void>;
	outputChunks: string[];
	outputBytes: number;
	outputBufferedBytes: number;
	outputTruncated: boolean;
	stop: DapStopLocation;
	threads: DapThread[];
	lastStackFrames: DapStackFrame[];
	exitCode?: number;
	capabilities?: DapCapabilities;
	initializedSeen: boolean;
	needsConfigurationDone: boolean;
	configurationDoneSent: boolean;
}

export interface DapOutputSnapshot {
	snapshot: DapSessionSummary;
	output: string;
}

export const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
export const CLEANUP_INTERVAL_MS = 30 * 1000;
export const HEARTBEAT_INTERVAL_MS = 5 * 1000;
export const MAX_BUFFERED_OUTPUT_BYTES = 128 * 1024;
export const STOP_CAPTURE_TIMEOUT_MS = 5_000;

export interface DapStartRequestFailure {
	rejected: boolean;
	error?: unknown;
	settled?: Promise<void>;
}

export function trackDapStartRequest<T>(promise: Promise<T>, failure: DapStartRequestFailure): Promise<T> {
	const tracked = promise.catch(error => {
		failure.rejected = true;
		failure.error = error;
		throw error;
	});
	failure.settled = tracked.then(
		() => {},
		() => {},
	);
	return tracked;
}

export function combineDapStartErrors(
	command: "launch" | "attach",
	startError: unknown,
	configurationError: unknown,
): Error {
	const startMessage = errorMessage(startError);
	const configurationMessage = errorMessage(configurationError);
	if (startMessage === configurationMessage) {
		return startError instanceof Error ? startError : new Error(startMessage);
	}
	return new Error(
		`DAP ${command} failed: ${startMessage}\nDAP configurationDone also failed: ${configurationMessage}`,
	);
}

export async function throwPreferredDapStartError(
	command: "launch" | "attach",
	startFailure: DapStartRequestFailure,
	configurationError: unknown,
): Promise<never> {
	await Promise.race([startFailure.settled ?? Promise.resolve(), timers.setTimeout(50)]);
	if (startFailure.rejected) {
		throw combineDapStartErrors(command, startFailure.error, configurationError);
	}
	throw configurationError;
}

export const DEBUGPY_MISSING_MODULE_RE = /No module named ['"]?debugpy['"]?/;

export function mapDebugpyMissingModule(adapterName: string, error: unknown): Error | null {
	if (adapterName !== "debugpy") return null;
	if (!DEBUGPY_MISSING_MODULE_RE.test(errorMessage(error))) return null;
	return new Error("adapter 'debugpy' is not available: install with 'pip install debugpy'");
}

export function normalizePath(filePath: string): string {
	return path.resolve(filePath);
}

export function truncateOutput(session: DapSession, output: string): void {
	if (!output) return;
	const bytes = Buffer.byteLength(output, "utf-8");
	session.outputChunks.push(output);
	session.outputBytes += bytes;
	session.outputBufferedBytes += bytes;
	while (session.outputChunks.length > 1) {
		const frontBytes = Buffer.byteLength(session.outputChunks[0], "utf-8");
		if (session.outputBufferedBytes - frontBytes < MAX_BUFFERED_OUTPUT_BYTES) break;
		session.outputChunks.shift();
		session.outputBufferedBytes -= frontBytes;
		session.outputTruncated = true;
	}
	if (session.outputBufferedBytes > MAX_BUFFERED_OUTPUT_BYTES) {
		const front = session.outputChunks[0];
		const frontBytes = Buffer.byteLength(front, "utf-8");
		const excess = session.outputBufferedBytes - MAX_BUFFERED_OUTPUT_BYTES;
		const kept = Buffer.from(front, "utf-8").subarray(excess).toString("utf-8");
		session.outputChunks[0] = kept;
		session.outputBufferedBytes += Buffer.byteLength(kept, "utf-8") - frontBytes;
		session.outputTruncated = true;
	}
}

function summarizeBreakpointCount(breakpoints: Map<string, DapBreakpointRecord[]>): number {
	let total = 0;
	for (const entries of breakpoints.values()) {
		total += entries.length;
	}
	return total;
}

export function buildSummary(session: DapSession): DapSessionSummary {
	return {
		id: session.id,
		adapter: session.adapter.name,
		cwd: session.cwd,
		program: session.program,
		status: session.status,
		launchedAt: new Date(session.launchedAt).toISOString(),
		lastUsedAt: new Date(session.lastUsedAt).toISOString(),
		threadId: session.stop.threadId,
		frameId: session.stop.frameId,
		stopReason: session.stop.reason,
		stopDescription: session.stop.description ?? session.stop.text,
		frameName: session.stop.frameName,
		instructionPointerReference: session.stop.instructionPointerReference,
		source: session.stop.source,
		line: session.stop.line,
		column: session.stop.column,
		breakpointFiles: session.breakpoints.size,
		breakpointCount: summarizeBreakpointCount(session.breakpoints),
		functionBreakpointCount: session.functionBreakpoints.length,
		outputBytes: session.outputBytes,
		outputTruncated: session.outputTruncated,
		exitCode: session.exitCode,
		needsConfigurationDone: session.needsConfigurationDone && !session.configurationDoneSent,
	};
}

export function reportTerminateFailure(session: DapSession, request: "terminate" | "disconnect", error: unknown): void {
	logger.warn("DAP teardown request failed; the debuggee may still be running", {
		session: session.id,
		request,
		error: errorMessage(error),
	});
}
