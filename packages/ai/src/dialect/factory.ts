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
import type { Dialect, DialectDefinition, InbandScanEvent, InbandScanner, InbandScannerOptions } from "./types";
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

/**
 * A dialect's scanner whose {@link InbandScanner.flush} ends the reply: the dialect's scanner ends or drops every
 * block open at the flush and is then discarded, so a second flush emits nothing and the next
 * {@link InbandScanner.feed} begins a new reply on a scanner in its initial state.
 */
class ReplyScanner implements InbandScanner {
	readonly #definition: DialectDefinition;
	readonly #options: InbandScannerOptions;
	#scanner: InbandScanner | undefined;

	constructor(definition: DialectDefinition, options: InbandScannerOptions) {
		this.#definition = definition;
		this.#options = options;
		this.#scanner = definition.createScanner(options);
	}

	feed(text: string): InbandScanEvent[] {
		this.#scanner ??= this.#definition.createScanner(this.#options);
		return this.#scanner.feed(text);
	}

	flush(): InbandScanEvent[] {
		const scanner = this.#scanner;
		this.#scanner = undefined;
		return scanner === undefined ? [] : scanner.flush();
	}
}

export function createInbandScanner(dialect: Dialect, options: InbandScannerOptions = {}): InbandScanner {
	return new ReplyScanner(getDialectDefinition(dialect), options);
}
