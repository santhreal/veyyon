import type { ThinkingLevel } from "@veyyon/agent-core";
import type { Api, Model } from "@veyyon/ai";
import type { AuthStorage } from "@veyyon/ai/auth-storage";
import { collapseWhitespace, prompt } from "@veyyon/utils";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import { commitPrompts } from "../../prompts/commit/rows";
import { commitAgenticPrompts } from "../../prompts/commit-agentic/rows";
import { createAgentSession } from "../../sdk";
import type { AgentSessionEvent } from "../../session/agent-session-types";
import type { CommitAgentState } from "./state";
import { commitAnalysisSpawnTarget, createCommitTools } from "./tools";

export interface CommitAgentInput {
	cwd: string;
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	settings: Settings;
	modelRegistry: ModelRegistry;
	authStorage: AuthStorage;
	userContext?: string;
	contextFiles?: Array<{ path: string; content: string }>;
	changelogTargets: string[];
	requireChangelog: boolean;
	diffText?: string;
	existingChangelogEntries?: ExistingChangelogEntries[];
	/** Where the run is drawn. A caller that draws nothing passes none. */
	reporter?: CommitAgentReporter;
	onComplete?: (state: CommitAgentState) => Promise<void> | void;
}

export interface ExistingChangelogEntries {
	path: string;
	sections: Array<{ name: string; items: string[] }>;
}

/**
 * What a commit agent run reports while it happens.
 *
 * The session states what occurred and never how it looks: `veyyon commit`
 * installs `createCommitConsoleReporter` from `./agent-render`, the only module
 * that draws any of it, and a caller with no screen installs nothing. The run's
 * result is {@link CommitAgentState} either way.
 */
export interface CommitAgentReporter {
	/** The assistant's text so far, whitespace collapsed and unbounded. */
	thinking(preview: string): void;
	/** An assistant message closed; any in-flight preview is spent. */
	messageEnded(): void;
	/** The message stopped on an error the model reported. */
	assistantError(message: string): void;
	/** The message's final text, as markdown. */
	assistantMessage(markdown: string): void;
	/** A tool call finished, with the arguments it was called with. */
	toolFinished(toolName: string, args: Record<string, unknown> | undefined, isError: boolean): void;
	/** The run ended after this many assistant messages and tool calls. */
	finished(messageCount: number, toolCalls: number): void;
}

