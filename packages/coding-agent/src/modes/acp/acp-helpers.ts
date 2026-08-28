import type {
	AgentSideConnection,
	ClientCapabilities,
	CreateElicitationResponse,
	ElicitationContentValue,
	ElicitationPropertySchema,
	PromptResponse,
} from "@agentclientprotocol/sdk";
import { logger } from "@veyyon/utils";
import {
	type ExtensionUIContext,
	type ExtensionUIDialogOptions,
	getExtensionUISelectOptionLabel,
} from "../../extensibility/extensions";
import type { MCPManager } from "../../mcp/manager";
import type { MCPServerConfig } from "../../mcp/types";
import { theme } from "../../modes/theme/theme";
import type { AgentSession } from "../../session/agent-session";
import type { UsageStatistics } from "../../session/session-entries";
import { DEFAULT_STT_MODEL_KEY, STT_MODEL_OPTIONS } from "../../stt/models";
import {
	DEFAULT_TTS_LOCAL_MODEL_KEY,
	DEFAULT_TTS_VOICE,
	TTS_LOCAL_MODELS,
	TTS_LOCAL_VOICE_OPTIONS,
} from "../../tts/models";

export const ACP_DEFAULT_MODE_ID = "default";
export const ACP_PLAN_MODE_ID = "plan";
export const APPROVE_OPTION = "Approve and execute";
export const REFINE_OPTION = "Refine plan";
export const MODE_CONFIG_ID = "mode";
export const MODEL_CONFIG_ID = "model";
export const THINKING_CONFIG_ID = "thinking";
export const THINKING_OFF = "off";
export const SESSION_PAGE_SIZE = 50;
export const SPEECH_MODELS_LIST_METHOD = "speech.models.list";
export const ACP_BOOTSTRAP_RACE_GUARD_MS = 50;
export const ACP_CANCEL_CLEANUP_TIMEOUT_MS = 5_000;
export const ACP_ASYNC_DELIVERY_DRAIN_TIMEOUT_MS = 250;
export const ACP_ASYNC_DELIVERY_DRAIN_MAX_PASSES = 3;
export type AgentImageContent = {
	type: "image";
	data: string;
	mimeType: string;
};
export type PromptQueueState = {
	promise: Promise<void>;
	release: (() => void) | undefined;
};
export type PromptLifecycleError = Error & { readonly code: "ACP_SESSION_CLOSED" };

