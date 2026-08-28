export type FinishReason =
	| "FINISH_REASON_UNSPECIFIED"
	| "STOP"
	| "MAX_TOKENS"
	| "SAFETY"
	| "RECITATION"
	| "LANGUAGE"
	| "OTHER"
	| "BLOCKLIST"
	| "PROHIBITED_CONTENT"
	| "SPII"
	| "MALFORMED_FUNCTION_CALL"
	| "IMAGE_SAFETY"
	| "IMAGE_PROHIBITED_CONTENT"
	| "IMAGE_RECITATION"
	| "IMAGE_OTHER"
	| "UNEXPECTED_TOOL_CALL"
	| "NO_IMAGE";

export type FunctionCallingConfigMode = "MODE_UNSPECIFIED" | "AUTO" | "NONE" | "ANY" | "VALIDATED";

export type ThinkingLevel = "THINKING_LEVEL_UNSPECIFIED" | "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";

export interface InlineDataPart {
	mimeType: string;
	data: string;
}

export interface FunctionCallPart {
	name?: string;
	args?: Record<string, unknown>;
	id?: string;
}

export interface FunctionResponsePart {
	name: string;
	response: Record<string, unknown>;
	parts?: Part[];
	id?: string;
}

export interface Part {
	text?: string;
	thought?: boolean;
	thoughtSignature?: string;
	inlineData?: InlineDataPart;
	functionCall?: FunctionCallPart;
	functionResponse?: FunctionResponsePart;
}

export interface Content {
	role?: string;
	parts?: Part[];
}

export interface ThinkingConfig {
	includeThoughts?: boolean;
	thinkingBudget?: number;
	thinkingLevel?: ThinkingLevel;
}

export interface FunctionDeclaration {
	name: string;
	description?: string;
	parameters?: Record<string, unknown>;
	parametersJsonSchema?: Record<string, unknown>;
}

export interface ToolDeclaration {
	functionDeclarations: Record<string, unknown>[];
}

export interface ToolConfig {
	functionCallingConfig?: {
		mode: FunctionCallingConfigMode;
		allowedFunctionNames?: string[];
	};
}

export interface GenerateContentConfig {
	temperature?: number;
	maxOutputTokens?: number;
	topP?: number;
	topK?: number;
	candidateCount?: number;
	stopSequences?: string[];
	presencePenalty?: number;
	frequencyPenalty?: number;
	seed?: number;
	responseMimeType?: string;
	responseSchema?: Record<string, unknown>;
	responseJsonSchema?: Record<string, unknown>;
	responseModalities?: string[];
	systemInstruction?: Content | { role?: string; parts: { text: string }[] };
	tools?: ToolDeclaration[];
	toolConfig?: ToolConfig;
	safetySettings?: Array<Record<string, unknown>>;
	cachedContent?: string;
	thinkingConfig?: ThinkingConfig;
	serviceTier?: "auto" | "default" | "flex" | "scale" | "priority";
	abortSignal?: AbortSignal;
}

export interface GenerateContentParameters {
	model: string;
	contents: Content[];
	config?: GenerateContentConfig;
}

export interface Candidate {
	content?: Content;
	finishReason?: FinishReason;
	index?: number;
}

export interface UsageMetadata {
	promptTokenCount?: number;
	candidatesTokenCount?: number;
	thoughtsTokenCount?: number;
	totalTokenCount?: number;
	cachedContentTokenCount?: number;
}

export interface PromptFeedback {
	blockReason?: string;
	blockReasonMessage?: string;
	[key: string]: unknown;
}

export interface GenerateContentResponse {
	candidates?: Candidate[];
	usageMetadata?: UsageMetadata;
	modelVersion?: string;
	responseId?: string;
	promptFeedback?: PromptFeedback;
	error?: { code?: number; message?: string; status?: string };
}
