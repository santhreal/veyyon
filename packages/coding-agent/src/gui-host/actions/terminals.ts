import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { logger } from "@veyyon/utils";
import { writeFrame } from "../frames";
import type { TerminalInstance } from "../turns";
import { ensureTerminalsMap, flushPendingOutput, getAllTerminalsView, spawnTerminalPty } from "./terminal-session";
import type { ActionHandler, ActionHandlersMap } from "./types";

export * from "./terminal-session";

interface CreateTerminalPayload {
	cwd?: string;
	shell?: string;
	cols?: number;
	rows?: number;
}

const handleCreateTerminal: ActionHandler<CreateTerminalPayload | undefined> = async (ctx, payload) => {
	const terminals = ensureTerminalsMap(ctx);
	const id = `term-${randomUUID()}`;
	const targetCwd = payload?.cwd ? path.resolve(ctx.cwd, payload.cwd) : ctx.cwd;
	const targetShell = payload?.shell || process.env.SHELL || (process.platform === "win32" ? "cmd.exe" : "/bin/sh");
	const targetCols =
		typeof payload?.cols === "number" && Number.isInteger(payload.cols) && payload.cols > 0 ? payload.cols : 80;
	const targetRows =
		typeof payload?.rows === "number" && Number.isInteger(payload.rows) && payload.rows > 0 ? payload.rows : 24;

	const instance: TerminalInstance = {
		id,
		cwd: targetCwd,
		shell: targetShell,
		cols: targetCols,
		rows: targetRows,
		status: "Running",
		seq: 0,
		scrollback: Buffer.alloc(0),
		pendingChunks: [],
		pendingBytes: 0,
		flushTimer: null,
		resetNextChunk: true,
	};

	try {
		await spawnTerminalPty(ctx, instance);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		instance.status = { Failed: { message } };
		terminals.set(id, instance);
		ctx.clientState.revision += 1;
		ctx.reply.snapshot({
			Terminals: getAllTerminalsView(terminals),
		});
		ctx.reply.failure({
			scope: "Terminal",
			code: "TERMINAL_SPAWN_FAILED",
			message,
			retryable: false,
		});
		return;
	}

	terminals.set(id, instance);
	ctx.clientState.revision += 1;
	ctx.reply.snapshot({
		Terminals: getAllTerminalsView(terminals),
	});
	ctx.reply.success();
};

interface AttachTerminalPayload {
	terminal_id?: string;
}

const handleAttachTerminal: ActionHandler<AttachTerminalPayload | undefined> = (ctx, payload) => {
	const terminals = ensureTerminalsMap(ctx);
	if (!payload?.terminal_id || !terminals.has(payload.terminal_id)) {
		ctx.reply.failure({
			scope: "Terminal",
			code: "TERMINAL_NOT_FOUND",
			message: `Terminal '${payload?.terminal_id}' was not found`,
			retryable: false,
		});
		return;
	}

	const instance = terminals.get(payload.terminal_id)!;
	flushPendingOutput(ctx.socket, instance);

	instance.seq += 1;
	writeFrame(ctx.socket, {
		Snapshot: {
			TerminalOutput: {
				terminal: instance.id,
				seq: instance.seq,
				data: Array.from(instance.scrollback),
				reset: true,
			},
		},
	});

	ctx.reply.success();
};

interface WriteTerminalPayload {
	terminal_id?: string;
	data?: number[];
}

