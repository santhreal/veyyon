import { isPromise } from "node:util/types";
import type { AgentEvent, AgentMessage, ThinkingLevel } from "@veyyon/agent-core";
import type { CompactionResult } from "@veyyon/agent-core/compaction";
import type { ImageContent } from "@veyyon/ai";
import { errorMessage, isRecord, ptree, readJsonl } from "@veyyon/utils";
import type { FileSink } from "bun";
import type { BashResult } from "../../exec/bash-executor";
import type { SessionStats } from "../../session/agent-session";
import { primarySessionCpuAdoption } from "../../session/cpu-limit";
import type {
	ModelInfo,
	RpcAvailableCommandsUpdateListener,
	RpcClientCustomTool,
	RpcClientOptions,
	RpcClientToolResult,
	RpcCommandBody,
	RpcEventListener,
	RpcSessionEventListener,
	RpcSubagentEventListener,
	RpcSubagentLifecycleListener,
	RpcSubagentProgressListener,
} from "./rpc-client-helpers";

export * from "./rpc-client-helpers";

import {
	isAgentEvent,
	isAgentSessionEvent,
	isRpcAvailableCommandsUpdateFrame,
	isRpcExtensionUiRequest,
	isRpcHostToolCallRequest,
	isRpcHostToolCancelRequest,
	isRpcResponse,
	isRpcSubagentEventFrame,
	isRpcSubagentLifecycleFrame,
	isRpcSubagentProgressFrame,
	normalizeToolResult,
} from "./rpc-client-helpers";
import type {
	RpcAvailableSlashCommand,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcHandoffResult,
	RpcHostToolCallRequest,
	RpcHostToolDefinition,
	RpcHostToolResult,
	RpcHostToolUpdate,
	RpcResponse,
	RpcSessionState,
	RpcSubagentMessagesResult,
	RpcSubagentSnapshot,
	RpcSubagentSubscriptionLevel,
} from "./rpc-types";

export class RpcClient {
	#process: ptree.ChildProcess | null = null;
	#eventListeners: RpcEventListener[] = [];
	#sessionEventListeners: RpcSessionEventListener[] = [];
	#subagentLifecycleListeners = new Set<RpcSubagentLifecycleListener>();
	#subagentProgressListeners = new Set<RpcSubagentProgressListener>();
	#subagentEventListeners = new Set<RpcSubagentEventListener>();
	#availableCommandsUpdateListeners = new Set<RpcAvailableCommandsUpdateListener>();
	#pendingRequests: Map<string, { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }> =
		new Map();
	#customTools: RpcClientCustomTool[] = [];
	#pendingHostToolCalls = new Map<string, { controller: AbortController }>();
	#requestId = 0;
	#extensionUiListeners: Set<(req: RpcExtensionUIRequest) => void> = new Set();
	#abortController = new AbortController();

	constructor(private options: RpcClientOptions = {}) {
		this.#customTools = [...(options.customTools ?? [])];
	}

	async start(): Promise<void> {
		if (this.#process) {
			throw new Error("Client already started");
		}

		this.#abortController = new AbortController();

		const cliPath = this.options.cliPath ?? "dist/cli.js";
		const args = ["--mode", "rpc"];

		if (this.options.provider) {
			args.push("--provider", this.options.provider);
		}
		if (this.options.model) {
			args.push("--model", this.options.model);
		}
		if (this.options.sessionDir) {
			args.push("--session-dir", this.options.sessionDir);
		}
		if (this.options.args) {
			for (let ai = 0; ai < this.options.args.length; ai++) args.push(this.options.args[ai]!);
		}

		const child = ptree.spawn(["bun", cliPath, ...args], {
			cwd: this.options.cwd,
			env: { ...Bun.env, ...this.options.env },
			stdin: "pipe",
			onSpawnPid: primarySessionCpuAdoption(),
		});
		this.#process = child;

		const { promise: readyPromise, resolve: readyResolve, reject: readyReject } = Promise.withResolvers<void>();
		let readySettled = false;

		const lines = readJsonl(child.stdout, this.#abortController.signal);
		void (async () => {
			for await (const line of lines) {
				if (!readySettled && isRecord(line) && line.type === "ready") {
					readySettled = true;
					readyResolve();
					continue;
				}
				this.#handleLine(line);
			}
			if (readySettled) return;
			await child.exited.catch(() => {});
			if (!readySettled) {
				readySettled = true;
				readyReject(new Error(`Agent process exited before ready. Stderr: ${child.peekStderr()}`));
			}
		})().catch((err: Error) => {
			if (!readySettled) {
				readySettled = true;
				readyReject(err);
			}
		});

		void child.exited.then(
			(exitCode: number) => {
				if (readySettled) return;
				readySettled = true;
				readyReject(new Error(`Agent process exited with code ${exitCode}. Stderr: ${child.peekStderr()}`));
			},
			(err: Error) => {
				if (readySettled) return;
				readySettled = true;
				readyReject(new Error(`Agent process exited before ready. Stderr: ${child.peekStderr()}`, { cause: err }));
			},
		);

		const readyTimeout = this.#startTimeout(30000, () => {
			if (readySettled) return;
			readySettled = true;
			readyReject(new Error(`Timeout waiting for agent to become ready. Stderr: ${child.peekStderr()}`));
		});

