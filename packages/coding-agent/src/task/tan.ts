/**
 * `/tan`: tangential work dispatched to a background agent.
 *
 * The work runs on a fork of this session rather than beside it: the session
 * file is forked on disk, the clone inherits the model, prompt and tools the
 * parent is using, and the parent's turn is left alone. The dispatch is
 * recorded in the parent's transcript so the conversation states that the work
 * was sent, and the clone stays in the agent roster once it finishes.
 *
 * Nothing here draws anything. A terminal states the result on its status line
 * and a window states it in the palette's reply, both from the same dispatch.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { assistantText } from "@veyyon/ai/utils/message-text";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { errorMessage, prompt, Snowflake } from "@veyyon/utils";
import { sessionFileName } from "@veyyon/utils/session-file";
import type { Settings } from "../config/settings";
import type { MCPManager } from "../mcp/manager";
import { sideChannelPrompts } from "../prompts/side-channel/rows";
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import * as sdk from "../sdk";
import type { AgentSession } from "../session/agent-session";
import { BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE } from "../session/messages";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "../tools/agent/todo";
import { previewLine } from "../tools/core/render-utils";
import { createMCPProxyTools, createSubagentSettings } from "./executor";

const TAN_LABEL_PREVIEW_LENGTH = 80;

/** What a dispatch needs, whichever host asked for it. */
export interface TanDispatchContext {
	session: AgentSession;
	sessionManager: SessionManager;
	settings: Settings;
	mcpManager?: MCPManager;
}

/**
 * The outcome of a dispatch.
 *
 * `usage` is the empty request, which a terminal states without an error
 * register; `failure` is a dispatch that could not run. `recorded` states
 * whether the breadcrumb landed in the transcript now or waits for the next
 * turn, which is what decides whether a host redraws the conversation.
 */
export type TanDispatch =
	| { ok: true; jobId: string; work: string; recorded: "now" | "nextTurn" }
	| { ok: false; reason: "usage" | "failure"; message: string };

async function removeCloneSession(cloneFile: string): Promise<void> {
	await Promise.allSettled([
		fs.rm(cloneFile, { force: true }),
		fs.rm(cloneFile.slice(0, -6), { recursive: true, force: true }),
	]);
}

/** Forks the session, registers the background job, and records the dispatch. */
export async function dispatchTan(ctx: TanDispatchContext, work: string): Promise<TanDispatch> {
	const trimmedWork = work.trim();
	if (!trimmedWork) return { ok: false, reason: "usage", message: "Usage: /tan <work>" };

	const session = ctx.session;

	const model = session.model;
	if (!model) return { ok: false, reason: "failure", message: "No active model available for /tan." };

	const manager = session.asyncJobManager;
	if (!manager) {
		return {
			ok: false,
			reason: "failure",
			message: "Background jobs are disabled; enable async jobs to use /tan.",
		};
	}

	const parentFile = ctx.sessionManager.getSessionFile();
	if (!parentFile) return { ok: false, reason: "failure", message: "/tan requires a persisted session." };

	const parentSessionId = session.sessionId;
	// Providers route on `promptCacheKey ?? sessionId`, so the parent's live
	// requests may cache under a pinned key that differs from its session id
	// (the parent being itself a fork/tan). Mirror exactly what the parent
	// populated the cache under — same rule as advisor and handoff calls.
	const parentPromptCacheKey = session.agent.promptCacheKey ?? parentSessionId;
	const thinkingLevel = session.configuredThinkingLevel();
	const systemPrompt = session.systemPrompt.slice();
	const toolNames = session.getActiveToolNames();
	const modelRegistry = session.modelRegistry;
	const ownerId = session.getAgentId() ?? MAIN_AGENT_ID;
	const mcpManager = ctx.mcpManager;
	const cwd = ctx.sessionManager.getCwd();
	// Nest the clone inside the parent's artifact directory (like an agent
	// session) rather than as a top-level sibling, so it shares the parent's
	// artifacts in place — no copy needed.
	const sessionDir = parentFile.slice(0, -6);
	const settings = createSubagentSettings(ctx.settings);
	const customTools = mcpManager ? createMCPProxyTools(mcpManager) : undefined;
	const enableLsp = ctx.settings.get("agent.enableLsp") !== false;
	const agentRegistry = AgentRegistry.global();
	const cloneId = `Tan-${Snowflake.next()}`;
	const cloneFile = path.join(sessionDir, sessionFileName(cloneId));
	const label = `/tan ${previewLine(trimmedWork, TAN_LABEL_PREVIEW_LENGTH)}`;

	await ctx.sessionManager.ensureOnDisk();
	await ctx.sessionManager.flush();

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
					// The fork inherits the parent's todo list via session entries;
					// its reminders would drag the tan back onto the parent's task.
					// Clear runtime state and persist an empty edit so reloads agree.
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
					// Compaction summarizes the fork notice away with the rest of the
					// history, after which the clone re-adopts the parent's task as its
					// own (the summary blends both). Re-inject after every successful
					// compaction so the fork boundary survives summarization.
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
						// Inject a context-switch developer message so the clone knows
						// it is a tangential fork — its parent owns the prior conversation;
						// this agent must focus exclusively on the user's request.
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
					// Keep the finished tan in the Control Center roster instead of unregistering it:
					// flip the ref to parked BEFORE dispose so the sdk dispose wrapper
					// skips its unregister, then null the disposed session so the hub
					// treats it as a transcript-only parked agent. An aborted tan is
					// terminal — let dispose unregister it.
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
		return { ok: false, reason: "failure", message: errorMessage(error) };
	}

	const content = prompt.render(sideChannelPrompts["side-channel/background-tan-dispatch"].text, {
		jobId,
		work: trimmedWork,
	});
	// /tan is meant to run alongside an active session. While the parent turn is
	// still streaming, queue the dispatch breadcrumb for the next turn rather than
	// steering the in-flight response; when idle this same call appends + persists
	// the entry immediately (identical to omitting deliverAs).
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
	return { ok: true, jobId, work: trimmedWork, recorded: wasStreaming ? "nextTurn" : "now" };
}
