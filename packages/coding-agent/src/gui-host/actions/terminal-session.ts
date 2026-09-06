import * as fs from "node:fs/promises";
import type * as net from "node:net";
import { PtySession } from "@veyyon/natives";
import { logger } from "@veyyon/utils";
import { writeFrame } from "../frames";
import type { ClientSessionState, TerminalInstance } from "../turns";
import type { TerminalView } from "../wire";
import type { ActionContext } from "./types";

/** Maximum bounded scrollback retained in host memory per terminal (128 KiB). */
export const SCROLLBACK_CAP_BYTES = 128 * 1024;

/** Coalescing throttle window for rapid terminal output bursts (8 ms). */
export const BURST_FLUSH_INTERVAL_MS = 8;

/** Maximum buffered output bytes before forcing an immediate frame flush (64 KiB). */
export const BURST_FLUSH_MAX_BYTES = 64 * 1024;

export function ensureTerminalsMap(ctx: ActionContext): Map<string, TerminalInstance> {
	if (!ctx.clientState.terminals) {
		ctx.clientState.terminals = new Map<string, TerminalInstance>();
		ctx.socket.once("close", () => {
			if (ctx.clientState.terminals) {
				for (const terminal of ctx.clientState.terminals.values()) {
					if (terminal.flushTimer) {
						clearTimeout(terminal.flushTimer);
						terminal.flushTimer = null;
					}
					terminal.killed = true;
					if (terminal.pty) {
						try {
							terminal.pty.kill();
						} catch {
							// Ignore kill error on socket teardown
						}
					}
				}
				ctx.clientState.terminals.clear();
			}
		});
	}
	return ctx.clientState.terminals;
}

export function getAllTerminalsView(terminals: Map<string, TerminalInstance>): TerminalView[] {
	return Array.from(terminals.values()).map(t => ({
		id: t.id,
		cwd: t.cwd,
		shell: t.shell,
		cols: t.cols,
		rows: t.rows,
		status: t.status,
	}));
}

function appendToScrollback(existing: Buffer, addition: Buffer): Buffer {
	const combined = Buffer.concat([existing, addition]);
	if (combined.length <= SCROLLBACK_CAP_BYTES) {
		return combined;
	}
	return combined.subarray(combined.length - SCROLLBACK_CAP_BYTES);
}

export function flushPendingOutput(socket: net.Socket, terminal: TerminalInstance): void {
	if (terminal.flushTimer) {
		clearTimeout(terminal.flushTimer);
		terminal.flushTimer = null;
	}
	if (terminal.pendingBytes === 0) {
		return;
	}

	const coalesced = Buffer.concat(terminal.pendingChunks);
	terminal.pendingChunks = [];
	terminal.pendingBytes = 0;

	const reset = terminal.resetNextChunk;
	terminal.resetNextChunk = false;
	terminal.seq += 1;

	writeFrame(socket, {
		Snapshot: {
			TerminalOutput: {
				terminal: terminal.id,
				seq: terminal.seq,
				data: Array.from(coalesced),
				reset,
			},
		},
	});
}

export function pushPtyChunk(socket: net.Socket, terminal: TerminalInstance, chunk: string): void {
	if (terminal.killed) {
		return;
	}
	const buf = Buffer.from(chunk, "utf8");
	terminal.pendingChunks.push(buf);
	terminal.pendingBytes += buf.length;
	terminal.scrollback = appendToScrollback(terminal.scrollback, buf);

	if (terminal.pendingBytes >= BURST_FLUSH_MAX_BYTES) {
		flushPendingOutput(socket, terminal);
	} else if (!terminal.flushTimer) {
		terminal.flushTimer = setTimeout(() => {
			terminal.flushTimer = null;
			flushPendingOutput(socket, terminal);
		}, BURST_FLUSH_INTERVAL_MS);
	}
}

export function onPtyExit(
	socket: net.Socket,
	clientState: ClientSessionState,
	terminal: TerminalInstance,
	exitCode: number,
): void {
	if (terminal.killed) {
		return;
	}
	flushPendingOutput(socket, terminal);
	terminal.status = { Exited: { code: exitCode } };
	clientState.revision += 1;
	if (clientState.terminals) {
		writeFrame(socket, {
			Snapshot: {
				Terminals: getAllTerminalsView(clientState.terminals),
			},
		});
	}
}

export function onPtySpawnError(
	socket: net.Socket,
	clientState: ClientSessionState,
	terminal: TerminalInstance,
	message: string,
): void {
	if (terminal.killed) {
		return;
	}
	flushPendingOutput(socket, terminal);
	terminal.status = { Failed: { message } };
	clientState.revision += 1;
	if (clientState.terminals) {
		writeFrame(socket, {
			Snapshot: {
				Terminals: getAllTerminalsView(clientState.terminals),
			},
		});
	}
}

export async function spawnTerminalPty(ctx: ActionContext, instance: TerminalInstance): Promise<void> {
	const stat = await fs.stat(instance.cwd);
	if (!stat.isDirectory()) {
		throw new Error(`Directory not found: ${instance.cwd}`);
	}

	const pty = new PtySession();
	instance.pty = pty;
	instance.status = "Running";

	const runPromise = pty.start(
		{
			command: instance.shell,
			cwd: instance.cwd,
			cols: instance.cols,
			rows: instance.rows,
		},
		(error, chunk) => {
			if (error) {
				logger.error("PTY output streaming error", { terminalId: instance.id, error: error.message });
				return;
			}
			if (chunk) {
				pushPtyChunk(ctx.socket, instance, chunk);
			}
		},
	);

	runPromise
		.then(result => {
			onPtyExit(ctx.socket, ctx.clientState, instance, result.exitCode ?? 0);
		})
		.catch(error => {
			onPtySpawnError(ctx.socket, ctx.clientState, instance, error instanceof Error ? error.message : String(error));
		});
}
