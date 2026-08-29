import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { errorMessage, logger, prompt, Snowflake } from "@veyyon/utils";
import type { AsyncJob, AsyncJobManager } from "../async/job-manager";
import type { LocalProtocolOptions } from "../internal-urls";
import { registerArtifactsDir } from "../internal-urls/registry-helpers";
import { mcpManagerInstance } from "../mcp/manager-instance";
import { toolsPrompts } from "../prompts/tools/rows";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import { inheritContextFiles } from "../task/context-inheritance";
import { discoverAgents, getAgent } from "../task/discovery";
import { type ExecutorOptions, runSubagentFollowUpTurn, runSubprocess } from "../task/executor";
import { inheritResolvedCollection } from "../task/inherited-collections";
import { generateTaskName } from "../task/name-generator";
import { AgentOutputManager } from "../task/output-manager";
import {
	isSubagentEnabled,
	resolveEnabledSubagents,
	resolveSubagentModel,
	resolveSubagentThinkingLevel,
	subagentModelSourceLabel,
	subagentsEnabled,
} from "../task/subagent-settings";
import type { AgentProgress, SingleResult } from "../task/types";
import type { ToolSession } from "../tools";
import { formatDuration } from "../tools/render-utils";
import { ToolError } from "../tools/tool-errors";
import type {
	VibeCli,
	VibeKillOutcome,
	VibeRecord,
	VibeScreenSnapshot,
	VibeSendOutcome,
	VibeSpawnOutcome,
	VibeTurn,
	VibeWaitOutcome,
} from "./runtime-helpers";
import {
	DEFAULT_WAIT_TIMEOUT_MS,
	firstLine,
	mergeTrace,
	RESPONSE_PREVIEW_MAX,
	TRACE_LINE_MAX,
	VIBE_CLI_AGENT,
} from "./runtime-helpers";

export type { VibeSessionState } from "./runtime-helpers";
export type { VibeCli, VibeKillOutcome, VibeScreenSnapshot, VibeSendOutcome, VibeSpawnOutcome, VibeWaitOutcome };

class VibeTurnError extends Error {}

export class VibeSessionRegistry {
	static #global: VibeSessionRegistry | undefined;

	static global(): VibeSessionRegistry {
		if (!VibeSessionRegistry.#global) {
			VibeSessionRegistry.#global = new VibeSessionRegistry();
		}
		return VibeSessionRegistry.#global;
	}

	static resetGlobalForTests(): void {
		VibeSessionRegistry.#global = undefined;
	}

	readonly #records = new Map<string, VibeRecord>();