		try {
			await readyPromise;
			if (this.#customTools.length > 0) {
				await this.setCustomTools(this.#customTools);
			}
		} catch (err) {
			try {
				child.kill();
			} catch {}
			this.#abortController.abort();
			if (this.#process === child) {
				this.#process = null;
			}
			throw err;
		} finally {
			clearTimeout(readyTimeout);
		}
	}

	stop() {
		if (!this.#process) return;

		this.#process.kill();
		this.#abortController.abort();
		this.#process = null;
		this.#pendingRequests.clear();
		for (const pendingCall of this.#pendingHostToolCalls.values()) {
			pendingCall.controller.abort();
		}
		this.#pendingHostToolCalls.clear();
	}

	[Symbol.dispose](): void {
		try {
			this.stop();
		} catch {}
	}

	onEvent(listener: RpcEventListener): () => void {
		this.#eventListeners.push(listener);
		return () => {
			const index = this.#eventListeners.indexOf(listener);
			if (index !== -1) {
				this.#eventListeners.splice(index, 1);
			}
		};
	}

	onSessionEvent(listener: RpcSessionEventListener): () => void {
		this.#sessionEventListeners.push(listener);
		return () => {
			const index = this.#sessionEventListeners.indexOf(listener);
			if (index !== -1) {
				this.#sessionEventListeners.splice(index, 1);
			}
		};
	}

	onSubagentLifecycle(listener: RpcSubagentLifecycleListener): () => void {
		this.#subagentLifecycleListeners.add(listener);
		return () => this.#subagentLifecycleListeners.delete(listener);
	}

	onSubagentProgress(listener: RpcSubagentProgressListener): () => void {
		this.#subagentProgressListeners.add(listener);
		return () => this.#subagentProgressListeners.delete(listener);
	}

	onSubagentEvent(listener: RpcSubagentEventListener): () => void {
		this.#subagentEventListeners.add(listener);
		return () => this.#subagentEventListeners.delete(listener);
	}

	onAvailableCommandsUpdate(listener: RpcAvailableCommandsUpdateListener): () => void {
		this.#availableCommandsUpdateListeners.add(listener);
		return () => this.#availableCommandsUpdateListeners.delete(listener);
	}

	getStderr(): string {
		return this.#process?.peekStderr() ?? "";
	}

	#startTimeout(timeoutMs: number, onTimeout: () => void): NodeJS.Timeout {
		const timer = setTimeout(onTimeout, timeoutMs);
		timer.unref();
		return timer;
	}

	async prompt(message: string, images?: ImageContent[]): Promise<void> {
		await this.#send({ type: "prompt", message, images });
	}

	async steer(message: string, images?: ImageContent[]): Promise<void> {
		await this.#send({ type: "steer", message, images });
	}

	async followUp(message: string, images?: ImageContent[]): Promise<void> {
		await this.#send({ type: "follow_up", message, images });
	}

	async abort(): Promise<void> {
		await this.#send({ type: "abort" });
	}

	async abortAndPrompt(message: string, images?: ImageContent[]): Promise<void> {
		await this.#send({ type: "abort_and_prompt", message, images });
	}