const handleWriteTerminal: ActionHandler<WriteTerminalPayload | undefined> = (ctx, payload) => {
	const terminals = ensureTerminalsMap(ctx);
	if (!payload?.terminal_id || !terminals.has(payload.terminal_id)) {
		ctx.reply.failure({
			scope: "Terminal",
			code: "TERMINAL_NOT_FOUND",
			message: `Terminal '${payload?.terminal_id}' was not found`,
			retryable: false,
		});
		return;
	}

	const instance = terminals.get(payload.terminal_id)!;
	if (instance.status !== "Running") {
		ctx.reply.failure({
			scope: "Terminal",
			code: "TERMINAL_NOT_RUNNING",
			message: `Terminal '${payload.terminal_id}' is not running`,
			retryable: false,
		});
		return;
	}

	if (instance.pty && payload.data && payload.data.length > 0) {
		try {
			const str = Buffer.from(payload.data).toString("utf8");
			instance.pty.write(str);
		} catch (error) {
			logger.warn("Terminal write failed on running PTY", {
				terminalId: instance.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	ctx.reply.success();
};

interface ResizeTerminalPayload {
	terminal_id?: string;
	cols?: number;
	rows?: number;
}

const handleResizeTerminal: ActionHandler<ResizeTerminalPayload | undefined> = (ctx, payload) => {
	if (
		typeof payload?.cols !== "number" ||
		!Number.isInteger(payload.cols) ||
		payload.cols <= 0 ||
		typeof payload?.rows !== "number" ||
		!Number.isInteger(payload.rows) ||
		payload.rows <= 0
	) {
		ctx.reply.failure({
			scope: "Terminal",
			code: "INVALID_ARGUMENTS",
			message: "ResizeTerminal requires positive integer cols and rows parameters",
			retryable: false,
		});
		return;
	}

	const terminals = ensureTerminalsMap(ctx);
	if (!payload?.terminal_id || !terminals.has(payload.terminal_id)) {
		ctx.reply.failure({
			scope: "Terminal",
			code: "TERMINAL_NOT_FOUND",
			message: `Terminal '${payload?.terminal_id}' was not found`,
			retryable: false,
		});
		return;
	}

	const instance = terminals.get(payload.terminal_id)!;
	if (instance.status !== "Running") {
		ctx.reply.failure({
			scope: "Terminal",
			code: "TERMINAL_NOT_RUNNING",
			message: `Terminal '${payload.terminal_id}' is not running`,
			retryable: false,
		});
		return;
	}

	instance.cols = payload.cols;
	instance.rows = payload.rows;

	if (instance.pty) {
		try {
			instance.pty.resize(payload.cols, payload.rows);
		} catch (error) {
			logger.warn("Terminal resize failed", {
				terminalId: instance.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	ctx.clientState.revision += 1;
	ctx.reply.snapshot({
		Terminals: getAllTerminalsView(terminals),
	});
	ctx.reply.success();
};

interface RestartTerminalPayload {
	terminal_id?: string;
}

const handleRestartTerminal: ActionHandler<RestartTerminalPayload | undefined> = async (ctx, payload) => {
	const terminals = ensureTerminalsMap(ctx);
	if (!payload?.terminal_id || !terminals.has(payload.terminal_id)) {
		ctx.reply.failure({
			scope: "Terminal",
			code: "TERMINAL_NOT_FOUND",
			message: `Terminal '${payload?.terminal_id}' was not found`,
			retryable: false,
		});
		return;
	}

	const instance = terminals.get(payload.terminal_id)!;
	if (instance.flushTimer) {
		clearTimeout(instance.flushTimer);
		instance.flushTimer = null;
	}
	if (instance.pty) {
		try {
			instance.pty.kill();
		} catch {
			// Ignore kill errors
		}
	}

	instance.scrollback = Buffer.alloc(0);
	instance.pendingChunks = [];
	instance.pendingBytes = 0;
	instance.resetNextChunk = true;
	instance.killed = false;

	try {
		await spawnTerminalPty(ctx, instance);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		instance.status = { Failed: { message } };
		ctx.clientState.revision += 1;
		ctx.reply.snapshot({
			Terminals: getAllTerminalsView(terminals),
		});
		ctx.reply.failure({
			scope: "Terminal",
			code: "TERMINAL_SPAWN_FAILED",
			message,
			retryable: false,
		});
		return;
	}

	ctx.clientState.revision += 1;
	ctx.reply.snapshot({
		Terminals: getAllTerminalsView(terminals),
	});
	ctx.reply.success();
};

interface ClearTerminalPayload {
	terminal_id?: string;
}

const handleClearTerminal: ActionHandler<ClearTerminalPayload | undefined> = (ctx, payload) => {
	const terminals = ensureTerminalsMap(ctx);
	if (!payload?.terminal_id || !terminals.has(payload.terminal_id)) {
		ctx.reply.failure({
			scope: "Terminal",
			code: "TERMINAL_NOT_FOUND",
			message: `Terminal '${payload?.terminal_id}' was not found`,
			retryable: false,
		});
		return;
	}

	const instance = terminals.get(payload.terminal_id)!;
	if (instance.flushTimer) {
		clearTimeout(instance.flushTimer);
		instance.flushTimer = null;
	}
	instance.scrollback = Buffer.alloc(0);
	instance.pendingChunks = [];
	instance.pendingBytes = 0;
	instance.resetNextChunk = true;

	instance.seq += 1;
	writeFrame(ctx.socket, {
		Snapshot: {
			TerminalOutput: {
				terminal: instance.id,
				seq: instance.seq,
				data: [],
				reset: true,
			},
		},
	});

	ctx.reply.success();
};

interface CloseTerminalPayload {
	terminal_id?: string;
}

const handleCloseTerminal: ActionHandler<CloseTerminalPayload | undefined> = (ctx, payload) => {
	const terminals = ensureTerminalsMap(ctx);
	if (!payload?.terminal_id || !terminals.has(payload.terminal_id)) {
		ctx.reply.failure({
			scope: "Terminal",
			code: "TERMINAL_NOT_FOUND",
			message: `Terminal '${payload?.terminal_id}' was not found`,
			retryable: false,
		});
		return;
	}

	const instance = terminals.get(payload.terminal_id)!;
	instance.killed = true;
	if (instance.flushTimer) {
		clearTimeout(instance.flushTimer);
		instance.flushTimer = null;
	}
	if (instance.pty) {
		try {
			instance.pty.kill();
		} catch {
			// Ignore kill errors
		}
	}

	terminals.delete(payload.terminal_id);
	ctx.clientState.revision += 1;
	ctx.reply.snapshot({
		Terminals: getAllTerminalsView(terminals),
	});
	ctx.reply.success();
};

export const terminalsActionHandlers: ActionHandlersMap = {
	CreateTerminal: handleCreateTerminal as ActionHandler<never>,
	AttachTerminal: handleAttachTerminal as ActionHandler<never>,
	WriteTerminal: handleWriteTerminal as ActionHandler<never>,
	ResizeTerminal: handleResizeTerminal as ActionHandler<never>,
	RestartTerminal: handleRestartTerminal as ActionHandler<never>,
	ClearTerminal: handleClearTerminal as ActionHandler<never>,
	CloseTerminal: handleCloseTerminal as ActionHandler<never>,
};
