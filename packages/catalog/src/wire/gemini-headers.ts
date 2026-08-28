export function getGeminiCliUserAgent(modelId = "gemini-3.1-pro-preview"): string {
	const version = process.env.VEYYON_AI_GEMINI_CLI_VERSION || "0.46.0";
	return `GeminiCLI/${version}/${modelId} (${process.platform}; ${process.arch}; terminal)`;
}

export const getGeminiCliHeaders = (modelId?: string) => ({
	"User-Agent": getGeminiCliUserAgent(modelId),
	"Client-Metadata": "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
});

export const ANTIGRAVITY_SYSTEM_INSTRUCTION =
	"You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding." +
	"You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question." +
	"**Absolute paths only**" +
	"**Proactiveness**";
export let getAntigravityUserAgent = () => {
	const DEFAULT_ANTIGRAVITY_VERSION = "2.1.4";
	const version = process.env.VEYYON_AI_ANTIGRAVITY_VERSION || DEFAULT_ANTIGRAVITY_VERSION;
	const os = process.platform === "win32" ? "windows" : process.platform;
	const arch = process.arch === "x64" ? "amd64" : process.arch === "ia32" ? "386" : process.arch;
	const userAgent = `antigravity/hub/${version} ${os}/${arch}`;
	getAntigravityUserAgent = () => userAgent;
	return userAgent;
};
export interface AntigravityModelWireProfile {
	modelEnum?: string;
	maxOutputTokens: number;
}
export const ANTIGRAVITY_MODEL_WIRE_PROFILES: Readonly<Record<string, AntigravityModelWireProfile>> = {
	"gemini-3.5-flash-extra-low": { modelEnum: "MODEL_PLACEHOLDER_M187", maxOutputTokens: 65536 },
	"gemini-3.5-flash-low": { modelEnum: "MODEL_PLACEHOLDER_M20", maxOutputTokens: 65536 },
	"gemini-3-flash-agent": { modelEnum: "MODEL_PLACEHOLDER_M132", maxOutputTokens: 65536 },
	"gemini-3.1-pro-low": { modelEnum: "MODEL_PLACEHOLDER_M36", maxOutputTokens: 65535 },
	"gemini-pro-agent": { modelEnum: "MODEL_PLACEHOLDER_M16", maxOutputTokens: 65535 },
	"gemini-3.6-flash-tiered": { maxOutputTokens: 65536 },
	"gemini-3.7-flash-tiered": { maxOutputTokens: 65536 },
	"claude-sonnet-4-6": { maxOutputTokens: 64000 },
	"claude-opus-4-6-thinking": { maxOutputTokens: 64000 },
};
export function getAntigravityModelWireProfile(wireModelId: string): AntigravityModelWireProfile | undefined {
	return ANTIGRAVITY_MODEL_WIRE_PROFILES[wireModelId];
}
