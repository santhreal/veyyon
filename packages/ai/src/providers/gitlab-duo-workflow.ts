import type { Context, Model, StreamFunction } from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";

import type { GitLabDuoWorkflowOptions, GitLabDuoWorkflowStreamState } from "./gitlab-duo-workflow-helpers";

export {
	GITLAB_DUO_WORKFLOW_API,
	GITLAB_DUO_WORKFLOW_CLIENT_CAPABILITIES,
	GITLAB_DUO_WORKFLOW_DEFINITION,
	GITLAB_DUO_WORKFLOW_PROVIDER_ID,
	type GitLabAvailableModel,
	type GitLabAvailableModelsPayload,
	type GitLabDirectAccessResponse,
	type GitLabDuoWorkflowActionResponse,
	type GitLabDuoWorkflowActiveSession,
	type GitLabDuoWorkflowAdditionalContextItem,
	type GitLabDuoWorkflowDefinition,
	type GitLabDuoWorkflowInlineFlowComponent,
	type GitLabDuoWorkflowInlineFlowConfig,
	type GitLabDuoWorkflowInlineFlowPrompt,
	type GitLabDuoWorkflowOptions,
	type GitLabDuoWorkflowProviderSessionState,
	type GitLabDuoWorkflowStartRequest,
	type GitLabDuoWorkflowStreamState,
	type GitLabDuoWorkflowWebSocketFactory,
	type GitLabDuoWorkflowWebSocketFactoryOptions,
	type GitLabDuoWorkflowWebSocketLike,
	type GitLabMcpToolArgs,
	type GitLabMcpToolDefinition,
	type GitLabPlainTextResponse,
	type PlainTextResponse,
} from "./gitlab-duo-workflow-helpers";

import {
	createAssistantMessage,
	gitLabDuoWorkflowErrorText,
	runGitLabDuoWorkflow,
} from "./gitlab-duo-workflow-helpers";

export {
	buildGitLabDuoWorkflowApprovalStartRequest,
	buildGitLabDuoWorkflowClientAdditionalContext,
	buildGitLabDuoWorkflowCreateBody,
	buildGitLabDuoWorkflowDirectAccessBody,
	buildGitLabDuoWorkflowInlineFlowConfig,
	buildGitLabDuoWorkflowMcpTools,
	buildGitLabDuoWorkflowSettingsBody,
	buildGitLabDuoWorkflowStartRequest,
	buildGitLabDuoWorkflowStopBody,
	buildGitLabDuoWorkflowWebSocketHeaders,
	buildGitLabDuoWorkflowWebSocketUrl,
	buildGitLabPlainTextFromToolResult,
	describeGitLabDuoWorkflowSocketEvent,
	extractGitLabWorkflowToken,
	gitLabDuoWorkflowErrorText,
	resolveGitLabDuoWorkflowNamespaceSelection,
	resolveGitLabDuoWorkflowRootNamespaceId,
	runGitLabDuoWorkflowSocket,
	selectGitLabDuoWorkflowModelRef,
	traceGitLabDuoWorkflow,
} from "./gitlab-duo-workflow-helpers";

export const streamGitLabDuoWorkflow: StreamFunction<"gitlab-duo-agent"> = (
	model: Model<"gitlab-duo-agent">,
	context: Context,
	options: GitLabDuoWorkflowOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	const output = createAssistantMessage(model);
	stream.push({ type: "start", partial: output });
	const state: GitLabDuoWorkflowStreamState = { stream, output, started: true };

	void runGitLabDuoWorkflow(model, context, options, state).catch(error => {
		const errorText = gitLabDuoWorkflowErrorText(error);
		if (!stream.done) {
			output.stopReason = "error";
			output.errorMessage = state.goalOverflowMessage ?? errorText;
			stream.push({ type: "error", reason: "error", error: output });
		}
	});

	return stream;
};