	async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
		const response = await this.#send({ type: "new_session", parentSession });
		return this.#getData(response);
	}

	async getState(): Promise<RpcSessionState> {
		const response = await this.#send({ type: "get_state" });
		return this.#getData(response);
	}

	async setSubagentSubscription(level: RpcSubagentSubscriptionLevel): Promise<RpcSubagentSubscriptionLevel> {
		const response = await this.#send({ type: "set_subagent_subscription", level });
		return this.#getData<{ level: RpcSubagentSubscriptionLevel }>(response).level;
	}

	async getSubagents(): Promise<RpcSubagentSnapshot[]> {
		const response = await this.#send({ type: "get_subagents" });
		return this.#getData<{ subagents: RpcSubagentSnapshot[] }>(response).subagents;
	}

	async getSubagentMessages(selector: {
		subagentId?: string;
		sessionFile?: string;
		fromByte?: number;
	}): Promise<RpcSubagentMessagesResult> {
		const response = await this.#send({
			type: "get_subagent_messages",
			subagentId: selector.subagentId,
			sessionFile: selector.sessionFile,
			fromByte: selector.fromByte,
		});
		return this.#getData<RpcSubagentMessagesResult>(response);
	}

	async setModel(provider: string, modelId: string): Promise<{ provider: string; id: string }> {
		const response = await this.#send({ type: "set_model", provider, modelId });
		return this.#getData(response);
	}

	async cycleModel(): Promise<{
		model: { provider: string; id: string };
		thinkingLevel: ThinkingLevel | undefined;
		isScoped: boolean;
	} | null> {
		const response = await this.#send({ type: "cycle_model" });
		return this.#getData(response);
	}

	async getAvailableModels(): Promise<ModelInfo[]> {
		const response = await this.#send({ type: "get_available_models" });
		return this.#getData<{ models: ModelInfo[] }>(response).models;
	}

	async getAvailableCommands(): Promise<RpcAvailableSlashCommand[]> {
		const response = await this.#send({ type: "get_available_commands" });
		return this.#getData<{ commands: RpcAvailableSlashCommand[] }>(response).commands;
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		await this.#send({ type: "set_thinking_level", level });
	}

	async cycleThinkingLevel(): Promise<{ level: ThinkingLevel } | null> {
		const response = await this.#send({ type: "cycle_thinking_level" });
		return this.#getData(response);
	}

	async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.#send({ type: "set_steering_mode", mode });
	}

	async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.#send({ type: "set_follow_up_mode", mode });
	}

	async compact(customInstructions?: string): Promise<CompactionResult> {
		const response = await this.#send({ type: "compact", customInstructions });
		return this.#getData(response);
	}

	async setAutoCompaction(enabled: boolean): Promise<void> {
		await this.#send({ type: "set_auto_compaction", enabled });
	}

	async setAutoRetry(enabled: boolean): Promise<void> {
		await this.#send({ type: "set_auto_retry", enabled });
	}

	async abortRetry(): Promise<void> {
		await this.#send({ type: "abort_retry" });
	}

	async bash(command: string): Promise<BashResult> {
		const response = await this.#send({ type: "bash", command });
		return this.#getData(response);
	}

	async abortBash(): Promise<void> {
		await this.#send({ type: "abort_bash" });
	}

	async getSessionStats(): Promise<SessionStats> {
		const response = await this.#send({ type: "get_session_stats" });
		return this.#getData(response);
	}

	async handoff(customInstructions?: string): Promise<RpcHandoffResult | null> {
		const response = await this.#send({ type: "handoff", customInstructions });
		return this.#getData(response);
	}

	async exportHtml(outputPath?: string): Promise<{ path: string }> {
		const response = await this.#send({ type: "export_html", outputPath });
		return this.#getData(response);
	}

	async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		const response = await this.#send({ type: "switch_session", sessionPath });
		return this.#getData(response);
	}

	async branch(entryId: string): Promise<{ text: string; cancelled: boolean }> {
		const response = await this.#send({ type: "branch", entryId });
		return this.#getData(response);
	}

	async getBranchMessages(): Promise<Array<{ entryId: string; text: string }>> {
		const response = await this.#send({ type: "get_branch_messages" });
		return this.#getData<{ messages: Array<{ entryId: string; text: string }> }>(response).messages;
	}

	async getLastAssistantText(): Promise<string | null> {
		const response = await this.#send({ type: "get_last_assistant_text" });
		return this.#getData<{ text: string | null }>(response).text;
	}

	async getMessages(): Promise<AgentMessage[]> {
		const response = await this.#send({ type: "get_messages" });
		return this.#getData<{ messages: AgentMessage[] }>(response).messages;
	}

	async getLoginProviders(): Promise<Array<{ id: string; name: string; available: boolean; authenticated: boolean }>> {
		const response = await this.#send({ type: "get_login_providers" });
		return this.#getData<{
			providers: Array<{ id: string; name: string; available: boolean; authenticated: boolean }>;
		}>(response).providers;
	}

	async login(
		providerId: string,
		options?: {
			onOpenUrl?: (url: string, instructions?: string, launchUrl?: string) => void;
			onManualCodeInput?: (prompt: { title: string; placeholder?: string }) => string | Promise<string>;
		},
	): Promise<{ providerId: string }> {
		const { onManualCodeInput, onOpenUrl } = options ?? {};
		const listener =
			onOpenUrl || onManualCodeInput
				? (req: RpcExtensionUIRequest) => {
						if (req.method === "open_url") {
							onOpenUrl?.(req.url, req.instructions, req.launchUrl);
							return;
						}
						if (req.method !== "input" || !onManualCodeInput) return;
						void Promise.resolve(onManualCodeInput({ title: req.title, placeholder: req.placeholder }))
							.then(value => {
								this.#writeFrame({
									type: "extension_ui_response",
									id: req.id,
									value,
								});
							})
							.catch(() => {
								this.#writeFrame({
									type: "extension_ui_response",
									id: req.id,
									cancelled: true,
								});
							});
					}
				: undefined;
		if (listener) this.#extensionUiListeners.add(listener);
		try {
			const response = await this.#send({ type: "login", providerId }, 600_000);
			return this.#getData<{ providerId: string }>(response);
		} finally {
			if (listener) this.#extensionUiListeners.delete(listener);
		}
	}

	async setCustomTools(tools: RpcClientCustomTool[]): Promise<string[]> {
		this.#customTools = tools.slice();
		if (!this.#process) {
			return this.#customTools.map(tool => tool.name);
		}
		const definitions: RpcHostToolDefinition[] = this.#customTools.map(tool => ({
			name: tool.name,
			label: tool.label,
			description: tool.description,
			parameters: tool.parameters,
			hidden: tool.hidden,
		}));
		const response = await this.#send({ type: "set_host_tools", tools: definitions });
		return this.#getData<{ toolNames: string[] }>(response).toolNames;
	}

	waitForIdle(timeout = 60000): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		let settled = false;
		const unsubscribe = this.onEvent(event => {
			if (event.type === "agent_end") {
				settled = true;
				unsubscribe();
				clearTimeout(timeoutId);
				resolve();
			}
		});

		const timeoutId = this.#startTimeout(timeout, () => {
			if (settled) return;
			settled = true;
			unsubscribe();
			reject(new Error(`Timeout waiting for agent to become idle. Stderr: ${this.#process?.peekStderr() ?? ""}`));
		});
		return promise;
	}

	collectEvents(timeout = 60000): Promise<AgentEvent[]> {
		const { promise, resolve, reject } = Promise.withResolvers<AgentEvent[]>();
		const events: AgentEvent[] = [];
		let settled = false;
		const unsubscribe = this.onEvent(event => {
			events.push(event);
			if (event.type === "agent_end") {
				settled = true;
				unsubscribe();
				clearTimeout(timeoutId);
				resolve(events);
			}
		});

		const timeoutId = this.#startTimeout(timeout, () => {
			if (settled) return;
			settled = true;
			unsubscribe();
			reject(new Error(`Timeout collecting events. Stderr: ${this.#process?.peekStderr() ?? ""}`));
		});
		return promise;
	}

	async promptAndWait(message: string, images?: ImageContent[], timeout = 60000): Promise<AgentEvent[]> {
		const eventsPromise = this.collectEvents(timeout);
		await this.prompt(message, images);
		return eventsPromise;
	}

	#handleLine(data: unknown): void {
		if (isRpcResponse(data)) {
			const id = data.id;
			if (id && this.#pendingRequests.has(id)) {
				const pending = this.#pendingRequests.get(id)!;
				this.#pendingRequests.delete(id);
				pending.resolve(data);
				return;
			}
		}

		if (isRpcHostToolCallRequest(data)) {
			void this.#handleHostToolCall(data);
			return;
		}

		if (isRpcExtensionUiRequest(data)) {
			for (const listener of this.#extensionUiListeners) {
				listener(data);
			}
			return;
		}

		if (isRpcHostToolCancelRequest(data)) {
			this.#pendingHostToolCalls.get(data.targetId)?.controller.abort();
			return;
		}

		if (isRpcSubagentLifecycleFrame(data)) {
			for (const listener of this.#subagentLifecycleListeners) {
				listener(data.payload);
			}
			return;
		}

		if (isRpcSubagentProgressFrame(data)) {
			for (const listener of this.#subagentProgressListeners) {
				listener(data.payload);
			}
			return;
		}

		if (isRpcSubagentEventFrame(data)) {
			for (const listener of this.#subagentEventListeners) {
				listener(data.payload);
			}
			return;
		}

		if (isRpcAvailableCommandsUpdateFrame(data)) {
			for (const listener of this.#availableCommandsUpdateListeners) {
				listener(data.commands);
			}
			return;
		}

		if (!isAgentSessionEvent(data)) return;

		for (const listener of this.#sessionEventListeners) {
			listener(data);
		}

		if (!isAgentEvent(data)) return;

		for (const listener of this.#eventListeners) {
			listener(data);
		}
	}

	#send(command: RpcCommandBody, timeoutMs = 30_000): Promise<RpcResponse> {
		if (!this.#process?.stdin) {
			throw new Error("Client not started");
		}

		const id = `req_${++this.#requestId}`;
		const fullCommand = { ...command, id } as RpcCommand;
		const { promise, resolve, reject } = Promise.withResolvers<RpcResponse>();
		let settled = false;
		const timeoutId = this.#startTimeout(timeoutMs, () => {
			if (settled) return;
			this.#pendingRequests.delete(id);
			settled = true;
			reject(
				new Error(`Timeout waiting for response to ${command.type}. Stderr: ${this.#process?.peekStderr() ?? ""}`),
			);
		});

		this.#pendingRequests.set(id, {
			resolve: response => {
				if (settled) return;
				settled = true;
				clearTimeout(timeoutId);
				resolve(response);
			},
			reject: error => {
				if (settled) return;
				settled = true;
				clearTimeout(timeoutId);
				reject(error);
			},
		});

		this.#writeFrame(fullCommand, err => {
			this.#pendingRequests.delete(id);
			if (settled) return;
			settled = true;
			clearTimeout(timeoutId);
			reject(err);
		});
		return promise;
	}

	async #handleHostToolCall(request: RpcHostToolCallRequest): Promise<void> {
		const tool = this.#customTools.find(candidate => candidate.name === request.toolName);
		if (!tool) {
			this.#writeFrame({
				type: "host_tool_result",
				id: request.id,
				result: {
					content: [{ type: "text", text: `Host tool "${request.toolName}" is not registered` }],
					details: {},
				},
				isError: true,
			} satisfies RpcHostToolResult);
			return;
		}

		const controller = new AbortController();
		this.#pendingHostToolCalls.set(request.id, { controller });

		const sendUpdate = (partialResult: RpcClientToolResult<unknown>): void => {
			if (controller.signal.aborted) return;
			this.#writeFrame({
				type: "host_tool_update",
				id: request.id,
				partialResult: normalizeToolResult(partialResult),
			} satisfies RpcHostToolUpdate);
		};

		try {
			const result = await tool.execute(request.arguments, {
				toolCallId: request.toolCallId,
				signal: controller.signal,
				sendUpdate,
			});
			if (controller.signal.aborted) return;
			this.#writeFrame({
				type: "host_tool_result",
				id: request.id,
				result: normalizeToolResult(result),
			} satisfies RpcHostToolResult);
		} catch (error) {
			if (controller.signal.aborted) return;
			this.#writeFrame({
				type: "host_tool_result",
				id: request.id,
				result: {
					content: [{ type: "text", text: errorMessage(error) }],
					details: {},
				},
				isError: true,
			} satisfies RpcHostToolResult);
		} finally {
			this.#pendingHostToolCalls.delete(request.id);
		}
	}

	#writeFrame(
		frame: RpcCommand | RpcExtensionUIResponse | RpcHostToolResult | RpcHostToolUpdate,
		onError?: (error: Error) => void,
	): void {
		if (!this.#process?.stdin) {
			throw new Error("Client not started");
		}
		const stdin = this.#process.stdin as FileSink;
		stdin.write(`${JSON.stringify(frame)}\n`);
		const flushResult = stdin.flush();
		if (isPromise(flushResult)) {
			flushResult.catch((err: Error) => {
				onError?.(err);
			});
		}
	}

	#getData<T>(response: RpcResponse): T {
		if (!response.success) {
			const errorResponse = response as Extract<RpcResponse, { success: false }>;
			throw new Error(errorResponse.error);
		}
		const successResponse = response as Extract<RpcResponse, { success: true; data: unknown }>;
		return successResponse.data as T;
	}
}
