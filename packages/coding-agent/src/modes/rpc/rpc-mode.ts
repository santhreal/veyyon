/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */
import { errorMessage, isRecord, readLines } from "@veyyon/utils";
import { exitAfterStdoutDrain } from "../../cli/stdout-drain";
import { reset as resetCapabilities } from "../../discovery/capability";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../../discovery/helpers";
import { loadSlashCommands } from "../../extensibility/slash-commands";
import { type AttachableSession, BackgroundSessions, type NextSessionFactory } from "../../session/background-sessions";
import { buildAvailableSlashCommands } from "../../slash-commands/available-commands";
import type { EventBus } from "../../utils/event-bus";
import { initializeExtensions } from "../runtime-init";
import { isRpcHostToolResult, isRpcHostToolUpdate, RpcHostToolBridge } from "./host-tools";
import { isRpcHostUriResult, RpcHostUriBridge } from "./host-uris";
import { RpcAgentRegistry } from "./rpc-agents";
import { handleRpcCommand, type RpcCommandHost, rpcErrorResponse } from "./rpc-commands";
import { RpcExtensionUserMessageTracker } from "./rpc-prompt-result";
import { type RpcSessionRouting, RpcSessionSlot } from "./rpc-session-slot";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolResult,
	RpcHostToolUpdate,
	RpcHostUriCancelRequest,
	RpcHostUriRequest,
	RpcHostUriResult,
	RpcResponse,
} from "./rpc-types";
import {
	type PendingExtensionRequest,
	RpcExtensionUIContext,
	RpcPendingExtensionRequests,
	shouldEmitRpcTitles,
} from "./rpc-ui-context";

// Re-export types for consumers
export type * from "./rpc-types";

const LINE_DECODER = new TextDecoder();

type RpcOutput = (
	obj:
		| RpcResponse
		| RpcExtensionUIRequest
		| RpcHostToolCallRequest
		| RpcHostToolCancelRequest
		| RpcHostUriRequest
		| RpcHostUriCancelRequest
		| object,
) => void;

/**
 * Dependencies for {@link dispatchRpcInputFrame}. Provided by the RPC mode
 * entrypoint; broken out so tests can drive the input loop with stubs.
 */
export interface RpcInputFrameDeps {
	handleCommand: (command: RpcCommand) => Promise<RpcResponse>;
	output: RpcOutput;
	errorResponse: (id: string | undefined, command: string, message: string) => RpcResponse;
	trackBackgroundTask?: (task: Promise<void>) => void;
	pendingExtensionRequests: Map<string, PendingExtensionRequest>;
	onHostToolResult: (frame: RpcHostToolResult) => void;
	onHostToolUpdate: (frame: RpcHostToolUpdate) => void;
	onHostUriResult: (frame: RpcHostUriResult) => void;
}

/**
 * Structural guard for a well-formed extension UI response frame. Mirrors the
 * shape declared in {@link RpcExtensionUIResponse} — a truthy record with
 * `type === "extension_ui_response"` and a string `id`. Payload variants (value,
 * confirmed, cancelled) are validated at the read site.
 */
function isRpcExtensionUIResponse(value: unknown): value is RpcExtensionUIResponse {
	if (!isRecord(value)) return false;
	return value.type === "extension_ui_response" && typeof value.id === "string";
}

/** Dispatch side-channel frames that must overtake the serialized command queue. */
export function dispatchRpcControlFrame(parsed: unknown, deps: RpcInputFrameDeps): boolean {
	if (isRpcExtensionUIResponse(parsed)) {
		const pending = deps.pendingExtensionRequests.get(parsed.id);
		if (pending) pending.resolve(parsed);
		return true;
	}

	if (isRpcHostToolResult(parsed)) {
		deps.onHostToolResult(parsed);
		return true;
	}

	if (isRpcHostToolUpdate(parsed)) {
		deps.onHostToolUpdate(parsed);
		return true;
	}

	if (isRpcHostUriResult(parsed)) {
		deps.onHostUriResult(parsed);
		return true;
	}

	return false;
}