export type PromptTurnState = {
	cancelRequested: boolean;
	settled: boolean;
	errorTextDelivery: Promise<boolean> | undefined;
	cleanup: Promise<void> | undefined;
	usageBaseline: UsageStatistics;
	unsubscribe: (() => void) | undefined;
	resolve: (value: PromptResponse) => void;
	reject: (reason?: unknown) => void;
	promise: Promise<PromptResponse>;
};
export function isPromptTurnInFlight(turn: PromptTurnState | undefined): turn is PromptTurnState {
	return turn !== undefined && (!turn.settled || turn.cleanup !== undefined);
}
export type ManagedSessionRecord = {
	session: AgentSession;
	mcpManager: MCPManager | undefined;
	promptTurn: PromptTurnState | undefined;
	promptQueue: PromptQueueState;
	liveMessageId: string | undefined;
	liveMessageProgress: { textEmitted: boolean; thoughtEmitted: boolean } | undefined;
	toolArgsById: Map<string, unknown>;
	extensionsConfigured: boolean;
	lifetimeUnsubscribe: (() => void) | undefined;
	closedError: PromptLifecycleError | undefined;
	promptEventHandlers: Set<Promise<void>>;
	extensionUserMessageTasks: Set<Promise<void>>;
};
export type ReplayableMessage = {
	role: string;
	content?: unknown;
	errorMessage?: string;
	toolCallId?: string;
	toolName?: string;
	details?: unknown;
	isError?: boolean;
};
export type ReplayableToolItem = {
	type?: unknown;
	id?: unknown;
	name?: unknown;
	arguments?: unknown;
	input?: unknown;
};
export type MCPConfigMap = {
	[name: string]: MCPServerConfig;
};
export type MCPSource = {
	provider: string;
	providerName: string;
	path: string;
	level: "project";
};
export type MCPSourceMap = {
	[name: string]: MCPSource;
};
export type CreateAcpSession = (cwd: string) => Promise<AgentSession>;
export type AcpSpeechOption = {
	value: string;
	label: string;
	description?: string;
};
export type AcpSpeechVoiceOption = {
	value: string;
	label: string;
};
export type AcpSpeechTtsModelOption = AcpSpeechOption & {
	voices: AcpSpeechVoiceOption[];
};
export function buildAcpSpeechModelsCatalog(): Record<string, unknown> {
	const voices = TTS_LOCAL_VOICE_OPTIONS.map(({ value, label }) => ({ value, label }));
	return {
		settings: {
			speechToTextModel: "stt.modelName",
			textToSpeechModel: "tts.localModel",
			textToSpeechVoice: "tts.localVoice",
			speechVoice: "speech.voice",
		},
		defaults: {
			speechToTextModel: DEFAULT_STT_MODEL_KEY,
			textToSpeechModel: DEFAULT_TTS_LOCAL_MODEL_KEY,
			voice: DEFAULT_TTS_VOICE,
		},
		speechToText: {
			setting: "stt.modelName",
			defaultValue: DEFAULT_STT_MODEL_KEY,
			models: STT_MODEL_OPTIONS.map(({ value, label, description }) => ({ value, label, description })),
		},
		textToSpeech: {
			modelSetting: "tts.localModel",
			voiceSetting: "tts.localVoice",
			speechVoiceSetting: "speech.voice",
			defaultModel: DEFAULT_TTS_LOCAL_MODEL_KEY,
			defaultVoice: DEFAULT_TTS_VOICE,
			models: TTS_LOCAL_MODELS.map(
				({ key, label, description, voices: modelVoices }): AcpSpeechTtsModelOption => ({
					value: key,
					label,
					description,
					voices: modelVoices.map(({ id, label: voiceLabel }) => ({ value: id, label: voiceLabel })),
				}),
			),
			voices,
		},
	};
}
export async function elicitFromAcpClient(
	connection: AgentSideConnection,
	sessionId: string,
	method: "select" | "confirm" | "input",
	message: string,
	property: ElicitationPropertySchema,
	dialogOptions: ExtensionUIDialogOptions | undefined,
): Promise<ElicitationContentValue | undefined> {
	const signal = dialogOptions?.signal;
	if (signal?.aborted) {
		return undefined;
	}
	const { promise, resolve } = Promise.withResolvers<CreateElicitationResponse | undefined>();
	let settled = false;
	let timeoutId: NodeJS.Timeout | undefined;
	const finish = (value: CreateElicitationResponse | undefined) => {
		if (settled) return;
		settled = true;
		if (timeoutId !== undefined) clearTimeout(timeoutId);
		signal?.removeEventListener("abort", onAbort);
		resolve(value);
	};
	const onAbort = () => finish(undefined);
	signal?.addEventListener("abort", onAbort, { once: true });
	if (dialogOptions?.timeout !== undefined) {
		timeoutId = setTimeout(() => {
			if (settled) return;
			try {
				dialogOptions.onTimeout?.();
			} catch (error) {
				logger.warn("ACP elicitation onTimeout threw", { sessionId, method, error });
			}
			finish(undefined);
		}, dialogOptions.timeout);

		timeoutId.unref();
	}
	connection
		.unstable_createElicitation({
			mode: "form",
			sessionId,
			message,
			requestedSchema: {
				type: "object",
				properties: { value: property },
				required: ["value"],
			},
		})
		.then(finish, error => {
			if (settled) return;
			logger.warn("ACP elicitation failed", { sessionId, method, error });
			finish(undefined);
		});
	const response = await promise;
	if (!isAcceptedElicitation(response) || !response.content) {
		return undefined;
	}
	return response.content.value;
}
export function isAcceptedElicitation(
	response: CreateElicitationResponse | undefined,
): response is Extract<CreateElicitationResponse, { action: "accept" }> {
	return response?.action === "accept";
}
export function createAcpExtensionUiContext(
	connection: AgentSideConnection,
	getSessionId: () => string,
	clientCapabilities: ClientCapabilities | undefined,
): ExtensionUIContext {
	const supportsForm = clientCapabilities?.elicitation?.form != null;
	return {
		select: async (title, options, dialogOptions) => {
			if (!supportsForm) return undefined;
			const value = await elicitFromAcpClient(
				connection,
				getSessionId(),
				"select",
				title,
				{ type: "string", enum: options.map(getExtensionUISelectOptionLabel) },
				dialogOptions,
			);
			return typeof value === "string" ? value : undefined;
		},
		confirm: async (title, message, dialogOptions) => {
			if (!supportsForm) return false;
			const value = await elicitFromAcpClient(
				connection,
				getSessionId(),
				"confirm",
				message.trim().length > 0 ? `${title}\n\n${message}` : title,
				{ type: "boolean" },
				dialogOptions,
			);
			return typeof value === "boolean" ? value : false;
		},
		input: async (title, placeholder, dialogOptions) => {
			if (!supportsForm) return undefined;
			const value = await elicitFromAcpClient(
				connection,
				getSessionId(),
				"input",
				title,
				{ type: "string", ...(placeholder?.trim() ? { description: placeholder } : {}) },
				dialogOptions,
			);
			return typeof value === "string" ? value : undefined;
		},
		notify: (message, type) => {
			logger.debug("ACP extension notification", { message, type });
		},
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async () => undefined as never,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		get theme() {
			return theme;
		},
		getAllThemes: async () => [],
		getTheme: async () => undefined,
		setTheme: async () => ({ success: false, error: "Theme changes are unavailable in ACP mode" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}