export async function runCommitAgentSession(input: CommitAgentInput): Promise<CommitAgentState> {
	const typesDescription = prompt.render(commitPrompts["commit/types-description"].text);
	const systemPrompt = prompt.render(commitAgenticPrompts["commit-agentic/system"].text, {
		types_description: typesDescription,
	});
	const state: CommitAgentState = { diffText: input.diffText };
	// The session's spawn capability is the SAME resolved name `analyze_files`
	// will request, so the two cannot disagree. It was the literal `"sonic"`,
	// which meant an operator with that agent off ran a session permitted to
	// spawn one agent that the enablement check then refused. An empty string is
	// the spelling for "spawn nothing", used when nothing at all is enabled.
	const spawns = commitAnalysisSpawnTarget(input.settings) ?? "";
	const tools = createCommitTools({
		cwd: input.cwd,
		authStorage: input.authStorage,
		modelRegistry: input.modelRegistry,
		settings: input.settings,
		state,
		changelogTargets: input.changelogTargets,
		enableAnalyzeFiles: true,
	});

	const { session } = await createAgentSession({
		cwd: input.cwd,
		authStorage: input.authStorage,
		modelRegistry: input.modelRegistry,
		settings: input.settings,
		model: input.model,
		thinkingLevel: input.thinkingLevel,
		systemPrompt: [systemPrompt],
		customTools: tools,
		enableLsp: false,
		enableMCP: false,
		hasUI: false,
		spawns,
		toolNames: ["__none__"],
		contextFiles: input.contextFiles,
		disableExtensionDiscovery: true,
		skills: [],
		promptTemplates: [],
		slashCommands: [],
	});
	let toolCalls = 0;
	let messageCount = 0;
	const report = input.reporter;
	const toolArgsById = new Map<string, { name: string; args?: Record<string, unknown> }>();
	const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
		switch (event.type) {
			case "message_update": {
				if (event.message?.role !== "assistant") break;
				const preview = extractMessagePreview(event.message?.content ?? []);
				if (!preview) break;
				report?.thinking(preview);
				break;
			}
			case "tool_execution_start":
				toolCalls += 1;
				toolArgsById.set(event.toolCallId, {
					name: event.toolName,
					args: event.args as Record<string, unknown> | undefined,
				});
				break;
			case "message_end": {
				if (event.message?.role !== "assistant") break;
				messageCount += 1;
				report?.messageEnded();
				const assistantMessage = event.message as { stopReason?: string; errorMessage?: string };
				if (assistantMessage.stopReason === "error" && assistantMessage.errorMessage) {
					report?.assistantError(assistantMessage.errorMessage);
				}
				const messageText = extractMessageText(event.message?.content ?? []);
				if (messageText) {
					report?.assistantMessage(messageText);
				}
				break;
			}
			case "tool_execution_end": {
				const stored = toolArgsById.get(event.toolCallId) ?? { name: event.toolName };
				toolArgsById.delete(event.toolCallId);
				report?.toolFinished(stored.name, stored.args, event.isError === true);
				break;
			}
			case "agent_end":
				report?.finished(messageCount, toolCalls);
				break;
			default:
				break;
		}
	});

	try {
		const agentUserMessage = prompt.render(commitAgenticPrompts["commit-agentic/session-user"].text, {
			user_context: input.userContext,
			changelog_targets: input.changelogTargets.length > 0 ? input.changelogTargets.join("\n") : undefined,
			existing_changelog_entries: input.existingChangelogEntries,
		});
		const MAX_RETRIES = 3;
		let retryCount = 0;
		const needsChangelog = input.requireChangelog && input.changelogTargets.length > 0;

		await session.prompt(agentUserMessage, {
			attribution: "agent",
			expandPromptTemplates: false,
		});
		while (retryCount < MAX_RETRIES && !isProposalComplete(state, needsChangelog)) {
			retryCount += 1;
			const reminder = buildReminderMessage(state, needsChangelog, retryCount, MAX_RETRIES);
			await session.prompt(reminder, {
				attribution: "agent",
				expandPromptTemplates: false,
				synthetic: true,
			});
		}

		if (input.onComplete) {
			await input.onComplete(state);
		}
		return state;
	} finally {
		unsubscribe();
		await session.dispose();
	}
}

function extractMessagePreview(content: Array<{ type: string; text?: string }>): string | null {
	const textBlocks = content
		.filter(block => block.type === "text" && typeof block.text === "string")
		.map(block => block.text?.trim())
		.filter((value): value is string => Boolean(value));
	if (textBlocks.length === 0) return null;
	return collapseWhitespace(textBlocks.join(" "));
}

function extractMessageText(content: Array<{ type: string; text?: string }>): string | null {
	const textBlocks = content
		.filter(block => block.type === "text" && typeof block.text === "string")
		.map(block => block.text ?? "")
		.filter(value => value.trim().length > 0);
	if (textBlocks.length === 0) return null;
	return textBlocks.join("\n").trim();
}

function isProposalComplete(state: CommitAgentState, requireChangelog: boolean): boolean {
	const hasCommit = Boolean(state.proposal ?? state.splitProposal);
	const hasChangelog = !requireChangelog || Boolean(state.changelogProposal);
	return hasCommit && hasChangelog;
}

function buildReminderMessage(
	state: CommitAgentState,
	requireChangelog: boolean,
	retryCount: number,
	maxRetries: number,
): string {
	const missing: string[] = [];
	if (!state.proposal && !state.splitProposal) {
		missing.push("commit proposal (propose_commit or split_commit)");
	}
	if (requireChangelog && !state.changelogProposal) {
		missing.push("changelog entries (propose_changelog)");
	}
	return `<system-reminder>
CRITICAL: You must call the required tools before finishing.

Missing: ${missing.join(", ") || "none"}.
Reminder ${retryCount} of ${maxRetries}.

Call the missing tool(s) now.
</system-reminder>`;
}
