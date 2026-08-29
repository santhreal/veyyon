import * as path from "node:path";
import { assistantText } from "@veyyon/ai/utils/message-text";
import { errorMessage, prompt, Snowflake } from "@veyyon/utils";
import { sessionFileName } from "@veyyon/utils/session-file";
import { sideChannelPrompts } from "../../prompts/side-channel/rows";
import { AgentRegistry, MAIN_AGENT_ID } from "../../registry/agent-registry";
import * as sdk from "../../sdk";
import type { AgentSession } from "../../session/agent-session";
import { BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE } from "../../session/messages";
import { SessionManager } from "../../session/session-manager";
import { createMCPProxyTools, createSubagentSettings } from "../../task/executor";
import { previewLine } from "../../tools/render-utils";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "../../tools/todo";
import type { TanCommandControllerContext } from "./tan-command-controller-helpers";
import { removeCloneSession, TAN_LABEL_PREVIEW_LENGTH } from "./tan-command-controller-helpers";

export class TanCommandController {
	constructor(private readonly ctx: TanCommandControllerContext) {}

	async start(work: string): Promise<void> {
		const trimmedWork = work.trim();
		if (!trimmedWork) {
			this.ctx.showStatus("Usage: /tan <work>");
			return;
		}

		const session = this.ctx.session;

		const model = session.model;
		if (!model) {
			this.ctx.showError("No active model available for /tan.");
			return;
		}

		const manager = session.asyncJobManager;
		if (!manager) {
			this.ctx.showError("Background jobs are disabled; enable async jobs to use /tan.");
			return;
		}

		const parentFile = this.ctx.sessionManager.getSessionFile();
		if (!parentFile) {
			this.ctx.showError("/tan requires a persisted session.");
			return;
		}

		const parentSessionId = session.sessionId;
		const parentPromptCacheKey = session.agent.promptCacheKey ?? parentSessionId;
		const thinkingLevel = session.configuredThinkingLevel();
		const systemPrompt = session.systemPrompt.slice();
		const toolNames = session.getActiveToolNames();
		const modelRegistry = session.modelRegistry;
		const ownerId = session.getAgentId() ?? MAIN_AGENT_ID;
		const mcpManager = this.ctx.mcpManager;
		const cwd = this.ctx.sessionManager.getCwd();
		const sessionDir = parentFile.slice(0, -6);
		const settings = createSubagentSettings(this.ctx.settings);
		const customTools = mcpManager ? createMCPProxyTools(mcpManager) : undefined;
		const enableLsp = this.ctx.settings.get("subagent.enableLsp") !== false;
		const agentRegistry = AgentRegistry.global();
		const cloneId = `Tan-${Snowflake.next()}`;
		const cloneFile = path.join(sessionDir, sessionFileName(cloneId));
		const label = `/tan ${previewLine(trimmedWork, TAN_LABEL_PREVIEW_LENGTH)}`;

		await this.ctx.sessionManager.ensureOnDisk();
		await this.ctx.sessionManager.flush();

		let jobId = "";
		try {
			const cloneManager = await SessionManager.forkFrom(parentFile, cwd, sessionDir, undefined, {
				suppressBreadcrumb: true,
				sessionFile: cloneFile,
			});

			jobId = manager.register(
				"task",
				label,
				async ({ signal }) => {
					if (signal.aborted) throw new Error("Aborted before execution");

					let clone: AgentSession | undefined;
					try {
						const created = await sdk.createAgentSession({
							cwd,
							sessionManager: cloneManager,
							model,
							thinkingLevel,
							systemPrompt,
							toolNames,
							providerSessionId: `${parentSessionId}:tan:${Snowflake.next()}`,
							providerPromptCacheKey: parentPromptCacheKey,
							modelRegistry,
							authStorage: modelRegistry.authStorage,
							settings,
							hasUI: false,
							enableMCP: false,
							customTools,
							enableLsp,
							agentId: cloneId,
							agentDisplayName: "tan",
							parentTaskPrefix: cloneId,
							parentAgentId: ownerId,
							agentRegistry,
							disableExtensionDiscovery: true,
						});
						clone = created.session;
						clone.sessionManager?.appendSessionInit?.({
							systemPrompt: clone.systemPrompt ? clone.systemPrompt.join("\n\n") : systemPrompt.join("\n\n"),
							task: trimmedWork,
							tools: clone.getActiveToolNames ? clone.getActiveToolNames() : toolNames,
						});
						const abortClone = () => {
							void clone?.abort();
						};
						signal.addEventListener("abort", abortClone, { once: true });
						clone.setTodoPhases([]);
						cloneManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: [] });
						const injectContextSwitch = () => {
							clone?.agent.appendMessage({
								role: "developer",
								content: sideChannelPrompts["side-channel/tan-context-switch"].text,
								attribution: "agent",
								timestamp: Date.now(),
							});
						};
						const unsubscribeCompaction = clone.subscribe(event => {
							if (event.type === "auto_compaction_end" && event.result && !event.aborted) {
								injectContextSwitch();
							}
						});
						try {
							if (signal.aborted) {
								abortClone();
								throw new Error("Aborted before execution");
							}
							injectContextSwitch();
							await clone.prompt(trimmedWork, { attribution: "user" });
							await clone.waitForIdle();
							const last = clone.getLastAssistantMessage();
							return (last ? assistantText(last, "").trim() : "") || "(no output)";
						} finally {
							unsubscribeCompaction();
							signal.removeEventListener("abort", abortClone);
						}
					} finally {
						if (clone) {
							if (signal.aborted) {
								agentRegistry.setStatus(cloneId, "aborted");
								await clone.dispose();
							} else {
								agentRegistry.setStatus(cloneId, "parked");
								await clone.dispose();
								agentRegistry.detachSession(cloneId);
							}
						}
					}
				},
				{ ownerId, agentId: cloneId },
			);
		} catch (error) {
			if (cloneFile) await removeCloneSession(cloneFile);
			this.ctx.showError(errorMessage(error));
			return;
		}

		const content = prompt.render(sideChannelPrompts["side-channel/background-tan-dispatch"].text, {
			jobId,
			work: trimmedWork,
		});
		const wasStreaming = session.isStreaming;
		await session.sendCustomMessage(
			{
				customType: BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE,
				content,
				display: true,
				attribution: "user",
				details: { jobId, work: trimmedWork, sessionFile: cloneFile },
			},
			{ triggerTurn: false, deliverAs: "nextTurn" },
		);
		if (!wasStreaming) this.ctx.rebuildChatFromMessages();
		this.ctx.showStatus(`Dispatched background tan ${jobId}`);
	}
}