	#manager(session: ToolSession): AsyncJobManager {
		const manager = session.asyncJobManager;
		if (!manager) {
			throw new ToolError("Vibe sessions require async execution (no background job manager is available).");
		}
		return manager;
	}

	#record(owner: string, id: string): VibeRecord {
		const record = this.#records.get(id.trim());
		if (!record || record.ownerId !== owner) {
			const roster = this.listIds(owner);
			throw new ToolError(
				`Unknown vibe session "${id}".${roster.length > 0 ? ` Active sessions: ${roster.join(", ")}` : " No sessions — spawn one with vibe_spawn."}`,
			);
		}
		return record;
	}

	listIds(owner: string): string[] {
		const ids: string[] = [];
		for (const record of this.#records.values()) {
			if (record.ownerId === owner && record.state !== "dead") ids.push(record.id);
		}
		return ids;
	}

	screens(owner: string, ids?: string[]): VibeScreenSnapshot[] {
		const wanted = ids?.length ? new Set(ids.map(id => id.trim())) : undefined;
		const records: VibeRecord[] = [];
		for (const record of this.#records.values()) {
			if (record.ownerId !== owner) continue;
			if (wanted && !wanted.has(record.id)) continue;
			records.push(record);
		}
		records.sort((a, b) => a.createdAt - b.createdAt);
		return records.map(record => ({
			id: record.id,
			cli: record.cli,
			state: record.state,
			model: record.resolvedModel,
			turns: record.turnCount,
			queued: record.queue.length,
			turnStartedAt: record.turn?.startedAt,
			turnMessage: record.turn ? firstLine(record.turn.message, 80) : undefined,
			currentTool: record.live?.currentTool,
			currentToolArgs: record.live?.currentToolArgs ? firstLine(record.live.currentToolArgs, 60) : undefined,
			lastIntent: record.live?.lastIntent ? firstLine(record.live.lastIntent, 80) : undefined,
			trace: record.turn
				? record.turn.trace
						.slice(-6)
						.map(entry => firstLine(`${entry.tool}${entry.args ? `(${entry.args})` : ""}`, TRACE_LINE_MAX))
				: [],
			outputTail: (record.live?.outputTail ?? []).map(line => firstLine(line, 100)),
			lastActivity: record.lastActivity,
			lastActivityAt: record.lastActivityAt,
		}));
	}

	async spawn(session: ToolSession, args: { cli: VibeCli; name?: string; prompt: string }): Promise<VibeSpawnOutcome> {
		const owner = session.getAgentId?.() ?? MAIN_AGENT_ID;
		const manager = this.#manager(session);
		const agentName = VIBE_CLI_AGENT[args.cli];
		const { agents } = await discoverAgents(session.cwd);
		if (!subagentsEnabled(session.settings)) {
			throw new ToolError(`Cannot start vibe worker "${agentName}": subagents are disabled in settings.`);
		}
		const discoveredAgent = getAgent(agents, agentName);
		if (!discoveredAgent) {
			throw new ToolError(`Agent "${agentName}" for vibe cli "${args.cli}" is unavailable.`);
		}
		const catalog = resolveEnabledSubagents({
			settings: session.settings,
			agents,
			parentSpawns: session.getSessionSpawns?.() ?? "*",
		});
		const agent = getAgent(catalog.agents, agentName);
		if (!agent) {
			if (!isSubagentEnabled(session.settings, discoveredAgent)) {
				throw new ToolError(
					`Agent "${agentName}" is disabled (subagent.agents.${agentName}.enabled is false). Enable it in the Subagents settings tab (/settings) before starting the "${args.cli}" vibe worker.`,
				);
			}
			const available = catalog.agents.map(candidate => candidate.name).join(", ") || "none";
			throw new ToolError(`Cannot start vibe worker "${agentName}". Enabled and allowed agents: ${available}.`);
		}

		const resolvedModel = resolveSubagentModel({
			settings: session.settings,
			agentName,
			agentModel: agent.model,
			activeModelPattern: session.getActiveModelString?.(),
			fallbackModelPattern: session.getModelString?.(),
			taskDepth: (session.taskDepth ?? 0) + 1,
		});
		if (resolvedModel.unresolved) {
			const { source, value, depth } = resolvedModel.unresolved;
			throw new ToolError(
				`Cannot start vibe worker "${agentName}": ${subagentModelSourceLabel(source, agentName, depth)} is set to "${value}", which matches no available model. Fix that setting (or clear it to inherit the session model) and try again.`,
			);
		}
		const modelOverride = resolvedModel.patterns;

		if (!session.agentOutputManager) {
			session.agentOutputManager = new AgentOutputManager(session.getArtifactsDir ?? (() => null));
		}
		const requestedName = args.name?.replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 48);
		const id = await session.agentOutputManager.allocate(requestedName || generateTaskName());

		const record: VibeRecord = {
			id,
			cli: args.cli,
			ownerId: owner,
			agent,
			modelOverride,
			thinkingLevel: resolveSubagentThinkingLevel({
				settings: session.settings,
				agentName,
				agentThinkingLevel: agent.thinkingLevel,
			}),
			state: "starting",
			createdAt: Date.now(),
			lastActivityAt: Date.now(),
			queue: [],
			turnCount: 0,
			killed: false,
		};
		this.#records.set(id, record);

		try {
			const jobId = this.#registerTurnJob(session, manager, record, args.prompt, { first: true });
			return { id, jobId };
		} catch (error) {
			this.#records.delete(id);
			throw error;
		}
	}

	async send(session: ToolSession, args: { session: string; message: string }): Promise<VibeSendOutcome> {
		const owner = session.getAgentId?.() ?? MAIN_AGENT_ID;
		const record = this.#record(owner, args.session);
		if (record.state === "dead") {
			throw new ToolError(`Vibe session "${record.id}" is dead. Spawn a new one with vibe_spawn.`);
		}
		const message = args.message.trim();
		if (!message) throw new ToolError("Message must not be empty.");

		if (record.turn) {
			const live = AgentRegistry.global().get(record.id)?.session;
			if (live?.isStreaming) {
				await live.steer(message);
				record.lastActivityAt = Date.now();
				return { id: record.id, mode: "steered" };
			}
			record.queue.push(message);
			record.lastActivityAt = Date.now();
			return { id: record.id, mode: "queued" };
		}

		const manager = this.#manager(session);
		const jobId = this.#registerTurnJob(session, manager, record, message, { first: false });
		return { id: record.id, mode: "turn", jobId };
	}

	async wait(
		session: ToolSession,
		args: { sessions?: string[]; timeoutMs?: number; signal?: AbortSignal },
	): Promise<VibeWaitOutcome> {
		const owner = session.getAgentId?.() ?? MAIN_AGENT_ID;
		const manager = this.#manager(session);
		const watched = args.sessions?.length
			? args.sessions.map(id => this.#record(owner, id))
			: Array.from(this.#records.values()).filter(record => record.ownerId === owner && record.turn !== undefined);

		const snapshots: Array<{ record: VibeRecord; jobId: string }> = [];
		for (const record of watched) {
			const jobId = record.turn?.jobId ?? record.lastJobId;
			if (jobId) snapshots.push({ record, jobId });
		}

		const collectSettled = (): VibeWaitOutcome["settled"] => {
			const settled: VibeWaitOutcome["settled"] = [];
			for (const { record, jobId } of snapshots) {
				const job = manager.getJob(jobId);
				if (!job || job.status === "running") continue;
				settled.push({
					id: record.id,
					jobId,
					status: job.status,
					resultText: job.resultText ?? job.errorText ?? "(no output)",
				});
			}
			return settled;
		};

		const runningJobs: AsyncJob[] = [];
		for (const { jobId } of snapshots) {
			const job = manager.getJob(jobId);
			if (job?.status === "running") runningJobs.push(job);
		}

		let waited = false;
		if (runningJobs.length > 0 && collectSettled().length === 0) {
			waited = true;
			const timeoutMs = Math.max(1, Math.trunc(args.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS));
			const watchedJobIds = runningJobs.map(job => job.id);
			manager.watchJobs(watchedJobIds);
			const { promise: timeoutPromise, resolve: timeoutResolve } = Promise.withResolvers<void>();
			const timeoutHandle = setTimeout(() => timeoutResolve(), timeoutMs);
			const racePromises: Promise<unknown>[] = runningJobs.map(job => job.promise).concat([timeoutPromise]);
			let abortCleanup: (() => void) | undefined;
			if (args.signal) {
				const { promise: abortPromise, resolve: abortResolve } = Promise.withResolvers<void>();
				const onAbort = () => abortResolve();
				args.signal.addEventListener("abort", onAbort, { once: true });
				abortCleanup = () => args.signal?.removeEventListener("abort", onAbort);
				racePromises.push(abortPromise);
			}
			try {
				await Promise.race(racePromises);
			} finally {
				manager.acknowledgeDeliveries(collectSettled().map(entry => entry.jobId));
				manager.unwatchJobs(watchedJobIds);
				clearTimeout(timeoutHandle);
				abortCleanup?.();
			}
		}

		const settled = collectSettled();
		manager.acknowledgeDeliveries(settled.map(entry => entry.jobId));
		const stillRunning = watched.filter(record => record.turn !== undefined).map(record => record.id);
		return { settled, stillRunning, timedOut: waited && settled.length === 0 };
	}

	async kill(session: ToolSession, id: string): Promise<VibeKillOutcome> {
		const owner = session.getAgentId?.() ?? MAIN_AGENT_ID;
		const record = this.#record(owner, id);
		return this.#killRecord(record, session.asyncJobManager);
	}

	async killAll(owner: string, manager?: AsyncJobManager): Promise<number> {
		let killed = 0;
		for (const record of this.#records.values()) {
			if (record.ownerId !== owner || record.state === "dead") continue;
			await this.#killRecord(record, manager);
			killed++;
		}
		return killed;
	}

	async #killRecord(record: VibeRecord, manager: AsyncJobManager | undefined): Promise<VibeKillOutcome> {
		record.killed = true;
		record.queue.length = 0;
		let cancelledTurn = false;
		if (record.turn && manager) {
			cancelledTurn = manager.cancel(record.turn.jobId, { ownerId: record.ownerId });
		}
		record.state = "dead";
		record.lastActivityAt = Date.now();
		record.lastActivity = "killed";
		try {
			await AgentLifecycleManager.global().release(record.id);
		} catch (error) {
			logger.warn("vibe: failed to release worker session", {
				id: record.id,
				error: errorMessage(error),
			});
		}
		return { id: record.id, cancelledTurn };
	}

	async #buildSpawnOptions(
		session: ToolSession,
		record: VibeRecord,
		message: string,
		signal: AbortSignal,
		onProgress: (progress: AgentProgress) => void,
	): Promise<ExecutorOptions> {
		const sessionFile = session.getSessionFile();
		const sessionArtifactsDir = sessionFile ? sessionFile.slice(0, -6) : null;
		const artifactsDir = sessionArtifactsDir ?? path.join(os.tmpdir(), `veyyon-vibe-${Snowflake.next()}`);
		await fs.mkdir(artifactsDir, { recursive: true });
		if (!sessionArtifactsDir) registerArtifactsDir(artifactsDir);
		const localProtocolOptions: LocalProtocolOptions = session.localProtocolOptions ?? {
			getArtifactsDir: session.getArtifactsDir ?? (() => null),
			getSessionId: session.getSessionId ?? (() => null),
		};
		return {
			cwd: session.cwd,
			agent: record.agent,
			task: message,
			assignment: message,
			description: `vibe ${record.cli} session`,
			index: 0,
			id: record.id,
			taskDepth: session.taskDepth ?? 0,
			detached: true,
			modelOverride: record.modelOverride,
			parentActiveModelPattern: session.getActiveModelString?.(),
			parentThinkingLevel: session.getActiveThinkingLevel?.(),
			thinkingLevel: record.thinkingLevel,
			sessionFile,
			persistArtifacts: Boolean(sessionFile),
			artifactsDir,
			enableLsp: (session.enableLsp ?? true) && session.settings.get("subagent.enableLsp"),
			signal,
			eventBus: session.eventBus,
			onProgress,
			authStorage: session.authStorage,
			modelRegistry: session.modelRegistry,
			settings: session.settings,
			mcpManager: session.mcpManager ?? mcpManagerInstance(),
			contextFiles: inheritContextFiles({
				parentContextFiles: session.contextFiles,
				parentCwd: session.cwd,
				spawnCwd: session.cwd,
				agentName: record.agent.name,
			}),
			skills: inheritResolvedCollection({
				items: session.skills,
				kind: "skills",
				parentCwd: session.cwd,
				spawnCwd: session.cwd,
				agentName: record.agent.name,
			}),
			workspaceTree: session.workspaceTree,
			promptTemplates: inheritResolvedCollection({
				items: session.promptTemplates,
				kind: "promptTemplates",
				parentCwd: session.cwd,
				spawnCwd: session.cwd,
				agentName: record.agent.name,
			}),
			rules: inheritResolvedCollection({
				items: session.rules,
				kind: "rules",
				parentCwd: session.cwd,
				spawnCwd: session.cwd,
				agentName: record.agent.name,
			}),
			preloadedExtensionPaths: session.extensionPaths,
			preloadedNamedExtensionPaths: session.namedExtensionPaths,
			preloadedCustomToolPaths: session.customToolPaths,
			localProtocolOptions,
			parentArtifactManager: session.getArtifactManager?.() ?? undefined,
			parentHindsightSessionState: session.getHindsightSessionState?.(),
			parentMnemopiSessionState: session.getMnemopiSessionState?.(),
			parentTelemetry: session.getTelemetry?.(),
			parentEvalSessionId: session.getEvalSessionId?.() ?? undefined,
			parentAgentId: session.getAgentId?.() ?? MAIN_AGENT_ID,
			parentSessionId: session.getSessionId?.() ?? undefined,
			parentServiceTier: session.getServiceTierByFamily ? (session.getServiceTierByFamily() ?? null) : undefined,
			keepAlive: true,
		};
	}

	#registerTurnJob(
		session: ToolSession,
		manager: AsyncJobManager,
		record: VibeRecord,
		message: string,
		options: { first: boolean },
	): string {
		const turnIndex = record.turnCount + 1;
		const turn: VibeTurn = {
			jobId: "",
			message,
			startedAt: Date.now(),
			trace: [],
			toolCount: 0,
		};
		const onProgress = (progress: AgentProgress): void => {
			mergeTrace(turn, progress);
			record.resolvedModel = progress.resolvedModel ?? record.resolvedModel;
			record.live = {
				currentTool: progress.currentTool,
				currentToolArgs: progress.currentToolArgs,
				lastIntent: progress.lastIntent,
				outputTail: progress.recentOutput.slice(0, 3).reverse(),
			};
			const gist =
				progress.lastIntent ??
				(progress.currentTool ? `${progress.currentTool} ${progress.currentToolArgs ?? ""}` : undefined);
			if (gist) record.lastActivity = firstLine(gist);
			record.lastActivityAt = Date.now();
		};

		const jobId = manager.register(
			"task",
			`vibe ${record.cli} ${record.id}: ${firstLine(message, 60)}`,
			async ({ jobId: ownJobId, signal }) => {
				record.state = "running";
				record.turnCount = turnIndex;
				record.lastActivityAt = Date.now();
				try {
					const result = options.first
						? await runSubprocess(await this.#buildSpawnOptions(session, record, message, signal, onProgress))
						: await runSubagentFollowUpTurn({
								id: record.id,
								agent: record.agent,
								message,
								description: `vibe ${record.cli} session`,
								signal,
								onProgress,
								eventBus: session.eventBus,
								artifactsDir: session.getSessionFile()?.slice(0, -6),
							});
					return this.#settleTurn(session, manager, record, turn, ownJobId, turnIndex, result);
				} catch (error) {
					if (error instanceof VibeTurnError) throw error;
					this.#finishTurn(session, manager, record, ownJobId);
					const reason = errorMessage(error);
					record.lastActivity = firstLine(`turn failed: ${reason}`);
					throw new VibeTurnError(
						`[vibe:${record.id} cli=${record.cli} turn=${turnIndex}] turn failed: ${reason}`,
					);
				}
			},
			{ id: `${record.id}-t${turnIndex}`, agentId: record.id, ownerId: record.ownerId },
		);
		turn.jobId = jobId;
		record.turn = turn;
		return jobId;
	}

	#finishTurn(session: ToolSession, manager: AsyncJobManager, record: VibeRecord, settledJobId: string): void {
		record.lastJobId = settledJobId;
		record.turn = undefined;
		record.live = undefined;
		record.lastActivityAt = Date.now();
		if (record.killed) {
			record.state = "dead";
			return;
		}
		record.state = AgentRegistry.global().get(record.id) ? "idle" : "dead";
		if (record.state === "dead" || record.queue.length === 0) return;
		const nextMessage = record.queue.splice(0, record.queue.length).join("\n\n");
		try {
			this.#registerTurnJob(session, manager, record, nextMessage, { first: false });
		} catch (error) {
			record.queue.unshift(nextMessage);
			logger.warn("vibe: failed to start queued follow-up turn", {
				id: record.id,
				error: errorMessage(error),
			});
		}
	}

	#settleTurn(
		session: ToolSession,
		manager: AsyncJobManager,
		record: VibeRecord,
		turn: VibeTurn,
		settledJobId: string,
		turnIndex: number,
		result: SingleResult,
	): string {
		this.#finishTurn(session, manager, record, settledJobId);
		const failed = result.exitCode !== 0 || result.aborted === true;
		const status = result.aborted ? "aborted" : failed ? "failed" : "completed";
		record.lastActivity = firstLine(
			failed
				? `turn ${turnIndex} ${status}: ${result.abortReason ?? result.error ?? ""}`
				: (result.lastIntent ?? result.output),
		);

		const traceLines = turn.trace.map(entry =>
			firstLine(`${entry.tool}${entry.args ? `(${entry.args})` : ""}`, TRACE_LINE_MAX),
		);
		const traceOverflow = Math.max(0, turn.toolCount - turn.trace.length);
		let response = result.output.trim() || "(no output)";
		let responseTruncated = false;
		if (response.length > RESPONSE_PREVIEW_MAX) {
			const slice = response.slice(0, RESPONSE_PREVIEW_MAX);
			const lastNewline = slice.lastIndexOf("\n");
			response = lastNewline > 0 ? slice.slice(0, lastNewline) : slice;
			responseTruncated = true;
		}
		let text: string;
		try {
			text = prompt
				.render(toolsPrompts["tools/vibe-turn-result"].text, {
					id: record.id,
					cli: record.cli,
					turn: turnIndex,
					status,
					duration: formatDuration(result.durationMs),
					requests: result.requests,
					toolCount: turn.toolCount,
					model: result.resolvedModel ?? record.resolvedModel ?? "",
					trace: traceLines,
					traceOverflow: traceOverflow > 0 ? traceOverflow : undefined,
					response,
					responseTruncated,
					error: failed ? (result.abortReason ?? result.error ?? result.stderr ?? "") : "",
					alive: record.state !== "dead",
				})
				.trim();
		} catch (error) {
			logger.warn("vibe: turn-result template render failed; using plain fallback", {
				id: record.id,
				error: errorMessage(error),
			});
			text = [
				`[vibe:${record.id} cli=${record.cli} turn=${turnIndex} status=${status}]`,
				`Activity (${turn.toolCount} tool calls, ${result.requests} requests):`,
				...traceLines.map(line => `- ${line}`),
				"",
				"Response:",
				response,
			].join("\n");
		}
		if (failed) throw new VibeTurnError(text);
		return text;
	}
}
