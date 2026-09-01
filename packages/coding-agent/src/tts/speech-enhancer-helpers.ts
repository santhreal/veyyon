import { prompt } from "@veyyon/utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { sideChannelPrompts } from "../prompts/side-channel/rows";

export const SYSTEM_PROMPT = prompt.render(sideChannelPrompts["side-channel/speech-rewrite"].text);
export const ANSWER_MAX_TOKENS = 1536;
export const REWRITE_TIMEOUT_MS = 6000;
export const MAX_BLOCK_CHARS = 4000;

export interface SpeechEnhancerDeps {
	settings: Settings;
	registry: ModelRegistry;
	sessionId: string;
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined;
	obfuscateProviderText?: (text: string) => string;
}
