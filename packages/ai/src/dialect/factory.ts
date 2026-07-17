import anthropicDefinition from "./anthropic";
import deepseekDefinition from "./deepseek";
import geminiDefinition from "./gemini";
import gemmaDefinition from "./gemma";
import glmDefinition from "./glm";
import harmonyDefinition from "./harmony";
import hermesDefinition from "./hermes";
import kimiDefinition from "./kimi";
import minimaxDefinition from "./minimax";
import piNativeDefinition from "./pi-native";
import qwen3Definition from "./qwen3";
import type { Dialect, DialectDefinition, InbandScanner, InbandScannerOptions } from "./types";
import xmlDefinition from "./xml";

const DIALECT_DEFINITIONS: Record<Dialect, DialectDefinition> = {
	glm: glmDefinition,
	hermes: hermesDefinition,
	kimi: kimiDefinition,
	xml: xmlDefinition,
	anthropic: anthropicDefinition,
	deepseek: deepseekDefinition,
	minimax: minimaxDefinition,
	harmony: harmonyDefinition,
	qwen3: qwen3Definition,
	gemini: geminiDefinition,
	gemma: gemmaDefinition,
	"pi-native": piNativeDefinition,
};

export function getDialectDefinition(dialect: Dialect): DialectDefinition {
	return DIALECT_DEFINITIONS[dialect];
}

export function createInbandScanner(dialect: Dialect, options: InbandScannerOptions = {}): InbandScanner {
	return getDialectDefinition(dialect).createScanner(options);
}