/**
 * Dispatch a single parsed frame from the RPC input stream.
 *
 * Bash commands are dispatched in the background so the caller can keep reading
 * subsequent frames while a shell command is still running. This lets a client
 * send `abort_bash` while a long-running `bash` is in flight. Response
 * correlation is preserved via each command's `id`; ordering across concurrent
 * commands is not guaranteed and clients MUST match on `id`.
 *
 * @returns `undefined` when the frame was routed to a side-channel handler
 *   (extension UI response, host tool/URI frames) or dispatched in the
 *   background (`bash`). Otherwise a promise that resolves once the response
 *   for the command has been emitted via `output`. Errors from `handleCommand`
 *   on non-`bash` commands propagate; the caller is expected to wrap them.
 */
export function dispatchRpcInputFrame(parsed: unknown, deps: RpcInputFrameDeps): Promise<void> | undefined {
	if (dispatchRpcControlFrame(parsed, deps)) return undefined;
	// Regular RPC command. The transport contract states each remaining frame
	// is an {@link RpcCommand}; `handleCommand`'s `default` arm surfaces
	// unknown discriminants as an error response, so we do not shape-check
	// the union here.
	const command = parsed as RpcCommand;

	// `bash` can run for a long time. Dispatch it in the background so a
	// subsequent `abort_bash` frame can be read and handled without waiting
	// for the shell command to finish on its own. The response is emitted
	// when `handleCommand` resolves; clients correlate via `command.id`.
	if (command.type === "bash") {
		const task = (async () => {
			try {
				deps.output(await deps.handleCommand(command));
			} catch (err: unknown) {
				const message = errorMessage(err);
				deps.output(deps.errorResponse(command.id, "bash", message));
			}
		})();
		deps.trackBackgroundTask?.(task);
		return undefined;
	}

	return (async () => {
		deps.output(await deps.handleCommand(command));
	})();
}

/** Serializes ordinary RPC commands while allowing control frames to dispatch immediately. */
export class RpcInputDispatcher {
	#tail: Promise<void> = Promise.resolve();
	#tasks = new Set<Promise<void>>();
	readonly #deps: RpcInputFrameDeps;
	readonly #afterSerialCommand: (() => Promise<void>) | undefined;

	constructor(options: { deps: RpcInputFrameDeps; afterSerialCommand?: () => Promise<void> }) {
		this.#deps = options.deps;
		this.#afterSerialCommand = options.afterSerialCommand;
	}

	/**
	 * Accept one raw stdin line. A line that is not JSON answers with the
	 * documented `parse` error frame and the reader continues; the JSONL
	 * chunk parser this replaced threw out of the input loop on the first bad
	 * line and took every later frame (and the process) with it.
	 */
	dispatchLine(line: Uint8Array): void {
		const text = LINE_DECODER.decode(line);
		if (text.trim().length === 0) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (err: unknown) {
			const message = errorMessage(err);
			this.#deps.output(this.#deps.errorResponse(undefined, "parse", `Failed to parse command: ${message}`));
			return;
		}
		this.dispatch(parsed);
	}

	/** Accept a parsed input frame without blocking the stdin reader. */
	dispatch(parsed: unknown): void {
		try {
			if (dispatchRpcControlFrame(parsed, this.#deps)) return;

			const command = parsed as RpcCommand;
			if (command.type === "bash") {
				dispatchRpcInputFrame(command, this.#deps);
				return;
			}

			const task = this.#tail.then(
				() => this.#dispatchSerialCommand(command),
				() => this.#dispatchSerialCommand(command),
			);
			// `task` is tracked in `#tasks` and its failure is handled by the dispatcher itself; the tail only
			// serializes the next command, so it must settle rather than inherit the rejection.
			this.#tail = task.catch(() => {});
			this.#tasks.add(task);
			void task.finally(() => {
				this.#tasks.delete(task);
			});
		} catch (err: unknown) {
			const message = errorMessage(err);
			this.#deps.output(this.#deps.errorResponse(undefined, "parse", `Failed to parse command: ${message}`));
		}
	}

	/** Await every accepted serial command, including commands queued before EOF. */
	async drain(): Promise<void> {
		while (this.#tasks.size > 0) {
			await Promise.allSettled(Array.from(this.#tasks));
		}
	}

	async #dispatchSerialCommand(command: RpcCommand): Promise<void> {
		try {
			const awaited = dispatchRpcInputFrame(command, this.#deps);
			if (awaited) await awaited;
		} catch (err: unknown) {
			const message = errorMessage(err);
			this.#deps.output(this.#deps.errorResponse(command.id, command.type, message));
		} finally {
			await this.#afterSerialCommand?.();
		}
	}
}

/**
 * Coordinates deferred shutdown with in-flight background input tasks.
 *
 * `pi.shutdown()` from an extension only *requests* shutdown; the process must
 * not exit while a background-dispatched command (`bash`, see
 * {@link dispatchRpcInputFrame}) still owes the client a response frame. The
 * coordinator tracks those tasks, re-checks the shutdown request whenever one
 * settles (covering a shutdown requested mid-bash with no follow-up client
 * frame), and drains every tracked task before invoking `performShutdown`.
 * The shutdown sequence is latched so concurrent triggers (input loop and
 * settling tasks) run it exactly once.
 */
export class RpcShutdownCoordinator {
	#tasks = new Set<Promise<void>>();
	#shutdown: Promise<void> | undefined;
	readonly #isShutdownRequested: () => boolean;
	readonly #performShutdown: () => Promise<void>;

	constructor(options: { isShutdownRequested: () => boolean; performShutdown: () => Promise<void> }) {
		this.#isShutdownRequested = options.isShutdownRequested;
		this.#performShutdown = options.performShutdown;
	}

	/**
	 * Track a background input task. When it settles it is untracked and the
	 * shutdown request is re-checked, so a deferred shutdown fires even when
	 * no further client frames arrive.
	 */
	track(task: Promise<void>): void {
		this.#tasks.add(task);
		void task.finally(() => {
			this.#tasks.delete(task);
			// Fire-and-forget: performShutdown ends the process. Rejections are
			// not expected — hook errors are caught inside extensionRunner.emit,
			// and background tasks catch their own dispatch errors.
			void this.checkShutdownRequested();
		});
	}

	/** Await every tracked task, including tasks tracked while draining. */
	async drain(): Promise<void> {
		while (this.#tasks.size > 0) {
			await Promise.allSettled(Array.from(this.#tasks));
		}
	}

	/**
	 * If shutdown was requested, drain background tasks (so every owed
	 * response frame is written) before running the shutdown sequence.
	 */
	checkShutdownRequested(): Promise<void> {
		if (!this.#shutdown) {
			if (!this.#isShutdownRequested()) return Promise.resolve();
			this.#shutdown = this.drain().then(() => this.#performShutdown());
		}
		return this.#shutdown;
	}
}

export interface RpcModeOptions {
	/** Install the RPC extension UI on the session's tools (`--mode rpc-ui`). */
	readonly ui: boolean;
	readonly eventBus?: EventBus;
	/** Builds the session `new_session` with `background: true` attaches. */
	readonly createNextSession?: NextSessionFactory;
}

/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
export async function runRpcMode(attached: AttachableSession, options: RpcModeOptions): Promise<never> {
	// Signal to RPC clients that the server is ready to accept commands
	// Suppress terminal notifications: they write \x07 (BEL) or OSC sequences directly to
	// process.stdout with no newline, which the reader merges with the next JSON line and
	// breaks JSON.parse. In RPC mode stdout is the JSON protocol channel — nothing else
	// may write there.
	process.env.VEYYON_NOTIFICATIONS = "off";

	process.stdout.write(`${JSON.stringify({ type: "ready" })}\n`);
	const output = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
		process.stdout.write(`${JSON.stringify(obj)}\n`);
	};

	const extensionUserMessageTracker = new RpcExtensionUserMessageTracker();

	const pendingExtensionRequests = new RpcPendingExtensionRequests();
	const hostToolBridge = new RpcHostToolBridge(output);
	const hostUriBridge = new RpcHostUriBridge(output);
	const agentRegistry = options.eventBus ? new RpcAgentRegistry(options.eventBus, output) : undefined;

	// Shutdown request flag (wrapped in object to allow mutation with const)
	const shutdownState = { requested: false };

	// One shared UI context routes every response received on stdin to the
	// waiting promise, whichever session's tool or extension created the request.
	const rpcUiContext = new RpcExtensionUIContext(pendingExtensionRequests, output, {
		emitTitles: shouldEmitRpcTitles(),
	});

	const routing: RpcSessionRouting = {
		route: session => {
			const stopEvents = session.subscribe(event => {
				output(event);
			});
			const stopCommandUpdates = session.subscribeCommandMetadataChanged(() => {
				void emitAvailableCommandsUpdate();
			});
			return () => {
				stopEvents();
				stopCommandUpdates();
			};
		},
		adopt: async next => {
			if (options.ui) next.setToolUIContext(rpcUiContext, true);
			await initializeExtensions(next.session, {
				reportSendError: (action, err) => {
					output(rpcErrorResponse(undefined, action, err.message));
				},
				reportRuntimeError: err => {
					output({
						type: "extension_error",
						extensionPath: err.extensionPath,
						event: err.event,
						error: err.error,
					});
				},
				onShutdown: () => {
					shutdownState.requested = true;
				},
				trackAgentInvokingMessage: task => {
					extensionUserMessageTracker.trackAgentMessageTask(task);
				},
				uiContext: rpcUiContext,
			});
			if (hostToolBridge.tools.length > 0) await next.session.refreshRpcHostTools(hostToolBridge.tools);
		},
	};
	await routing.adopt(attached);
	const slot = new RpcSessionSlot(attached.session, { routing, createNextSession: options.createNextSession });

	const availableCommands = async () => buildAvailableSlashCommands(slot.session);
	const reloadPlugins = async () => {
		const session = slot.session;
		const cwd = session.sessionManager.getCwd();
		const projectPath = await resolveActiveProjectRegistryPath(cwd);
		clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
		resetCapabilities();
		session.setSlashCommands(await loadSlashCommands({ cwd }));
		await session.refreshSshTool({ activateIfAvailable: true });
		await emitAvailableCommandsUpdate();
	};
	const emitAvailableCommandsUpdate = async () => {
		output({ type: "available_commands_update", commands: await availableCommands() });
	};
	await emitAvailableCommandsUpdate();

	const commandHost: RpcCommandHost = {
		output,
		slot,
		agentRegistry,
		hostTools: hostToolBridge,
		hostUris: hostUriBridge,
		uiContext: rpcUiContext,
		extensionUserMessageTracker,
		availableCommands,
		emitAvailableCommandsUpdate,
		reloadPlugins,
	};
	// The session at dispatch: a command that outlives a handoff stays with the session it was sent to.
	const handleCommand = (command: RpcCommand) => handleRpcCommand(command, slot.session, commandHost);

	// Deferred shutdown (pi.shutdown() from an extension) must not kill the
	// process while a background-dispatched bash still owes the client its
	// response frame. The coordinator drains tracked tasks before exiting and
	// re-checks the request as each task settles.
	const shutdownCoordinator = new RpcShutdownCoordinator({
		isShutdownRequested: () => shutdownState.requested,
		performShutdown: async () => {
			const session = slot.session;
			if (session.extensionRunner?.hasHandlers("session_shutdown")) {
				await session.extensionRunner.emit({ type: "session_shutdown" });
			}
			await BackgroundSessions.global().drain();
			await exitAfterStdoutDrain(0);
		},
	});

	const dispatchFrameDeps: RpcInputFrameDeps = {
		handleCommand,
		output,
		errorResponse: rpcErrorResponse,
		trackBackgroundTask: task => shutdownCoordinator.track(task),
		pendingExtensionRequests,
		onHostToolResult: frame => hostToolBridge.handleResult(frame),
		onHostToolUpdate: frame => hostToolBridge.handleUpdate(frame),
		onHostUriResult: frame => hostUriBridge.handleResult(frame),
	};

	const inputDispatcher = new RpcInputDispatcher({
		deps: dispatchFrameDeps,
		afterSerialCommand: () => shutdownCoordinator.checkShutdownRequested(),
	});

	// Keep the stdin reader moving: side-channel frames dispatch immediately,
	// ordinary commands serialize through inputDispatcher, and bash remains
	// background-dispatched so abort_bash can overtake it. Lines are parsed one
	// at a time so a malformed line answers `parse` instead of ending the loop.
	for await (const line of readLines(Bun.stdin.stream())) {
		inputDispatcher.dispatchLine(line);
	}

	// stdin closed — RPC client is gone. Fail pending side-channel requests
	// first so active/queued commands can settle, then drain accepted work.
	pendingExtensionRequests.rejectAll("RPC client disconnected before extension UI response completed");
	hostToolBridge.close("RPC client disconnected before host tool execution completed");
	hostUriBridge.clear("RPC client disconnected before host URI request completed");
	await inputDispatcher.drain();
	await shutdownCoordinator.drain();
	await BackgroundSessions.global().drain();
	agentRegistry?.dispose();
	return exitAfterStdoutDrain(0);
}
